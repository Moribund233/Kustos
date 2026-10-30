"""搜索域 · 搜索服务

主库持久化的块级索引：构建、增量更新、符号/引用查找、语义检索与自愈。
依赖四个支撑模块：config（限流）、dto（返回结构）、
git_scan（Git 遍历）、locks（重建锁）。
"""
import logging
from collections import OrderedDict
from sqlalchemy import delete, func, insert, not_, or_, select, text
from typing import Any, Dict, List, Optional, Tuple
import asyncio
import pygit2
import time

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_config, get_config_value
from app.models.repo_search import RepoSearchState
from app.models.repo_search_chunk import RepoSearchChunk
from app.models.repo_search_embedding import RepoSearchEmbedding
from app.models.repo_search_ref import RepoSearchRef
from app.models.uuid7 import generate_uuid7
from app.services.indexing.chunker import Chunk, analyze_file
from app.services.indexing.embeddings import get_embedding_provider, is_configured
from app.services.search.config import INDEX_GENERATION, _clamp_results, _index_file_batch, _index_limits, _index_row_batch, _max_file_bytes, scan_file_limit
from app.services.search.dto import ChunkRef, SearchResponse, SearchResult, SymbolHit, SymbolLookup, UsageHit
from app.services.search.git_scan import _batched, _default_branch, _extract_all_snapshot, _head_commit, _is_text_path, _iter_text_blobs, _list_text_paths, _needs_ref_scan, _path_prefix, _read_text_blobs, _rrf_fuse, _scan_definitions_at_ref, _scan_usages_at_ref, _test_path_clauses, head_commit
from app.services.search.locks import _acquire_rebuild_lock, _local_rebuild_lock, _release_rebuild_lock

logger = logging.getLogger(__name__)


_QUERY_VECTORS: "OrderedDict[Tuple[str, str], Tuple[float, Tuple[float, ...]]]" = OrderedDict()


_MODEL_HEAL_COOLDOWN = 300.0


_MODEL_HEAL_ATTEMPTED: Dict[object, float] = {}


def _extract_changed(
    repo_path: str, changed_files: List[str], max_file_bytes: Optional[int] = None
) -> Tuple[Optional[str], List[Tuple[str, str]]]:
    """从默认分支 HEAD 读取指定路径的内容（供增量更新）"""
    if max_file_bytes is None:
        max_file_bytes = _max_file_bytes()
    try:
        repo = pygit2.Repository(repo_path)
    except Exception:
        return None, []
    commit = _head_commit(repo)
    if commit is None:
        return None, []
    out: List[Tuple[str, str]] = []
    for path in changed_files:
        if not _is_text_path(path):
            continue
        try:
            entry = commit.tree[path]
        except KeyError:
            continue
        if entry.type != pygit2.GIT_OBJECT_BLOB:
            continue
        blob = repo[entry.id]
        if blob.size > max_file_bytes or b"\x00" in blob.data:
            continue
        out.append((path, blob.data.decode("utf-8", "replace")))
    return str(commit.id), out


def _analyze_rows(
    repository_id, files: List[Tuple[str, str]]
) -> Tuple[List[Dict[str, object]], List[Dict[str, object]]]:
    """将 (path, content) 列表切分为 chunk 行与引用行（供批量插入）"""
    chunk_rows: List[Dict[str, object]] = []
    ref_rows: List[Dict[str, object]] = []
    for path, content in files:
        analysis = analyze_file(path, content)
        chunks: List[Chunk] = analysis.chunks
        for index, c in enumerate(chunks):
            chunk_rows.append({
                "id": generate_uuid7(),
                "repository_id": repository_id,
                "path": path,
                "chunk_index": index,
                "symbol": c.symbol,
                "kind": c.kind,
                "start_line": c.start_line,
                "end_line": c.end_line,
                "content": c.content,
                "size": len(c.content.encode("utf-8")),
            })
        seen = set()
        for ref in analysis.refs:
            key = (ref.name, ref.line)
            if key in seen:
                continue
            seen.add(key)
            ref_rows.append({
                "id": generate_uuid7(),
                "repository_id": repository_id,
                "path": path,
                "name": ref.name,
                "line": ref.line,
            })
    return chunk_rows, ref_rows


def _search_git_tree(
    repo_path: str, ref: str, query: str, path: Optional[str], max_results: int
) -> List[SearchResult]:
    """进程内扫描 Git tree（大小写不敏感子串匹配）——兜底与任意 ref"""
    try:
        repo = pygit2.Repository(repo_path)
        commit = repo.revparse_single(ref).peel(pygit2.Commit)
    except Exception:
        return []

    needle = query.lower()
    prefix = None
    if path and path.strip("./"):
        prefix = path.strip("/").rstrip("/") + "/"

    results: List[SearchResult] = []
    for file_path, content in _iter_text_blobs(repo, commit.tree):
        if prefix and not file_path.startswith(prefix):
            continue
        for idx, line in enumerate(content.splitlines(), 1):
            if needle in line.lower():
                results.append(SearchResult(file=file_path, line=idx, content=line))
                if len(results) >= max_results:
                    return results
    return results


