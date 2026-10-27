"""索引债务测试：异常边界 / embedding 串行与预算 / 增量锁"""
import asyncio
import shutil

import pytest
from sqlalchemy import delete, func, select

from app.models.repo_search import RepoSearchState
from app.models.repo_search_chunk import RepoSearchChunk
from app.models.repo_search_embedding import RepoSearchEmbedding
from app.services.indexing import embeddings
from app.services.search_service import SearchService
from tests.test_search_service import _git, _make_bare_repo


class _FakeEmbedProvider:
    name = "fake"
    model = "fake-embed"
    dim = 1536  # PG vector(1536)

    async def embed(self, texts):
        return [[1.0] + [0.0] * 1535 for _ in texts]


class _ConcurrencyProbe:
    """记录并发度的 embedding provider（配合 asyncio.sleep 暴露串行/并行）"""

    name = "probe"
    model = "probe"
    dim = 1536  # PG vector(1536)

    def __init__(self, delay=0.05):
        self.delay = delay
        self.active = 0
        self.max_active = 0

    async def embed(self, texts):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(self.delay)
        finally:
            self.active -= 1
        return [[1.0] + [0.0] * 1535 for _ in texts]


async def _indexed_commit(db, repo_id):
    return (
        await db.execute(
            select(RepoSearchState.indexed_commit).where(
                RepoSearchState.repository_id == repo_id
            )
        )
    ).scalar_one()


@pytest.fixture
def search_service():
    return SearchService()


@pytest.mark.asyncio
async def test_embedding_insert_failure_keeps_keyword_index(
    async_db, async_test_repo, search_service, monkeypatch
):
    """embedding 写入异常（如维度不匹配）只回滚该段，关键词索引照常可用"""
    import app.services.search_service as ss

    real_insert = ss.insert

    def flaky_insert(table, *args, **kwargs):
        if getattr(table, "name", "") == "repo_search_embeddings":
            raise RuntimeError("embedding dim mismatch")
        return real_insert(table, *args, **kwargs)

    monkeypatch.setattr(ss, "insert", flaky_insert)
    embeddings.set_embedding_provider(_FakeEmbedProvider())
    tmp, bare, _ = _make_bare_repo({"a.py": "def alpha():\n    pass\n"})
    try:
        count = await search_service.rebuild_index(async_db, async_test_repo.id, bare)
        assert count == 1  # 构建本身未被 embedding 写入失败拖垮

        emb = (
            await async_db.execute(
                select(func.count()).select_from(RepoSearchEmbedding).where(
                    RepoSearchEmbedding.repository_id == async_test_repo.id
                )
            )
        ).scalar_one()
        assert emb == 0

        # 关键词索引仍然命中（未退化且可复现）
        res = await search_service.search_code(async_db, async_test_repo.id, bare, "alpha")
        assert res.total_count > 0
        assert res.results[0].file == "a.py"
        # 第二次构建不应因上次失败而永久失败
        assert await search_service.rebuild_index(async_db, async_test_repo.id, bare) == 1
    finally:
        embeddings.reset_embedding_provider()
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_embedding_batches_run_concurrently(
    async_db, async_test_repo, search_service, monkeypatch
):
    """embedding 批次并发提交（非 94 次串行）"""
    from app.core.config import get_config

    monkeypatch.setattr(get_config().search, "embedding_batch", 1, raising=False)
    monkeypatch.setattr(get_config().search, "embedding_concurrency", 4, raising=False)
    monkeypatch.setattr(get_config().search, "embedding_build_budget", 5.0, raising=False)

    probe = _ConcurrencyProbe(delay=0.05)
    embeddings.set_embedding_provider(probe)
    files = {f"f{i}.py": f"def fn{i}():\n    pass\n" for i in range(6)}
    tmp, bare, _ = _make_bare_repo(files)
    try:
        await search_service.rebuild_index(async_db, async_test_repo.id, bare)
        assert probe.max_active >= 2, f"期望并发执行，实际峰值 {probe.max_active}"
    finally:
        embeddings.reset_embedding_provider()
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_embedding_budget_aborts_without_failing_build(
    async_db, async_test_repo, search_service, monkeypatch
):
    """超过墙钟预算的 embedding 被取消，索引构建仍成功（语义降级为关键词）"""
    from app.core.config import get_config

    monkeypatch.setattr(get_config().search, "embedding_batch", 1, raising=False)
    monkeypatch.setattr(get_config().search, "embedding_concurrency", 1, raising=False)
    monkeypatch.setattr(get_config().search, "embedding_build_budget", 0.05, raising=False)

    slow = _ConcurrencyProbe(delay=0.3)
    embeddings.set_embedding_provider(slow)
    tmp, bare, _ = _make_bare_repo({"a.py": "def a():\n", "b.py": "def b():\n", "c.py": "def c():\n"})
    try:
        count = await search_service.rebuild_index(async_db, async_test_repo.id, bare)
        assert count == 3  # chunk 照常入库
        res = await search_service.search_code(async_db, async_test_repo.id, bare, "def")
        assert res.total_count > 0  # 关键词检索不受 embedding 超预算影响
    finally:
        embeddings.reset_embedding_provider()
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_update_files_skips_while_rebuild_lock_held(
    async_db, async_test_repo, search_service
):
    """增量更新与全量重建共用锁；锁被占用时放弃增量（state 不变，可自愈）"""
    from app.services.search_service import _local_rebuild_lock

    tmp, bare, work = _make_bare_repo({"src/change.py": "def old():\n"})
    try:
        await search_service.rebuild_index(async_db, async_test_repo.id, bare)
        old_commit = await _indexed_commit(async_db, async_test_repo.id)

        with open(f"{work}/src/change.py", "w", encoding="utf-8") as f:
            f.write("def changed():\n")
        _git("add", "-A", cwd=work)
        _git("commit", "-m", "change", cwd=work)
        _git("push", "origin", "main", cwd=work)

        lock = await _local_rebuild_lock(async_test_repo.id)
        async with lock:
            await search_service.update_files(
                async_db, async_test_repo.id, bare, ["src/change.py"]
            )
        assert await _indexed_commit(async_db, async_test_repo.id) == old_commit  # 跳过

        # 释放锁后增量可正常执行
        await search_service.update_files(
            async_db, async_test_repo.id, bare, ["src/change.py"]
        )
        assert await _indexed_commit(async_db, async_test_repo.id) != old_commit
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def _chunk_count(db, repo_id):
    return (
        await db.execute(
            select(func.count()).select_from(RepoSearchChunk).where(
                RepoSearchChunk.repository_id == repo_id
            )
        )
    ).scalar_one()


