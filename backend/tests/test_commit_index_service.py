"""变更图索引（repo_commit_files）：全量 / 增量 / 自愈 / 清理。"""
import json
import os
import shutil

import pytest
from sqlalchemy import func, select

from app.models.repo_commit_file import RepoCommitFile, RepoCommitIndexState
from app.services.repository.commit_index_service import CommitIndexService


async def _count(db, repo_id) -> int:
    return int(
        (
            await db.execute(
                select(func.count()).select_from(RepoCommitFile).where(
                    RepoCommitFile.repository_id == repo_id
                )
            )
        ).scalar_one()
    )


async def _state(db, repo_id):
    return (
        await db.execute(
            select(RepoCommitIndexState).where(
                RepoCommitIndexState.repository_id == repo_id
            )
        )
    ).scalar_one_or_none()


@pytest.mark.asyncio
async def test_rebuild_indexes_all_commits(async_db, async_test_repo):
    from tests.test_search_service import _build_worktree_repo

    repo_path, old_sha, new_sha = _build_worktree_repo()
    try:
        await CommitIndexService().rebuild(async_db, async_test_repo.id, repo_path)
        rows = (
            await async_db.execute(
                select(RepoCommitFile).where(
                    RepoCommitFile.repository_id == async_test_repo.id
                )
            )
        ).scalars().all()
        by_commit: dict = {}
        for r in rows:
            by_commit.setdefault(r.commit_sha, {})[r.path] = r

        assert old_sha in by_commit and new_sha in by_commit
        assert by_commit[old_sha]["a.py"].status == "A"  # 根提交新增
        second = by_commit[new_sha]
        assert second["a.py"].status == "M"
        assert second["c.py"].status == "A"
        assert second["b.txt"].status == "D"
        assert second["a.py"].additions > 0
        # 删除文件无新侧行区间
        assert json.loads(second["b.txt"].changed_ranges) == []
        assert json.loads(second["a.py"].changed_ranges)  # 新增两行 → 非空

        state = await _state(async_db, async_test_repo.id)
        assert state is not None and state.indexed_commit == new_sha
    finally:
        shutil.rmtree(os.path.dirname(repo_path), ignore_errors=True)


@pytest.mark.asyncio
async def test_ensure_is_incremental(async_db, async_test_repo):
    from tests.test_search_service import _build_worktree_repo, _git

    repo_path, old_sha, new_sha = _build_worktree_repo()
    try:
        svc = CommitIndexService()
        await svc.ensure(async_db, async_test_repo.id, repo_path)  # 首次 = 全量
        base_count = await _count(async_db, async_test_repo.id)
        assert base_count > 0

        async def _old_ids():
            return {
                r.id for r in (
                    await async_db.execute(
                        select(RepoCommitFile).where(
                            RepoCommitFile.repository_id == async_test_repo.id,
                            RepoCommitFile.commit_sha == old_sha,
                        )
                    )
                ).scalars().all()
            }

        old_ids_before = await _old_ids()
        assert old_ids_before  # 根提交含 a.py / b.txt 两行

        # 新提交（新增 d.py）
        with open(os.path.join(repo_path, "d.py"), "w", encoding="utf-8") as f:
            f.write("def four():\n    pass\n")
        _git("add", "-A", cwd=repo_path)
        _git("commit", "-m", "third", cwd=repo_path)
        third = _git("rev-parse", "HEAD", cwd=repo_path).stdout.strip()

        await svc.ensure(async_db, async_test_repo.id, repo_path)

        third_rows = (
            await async_db.execute(
                select(RepoCommitFile).where(
                    RepoCommitFile.repository_id == async_test_repo.id,
                    RepoCommitFile.commit_sha == third,
                )
            )
        ).scalars().all()
        assert len(third_rows) == 1
        assert third_rows[0].path == "d.py" and third_rows[0].status == "A"

        # 旧提交行主键不变（增量未删除重插旧提交 —— 否则 id 会变）
        assert await _old_ids() == old_ids_before

        state = await _state(async_db, async_test_repo.id)
        assert state.indexed_commit == third
    finally:
        shutil.rmtree(os.path.dirname(repo_path), ignore_errors=True)


@pytest.mark.asyncio
async def test_unknown_baseline_falls_back_to_full(async_db, async_test_repo):
    from tests.test_search_service import _build_worktree_repo, _git

    repo_path, _old, _new = _build_worktree_repo()
    try:
        svc = CommitIndexService()
        await svc.ensure(async_db, async_test_repo.id, repo_path)

        # 篡改 baseline 为库中不存在的提交 → 应全量重建而非清空
        state = await _state(async_db, async_test_repo.id)
        state.indexed_commit = "f" * 40
        await async_db.commit()

        await svc.ensure(async_db, async_test_repo.id, repo_path)
        assert await _count(async_db, async_test_repo.id) > 0
        state = await _state(async_db, async_test_repo.id)
        assert state.indexed_commit == _git("rev-parse", "HEAD", cwd=repo_path).stdout.strip()
    finally:
        shutil.rmtree(os.path.dirname(repo_path), ignore_errors=True)


@pytest.mark.asyncio
async def test_cleanup_removes_rows_and_state(async_db, async_test_repo):
    from tests.test_search_service import _build_worktree_repo

    repo_path, _old, _new = _build_worktree_repo()
    try:
        svc = CommitIndexService()
        await svc.rebuild(async_db, async_test_repo.id, repo_path)
        assert await _count(async_db, async_test_repo.id) > 0

        await svc.cleanup_index(async_db, async_test_repo.id)
        await async_db.commit()
        assert await _count(async_db, async_test_repo.id) == 0
        assert await _state(async_db, async_test_repo.id) is None
    finally:
        shutil.rmtree(os.path.dirname(repo_path), ignore_errors=True)
