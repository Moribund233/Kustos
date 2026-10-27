"""变更图索引：每个提交的改动文件与行区间（``repo_commit_files``）。

复刻块级索引的成功路径（``repo_search_chunk`` + ``repo_search_state``）——把
「某提交改了哪些文件、改在哪些行」前置到库端，供复合审查工具（如
``review_recent_changes`` / ``who_changed``）一次查询拿到，避免
``log → diff → read×N`` 的多轮往返。
"""
from sqlalchemy import ForeignKey, Index, Integer, String, Text, Uuid as SAUuid
from sqlalchemy.orm import mapped_column

from app.models.base import BaseModel


class RepoCommitFile(BaseModel):
    """单提交 × 单文件的改动记录"""
    __tablename__ = "repo_commit_files"

    repository_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("repositories.id"), nullable=False, index=True
    )
    commit_sha = mapped_column(String(40), nullable=False)
    path = mapped_column(String(1024), nullable=False)
    #: git 状态字符：A/M/D/R/C…
    status = mapped_column(String(8), nullable=False)
    additions = mapped_column(Integer, nullable=False, default=0)
    deletions = mapped_column(Integer, nullable=False, default=0)
    #: 新侧改动行区间 JSON：``[[start, end], ...]``（删除的文件为空）
    changed_ranges = mapped_column(Text, nullable=True)

    __table_args__ = (
        Index("ix_repo_commit_files_repo_commit", "repository_id", "commit_sha"),
        Index("ix_repo_commit_files_repo_path", "repository_id", "path"),
    )


class RepoCommitIndexState(BaseModel):
    """仓库变更图索引状态：记录已索引提交与数据代次（自愈依据）"""
    __tablename__ = "repo_commit_index_state"

    repository_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("repositories.id"), nullable=False, unique=True
    )
    indexed_commit = mapped_column(String(40), nullable=True)
    #: 与 ``services.commit_index_service.COMMIT_INDEX_GENERATION`` 对应；
    #: NULL/偏低 = 上一代残留，需全量重建（同 repo_search_state 的自愈语义）
    index_generation = mapped_column(Integer, nullable=True)