@pytest.mark.asyncio
async def test_stale_generation_state_triggers_full_rebuild(
    async_db, async_test_repo, search_service
):
    """上一代索引留下的 state（代次缺失）不阻塞当前代索引：首次搜索即自愈重建"""
    tmp, bare, _ = _make_bare_repo({"a.py": "def alpha():\n    pass\n"})
    try:
        await search_service.rebuild_index(async_db, async_test_repo.id, bare)
        head = await _indexed_commit(async_db, async_test_repo.id)

        # 模拟上一代数据表被迁移删除后的孤儿 state：commit 已同步、代次缺失
        await async_db.execute(
            delete(RepoSearchChunk).where(
                RepoSearchChunk.repository_id == async_test_repo.id
            )
        )
        row = (
            await async_db.execute(
                select(RepoSearchState).where(
                    RepoSearchState.repository_id == async_test_repo.id
                )
            )
        ).scalar_one()
        row.index_generation = None
        await async_db.commit()
        assert await _chunk_count(async_db, async_test_repo.id) == 0

        res = await search_service.search_code(async_db, async_test_repo.id, bare, "alpha")

        assert await _chunk_count(async_db, async_test_repo.id) > 0  # 自愈重建
        assert res.results and res.results[0].chunk is not None  # 来自索引而非 Git tree 兜底
        assert await _indexed_commit(async_db, async_test_repo.id) == head
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_current_generation_empty_index_is_not_rebuilt(
    async_db, async_test_repo, search_service
):
    """当前代已处理过该 commit 的空索引（如超限跳过）不会每次搜索都重建"""
    tmp, bare, _ = _make_bare_repo({"a.py": "def alpha():\n    pass\n"})
    try:
        await search_service.rebuild_index(async_db, async_test_repo.id, bare)
        state_before = (
            await async_db.execute(
                select(RepoSearchState).where(
                    RepoSearchState.repository_id == async_test_repo.id
                )
            )
        ).scalar_one()

        # 代次齐全但数据行为空：视为「有意的空索引」（不重试语义），重建会重新填满
        await async_db.execute(
            delete(RepoSearchChunk).where(
                RepoSearchChunk.repository_id == async_test_repo.id
            )
        )
        await async_db.commit()

        await search_service.search_code(async_db, async_test_repo.id, bare, "alpha")

        assert await _chunk_count(async_db, async_test_repo.id) == 0  # 未重建
        row = (
            await async_db.execute(
                select(RepoSearchState).where(
                    RepoSearchState.repository_id == async_test_repo.id
                )
            )
        ).scalar_one()
        assert row.index_generation == state_before.index_generation
        assert row.indexed_commit == state_before.indexed_commit
    finally:
        shutil.rmtree(tmp, ignore_errors=True)