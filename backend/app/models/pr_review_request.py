"""PR 评审请求模型

``pr_reviews`` 记录的是**已提交**的评审；评审请求（requested reviewer）是另一件事：
PR 作者指定某人来看，但对方还没提交结论。两者分开存，状态由 ``pr_reviews`` 推导，
避免出现「请求了评审」和「评审结论」两套互相覆盖的状态机。
"""
from sqlalchemy import ForeignKey, UniqueConstraint, Uuid as SAUuid
from sqlalchemy.orm import relationship, mapped_column

from app.models.base import TimestampMixin


class PRReviewRequest(TimestampMixin):
    """PR 评审请求（pending reviewer）"""

    __tablename__ = "pr_review_requests"
    __table_args__ = (
        UniqueConstraint("pull_request_id", "reviewer_id", name="uq_pr_review_request"),
    )

    pull_request_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("pull_requests.id"), nullable=False
    )
    """所属 PR ID"""

    reviewer_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    """被请求的评审人 ID"""

    requested_by = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    """发起请求的用户 ID（PR 作者或仓库管理员）"""

    # 关联关系
    pull_request = relationship("PullRequest", back_populates="review_requests")
    reviewer = relationship(
        "User", foreign_keys=[reviewer_id], backref="pr_review_requests"
    )
    requester = relationship("User", foreign_keys=[requested_by])
