"""重建复用（blob 级复用的零迁移形态）：未变文件跳过重切重嵌。

落地形态为 chunk 内容比对（分块由文件内容确定性推导，无需新增 hash 列）：
- 内容未变 → 整文件跳过：不删不插、不调 embedding（语义向量只为变化文件付费）
- 代次变更（切分算法升级）→ 禁用复用，全部重切重嵌
- 树中已删文件 → 结尾统一剪除（且未变文件零重嵌）
"""
import os
import shutil
import subprocess
import tempfile

import pytest
from sqlalchemy import func, select

from app.models.repo_search import RepoSearchState
from app.models.repo_search_chunk import RepoSearchChunk
from app.models.repo_search_embedding import RepoSearchEmbedding
from app.services.indexing import embeddings as embeddings_mod
from app.services.indexing.vector_type import VECTOR_DIM
from app.services.search_service import INDEX_GENERATION, SearchService


class _CountingEmbedProvider:
    """确定性假 provider：记录被嵌入的文本，供「谁被重新嵌入了」断言"""

    name = "fake"

    def __init__(self, model: str = "fake-embed") -> None:
        self.model = model
        self.calls = 0
        self.texts: list[str] = []

    async def embed(self, texts):
        self.calls += 1
        self.texts.extend(texts)
        return [[0.01] * VECTOR_DIM for _ in texts]


@pytest.fixture(autouse=True)
def _reset_embed_provider():
    yield
    embeddings_mod.reset_embedding_provider()


def _git(*args, cwd=None):
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
    )


def _make_bare_repo(files: dict):
    """创建带提交的 bare 仓库（模拟 Kustos 存储形态），返回 (tmpdir, bare, work)"""
    tmp = tempfile.mkdtemp()
    work = os.path.join(tmp, "work")
    _git("init", "--initial-branch=main", work)
    _git("config", "user.email", "t@example.com", cwd=work)
    _git("config", "user.name", "T", cwd=work)
    for name, content in files.items():
        full = os.path.join(work, name)
        os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)
    _git("add", "-A", cwd=work)
    _git("commit", "-m", "init", cwd=work)
    bare = os.path.join(tmp, "repo.git")
    _git("clone", "--bare", work, bare)
    _git("remote", "add", "origin", bare, cwd=work)
    return tmp, bare, work


def _commit_all(work):
    _git("add", "-A", cwd=work)
    _git("commit", "-m", "change", cwd=work)
    _git("push", "origin", "main", cwd=work)


async def _count(db, model, repository_id) -> int:
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(model)
                .where(model.repository_id == repository_id)
            )
        ).scalar_one()
    )


@pytest.mark.asyncio
async def test_rebuild_skips_unchanged_files(async_db, async_test_repo):
    """二次重建（内容未变）：零 embed 调用、行数不变（向量原样保留）"""
    tmp, bare, work = _make_bare_repo(
        {
            "a.py": "def alpha():\n    return 'UNIQUE_A'\n",
            "b.py": "def beta():\n    return 'UNIQUE_B'\n",
        }
    )
    fake = _CountingEmbedProvider()
    embeddings_mod.set_embedding_provider(fake)
    try:
        svc = SearchService()
        assert await svc.rebuild_index(async_db, async_test_repo.id, bare) == 2
        assert fake.calls > 0  # 首建已嵌入
        chunks_before = await _count(async_db, RepoSearchChunk, async_test_repo.id)
        embs_before = await _count(async_db, RepoSearchEmbedding, async_test_repo.id)
        assert embs_before > 0
        calls_before = fake.calls

        assert await svc.rebuild_index(async_db, async_test_repo.id, bare) == 2
        assert fake.calls == calls_before  # 未变文件零重嵌
        assert await _count(async_db, RepoSearchChunk, async_test_repo.id) == chunks_before
        assert (
            await _count(async_db, RepoSearchEmbedding, async_test_repo.id)
            == embs_before
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_rebuild_embeds_only_changed_file(async_db, async_test_repo):
    """只改一个文件：重建只为它重新嵌入，未变文件的 chunk 不进 embed 批次"""
    tmp, bare, work = _make_bare_repo(
        {
            "changed.py": "def c():\n    return 'OLD_C'\n",
            "stable.py": "def s():\n    return 'STABLE_S'\n",
        }
    )
    fake = _CountingEmbedProvider()
    embeddings_mod.set_embedding_provider(fake)
    try:
        svc = SearchService()
        await svc.rebuild_index(async_db, async_test_repo.id, bare)
        with open(os.path.join(work, "changed.py"), "w", encoding="utf-8") as f:
            f.write("def c():\n    return 'NEW_C_MARKER'\n")
        _commit_all(work)

        fake.texts.clear()
        await svc.rebuild_index(async_db, async_test_repo.id, bare)
        assert fake.calls > 0
        joined = "\n".join(fake.texts)
        assert "NEW_C_MARKER" in joined          # 变化文件被重嵌
        assert "STABLE_S" not in joined          # 未变文件不重嵌
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_generation_change_forces_full_reembed(async_db, async_test_repo):
    """代次变更（切分算法升级语义）：复用必须关闭，全部重切重嵌"""
    tmp, bare, work = _make_bare_repo(
        {
            "a.py": "def a():\n    return 'GA'\n",
            "b.py": "def b():\n    return 'GB'\n",
        }
    )
    fake = _CountingEmbedProvider()
    embeddings_mod.set_embedding_provider(fake)
    try:
        svc = SearchService()
        await svc.rebuild_index(async_db, async_test_repo.id, bare)
        calls_before = fake.calls

        state = (
            await async_db.execute(
                select(RepoSearchState).where(
                    RepoSearchState.repository_id == async_test_repo.id
                )
            )
        ).scalar_one()
        state.index_generation = 0  # 伪造成上一代
        await async_db.commit()

        fake.texts.clear()
        await svc.rebuild_index(async_db, async_test_repo.id, bare)
        assert fake.calls > calls_before  # 复用被禁用 → 重新嵌入
        joined = "\n".join(fake.texts)
        assert "GA" in joined and "GB" in joined  # 两个文件都重做
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_rebuild_prunes_deleted_files_without_reembed(async_db, async_test_repo):
    """树里删掉的文件：残余行被剪除；存活文件零重嵌"""
    tmp, bare, work = _make_bare_repo(
        {
            "keep.py": "def k():\n    return 'KEEP_MARK'\n",
            "gone.py": "def g():\n    return 'GONE_MARK'\n",
        }
    )
    fake = _CountingEmbedProvider()
    embeddings_mod.set_embedding_provider(fake)
    try:
        svc = SearchService()
        await svc.rebuild_index(async_db, async_test_repo.id, bare)
        calls_before = fake.calls

        os.remove(os.path.join(work, "gone.py"))
        _commit_all(work)

        fake.texts.clear()
        await svc.rebuild_index(async_db, async_test_repo.id, bare)
        # 已删文件的行被剪除
        gone_chunks = (
            await async_db.execute(
                select(func.count())
                .select_from(RepoSearchChunk)
                .where(
                    RepoSearchChunk.repository_id == async_test_repo.id,
                    RepoSearchChunk.path == "gone.py",
                )
            )
        ).scalar_one()
        assert int(gone_chunks) == 0
        # 存活文件复用：没有任何重新嵌入
        assert fake.calls == calls_before
        assert await _count(async_db, RepoSearchChunk, async_test_repo.id) > 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
