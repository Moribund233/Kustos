"""代码搜索索引数据模型

搜索内容来自 Git 对象（pygit2 读取 ref 的 tree/blob），持久化到主库
（PostgreSQL 为核心设施）。块级索引每符号块一行；PostgreSQL 侧由迁移创建
`pg_trgm` GIN 索引以加速 `ILIKE '%q%'` 子串检索。
"""
from sqlalchemy import Integer, String, ForeignKey, Uuid as SAUuid
from sqlalchemy.orm import mapped_column

from app.models.base import BaseModel


class RepoSearchState(BaseModel):
    """仓库搜索索引状态：记录已索引的提交，用于增量维护与陈旧检测"""
    __tablename__ = "repo_search_state"

    repository_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("repositories.id"), nullable=False, unique=True
    )
    indexed_commit = mapped_column(String(40), nullable=True)
    # 由哪一代索引器写入（services.search_service.INDEX_GENERATION）：
    # NULL = 旧代残留/从未构建，当前索引器据此触发全量重建自愈。
    index_generation = mapped_column(Integer, nullable=True)
