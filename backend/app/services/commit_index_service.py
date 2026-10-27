"""变更图索引服务：每个提交的改动文件与行区间（``repo_commit_files``）。

复刻块级索引的**懒构建 / 增量 / 代次自愈**模式（见 ``services/search_service.py``）：
- 懒构建：``ensure`` 从状态表读 baseline，只补齐 baseline→HEAD 的新提交（增量）；
  baseline 缺失或代次不足时全量重建；
- 并发：与搜索索引共用同一把 per-repo 锁（进程内 + Redis ``SET NX``）；
- 代次：``COMMIT_INDEX_GENERATION`` 与状态表 ``index_generation`` 共同构成跳过条件，
  避免「commit 相同但数据行为空」的永久空索引（同 ``repo_search_state`` 的教训）。

数据来源为 pygit2 直读 ref 历史，与块级索引一致（不依赖工作树）。
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import List, Optional, Tuple

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_config
from app.models.repo_commit_file import RepoCommitFile, RepoCommitIndexState
from app.services.search_service import (
    _acquire_rebuild_lock,
    _local_rebuild_lock,
    _release_rebuild_lock,
)

logger = logging.getLogger(__name__)

#: 变更图索引数据代次（构建算法升级时递增，强制自愈重建）
COMMIT_INDEX_GENERATION = 1


def _max_commits() -> int:
    return int(get_config().search.commit_index_max_commits)


def _commit_changes(repo, commit) -> List[Tuple[str, str, int, int, str]]:
    """单个提交的改动文件：``[(path, status, additions, deletions, ranges_json)]``"""
    import pygit2

    if commit.parents:
        diff = commit.parents[0].tree.diff_to_tree(commit.tree)
    else:
        # 根提交：与空树对比（新侧即该提交自身）
        empty_oid = repo.TreeBuilder().write()
        diff = repo[empty_oid].diff_to_tree(commit.tree)

    out: List[Tuple[str, str, int, int, str]] = []
    for patch in diff:
        if patch is None:
            continue
        ranges: List[List[int]] = []
        if patch.delta.status != pygit2.GIT_DELTA_DELETED:
            for h in patch.hunks:
                start = int(h.new_start)
                end = start + max(0, int(h.new_lines) - 1)
                ranges.append([start, end])
        path = patch.delta.new_file.path or patch.delta.old_file.path
        out.append((
            path,
            patch.delta.status_char(),
            max(0, int(patch.line_stats[1])),
            max(0, int(patch.line_stats[2])),
            json.dumps(ranges),
        ))
    return out


def _build_rows(
    repo_path: str, baseline: Optional[str], limit: int
) -> Tuple[Optional[str], Optional[List[Tuple[str, str, str, int, int, str]]]]:
    """返回 ``(head_sha, rows)``；``rows is None`` 表示 baseline 不可解析（应全量重建）。

    ``baseline`` 非空时只遍历其后（不含）的提交（增量）；为空时遍历全历史。
    ``rows`` 元素为 ``(commit_sha, path, status, additions, deletions, ranges_json)``。
    """
    import pygit2

    repo = pygit2.Repository(repo_path)
    try:
        head = repo.head.peel(pygit2.Commit)
    except Exception:  # noqa: BLE001 — 空仓库 / HEAD 不可解
        return None, []

    head_sha = str(head.id)
    walker = repo.walk(head.id, pygit2.enums.SortMode.TIME)
    if baseline:
        obj = repo.get(baseline)
        if obj is None:
            return head_sha, None  # baseline 不在库中 → 调用方全量重建
        walker.hide(obj.id)

    rows: List[Tuple[str, str, str, int, int, str]] = []
    for i, commit in enumerate(walker):
        if i >= limit:
            break
        sha = str(commit.id)
        for path, status, add, dele, ranges in _commit_changes(repo, commit):
            rows.append((sha, path, status, add, dele, ranges))
    return head_sha, rows


class CommitIndexService:
    """变更图索引构建/增量/自愈 + 生命周期清理"""

    async def ensure(self, db: AsyncSession, repository_id, repo_path: str) -> None:
        """懒构建：与默认分支 HEAD 同步（增量优先，baseline 缺失/代次不足则全量）。"""
        await self._with_lock(db, repository_id, repo_path, baseline_from_state=True)

    async def rebuild(self, db: AsyncSession, repository_id, repo_path: str) -> None:
        """全量重建（手动/自愈入口）。"""
        await self._with_lock(db, repository_id, repo_path, baseline_from_state=False)

    async def _with_lock(
        self, db: AsyncSession, repository_id, repo_path: str, *, baseline_from_state: bool
    ) -> None:
        if not repo_path:
            return
        local = await _local_rebuild_lock(repository_id)
        if local.locked():
            logger.info("变更图索引跳过：仓库 %s 正在构建", repository_id)
            return
        async with local:
            handle = await _acquire_rebuild_lock(repository_id)
            if handle is False:
                logger.info("变更图索引跳过：仓库 %s 的锁被其他 worker 持有", repository_id)
                return
            try:
                baseline = None
                if baseline_from_state:
                    state = await self._state(db, repository_id)
                    generation = (state.index_generation if state else None) or 0
                    if state is not None and generation >= COMMIT_INDEX_GENERATION:
                        baseline = state.indexed_commit
                await self._build(db, repository_id, repo_path, baseline)
            finally:
                await _release_rebuild_lock(handle)

    async def _build(
        self, db: AsyncSession, repository_id, repo_path: str, baseline: Optional[str]
    ) -> None:
        head_sha, rows = await asyncio.to_thread(
            _build_rows, repo_path, baseline, _max_commits()
        )
        if rows is None:  # baseline 不可解析 → 退化为全量
            head_sha, rows = await asyncio.to_thread(
                _build_rows, repo_path, None, _max_commits()
            )
        if rows:
            await self._delete_commits(db, repository_id, {r[0] for r in rows})
            await self._insert(db, repository_id, rows)
        await self._upsert_state(db, repository_id, head_sha)
        await db.commit()

    async def cleanup_index(self, db: AsyncSession, repository_id) -> None:
        """仓库删除后的生命周期清理"""
        await db.execute(
            delete(RepoCommitFile).where(RepoCommitFile.repository_id == repository_id)
        )
        await db.execute(
            delete(RepoCommitIndexState).where(
                RepoCommitIndexState.repository_id == repository_id
            )
        )
        await db.flush()

    # ---- 内部 ----

    @staticmethod
    async def _state(db: AsyncSession, repository_id) -> Optional[RepoCommitIndexState]:
        return (
            await db.execute(
                select(RepoCommitIndexState).where(
                    RepoCommitIndexState.repository_id == repository_id
                )
            )
        ).scalar_one_or_none()

    @staticmethod
    async def _upsert_state(db: AsyncSession, repository_id, commit_sha: Optional[str]) -> None:
        row = await CommitIndexService._state(db, repository_id)
        if row is None:
            db.add(RepoCommitIndexState(
                repository_id=repository_id,
                indexed_commit=commit_sha,
                index_generation=COMMIT_INDEX_GENERATION,
            ))
        else:
            row.indexed_commit = commit_sha
            row.index_generation = COMMIT_INDEX_GENERATION
        await db.flush()

    @staticmethod
    async def _delete_commits(db: AsyncSession, repository_id, shas) -> None:
        if not shas:
            return
        await db.execute(
            delete(RepoCommitFile).where(
                RepoCommitFile.repository_id == repository_id,
                RepoCommitFile.commit_sha.in_(list(shas)),
            )
        )

    @staticmethod
    async def _insert(
        db: AsyncSession, repository_id, rows: List[Tuple[str, str, str, int, int, str]]
    ) -> None:
        batch = int(get_config().search.index_row_batch)
        for i in range(0, len(rows), batch):
            db.add_all([
                RepoCommitFile(
                    repository_id=repository_id,
                    commit_sha=sha,
                    path=path,
                    status=status,
                    additions=add,
                    deletions=dele,
                    changed_ranges=ranges,
                )
                for (sha, path, status, add, dele, ranges) in rows[i:i + batch]
            ])
            await db.flush()
