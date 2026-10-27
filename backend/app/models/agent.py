"""内置 Agent 数据模型（会话 / 作业 / 步骤）

- ``AgentSession``：一次对话会话（用户 × 可选仓库）。
- ``AgentJob``：一次异步执行单元，状态机
  ``queued → running → awaiting_approval → queued → … → succeeded/failed/cancelled``。
- ``AgentStep``：作业内的有序步骤（user / assistant / tool_call / tool_result /
  error / approval_required），既是 checkpoint，也是流式推送的数据源。

**人工审批**：写工具执行前必须由用户显式确认。作业在 ``awaiting_approval``
态挂起，把待批工具调用存入 ``pending_approval``、完整消息列表存入
``runtime_state``；approve/reject 端点写入 ``approval_decision`` 并重新入队，
worker 凭 ``runtime_state`` 原样恢复对话继续执行（无需从步骤反推）。

安全：LLM API key **绝不入库/入配置**。作业入参在落库前由 ``agent_service`` 剔除
provider 密钥字段；密钥仅存在于内存或进程环境变量。
"""
from sqlalchemy import (
    DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid as SAUuid,
)
from sqlalchemy.orm import mapped_column

from app.models.base import BaseModel


class AgentSession(BaseModel):
    """Agent 会话（同一会话下的多次作业共享上下文）"""
    __tablename__ = "agent_sessions"

    user_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    repository_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("repositories.id"), nullable=True, index=True
    )
    title = mapped_column(String(256), nullable=True)
    # 会话记忆：跨作业的确定性摘要（由 agent_service 按最近终态作业生成，无额外模型调用）。
    # 下一次作业的提示中会注入该摘要，使「上次审查结论」无需重读代码即可续接。
    summary = mapped_column(Text, nullable=True)
    summary_updated_at = mapped_column(DateTime(timezone=True), nullable=True)


class AgentJob(BaseModel):
    """Agent 作业（一次 prompt → 工具调用 → 回答 的执行单元）"""
    __tablename__ = "agent_jobs"

    session_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("agent_sessions.id"), nullable=False, index=True
    )
    repository_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("repositories.id"), nullable=False, index=True
    )
    # 聊天桥接来源房间（消息 @bot 唤醒时写入；None = panel/API 发起，不回帖到聊天）
    # 无 FK：房间删除不牵连作业历史（回帖时房间不存在由 ChatService 兜底）
    source_room_id = mapped_column(SAUuid(as_uuid=True), nullable=True)
    user_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    status = mapped_column(String(32), nullable=False, default="queued", index=True)
    #: 作业来源：``user``（面板/API/聊天）| ``trigger``（事件驱动，自主**只读**）。
    #: trigger 作业不暴露写工具——无人值守时写审批无人可批，会永久挂起。
    origin = mapped_column(String(16), nullable=False, default="user", server_default="user")
    prompt = mapped_column(Text, nullable=False)
    result = mapped_column(Text, nullable=True)
    error = mapped_column(Text, nullable=True)
    provider = mapped_column(String(64), nullable=True)
    model = mapped_column(String(128), nullable=True)
    step_count = mapped_column(Integer, nullable=False, default=0)
    # 累计真实消耗的 token（来自 provider 的 usage；用于 每日预算）
    tokens_used = mapped_column(Integer, nullable=False, default=0, server_default="0")
    # usage 拆分（成本审计：区分输入重放/输出/前缀缓存命中；provider 未回传则为 0）
    prompt_tokens = mapped_column(Integer, nullable=False, default=0, server_default="0")
    completion_tokens = mapped_column(Integer, nullable=False, default=0, server_default="0")
    cached_tokens = mapped_column(Integer, nullable=False, default=0, server_default="0")
    started_at = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at = mapped_column(DateTime(timezone=True), nullable=True)
    # --- 人工审批---
    # 待批工具调用 JSON：{"tool_call_id","tool","arguments"}
    pending_approval = mapped_column(Text, nullable=True)
    # 用户决定："approved" | "rejected"（消费后随 runtime_state 一并清空）
    approval_decision = mapped_column(String(16), nullable=True)
    approval_reason = mapped_column(Text, nullable=True)
    # 挂起时的完整消息列表 JSON（恢复执行的唯一真相来源）
    runtime_state = mapped_column(Text, nullable=True)


class AgentStep(BaseModel):
    """作业内单步（有序，作为 checkpoint 与流式事件）"""
    __tablename__ = "agent_steps"

    job_id = mapped_column(
        SAUuid(as_uuid=True), ForeignKey("agent_jobs.id"), nullable=False, index=True
    )
    seq = mapped_column(Integer, nullable=False)
    type = mapped_column(String(24), nullable=False)  # user|assistant|tool_call|tool_result|error
    name = mapped_column(String(128), nullable=True)   # 工具名（tool_* 时）
    content = mapped_column(Text, nullable=True)
    data = mapped_column(Text, nullable=True)           # JSON 原文（工具入参/结果）

    __table_args__ = (
        UniqueConstraint("job_id", "seq", name="uq_agent_step_seq"),
    )
