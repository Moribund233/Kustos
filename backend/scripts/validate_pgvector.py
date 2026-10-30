"""pgvector 真实验证脚本。

在带 pgvector 的 PostgreSQL 上端到端验证：
1. vector 扩展已安装；repo_search_embeddings.vector 列类型为 vector；HNSW 索引存在；
2. 用注入的假 embedding provider 建索引 → 向量行落库（dim=1536）；
3. search_code(semantic=True) 对无字面命中的语义 query 走 pgvector `<=>` 召回正确块。

运行（app 容器内，自带 DATABASE_URL，指向 deployment 库；脚本自带假 provider，
无需 API key，结束时清理自建的临时用户/仓库）：
    docker exec -e PYTHONPATH=/app kustos-app python /app/scripts/validate_pgvector.py
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from sqlalchemy import delete, select, text

# 直接执行本脚本时 sys.path[0] 是脚本目录，补上项目根才能 import models/services
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

DIM = 1536


class FakeEmbeddingProvider:
    name = "fake"
    model = "fake-vec"
    dim = DIM

    async def embed(self, texts):
        out = []
        for t in texts:
            vec = [0.0] * DIM
            low = t.lower()
            if any(k in low for k in ("auth", "login", "credential")):
                vec[0] = 1.0
            elif any(k in low for k in ("add", "number", "math", "sum")):
                vec[1] = 1.0
            else:
                vec[0] = 0.5
                vec[1] = 0.5
            out.append(vec)
        return out


def _make_bare_repo(files):
    tmp = tempfile.mkdtemp()
    work = os.path.join(tmp, "work")
    subprocess.run(["git", "init", "-q", "--initial-branch=main", work], check=True)
    subprocess.run(["git", "config", "user.email", "v@x.local"], cwd=work, check=True)
    subprocess.run(["git", "config", "user.name", "V"], cwd=work, check=True)
    for name, content in files.items():
        full = os.path.join(work, name)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)
    subprocess.run(["git", "add", "-A"], cwd=work, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=work, check=True)
    bare = os.path.join(tmp, "repo.git")
    subprocess.run(["git", "clone", "-q", "--bare", work, bare], check=True)
    return tmp, bare


async def main() -> None:
    from app.models.async_db import get_async_db_context
    from app.models.repository import Repository
    from app.models.repo_search import RepoSearchState
    from app.models.repo_search_chunk import RepoSearchChunk
    from app.models.repo_search_embedding import RepoSearchEmbedding
    from app.models.repo_search_ref import RepoSearchRef
    from app.models.user import User
    from app.services.indexing import embeddings
    from app.services.search.search_service import SearchService

    async with get_async_db_context() as db:
        ext = (await db.execute(text(
            "SELECT extname FROM pg_extension WHERE extname = 'vector'"
        ))).first()
        col = (await db.execute(text(
            "SELECT data_type, udt_name FROM information_schema.columns "
            "WHERE table_name = 'repo_search_embeddings' AND column_name = 'vector'"
        ))).first()
        idx = (await db.execute(text(
            "SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_repo_search_embeddings_hnsw'"
        ))).first()
        print(f"[pg] extension={ext}  column={col}  hnsw={idx}")
        assert ext is not None, "pgvector 扩展未安装"
        assert col is not None and col[1] == "vector", f"列类型不是 vector: {col}"
        assert idx is not None, "HNSW 索引缺失"

        suffix = uuid.uuid4().hex[:8]
        user = User(username=f"vec_{suffix}", email=f"vec_{suffix}@x.local", password="x")
        db.add(user)
        await db.commit()
        await db.refresh(user)
        repo = Repository(
            name=f"vec-{suffix}", path=f"{user.username}/vec-{suffix}",
            owner_id=user.id, is_public=True, description="pgvector validation",
        )
        db.add(repo)
        await db.commit()
        await db.refresh(repo)

        files = {
            "auth.py": "def authenticate_user():\n    return check_credentials()\n",
            "math.py": "def add_numbers(a, b):\n    return a + b\n",
        }
        tmp, bare = _make_bare_repo(files)
        embeddings.set_embedding_provider(FakeEmbeddingProvider())
        ok = False
        try:
            service = SearchService()
            await service.rebuild_index(db, repo.id, bare)
            embs = (await db.execute(
                select(RepoSearchEmbedding).where(RepoSearchEmbedding.repository_id == repo.id)
            )).scalars().all()
            print(f"[index] embedding rows={len(embs)}  dim={embs[0].dim if embs else None}")
            assert embs and embs[0].dim == DIM

            # 直接验证 pgvector 运算符 + 近邻排序
            qlit = "[" + ",".join(["1"] + ["0"] * (DIM - 1)) + "]"
            near = (await db.execute(text(
                "SELECT path, chunk_index FROM repo_search_embeddings "
                "WHERE repository_id = CAST(:rid AS uuid) "
                "ORDER BY vector <=> CAST(:q AS vector) LIMIT 3"
            ), {"rid": str(repo.id), "q": qlit})).all()
            print(f"[pgvector] <=> nearest = {near}")

            res = await service.search_code(db, repo.id, bare, "login flow", semantic=True)
            top = [(r.file, r.chunk.symbol if r.chunk else None, r.line) for r in res.results[:3]]
            print(f"[search] semantic top = {top}")
            assert res.results and res.results[0].file == "auth.py", "语义召回未命中 auth.py"
            ok = True
        finally:
            embeddings.reset_embedding_provider()
            for model in (RepoSearchEmbedding, RepoSearchChunk, RepoSearchRef, RepoSearchState):
                await db.execute(delete(model).where(model.repository_id == repo.id))
            await db.commit()
            await db.delete(repo)
            await db.commit()
            await db.delete(user)
            await db.commit()
            shutil.rmtree(tmp, ignore_errors=True)

    print("\nPGVECTOR VALIDATION OK" if ok else "\nVALIDATION FAILED")


if __name__ == "__main__":
    asyncio.run(main())