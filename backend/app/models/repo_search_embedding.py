"""代码块向量索引（语义检索）。

每个 chunk 一条向量记录，`(repository_id, path, chunk_index, model)` 唯一。
向量列是 pgvector 的 ``vector(1536)``，近邻检索（``<=>``）在库内完成。
"""
from sqlalchemy import (
    Integer, String, ForeignKey, UniqueConstraint, Uuid as SAUuid,
)
from sqlalchemy.orm import mapped_column

from app.models.base import BaseModel
from app.models.vector_type import VECTOR_DIM, PgVector


class RepoSearchEmbedding(BaseModel):
    """仓库内单个代码块的 embedding"""
    __tablename__ = "repo_search_embeddings"

    repository_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("repositories.id"), nullable=False, index=True
    )
    path = mapped_column(String(1024), nullable=False)
    chunk_index = mapped_column(Integer, nullable=False)
    model = mapped_column(String(128), nullable=False)
    dim = mapped_column(Integer, nullable=False, default=0)
    vector = mapped_column(PgVector(VECTOR_DIM), nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "repository_id", "path", "chunk_index", "model", name="uq_repo_search_embedding"
        ),
    )
