"""代码引用索引数据模型（符号/引用图）

将源码中的标识符引用落为边 `(path, name, line)`；配合 chunk 表里符号的定义位置，
即可提供低成本的 find-definition / find-usages（无需类型推断、无外部依赖）。
"""
from sqlalchemy import Index, Integer, String, ForeignKey, UniqueConstraint, Uuid as SAUuid
from sqlalchemy.orm import mapped_column

from app.models.base import BaseModel


class RepoSearchRef(BaseModel):
    """仓库内单个标识符引用（每 (文件, 名字, 行) 一行）"""
    __tablename__ = "repo_search_refs"

    repository_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("repositories.id"), nullable=False, index=True
    )
    path = mapped_column(String(1024), nullable=False)
    name = mapped_column(String(256), nullable=False)
    line = mapped_column(Integer, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "repository_id", "path", "name", "line", name="uq_repo_search_ref"
        ),
        Index("ix_repo_search_refs_repo_name", "repository_id", "name"),
    )
