from sqlalchemy import String, Integer, DateTime, Text, Uuid as SAUuid
from sqlalchemy.orm import mapped_column
from app.models.base import TimestampMixin


VALID_STATUSES = {"pending", "running", "success", "failure", "error", "cancelled"}


class BuildStatus(TimestampMixin):
    __tablename__ = "build_status"

    repo_id = mapped_column(SAUuid(as_uuid=True), nullable=False, index=True)
    branch = mapped_column(String(255), nullable=False)
    commit_sha = mapped_column(String(64), nullable=False)
    commit_message = mapped_column(Text, nullable=True)
    status = mapped_column(String(20), nullable=False, default="pending", index=True)
    triggered_by = mapped_column(SAUuid(as_uuid=True), nullable=False)
    started_at = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at = mapped_column(DateTime(timezone=True), nullable=True)
    details_url = mapped_column(String(512), nullable=True)
    logs = mapped_column(Text, nullable=True)
    #: 失败结构摘要（exit code / traceback 尾行等），落库时从日志抽取——
    #: 让 Agent 一次调用拿到「结论」，需要细节再取尾部日志（结论+指针）
    failure_summary = mapped_column(Text, nullable=True)
