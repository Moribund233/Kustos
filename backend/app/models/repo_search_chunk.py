"""代码块级搜索索引数据模型（块级索引）

将文件按声明节点切分为符号级 chunk `(path, symbol, start_line, end_line)`，
索引只存 chunk 而非整文件，Agent 检索到 `file:12-34` 即可按区间取内容，
避免「定位一行、读整个文件」的整文件 token 浪费。
"""
from sqlalchemy import Index, Integer, String, Text, ForeignKey, UniqueConstraint, Uuid as SAUuid
from sqlalchemy.orm import mapped_column

from app.models.base import TimestampMixin


class RepoSearchChunk(TimestampMixin):
    """仓库内单个代码块的搜索索引条目（每块一行）"""
    __tablename__ = "repo_search_chunks"

    repository_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("repositories.id"), nullable=False, index=True
    )
    path = mapped_column(String(1024), nullable=False)
    chunk_index = mapped_column(Integer, nullable=False)
    symbol = mapped_column(String(256), nullable=True)
    kind = mapped_column(String(32), nullable=True)
    start_line = mapped_column(Integer, nullable=False)
    end_line = mapped_column(Integer, nullable=False)
    content = mapped_column(Text, nullable=False)
    size = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        UniqueConstraint(
            "repository_id", "path", "chunk_index", name="uq_repo_search_chunk"
        ),
        # find-definition 恒按 (repository_id, symbol) 过滤，缺该索引时每次
        # 都要扫全仓 chunk（本仓 5964 行），随 chunk 数线性劣化。
        Index("ix_repo_search_chunks_repo_symbol", "repository_id", "symbol"),
    )
