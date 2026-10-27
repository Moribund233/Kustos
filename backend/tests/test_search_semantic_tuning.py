"""语义检索调优：查询向量缓存 / 候选顺序确定性 / 切换 embedding 模型自愈"""
import shutil

import pytest

import app.services.search_service as ss
from app.core.config import get_config
from app.models.repo_search_chunk import RepoSearchChunk
from app.models.repo_search_embedding import RepoSearchEmbedding
from app.services.indexing import embeddings
from app.services.search_service import SearchService
from tests.test_search_service import _make_bare_repo


class _CountingProvider:
    """伪 embedding provider：记录调用次数（用于区分「现算」与「命中缓存」）"""

    name = "fake"
    dim = 1536  # PG vector(1536)

    def __init__(self, model: str = "fake-embed"):
        self.model = model
        self.calls = 0

    async def embed(self, texts):
        self.calls += 1
        return [[1.0] + [0.0] * 1535 for _ in texts]


@pytest.fixture
def search_service():
    return SearchService()


@pytest.fixture(autouse=True)
def _clean_module_state():
    """模块级缓存/冷却表跨用例残留会污染断言，进出各清一次"""
    ss._QUERY_VECTORS.clear()
    ss._MODEL_HEAL_ATTEMPTED.clear()
    yield
    ss._QUERY_VECTORS.clear()
    ss._MODEL_HEAL_ATTEMPTED.clear()


async def _models(db, repo_id) -> set:
    """该仓库现存 embedding 行的 model 集合"""
    rows = (await db.execute(
        RepoSearchEmbedding.__table__.select().with_only_columns(
            RepoSearchEmbedding.model
        ).where(RepoSearchEmbedding.repository_id == repo_id)
    )).all()
    return {r[0] for r in rows}


async def _count_embeddings(db, repo_id) -> int:
    from sqlalchemy import func, select

    return int((await db.execute(
        select(func.count()).select_from(RepoSearchEmbedding).where(
            RepoSearchEmbedding.repository_id == repo_id
        )
    )).scalar_one())


@pytest.mark.asyncio
async def test_query_embedding_is_cached_within_ttl(
    async_db, async_test_repo, search_service, monkeypatch
):
    """同一条查询在 TTL 内只打一次 embedding API；关掉缓存即回到现算"""
    monkeypatch.setattr(
        get_config().search, "embedding_query_cache_size", 8, raising=False
    )
    monkeypatch.setattr(
        get_config().search, "embedding_query_cache_ttl", 600.0, raising=False
    )
    provider = _CountingProvider()
    embeddings.set_embedding_provider(provider)
    tmp, bare, _ = _make_bare_repo({"a.py": "def alpha():\n    pass\n"})
    try:
        await search_service.rebuild_index(async_db, async_test_repo.id, bare)
        provider.calls = 0  # 只统计查询侧（重建阶段的 chunk embedding 不计）

        for _ in range(3):
            await search_service.search_code(
                async_db, async_test_repo.id, bare, "alpha", semantic=True
            )
        assert provider.calls == 1, "同一查询三次搜索应只现算一次"

        await search_service.search_code(
            async_db, async_test_repo.id, bare, "另一个查询", semantic=True
        )
        assert provider.calls == 2, "不同查询应各现算一次"

        monkeypatch.setattr(
            get_config().search, "embedding_query_cache_size", 0, raising=False
        )
        await search_service.search_code(
            async_db, async_test_repo.id, bare, "alpha", semantic=True
        )
        assert provider.calls == 3, "容量 0 = 关闭缓存，回到每次现算"
    finally:
        embeddings.reset_embedding_provider()
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_semantic_candidates_are_deterministically_ordered(
    async_db, async_test_repo, search_service, monkeypatch
):
    """近邻检索必须带 ORDER BY：无排序时 LIMIT 取的是「任意 N 条」，
    同一条查询在不同执行计划下会挑出不同候选，无法对照复现"""
    provider = _CountingProvider()
    embeddings.set_embedding_provider(provider)
    tmp, bare, _ = _make_bare_repo({"a.py": "def alpha():\n    pass\n"})
    try:
        await search_service.rebuild_index(async_db, async_test_repo.id, bare)

        captured = {}
        original = async_db.execute

        async def _spy(stmt, *args, **kwargs):
            text_stmt = str(stmt)
            if "repo_search_embeddings" in text_stmt:
                captured.setdefault("sql", text_stmt)
            return await original(stmt, *args, **kwargs)

        monkeypatch.setattr(async_db, "execute", _spy)
        await search_service._semantic_pg(
            async_db, async_test_repo.id, "fake-embed", [1.0] * 1536, None, 10
        )

        sql = captured.get("sql", "")
        assert "ORDER BY" in sql, f"近邻检索缺少确定性排序: {sql}"
        assert "LIMIT" in sql, f"近邻检索必须限量返回: {sql}"
    finally:
        embeddings.reset_embedding_provider()
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_model_switch_reembeds_on_next_search(
    async_db, async_test_repo, search_service
):
    """切换 embedding 模型后语义按 model 过滤会命中不到：下次搜索应就地自愈
    （清旧行 + 用现有 chunk 重嵌），而不是静默退化成纯关键词直到全量重建"""
    embeddings.set_embedding_provider(_CountingProvider(model="old-embed"))
    tmp, bare, _ = _make_bare_repo({"a.py": "def alpha():\n    pass\n"})
    try:
        await search_service.rebuild_index(async_db, async_test_repo.id, bare)
        assert await _models(async_db, async_test_repo.id) == {"old-embed"}

        embeddings.set_embedding_provider(_CountingProvider(model="new-embed"))
        await search_service.search_code(
            async_db, async_test_repo.id, bare, "alpha", semantic=True
        )

        assert await _models(async_db, async_test_repo.id) == {"new-embed"}
        assert await _count_embeddings(async_db, async_test_repo.id) > 0, \
            "自愈后应有当前模型的向量行"
    finally:
        embeddings.reset_embedding_provider()
        shutil.rmtree(tmp, ignore_errors=True)
