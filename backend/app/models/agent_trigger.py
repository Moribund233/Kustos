"""Agent 触发器模型（事件驱动 / 定时巡航）。

触发器把平台事件（push / CI 失败）映射为一次**只读** Agent 作业：结论由作业
终态回帖到目标频道，无需人工审批——自主作业不暴露写工具（``AgentJob.origin``）。
"""
from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Integer, String, Text,
    UniqueConstraint, Uuid as SAUuid,
)
from sqlalchemy.orm import mapped_column

from app.models.base import BaseModel

#: 事件类型（新增类型须同时登记此处与派发侧）
EVENT_PUSH = "push"
EVENT_BUILD_FAILED = "build_failed"
#: 定时巡航：由 arq cron 周期扫描；按触发器 ``min_interval_seconds`` 决定实际频率
EVENT_SCHEDULE = "schedule"
VALID_EVENT_TYPES = (EVENT_PUSH, EVENT_BUILD_FAILED, EVENT_SCHEDULE)


class AgentTrigger(BaseModel):
    """单条触发规则（仓库 × 事件类型）"""
    __tablename__ = "agent_triggers"

    repository_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("repositories.id"), nullable=False, index=True
    )
    event_type = mapped_column(String(32), nullable=False, index=True)
    enabled = mapped_column(Boolean, nullable=False, default=True)
    #: 结论回帖目标房间（None=不回帖，仅落作业历史）
    target_room_id = mapped_column(SAUuid(as_uuid=True), nullable=True)
    #: prompt 模板：支持 ``{branch}`` / ``{sha}`` / ``{pusher}`` 等占位（缺键原样保留）
    prompt_template = mapped_column(Text, nullable=False)
    #: 节流：同一触发器两次触发的最小间隔（秒，0=不节流）
    min_interval_seconds = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    last_fired_at = mapped_column(DateTime(timezone=True), nullable=True)
    created_by = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("users.id"), nullable=True
    )


class AgentTriggerRun(BaseModel):
    """触发器执行记录：``(trigger_id, dedup_key)`` 唯一，兼作去重与审计。"""
    __tablename__ = "agent_trigger_runs"

    trigger_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("agent_triggers.id"), nullable=False, index=True
    )
    dedup_key = mapped_column(String(200), nullable=False)
    job_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("agent_jobs.id"), nullable=True
    )

    __table_args__ = (
        UniqueConstraint("trigger_id", "dedup_key", name="uq_agent_trigger_run_dedup"),
    )
