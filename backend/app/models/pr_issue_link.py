"""Pull Request 与 Issue 的关联模型

一个 PR 可以关联多个 Issue（"Fixes #12" 这类语义），一个 Issue 也可以被多个 PR
关联（分阶段修复）。关联只允许发生在同一仓库内，由服务层校验。

``closes_on_merge`` 表示合并该 PR 时是否自动关闭对应 Issue；手动关联默认关闭，
从描述里的 ``fixes/closes/resolves`` 关键字推导出的关联同样为 True。
"""
from sqlalchemy import Boolean, ForeignKey, UniqueConstraint, Uuid as SAUuid
from sqlalchemy.orm import relationship, mapped_column

from app.models.base import BaseModel


class PullRequestIssueLink(BaseModel):
    """PR ↔ Issue 关联边"""

    __tablename__ = "pull_request_issue_links"
    __table_args__ = (
        UniqueConstraint("pull_request_id", "issue_id", name="uq_pr_issue_link"),
    )

    pull_request_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("pull_requests.id"), nullable=False
    )
    """所属 PR ID"""

    issue_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("issues.id"), nullable=False, index=True
    )
    """被关联的 Issue ID"""

    created_by = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    """建立关联的用户；自动推导的关联为 PR 作者"""

    closes_on_merge = mapped_column(Boolean, default=True, nullable=False)
    """合并 PR 时是否关闭该 Issue"""

    # 关联关系
    pull_request = relationship("PullRequest", back_populates="issue_links")
    issue = relationship("Issue", back_populates="pull_request_links")
    creator = relationship("User", foreign_keys=[created_by], backref="pr_issue_links")