class SearchService:
    """搜索服务"""

    async def search_code(
        self,
        db: AsyncSession,
        repository_id,
        repo_path: str,
        query: str,
        path: Optional[str] = None,
        ref: Optional[str] = None,
        max_results: Optional[int] = None,
        semantic: Optional[bool] = None,
    ) -> SearchResponse:
        """
        搜索代码（内容来自 Git 对象，索引存于主库）

        Args:
            db: 异步数据库会话
            repository_id: 仓库ID
            repo_path: 仓库物理路径（bare）
            query: 搜索关键词
            path: 限制搜索目录（前缀）
            ref: 分支/标签/提交；缺省为默认分支
            max_results: 最大结果数；None = ``search.max_results``（service 默认
                兼硬上限，显式传参受其约束——显式值在此被夹取到上限内）
        """
        # 全局 kill switch：关闭 = 空结果（source="none"），不进入任何检索路径
        search_cfg = get_config().search
        if not search_cfg.enabled:
            return SearchResponse(
                query=query, results=[], total_count=0, truncated=False, source="none",
            )

        # service-side clamp 是最终裁决方——显式传参超上限即被夹回
        max_results = _clamp_results(
            max_results, default=int(search_cfg.max_results or 100)
        )

        if not query or not query.strip():
            return SearchResponse(
                query=query, results=[], total_count=0, truncated=False, source="none",
            )

        default_ref = await asyncio.to_thread(_default_branch, repo_path)
        target_ref = ref or default_ref

        # 快路径：默认分支走主库索引（懒构建 / 增量补齐）
        if target_ref == default_ref:
            try:
                await self._ensure_index(db, repository_id, repo_path)
                keyword = await self._search_db(db, repository_id, query, path, max_results)
                use_semantic = (
                    semantic if semantic is not None
                    else get_config().search.embedding_enabled
                )
                semantic_hits: List[SearchResult] = []
                if use_semantic:
                    semantic_hits = await self._search_semantic(
                        db, repository_id, query, path, max_results
                    )
                results = (
                    _rrf_fuse([keyword, semantic_hits], max_results, get_config().search.rrf_k)
                    if semantic_hits else keyword
                )
                if results:
                    truncated = len(results) >= max_results
                    return SearchResponse(
                        query=query,
                        results=results,
                        total_count=-1 if truncated else len(results),
                        truncated=truncated,
                        source="index",
                        semantic_used=bool(semantic_hits),
                    )
            except Exception:
                # 索引不可用（如迁移未执行）时回滚并退回 Git tree 扫描
                await db.rollback()

        # 兜底：索引路径无命中或不可用——如实标记来源，不冒充索引召回
        raw_results = await asyncio.to_thread(
            _search_git_tree, repo_path, target_ref, query, path, max_results + 1
        )
        truncated = len(raw_results) > max_results
        results = raw_results[:max_results]
        return SearchResponse(
            query=query,
            results=results,
            total_count=-1 if truncated else len(results),
            truncated=truncated,
            source="git_tree",
            semantic_used=False,
        )

    # ---- 索引维护 ----

    async def rebuild_index(self, db: AsyncSession, repository_id, repo_path: str) -> int:
        """全量重建某仓库的块级搜索索引，返回索引文件数。

        并发保护：同一仓库同时只允许一个 worker 重建（Redis NX + 进程内锁）。
        未抢到锁的调用方直接返回 0，由搜索路径退回 Git tree 全扫。
        """
        local = await _local_rebuild_lock(repository_id)
        if local.locked():
            return 0
        async with local:
            handle = await _acquire_rebuild_lock(repository_id)
            if handle is False:
                return 0
            try:
                return await self._do_rebuild(db, repository_id, repo_path)
            finally:
                await _release_rebuild_lock(handle)

    async def _load_old_chunk_contents(
        self, db: AsyncSession, repository_id, paths: List[str]
    ) -> Dict[str, List[Tuple[int, str]]]:
        """读旧 chunk 的 ``(chunk_index, content)``（按 index 升序），供复用比对。

        以「chunk 内容逐条相等」作为文件未变的判据（分块由文件内容确定性推导，
        无需落 blob-hash 列——零迁移）；按批 IN 查询，内存有界。
        """
        out: Dict[str, List[Tuple[int, str]]] = {}
        for batch in _batched(paths, 500):
            rows = (
                await db.execute(
                    select(
                        RepoSearchChunk.path,
                        RepoSearchChunk.chunk_index,
                        RepoSearchChunk.content,
                    ).where(
                        RepoSearchChunk.repository_id == repository_id,
                        RepoSearchChunk.path.in_(batch),
                    )
                )
            ).all()
            for path, idx, content in rows:
                out.setdefault(path, []).append((int(idx), content or ""))
        for path in out:
            out[path].sort()
        return out

    async def _delete_paths(
        self, db: AsyncSession, repository_id, paths: List[str]
    ) -> None:
        """按文件路径删除三表行（增量与重建共用同一删除语义）"""
        for batch in _batched(list(paths), 500):
            await db.execute(
                delete(RepoSearchChunk).where(
                    RepoSearchChunk.repository_id == repository_id,
                    RepoSearchChunk.path.in_(batch),
                )
            )
            await db.execute(
                delete(RepoSearchRef).where(
                    RepoSearchRef.repository_id == repository_id,
                    RepoSearchRef.path.in_(batch),
                )
            )
            await db.execute(
                delete(RepoSearchEmbedding).where(
                    RepoSearchEmbedding.repository_id == repository_id,
                    RepoSearchEmbedding.path.in_(batch),
                )
            )

    async def _prune_missing_paths(
        self, db: AsyncSession, repository_id, keep: set
    ) -> None:
        """删除树里已不存在文件的残留行（重建是全量换血，顺带自愈历史孤儿行）"""
        old_paths = (
            await db.execute(
                select(RepoSearchChunk.path)
                .where(RepoSearchChunk.repository_id == repository_id)
                .distinct()
            )
        ).scalars().all()
        missing = [p for p in old_paths if p not in keep]
        if missing:
            await self._delete_paths(db, repository_id, missing)

    async def _clear_index(self, db: AsyncSession, repository_id) -> None:
        """清空某仓全部索引行（超限跳过/语义重建的清场语义）"""
        await db.execute(
            delete(RepoSearchChunk).where(RepoSearchChunk.repository_id == repository_id)
        )
        await db.execute(
            delete(RepoSearchRef).where(RepoSearchRef.repository_id == repository_id)
        )
        await db.execute(
            delete(RepoSearchEmbedding).where(
                RepoSearchEmbedding.repository_id == repository_id
            )
        )

    async def _write_analysis(
        self,
        db: AsyncSession,
        repository_id,
        chunk_rows: List[dict],
        ref_rows: List[dict],
    ) -> None:
        """落库已分析的 chunk/ref 行 + 生成 embedding（``_insert_chunks`` 的可复用内核）"""
        row_batch = _index_row_batch()
        for batch in _batched(chunk_rows, row_batch):
            await db.execute(insert(RepoSearchChunk.__table__), batch)
        for batch in _batched(ref_rows, row_batch):
            await db.execute(insert(RepoSearchRef.__table__), batch)
        await self._insert_embeddings(db, repository_id, chunk_rows)

    async def _do_rebuild(self, db: AsyncSession, repository_id, repo_path: str) -> int:
        """全量重建，带**未变文件复用**（blob 级复用的零迁移形态）：

        - 文件内容未变（新旧 chunk 的 ``(index, content)`` 逐条相等）→ 整文件跳过：
          不删不插、**不重新调 embedding**——手动重建/增量丢失自愈时，语义向量
          只为真正变化的文件付费（未变文件零 API 调用）；
        - 代次变更（切分算法升级）→ 禁用复用，全部重切重嵌（旧代 chunk 一律作废）；
        - 树中已消失文件的残留行在结尾统一剪除（顺带自愈历史孤儿行）；
        - 超限跳过时维持原语义：清空数据 + 记 state（有意空索引，不逐次重试）。
        """
        commit_id, paths, truncated = await asyncio.to_thread(
            _list_text_paths, repo_path
        )
        if truncated:
            # 超限：放弃索引（结果完整性优先），标记 state 避免每次搜索重试；搜索退回 Git tree 全扫。
            max_files, max_bytes = _index_limits()
            logger.warning(
                "仓库 %s 超过索引上限（files<=%s, bytes<=%s），跳过块级索引",
                repository_id, max_files, max_bytes,
            )
            await self._clear_index(db, repository_id)
            await self._upsert_state(db, repository_id, commit_id)
            await db.flush()
            return 0

        # 复用开关：仅当旧数据就是当前代（分块结果可比）才允许跳过未变文件
        prev = (
            await db.execute(
                select(RepoSearchState).where(
                    RepoSearchState.repository_id == repository_id
                )
            )
        ).scalar_one_or_none()
        allow_reuse = prev is not None and (prev.index_generation or 0) == INDEX_GENERATION

        indexed = 0
        file_batch = _index_file_batch()
        for batch in _batched(paths, file_batch):
            _, files = await asyncio.to_thread(_read_text_blobs, repo_path, batch)
            indexed += len(files)
            if not files:
                continue
            chunk_rows, ref_rows = await asyncio.to_thread(
                _analyze_rows, repository_id, files
            )
            if allow_reuse:
                old_map = await self._load_old_chunk_contents(
                    db, repository_id, [p for p, _ in files]
                )
                new_by_path: Dict[str, List[Tuple[int, str]]] = {}
                for r in chunk_rows:
                    new_by_path.setdefault(r["path"], []).append(
                        (int(r["chunk_index"]), r.get("content") or "")
                    )
                for path in new_by_path:
                    new_by_path[path].sort()
                redo = {
                    p
                    for p, _ in files
                    if old_map.get(p) is None or new_by_path.get(p, []) != old_map[p]
                }
            else:
                redo = {p for p, _ in files}
            if not redo:
                continue  # 整批文件未变：chunk/ref/embedding 原样保留
            redo_files = [(p, c) for p, c in files if p in redo]
            redo_chunks = [r for r in chunk_rows if r["path"] in redo]
            redo_refs = [r for r in ref_rows if r["path"] in redo]
            await self._delete_paths(db, repository_id, list(redo))
            await self._write_analysis(db, repository_id, redo_chunks, redo_refs)

        await self._prune_missing_paths(db, repository_id, set(paths))
        await self._upsert_state(db, repository_id, commit_id)
        await db.flush()
        return indexed

    async def _insert_chunks(
        self, db: AsyncSession, repository_id, files: List[Tuple[str, str]]
    ) -> int:
        """切分并分批 INSERT chunk 与引用行（内存占用与单条语句大小均有界）"""
        if not files:
            return 0
        chunk_rows, ref_rows = await asyncio.to_thread(
            _analyze_rows, repository_id, files
        )
        await self._write_analysis(db, repository_id, chunk_rows, ref_rows)
        return len(chunk_rows)

    async def _insert_embeddings(self, db: AsyncSession, repository_id, chunk_rows) -> int:
        """为 chunk 生成并存入 embedding（provider 未配置时跳过，不阻塞索引）。

        批次**并发**提交（``embedding_concurrency``）并受整体墙钟预算
        （``embedding_build_budget``）约束——避免「94 次串行 HTTP 被 gunicorn
        timeout=30 斩杀」；超预算则取消剩余批次（语义检索退化为关键词，不失败）。

        ``INSERT`` 走 SAVEPOINT，任何写入异常（如维度不匹配）只回滚本段，
        不拖垮同一次构建里的关键词索引。
        """
        if not chunk_rows:
            return 0
        provider = get_embedding_provider()
        if not is_configured(provider):
            return 0
        cfg = get_config().search

        batch_size = cfg.embedding_batch
        batches = [
            chunk_rows[i:i + batch_size]
            for i in range(0, len(chunk_rows), batch_size)
        ]
        semaphore = asyncio.Semaphore(max(1, cfg.embedding_concurrency))

        async def _embed(batch):
            async with semaphore:
                try:
                    vectors = await provider.embed(
                        [str(r.get("content") or "") for r in batch]
                    )
                except Exception as exc:  # noqa: BLE001 — 单批失败不影响其它批
                    logger.warning("embedding 生成失败，跳过该批: %s", exc)
                    return batch, []
                return batch, vectors

        tasks = [asyncio.create_task(_embed(b)) for b in batches]
        done, pending = await asyncio.wait(tasks, timeout=cfg.embedding_build_budget)
        for task in pending:
            task.cancel()
        if pending:
            # 排空被取消的任务，避免 "task was destroyed" 告警
            await asyncio.gather(*pending, return_exceptions=True)
            logger.warning(
                "embedding 超预算（%.0fs）：跳过 %d/%d 批（语义检索降级为关键词）",
                cfg.embedding_build_budget, len(pending), len(batches),
            )

        rows: List[Dict[str, object]] = []
        for task in done:
            try:
                batch, vectors = task.result()
            except Exception:  # noqa: BLE001
                continue
            for row, vec in zip(batch, vectors):
                if not vec:
                    continue
                rows.append({
                    "id": generate_uuid7(),
                    "repository_id": repository_id,
                    "path": row["path"],
                    "chunk_index": row["chunk_index"],
                    "model": provider.model,
                    "dim": len(vec),
                    "vector": vec,  # PgVector 绑定为 pgvector 字面量 '[...]'
                })

        inserted = 0
        try:
            row_batch = _index_row_batch()
            for batch in _batched(rows, row_batch):
                async with db.begin_nested():  # SAVEPOINT：失败只回滚本段
                    await db.execute(insert(RepoSearchEmbedding.__table__), batch)
                inserted += len(batch)
        except Exception as exc:  # noqa: BLE001 — 不影响已写入的关键词索引
            logger.warning("embedding 写入失败，已回滚（关键词索引不受影响）: %s", exc)
        return inserted

    async def update_files(
        self, db: AsyncSession, repository_id, repo_path: str, changed_files: List[str]
    ) -> None:
        """增量更新：仅重切分指定路径（取自默认分支 HEAD），删除/读取/写入均分批。

        与全量 ``rebuild_index`` 共用同一把 per-repo 锁，避免「push 增量」
        与「搜索触发的全量重建」交错导致 chunk 与 ``indexed_commit`` 失同步且
        **永久不自愈**。未抢到锁时直接放弃本次增量（state 不变，下次搜索会重新
        检测陈旧并补齐）。
        """
        if not changed_files:
            return
        local = await _local_rebuild_lock(repository_id)
        if local.locked():
            logger.info("增量索引跳过：仓库 %s 正在重建/更新", repository_id)
            return
        async with local:
            handle = await _acquire_rebuild_lock(repository_id)
            if handle is False:
                logger.info("增量索引跳过：仓库 %s 的全量重建锁被其他 worker 持有", repository_id)
                return
            try:
                await self._do_update_files(db, repository_id, repo_path, changed_files)
            finally:
                await _release_rebuild_lock(handle)

    async def _do_update_files(
        self, db: AsyncSession, repository_id, repo_path: str, changed_files: List[str]
    ) -> None:
        # 与重建共用同一删除语义（按路径清三表）
        await self._delete_paths(db, repository_id, changed_files)
        commit_id: Optional[str] = None
        file_batch = _index_file_batch()
        for batch in _batched(changed_files, file_batch):
            cid, files = await asyncio.to_thread(_extract_changed, repo_path, batch)
            if cid is not None:
                commit_id = cid
            await self._insert_chunks(db, repository_id, files)
        await self._upsert_state(db, repository_id, commit_id)
        await db.flush()

    async def cleanup_index(self, db: AsyncSession, repository_id) -> None:
        """删除某仓库的搜索索引（仓库删除后的生命周期清理）"""
        await db.execute(
            delete(RepoSearchChunk).where(RepoSearchChunk.repository_id == repository_id)
        )
        await db.execute(
            delete(RepoSearchRef).where(RepoSearchRef.repository_id == repository_id)
        )
        await db.execute(
            delete(RepoSearchEmbedding).where(RepoSearchEmbedding.repository_id == repository_id)
        )
        await db.execute(
            delete(RepoSearchState).where(RepoSearchState.repository_id == repository_id)
        )
        await db.flush()

    # ---- 符号/引用图（find-definition / find-usages）----

    async def find_definition(
        self,
        db: AsyncSession,
        repository_id,
        name: str,
        max_results: int = 20,
        path: Optional[str] = None,
        exclude_tests: bool = False,
        repo_path: Optional[str] = None,
        ref: Optional[str] = None,
    ) -> SymbolLookup[SymbolHit]:
        """按精确符号名查找定义。

        块级索引只覆盖**默认分支 HEAD**。传入非默认 ``ref`` 时改为按该 ref
        现场扫描 Git tree，并在返回值中以 ``source`` / ``partial`` 标明来源与完整性
        ——修复前这里完全忽略 ref，会把默认分支的定义当作该分支的答案返回。
        """
        if not name or not name.strip():
            return SymbolLookup()
        # 显式传参受 ``search.max_results`` 硬上限约束（缺省 20 同样夹取）
        max_results = _clamp_results(max_results, default=20)
        if _needs_ref_scan(repo_path, ref):
            return await asyncio.to_thread(
                _scan_definitions_at_ref, repo_path, ref.strip(), name,
                max_results, path, exclude_tests,
            )
        stmt = select(
            RepoSearchChunk.path,
            RepoSearchChunk.symbol,
            RepoSearchChunk.kind,
            RepoSearchChunk.start_line,
            RepoSearchChunk.end_line,
        ).where(
            RepoSearchChunk.repository_id == repository_id,
            RepoSearchChunk.symbol == name,
        )
        prefix = _path_prefix(path)
        if prefix:
            stmt = stmt.where(RepoSearchChunk.path.like(prefix + "%"))
        if exclude_tests:
            stmt = stmt.where(not_(or_(*_test_path_clauses(RepoSearchChunk.path))))
        stmt = stmt.order_by(RepoSearchChunk.path, RepoSearchChunk.start_line).limit(max_results)
        rows = (await db.execute(stmt)).all()
        return SymbolLookup(
            hits=[
                SymbolHit(file=p, symbol=s, kind=k, start_line=a, end_line=b)
                for p, s, k, a, b in rows
            ],
            source="index",
        )

    async def find_usages(
        self,
        db: AsyncSession,
        repository_id,
        name: str,
        max_results: int = 200,
        path: Optional[str] = None,
        exclude_tests: bool = False,
        repo_path: Optional[str] = None,
        ref: Optional[str] = None,
    ) -> SymbolLookup[UsageHit]:
        """按精确标识符名查找引用（来自 refs 表，word 级、非子串）。

        同时 LEFT JOIN 出引用点所在的符号块（symbol/kind/start/end），
        使调用方（Agent）一次调用即可拿到"谁调用 + 所在上下文"，省去二次跳转。
        ``ref`` 语义同 :meth:`find_definition`。
        """
        if not name or not name.strip():
            return SymbolLookup()
        # 显式传参受 ``search.max_results`` 硬上限约束（缺省 200 超上限时夹到上限）
        max_results = _clamp_results(max_results, default=200)
        if _needs_ref_scan(repo_path, ref):
            return await asyncio.to_thread(
                _scan_usages_at_ref, repo_path, ref.strip(), name,
                max_results, path, exclude_tests,
            )
        stmt = (
            select(
                RepoSearchRef.path,
                RepoSearchRef.line,
                RepoSearchChunk.symbol,
                RepoSearchChunk.kind,
                RepoSearchChunk.start_line,
                RepoSearchChunk.end_line,
            )
            .select_from(RepoSearchRef)
            .outerjoin(
                RepoSearchChunk,
                (RepoSearchChunk.repository_id == RepoSearchRef.repository_id)
                & (RepoSearchChunk.path == RepoSearchRef.path)
                & (RepoSearchChunk.start_line <= RepoSearchRef.line)
                & (RepoSearchChunk.end_line >= RepoSearchRef.line),
            )
            .where(
                RepoSearchRef.repository_id == repository_id,
                RepoSearchRef.name == name,
            )
        )
        prefix = _path_prefix(path)
        if prefix:
            stmt = stmt.where(RepoSearchRef.path.like(prefix + "%"))
        if exclude_tests:
            stmt = stmt.where(not_(or_(*_test_path_clauses(RepoSearchRef.path))))
        stmt = stmt.order_by(RepoSearchRef.path, RepoSearchRef.line).limit(max_results)
        rows = (await db.execute(stmt)).all()
        return SymbolLookup(
            hits=[
                UsageHit(file=p, line=l, symbol=s, kind=k, start_line=a, end_line=b)
                for p, l, s, k, a, b in rows
            ],
            source="index",
        )

    @staticmethod
    def diff_changed_files(
        repo_path: str,
        old_ref: Optional[str],
        new_ref: Optional[str],
    ) -> Optional[List[str]]:
        """
        计算两个引用间变更的文件路径列表（用于索引增量更新）

        Returns:
            变更文件路径列表；None 表示无法计算（调用方应回退全量重建）
        """
        if not old_ref or not new_ref:
            return None
        try:
            repo = pygit2.Repository(repo_path)
            old_commit = repo.revparse_single(old_ref).peel(pygit2.Commit)
            new_commit = repo.revparse_single(new_ref).peel(pygit2.Commit)
        except Exception:
            return None
        try:
            diff = repo.diff(old_commit, new_commit)
            changed: List[str] = []
            for patch in diff:
                delta = patch.delta
                if delta.old_file.path:
                    changed.append(delta.old_file.path)
                if delta.new_file.path and delta.new_file.path != delta.old_file.path:
                    changed.append(delta.new_file.path)
            return list(dict.fromkeys(changed))
        except Exception:
            return None

    # ---- 索引状态查询面（可视化 / 手动构建入口） ----

    async def index_status(
        self, db: AsyncSession, repository_id, repo_path: str
    ) -> Dict[str, Any]:
        """单仓索引状态：HEAD 与 state 对齐情况 + 各表行数（只读，不触发构建）。

        ``in_sync`` 要求 **HEAD 对齐且代次足够**（代次不足 = 数据属上一代，
        需重建自愈，与 ``_ensure_index`` 的跳过条件同口径）。
        ``semantic_enabled`` 一并回传，供前端区分 ``embeddings=0`` 是「语义
        未开启」还是「向量未构建」。
        """
        head = await asyncio.to_thread(head_commit, repo_path)
        state = (
            await db.execute(
                select(RepoSearchState).where(
                    RepoSearchState.repository_id == repository_id
                )
            )
        ).scalar_one_or_none()

        async def _count(model) -> int:
            n = (
                await db.execute(
                    select(func.count())
                    .select_from(model)
                    .where(model.repository_id == repository_id)
                )
            ).scalar_one()
            return int(n or 0)

        generation = (state.index_generation if state is not None else None) or 0
        indexed_commit = state.indexed_commit if state is not None else None
        return {
            "head_commit": head,
            "indexed_commit": indexed_commit,
            "index_generation": generation,
            "current_generation": INDEX_GENERATION,
            "in_sync": bool(
                head and indexed_commit == head and generation >= INDEX_GENERATION
            ),
            "chunks": await _count(RepoSearchChunk),
            "refs": await _count(RepoSearchRef),
            "embeddings": await _count(RepoSearchEmbedding),
            "semantic_enabled": bool(get_config().search.embedding_enabled),
            "last_indexed_at": (
                state.updated_at.isoformat()
                if state is not None and state.updated_at is not None
                else None
            ),
        }

    @staticmethod
    async def is_rebuilding(repository_id) -> bool:
        """本进程是否正持有该仓的重建/增量锁（手动构建入口的快速提示）"""
        local = await _local_rebuild_lock(repository_id)
        return local.locked()

    # ---- 内部 ----

    async def _ensure_index(self, db: AsyncSession, repository_id, repo_path: str) -> None:
        """确保索引存在且与默认分支 HEAD 同步（懒构建 / 按 diff 增量）

        「commit 相同」不等于「数据在」：state 行还带代次，代次缺失/不足
        说明数据行属于上一代索引（其数据表可能已被迁移删除），此时必须
        全量重建自愈，否则早退会让搜索永远退回 Git tree 全扫。
        """
        commit_id, _ = await asyncio.to_thread(_extract_all_snapshot, repo_path)
        if commit_id is None:
            return
        row = (
            await db.execute(
                select(RepoSearchState).where(
                    RepoSearchState.repository_id == repository_id
                )
            )
        ).scalar_one_or_none()
        indexed = row.indexed_commit if row else None
        generation = (row.index_generation if row else None) or 0
        if indexed == commit_id and generation >= INDEX_GENERATION:
            return
        if indexed is None or generation < INDEX_GENERATION:
            if indexed is not None:
                logger.warning(
                    "仓库 %s 的索引 state 属上一代索引（commit=%s，代次 %s < %s），"
                    "全量重建自愈",
                    repository_id, indexed, generation, INDEX_GENERATION,
                )
            await self.rebuild_index(db, repository_id, repo_path)
            return
        changed = await asyncio.to_thread(
            SearchService.diff_changed_files, repo_path, indexed, commit_id
        )
        if changed is None:
            await self.rebuild_index(db, repository_id, repo_path)
        else:
            await self.update_files(db, repository_id, repo_path, changed)

    async def _upsert_state(self, db: AsyncSession, repository_id, commit_id: Optional[str]) -> None:
        """记录「当前代索引器已把该 commit 处理完」（含超限跳过的有意空索引）。

        代次与 commit 一起写，二者共同构成跳过重建的条件；只写 commit 会让
        上一代索引的 state 被误认为当前代已完成。
        """
        row = (
            await db.execute(
                select(RepoSearchState).where(
                    RepoSearchState.repository_id == repository_id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            db.add(RepoSearchState(
                repository_id=repository_id,
                indexed_commit=commit_id,
                index_generation=INDEX_GENERATION,
            ))
        else:
            row.indexed_commit = commit_id
            row.index_generation = INDEX_GENERATION

    async def _query_vector(self, provider, query: str) -> Optional[List[float]]:
        """查询向量：命中进程内 LRU 缓存则直接返回，否则现算并写入。

        键为 ``(model, 查询)``，换模型自动失效。容量与 TTL 由
        ``[search] embedding_query_cache_size`` / ``embedding_query_cache_ttl``
        控制，任一为 0 即关闭缓存（回到每次现算）。
        """
        cfg = get_config().search
        cacheable = cfg.embedding_query_cache_size > 0 and cfg.embedding_query_cache_ttl > 0
        key = (provider.model, query)
        if cacheable:
            hit = _QUERY_VECTORS.get(key)
            if hit is not None:
                if time.monotonic() < hit[0]:
                    _QUERY_VECTORS.move_to_end(key)
                    return list(hit[1])
                _QUERY_VECTORS.pop(key, None)

        vectors = await provider.embed([query])
        if not vectors or not vectors[0]:
            return None
        qvec = vectors[0]
        if cacheable:
            _QUERY_VECTORS[key] = (
                time.monotonic() + cfg.embedding_query_cache_ttl, tuple(qvec)
            )
            _QUERY_VECTORS.move_to_end(key)
            while len(_QUERY_VECTORS) > cfg.embedding_query_cache_size:
                _QUERY_VECTORS.popitem(last=False)
        return list(qvec)

    async def _heal_embedding_model(
        self, db: AsyncSession, repository_id, model: str
    ) -> None:
        """切换 embedding 模型后的自愈：清旧行 + 用现有 chunk 重嵌到当前模型。

        语义召回按 ``model`` 过滤，切换 ``[search] embedding_model`` 后旧行永远
        命中不到，语义会**静默**退化为纯关键词，直到某次全量重建才恢复。这里在
        查询前检测「有旧行、无当前模型行」并就地重嵌，把恢复时机从「下一次 push
        触发重建」提前到「切换后的第一次搜索」。

        重嵌受 ``embedding_build_budget`` 约束（超时退化为关键词，不阻塞查询）；
        带进程内冷却，provider 持续失败时不会每次搜索都吃一遍预算。
        """
        now = time.monotonic()
        last = _MODEL_HEAL_ATTEMPTED.get(repository_id)
        cooldown = float(get_config_value("search", "model_heal_cooldown", _MODEL_HEAL_COOLDOWN))
        if last is not None and now - last < cooldown:
            return
        _MODEL_HEAL_ATTEMPTED[repository_id] = now

        has_current = (await db.execute(
            select(RepoSearchEmbedding.id)
            .where(
                RepoSearchEmbedding.repository_id == repository_id,
                RepoSearchEmbedding.model == model,
            )
            .limit(1)
        )).first() is not None
        if has_current:
            _MODEL_HEAL_ATTEMPTED.pop(repository_id, None)  # 已健康：不留冷却记录
            return

        has_stale = (await db.execute(
            select(RepoSearchEmbedding.id)
            .where(
                RepoSearchEmbedding.repository_id == repository_id,
                RepoSearchEmbedding.model != model,
            )
            .limit(1)
        )).first() is not None
        if not has_stale:
            return  # 从未建过 embedding（未开启或首次）：交给常规构建路径

        logger.info(
            "embedding 模型已切换，清理由旧模型行并用现有 chunk 重嵌（model=%s）", model
        )
        await db.execute(
            delete(RepoSearchEmbedding).where(
                RepoSearchEmbedding.repository_id == repository_id,
                RepoSearchEmbedding.model != model,
            )
        )
        rows = (await db.execute(
            select(
                RepoSearchChunk.path,
                RepoSearchChunk.chunk_index,
                RepoSearchChunk.content,
            ).where(RepoSearchChunk.repository_id == repository_id)
        )).all()
        await self._insert_embeddings(
            db, repository_id,
            [{"path": p, "chunk_index": ci, "content": c} for p, ci, c in rows],
        )
        # 重嵌成本高，先落库：同一请求后续出错也不该回滚这次自愈
        await db.commit()

    async def _search_semantic(
        self,
        db: AsyncSession,
        repository_id,
        query: str,
        path: Optional[str],
        max_results: int,
    ) -> List[SearchResult]:
        """向量召回：取 top-k chunk（provider 未配置或失败时返回空）。

        PG + pgvector：SQL 侧 ``<=>`` 近邻（走 HNSW 索引）；
        其它方言（SQLite/dev/test）：应用端余弦。
        """
        provider = get_embedding_provider()
        if not is_configured(provider):
            return []
        # 换 embedding 模型后旧行按旧 model 过滤会永远命中不到：先自愈再查询
        await self._heal_embedding_model(db, repository_id, provider.model)
        try:
            qvec = await self._query_vector(provider, query)
        except Exception as exc:  # noqa: BLE001 — 语义检索失败不阻断关键词检索
            logger.warning("查询 embedding 生成失败: %s", exc)
            return []
        if not qvec:
            return []
        prefix = _path_prefix(path)

        ordered = await self._semantic_pg(
            db, repository_id, provider.model, qvec, prefix, max_results
        )
        if not ordered:
            return []

        conditions = [
            (RepoSearchChunk.path == p) & (RepoSearchChunk.chunk_index == ci)
            for p, ci in ordered
        ]
        chunk_stmt = select(
            RepoSearchChunk.path,
            RepoSearchChunk.content,
            RepoSearchChunk.symbol,
            RepoSearchChunk.kind,
            RepoSearchChunk.chunk_index,
            RepoSearchChunk.start_line,
            RepoSearchChunk.end_line,
        ).where(
            RepoSearchChunk.repository_id == repository_id,
            or_(*conditions),
        )
        chunk_map = {(r[0], r[4]): r for r in (await db.execute(chunk_stmt)).all()}

        results: List[SearchResult] = []
        for path_, ci in ordered:
            row = chunk_map.get((path_, ci))
            if row is None:
                continue
            lines = (row[1] or "").splitlines()
            results.append(SearchResult(
                file=path_,
                line=row[5],
                content=lines[0] if lines else "",
                chunk=ChunkRef(
                    chunk_index=row[4], symbol=row[2], kind=row[3],
                    start_line=row[5], end_line=row[6],
                ),
            ))
        return results

    async def _semantic_pg(
        self, db, repository_id, model, qvec, prefix, max_results
    ) -> List[tuple]:
        """PostgreSQL + pgvector：SQL 侧余弦近邻（走 hnsw 索引），返回 (path, chunk_index)"""
        qlit = "[" + ",".join(repr(float(x)) for x in qvec) + "]"
        sql = (
            "SELECT path, chunk_index FROM repo_search_embeddings "
            "WHERE repository_id = CAST(:rid AS uuid) AND model = :model "
        )
        params = {"rid": str(repository_id), "model": model, "q": qlit, "k": max_results}
        if prefix:
            sql += "AND path LIKE :p "
            params["p"] = prefix + "%"
        sql += "ORDER BY vector <=> CAST(:q AS vector) LIMIT :k"
        rows = (await db.execute(text(sql), params)).all()
        return [(r[0], r[1]) for r in rows]

    async def _search_db(
        self,
        db: AsyncSession,
        repository_id,
        query: str,
        path: Optional[str],
        max_results: int,
    ) -> List[SearchResult]:
        """块级索引检索：命中返回 file:start-end 区间（chunk 元数据附带在结果上）。"""
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        stmt = select(
            RepoSearchChunk.path,
            RepoSearchChunk.content,
            RepoSearchChunk.symbol,
            RepoSearchChunk.kind,
            RepoSearchChunk.chunk_index,
            RepoSearchChunk.start_line,
            RepoSearchChunk.end_line,
        ).where(
            RepoSearchChunk.repository_id == repository_id,
            RepoSearchChunk.content.ilike(pattern, escape="\\"),
        )
        prefix = _path_prefix(path)
        if prefix:
            stmt = stmt.where(RepoSearchChunk.path.like(prefix + "%"))
        # 按命中密度排序后再截断。原先是无 ORDER BY 的 LIMIT，命中数超过
        # scan_file_limit（[search] 配置）时返回**任意**子集且不稳定，调用方（Agent）
        # 会据此得出「不存在」的错误结论。排序表达式 lower+replace+length 在 PostgreSQL
        # 与 SQLite 上均可移植，且不做除法，空查询不会除零；两侧都 lower 以便
        # 大小写不敏感命中同样参与排名。path/chunk_index 作为稳定的次级排序键。
        density = (
            func.length(RepoSearchChunk.content)
            - func.length(func.replace(func.lower(RepoSearchChunk.content), query.lower(), ""))
        )
        stmt = stmt.order_by(
            density.desc(), RepoSearchChunk.path, RepoSearchChunk.chunk_index
        ).limit(scan_file_limit())

        rows = (await db.execute(stmt)).all()
        needle = query.lower()
        results: List[SearchResult] = []
        for row in rows:
            file_path, content, symbol, kind, chunk_index, start_line, end_line = row
            for idx, line in enumerate(content.splitlines(), 1):
                if needle in line.lower():
                    results.append(SearchResult(
                        file=file_path,
                        line=start_line + idx - 1,
                        content=line,
                        chunk=ChunkRef(
                            chunk_index=chunk_index,
                            symbol=symbol,
                            kind=kind,
                            start_line=start_line,
                            end_line=end_line,
                        ),
                    ))
                    if len(results) >= max_results:
                        return results
        return results

