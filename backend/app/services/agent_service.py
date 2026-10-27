"""内置 Agent 编排服务（审批/取消/开关/SSRF 防护）。

职责：
- 会话/作业 CRUD；创建作业时统一校验仓库读权限、**kill switch** 与
  **请求级 base_url 白名单**，并剔除请求中的 API key 后再落库；
- 作业入队（arq 生产 / 内联兜底）；带密钥的请求强制内联，密钥不离开进程内存；
- 执行 tool-calling 循环，每步 checkpoint 到 ``agent_steps`` 并经 WS 流式推送；
- 人工审批：写工具挂起 → approve/reject → 重新入队 → 凭 ``runtime_state`` 恢复；
- 提供 bot 用户建模（``is_bot``，供后续写操作/审计留痕）。

**状态机与并发**：

    queued ──claim──> running ──> succeeded / failed
                        │  ▲
              awaiting_approval ┘（approve/reject 后回到 queued）
                        │
                     cancelled

所有终态写入都走 :meth:`_cas_status`（``UPDATE … WHERE status = <前置状态>``），
因此「用户取消」与「执行器收尾」竞争时**只有一方生效**，不会出现"取消后又被覆盖成
成功"。``agent_steps`` 的写入走**独立短会话** + 定向列更新，不会把执行器内存里
过期的 ``job.status`` 一并 flush 回库（这正是旧实现撤销取消的原因）。

安全底线：API key 不写入数据库/配置文件/日志；持久化字段仅 provider 名与 model。
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_config
from app.core.exception import (
    AuthorizationException,
    ConflictException,
    NotFoundException,
    RateLimitException,
    ValidationException,
)
from app.models.agent import AgentJob, AgentSession, AgentStep
from app.models.async_db import get_async_db_context
from app.models.repository import Repository
from app.models.user import User
from app.services.agent.providers import ModelProvider, get_provider
from app.services.agent.quota import enforce_agent_quota
from app.services.agent.runtime import (
    APPROVAL_APPROVED,
    APPROVAL_REJECTED,
    AgentRuntime,
    RunStatus,
)
from app.services.agent.tool_registry import ToolContext
from app.services.repository_service import get_accessible_repository_ids
from app.utils.git_utils import get_repository_storage_path
from app.utils.password_utils import get_password_hash
from app.utils.url_guard import UrlNotAllowed, parse_allowlist, validate_outbound_url

logger = logging.getLogger(__name__)

AGENT_BOT_USERNAME = "kustos-agent"

_TERMINAL = {"succeeded", "failed", "cancelled"}
#: 作业状态集合（供 API 层文档/校验复用）
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_AWAITING_APPROVAL = "awaiting_approval"
STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"

_RUNTIME_STATE_MAX_CHARS = 512 * 1024


def _now():
    return datetime.now(timezone.utc)


class AgentService:
    """Agent 会话 / 作业 / 步骤编排"""

    # ---- 会话 / 作业 CRUD ----

    async def create_session(
        self, db: AsyncSession, user: User, repository_id: Optional[uuid.UUID], title: Optional[str] = None
    ) -> AgentSession:
        session = AgentSession(user_id=user.id, repository_id=repository_id, title=title)
        db.add(session)
        await db.commit()
        await db.refresh(session)
        return session

    async def create_job(
        self,
        db: AsyncSession,
        user: User,
        repository_id: uuid.UUID,
        prompt: str,
        session_id: Optional[uuid.UUID] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        source_room_id: Optional[uuid.UUID] = None,
        origin: str = "user",
    ) -> AgentJob:
        """创建并投递一个 Agent 作业。

        ``api_key`` 仅用于本次执行（内存），绝不落库/入配置；携带 ``api_key`` 时强制
        内联执行，避免密钥进入 Redis/arq 载荷。

        Raises:
            AuthorizationException: Agent 未启用（kill switch 关闭）
            AuthorizationException: 无仓库读权限
            AuthorizationException: 请求级 ``base_url`` 不在白名单（防 SSRF）
        """
        cfg = get_config().agent
        # kill switch：关闭时拒绝一切作业创建（此前 enabled 从未被读取）
        if not cfg.enabled:
            raise AuthorizationException(
                detail="内置 Agent 未启用", error_code="agent_disabled"
            )
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("prompt 不能为空")
        accessible = await get_accessible_repository_ids(db, user.id)
        if repository_id not in accessible:
            raise NotFoundException(detail="Repository not found", error_code="repository_not_found")

        # 配额/成本闸门：每用户并发、全局并发、每日作业数、每日 token 预算。
        # 并发闸门可能被中断作业占满（执行进程被回收 / 投递丢失后停在
        # running/queued），先回收僵尸再复核一次，避免用户被永久挡住。
        try:
            await enforce_agent_quota(db, user)
        except RateLimitException as exc:
            if exc.error_code not in (
                "agent_user_concurrency_exceeded",
                "agent_global_concurrency_exceeded",
            ):
                raise
            if not await reclaim_stale_jobs(db):
                raise  # 没有可回收的僵尸：确属真实配额超限
            await enforce_agent_quota(db, user)

        # 请求级 base_url 属于不可信输入。worker 无法为"无 api_key 的排队作业"重建
        # 安全 provider，因此明确要求同时提供 api_key（env-key 场景走管理员配置）。
        if base_url is not None and api_key is None:
            raise ValidationException(
                detail="请求级 base_url 需要同时携带 api_key",
                error_code="agent_base_url_requires_api_key",
            )

        # SSRF：仅校验**请求级** base_url（配置级 base_url 为管理员可信输入）
        try:
            checked_base_url = validate_outbound_url(
                base_url, parse_allowlist(cfg.allowed_base_urls)
            )
        except UrlNotAllowed as exc:
            raise AuthorizationException(detail=str(exc), error_code="agent_base_url_not_allowed")

        if session_id is not None:
            session = (
                await db.execute(
                    select(AgentSession).where(
                        AgentSession.id == session_id, AgentSession.user_id == user.id
                    )
                )
            ).scalar_one_or_none()
            if session is None:
                raise NotFoundException(detail="Session not found", error_code="agent_session_not_found")
        else:
            session = await self.create_session(db, user, repository_id, title=prompt[:80])

        job = AgentJob(
            session_id=session.id,
            repository_id=repository_id,
            user_id=user.id,
            status=STATUS_QUEUED,
            prompt=prompt[:cfg.max_prompt_chars],
            provider=("openai" if api_key else cfg.provider),
            model=model or cfg.model,
            # 聊天桥接：@bot 唤醒时关联来源房间（与 job 同一次 commit 落库，
            # worker 起跑前即可见——终态回帖不漏）
            source_room_id=source_room_id,
            # 作业来源：trigger = 触发器自主作业（运行时只读，见 process_job）
            origin=origin,
        )
        db.add(job)
        await db.flush()  # 先取 id（python 侧默认值在 flush 时生成）
        # 审计：作业创建入活动流（与 job 同一次 commit；实体锚点 = job.id）
        from app.services.activity_service import try_record_activity

        await try_record_activity(
            repository_id=repository_id,
            actor_id=user.id,
            entity_type="agent_job",
            entity_id=job.id,
            action="created",
            details=prompt[:200],
            db=db,
        )
        await db.commit()
        await db.refresh(job)

        provider_override = None
        if api_key:
            provider_override = get_provider(
                api_key=api_key, base_url=checked_base_url or None, model=model
            )
            from app.services.agent.queue import InlineJobQueue

            queue = InlineJobQueue()
        else:
            from app.services.agent.queue import get_job_queue

            queue = await get_job_queue()
        await queue.enqueue(job.id, provider=provider_override)
        return job

    async def get_job(self, db: AsyncSession, user: User, job_id: uuid.UUID) -> AgentJob:
        job = (
            await db.execute(select(AgentJob).where(AgentJob.id == job_id))
        ).scalar_one_or_none()
        if job is None or job.user_id != user.id:
            raise NotFoundException(detail="Job not found", error_code="agent_job_not_found")
        return job

    async def list_jobs(
        self, db: AsyncSession, user: User, repository_id: uuid.UUID, limit: int = 20
    ) -> List[AgentJob]:
        rows = await db.execute(
            select(AgentJob)
            .where(AgentJob.user_id == user.id, AgentJob.repository_id == repository_id)
            .order_by(AgentJob.created_at.desc())
            .limit(limit)
        )
        return list(rows.scalars().all())

    async def get_steps(
        self, db: AsyncSession, user: User, job_id: uuid.UUID, after_seq: int = 0
    ) -> List[AgentStep]:
        await self.get_job(db, user, job_id)
        rows = await db.execute(
            select(AgentStep)
            .where(AgentStep.job_id == job_id, AgentStep.seq > after_seq)
            .order_by(AgentStep.seq)
        )
        return list(rows.scalars().all())

    async def cancel_job(self, db: AsyncSession, user: User, job_id: uuid.UUID) -> AgentJob:
        """取消作业。

        语义：仅翻转终态标记，**执行循环**由 ``is_cancelled`` 回调
        感知后主动收尾。由于终态写入是 CAS，取消与执行器收尾竞争时只有一方生效；
        若执行器已先收尾（作业已终态），此处为幂等空操作。
        """
        job = await self.get_job(db, user, job_id)
        if job.status in _TERMINAL:
            return job
        claimed = await self._cas_status(
            db,
            job_id,
            from_status=job.status,
            to_status=STATUS_CANCELLED,
            mark_finished=True,
            clear_runtime_state=True,
        )
        if claimed:
            # 审计：取消决策入活动流（CAS 认领侧记录，不重复）
            from app.services.activity_service import try_record_activity

            await try_record_activity(
                repository_id=job.repository_id,
                actor_id=user.id,
                entity_type="agent_job",
                entity_id=job.id,
                action="cancelled",
                details=job.prompt[:120],
                db=db,
            )
            await db.commit()
            await self._post_room_reply(job.source_room_id, "⏹ 作业已取消")
        await db.refresh(job)
        return job

    # ---- 人工审批----

    async def resolve_approval(
        self,
        db: AsyncSession,
        user: User,
        job_id: uuid.UUID,
        decision: str,
        reason: Optional[str] = None,
    ) -> AgentJob:
        """批准或拒绝一次待确认的写工具调用，并把作业重新入队。

        写工具绝不在无用户显式确认时执行：执行循环遇到 ``requires_approval`` 的
        工具会挂起（``awaiting_approval``）并落库待批调用与完整消息列表。

        Raises:
            ConflictException: 作业当前不处于 ``awaiting_approval``（未挂起/已终态/重复决定）
        """
        if decision not in (APPROVAL_APPROVED, APPROVAL_REJECTED):
            raise ValueError(f"未知审批决定: {decision}")
        job = await self.get_job(db, user, job_id)
        if job.status != STATUS_AWAITING_APPROVAL:
            raise ConflictException(
                detail="作业当前不处于待审批状态",
                error_code="agent_not_awaiting_approval",
            )
        claimed = await self._cas_status(
            db,
            job_id,
            from_status=STATUS_AWAITING_APPROVAL,
            to_status=STATUS_QUEUED,
            approval_decision=decision,
            approval_reason=(reason or None),
        )
        if not claimed:
            raise ConflictException(
                detail="作业状态已变化，请重试",
                error_code="agent_not_awaiting_approval",
            )
        await db.refresh(job)
        # 审计：审批决策入活动流（与 CAS 认领同侧，天然不重复）
        from app.services.activity_service import try_record_activity

        await try_record_activity(
            repository_id=job.repository_id,
            actor_id=user.id,
            entity_type="agent_job",
            entity_id=job.id,
            action="approved" if decision == APPROVAL_APPROVED else "rejected",
            details=(reason or job.prompt[:120]),
            db=db,
        )
        await db.commit()
        # 恢复执行必须走能取到 provider 密钥的队列（arq worker 或带环境变量的内联）
        from app.services.agent.queue import get_job_queue

        await (await get_job_queue()).enqueue(job_id)
        return job

    # ---- 状态机----

    @staticmethod
    async def _cas_status(
        db: AsyncSession,
        job_id,
        *,
        from_status: str,
        to_status: str,
        result: Optional[str] = None,
        error: Optional[str] = None,
        mark_started: bool = False,
        mark_finished: bool = False,
        approval_decision: Optional[str] = None,
        approval_reason: Optional[str] = None,
        pending_approval: Optional[str] = None,
        runtime_state: Optional[str] = None,
        clear_runtime_state: bool = False,
    ) -> bool:
        """带前置状态条件的终态/状态写入。

        Returns:
            True 表示本次调用赢得了状态转换；False 表示状态已被他人变更
            （例如用户已取消），调用方**不得**再覆盖。
        """
        values: Dict[str, Any] = {"status": to_status}
        if result is not None:
            values["result"] = result
        if error is not None:
            values["error"] = error
        if mark_started:
            values["started_at"] = _now()
        if mark_finished:
            values["finished_at"] = _now()
        if approval_decision is not None:
            values["approval_decision"] = approval_decision
        if approval_reason is not None:
            values["approval_reason"] = approval_reason
        if pending_approval is not None:
            values["pending_approval"] = pending_approval
        if runtime_state is not None:
            values["runtime_state"] = runtime_state
        if clear_runtime_state:
            values["pending_approval"] = None
            values["approval_decision"] = None
            values["approval_reason"] = None
            values["runtime_state"] = None
        result_row = await db.execute(
            update(AgentJob)
            .where(AgentJob.id == job_id, AgentJob.status == from_status)
            .values(**values)
        )
        await db.commit()
        return bool(result_row.rowcount)

    # ---- 执行 ----

    async def process_job(
        self, job_id: uuid.UUID, provider_override: Optional[ModelProvider] = None
    ) -> None:
        """执行作业（工作进程/内联任务调用）。自带会话；逐步 checkpoint。"""
        async with get_async_db_context() as db:
            job = (
                await db.execute(select(AgentJob).where(AgentJob.id == job_id))
            ).scalar_one_or_none()
            if job is None:
                return
            # CAS 抢占：queued → running。已被他人取消/抢占则直接退出。
            if not await self._cas_status(
                db, job_id, from_status=STATUS_QUEUED, to_status=STATUS_RUNNING,
                mark_started=True,
            ):
                return
            # 抢占后重新读取，确保拿到最新列（runtime_state / approval_decision）
            job = (
                await db.execute(select(AgentJob).where(AgentJob.id == job_id))
            ).scalar_one_or_none()
            if job is None:
                return

            repo = (
                await db.execute(select(Repository).where(Repository.id == job.repository_id))
            ).scalar_one_or_none()
            repo_path = get_repository_storage_path(repo.path) if repo else None
            # 请求自带密钥的作业不暴露写工具：审批挂起后 worker 取不到密钥，
            # 写工具将永远无法被批准执行（详见 ToolContext.allow_write）。
            # 触发器作业同属"无人可批"：自主作业一律只读，结论由终态回帖。
            allow_write = (job.origin or "user") != "trigger" and provider_override is None
            ctx = ToolContext(
                db=db,
                repository_id=job.repository_id,
                user_id=job.user_id,
                repo_path=repo_path,
                job_id=job_id,
                allow_write=allow_write,
            )

            # 会话记忆：注入本会话此前的确定性摘要（仅首轮；恢复执行时由 runtime 忽略）
            cfg = get_config().agent
            session_summary = None
            if cfg.max_summary_chars > 0:
                session_summary = (
                    await db.execute(
                        select(AgentSession.summary).where(
                            AgentSession.id == job.session_id
                        )
                    )
                ).scalar_one_or_none()
            # 作业级 token 预算：扣除本作业已消耗（跨审批恢复累计），仅本轮余量生效
            remaining_budget = None
            if cfg.job_token_budget > 0:
                remaining_budget = max(0, cfg.job_token_budget - (job.tokens_used or 0))

            seq = {"value": job.step_count or 0}
            # 局部量持有：on_step 闭包不触碰可能被 commit 过期的 ORM 实例
            source_room_id = job.source_room_id

            # ---- 频道打字机：模型输出增量按 0.15s/400 字批流到来源房间 ----
            # 每个 SSE delta 一次广播会打爆 realtime bus，攒批再发；
            # 每个步骤广播前强制 flush，保证「增量 → 步骤」边界有序。
            delta_buf = {"text": "", "ts": 0.0}

            async def _flush_delta() -> None:
                if source_room_id is None or not delta_buf["text"]:
                    return
                text = delta_buf["text"]
                delta_buf["text"] = ""
                delta_buf["ts"] = time.monotonic()
                await _stream_room_delta(job_id, source_room_id, text)

            async def on_delta(delta: str) -> None:
                if source_room_id is None or not delta:
                    return
                delta_buf["text"] += delta
                now = time.monotonic()
                if len(delta_buf["text"]) >= 400 or now - delta_buf["ts"] >= 0.15:
                    await _flush_delta()

            async def on_step(step_type, name=None, content=None, data=None):
                # 独立短会话：避免把执行器内存里过期的 job.status 一并 flush（旧 bug）
                seq["value"] += 1
                async with get_async_db_context() as sdb:
                    sdb.add(
                        AgentStep(
                            job_id=job_id,
                            seq=seq["value"],
                            type=step_type,
                            name=name,
                            content=content,
                            data=_json_dumps(data),
                        )
                    )
                    await sdb.execute(
                        update(AgentJob)
                        .where(AgentJob.id == job_id)
                        .values(step_count=seq["value"])
                    )
                await _flush_delta()
                await _stream_step(job, seq["value"], step_type, name, content, data)
                if source_room_id is not None:
                    await _stream_room_step(
                        job_id, source_room_id, seq["value"], step_type, name,
                        # error 步骤携带详情：频道工作气泡需要展示失败原因
                        content if step_type == "error" else None,
                    )

            try:
                # provider 构造也纳入失败路径：DB 密钥解密失败等异常
                # 必须落 error 步骤 + 置 failed，而非逃逸导致作业僵死到超时回收
                provider = provider_override or get_provider()
                outcome = await AgentRuntime(provider=provider).run(
                    ctx,
                    job.prompt,
                    on_step,
                    history=_load_runtime_state(job),
                    approvals=_load_approvals(job),
                    is_cancelled=lambda: self._is_cancelled(job_id),
                    on_delta=on_delta,
                    session_context=session_summary,
                    token_budget=remaining_budget,
                )
            except Exception as exc:  # noqa: BLE001 — 失败落库，供前端展示
                logger.warning("Agent 作业 %s 失败: %s", job_id, exc)
                message = f"{type(exc).__name__}: {exc}"[:2000]
                await on_step("error", None, message, None)
                claimed = await self._cas_status(
                    db, job_id, from_status=STATUS_RUNNING, to_status=STATUS_FAILED,
                    error=message, mark_finished=True, clear_runtime_state=True,
                )
                if claimed:
                    await self._post_room_reply(
                        job.source_room_id, f"❌ 作业失败：{message}"
                    )
                    await self._refresh_session_summary(db, job.session_id)
                return

            # 无论终态如何，先结算本轮真实 token 消耗（预算按作业累计）；
            # 拆分列同步累计（成本审计：输入重放 / 输出 / 前缀缓存命中）
            if (
                outcome.tokens_used
                or outcome.prompt_tokens
                or outcome.completion_tokens
            ):
                await db.execute(
                    update(AgentJob)
                    .where(AgentJob.id == job_id)
                    .values(
                        tokens_used=AgentJob.tokens_used + outcome.tokens_used,
                        prompt_tokens=AgentJob.prompt_tokens + outcome.prompt_tokens,
                        completion_tokens=AgentJob.completion_tokens
                        + outcome.completion_tokens,
                        cached_tokens=AgentJob.cached_tokens + outcome.cached_tokens,
                    )
                )
                await db.commit()

            if outcome.status == RunStatus.ANSWERED:
                claimed = await self._cas_status(
                    db, job_id, from_status=STATUS_RUNNING, to_status=STATUS_SUCCEEDED,
                    result=outcome.answer, mark_finished=True, clear_runtime_state=True,
                )
                if claimed:
                    if outcome.answer:
                        # 对话本体进团队消息流（面板只承担流程）
                        await self._post_room_reply(job.source_room_id, outcome.answer)
                    await self._refresh_session_summary(db, job.session_id)
            elif outcome.status == RunStatus.BUDGET_EXCEEDED:
                # 预算耗尽优雅降级：以「已有结论 + 收尾提示」收尾为成功（非失败）
                claimed = await self._cas_status(
                    db, job_id, from_status=STATUS_RUNNING, to_status=STATUS_SUCCEEDED,
                    result=outcome.answer, mark_finished=True, clear_runtime_state=True,
                )
                if claimed:
                    if outcome.answer:
                        await self._post_room_reply(job.source_room_id, outcome.answer)
                    await self._refresh_session_summary(db, job.session_id)
            elif outcome.status == RunStatus.AWAITING_APPROVAL:
                try:
                    runtime_state = _dump_runtime_state(outcome.messages)
                except ValueError as exc:
                    # 状态过大无法安全保存：宁可显式失败，也不写入截断的损坏 JSON
                    message = str(exc)[:2000]
                    await on_step("error", None, message, None)
                    claimed = await self._cas_status(
                        db, job_id, from_status=STATUS_RUNNING, to_status=STATUS_FAILED,
                        error=message, mark_finished=True, clear_runtime_state=True,
                    )
                    if claimed:
                        await self._post_room_reply(
                            job.source_room_id, f"❌ 作业失败：{message}"
                        )
                        await self._refresh_session_summary(db, job.session_id)
                    return
                claimed = await self._cas_status(
                    db, job_id, from_status=STATUS_RUNNING, to_status=STATUS_AWAITING_APPROVAL,
                    pending_approval=_json_dumps(outcome.pending),
                    runtime_state=runtime_state,
                )
                if claimed:
                    pending = outcome.pending if isinstance(outcome.pending, dict) else {}
                    tool = pending.get("tool") or "write tool"
                    await self._post_room_reply(
                        job.source_room_id,
                        f"🔐 写操作待审批：`{tool}`\n"
                        f"请在聊天头部的 **Agent 作业** 面板中批准或拒绝。",
                    )
            else:  # RunStatus.CANCELLED —— 取消标记可能已由 cancel 端点写入，CAS 会自然落空
                claimed = await self._cas_status(
                    db, job_id, from_status=STATUS_RUNNING, to_status=STATUS_CANCELLED,
                    mark_finished=True, clear_runtime_state=True,
                )
                if claimed:
                    await self._post_room_reply(job.source_room_id, "⏹ 作业已取消")
                    await self._refresh_session_summary(db, job.session_id)

    async def _refresh_session_summary(self, db: AsyncSession, session_id) -> None:
        """按会话最近终态作业生成确定性摘要（无额外模型调用，best-effort）。

        摘要 = 最近若干「提问 → 结论」要点（结论取 ``result``/``error``），受
        ``agent.max_summary_chars`` 约束、保留最近的条目；由下一次作业经
        ``AgentRuntime.run(session_context=...)`` 注入。刷新失败不影响作业终态。
        """
        try:
            limit = get_config().agent.max_summary_chars
            if limit <= 0:
                return
            rows = (
                await db.execute(
                    select(AgentJob.prompt, AgentJob.result, AgentJob.error)
                    .where(
                        AgentJob.session_id == session_id,
                        AgentJob.status.in_(tuple(_TERMINAL)),
                    )
                    .order_by(AgentJob.finished_at.desc())
                    .limit(5)
                )
            ).all()
            if not rows:
                return
            header = "会话历史摘要（供续接上下文，按时间正序）："
            parts: List[str] = []
            used = len(header) + 1
            for prompt, result, error in rows:  # 最近 -> 较早（预算优先保留最近）
                q = " ".join((prompt or "").split())[:200]
                a = " ".join((result or error or "").split())[:800]
                block = f"- 问：{q}\n  答：{a}"
                if used + len(block) > limit:
                    break
                parts.append(block)
                used += len(block) + 1
            if not parts:
                return
            parts.reverse()
            summary = header + "\n" + "\n".join(parts)
            session = (
                await db.execute(
                    select(AgentSession).where(AgentSession.id == session_id)
                )
            ).scalar_one_or_none()
            if session is None:
                return
            session.summary = summary
            session.summary_updated_at = _now()
            await db.commit()
        except Exception as exc:  # noqa: BLE001 — 摘要失败不影响作业终态
            logger.warning("会话 %s 摘要刷新失败（忽略）: %s", session_id, exc)

    @staticmethod
    async def _is_cancelled(job_id) -> bool:
        """读取作业当前状态，判断执行循环是否应提前收尾（独立短会话，避免长事务快照）"""
        async with get_async_db_context() as sdb:
            status = (
                await sdb.execute(select(AgentJob.status).where(AgentJob.id == job_id))
            ).scalar_one_or_none()
        return status == STATUS_CANCELLED

    async def ensure_bot_user(self, db: AsyncSession, *, commit: bool = True) -> User:
        """确保内置 Agent bot 用户存在（bot 建模；不可登录，仅作代理身份留痕）

        Args:
            commit: False 时只 flush 不提交——供建房/建仓等**自有事务内**使用，
                避免把调用方尚未完成的事务提前提交（FK/业务一致性由调用方掌控）。
        """
        existing = (
            await db.execute(select(User).where(User.username == AGENT_BOT_USERNAME))
        ).scalar_one_or_none()
        if existing is not None:
            return existing
        bot = User(
            username=AGENT_BOT_USERNAME,
            email="agent@kustos.local",
            password=get_password_hash(uuid.uuid4().hex),
            full_name="Kustos Agent",
            is_active=False,
            is_admin=False,
            is_bot=True,
        )
        db.add(bot)
        if commit:
            await db.commit()
        else:
            await db.flush()
        await db.refresh(bot)
        return bot

    async def ensure_bot_repo_member(
        self, db: AsyncSession, repository_id: uuid.UUID, *, commit: bool = False
    ) -> None:
        """Agent 启用时 bot 入驻仓库成员（幂等；失败不阻断建仓/启用主流程）。

        与频道成员（RoomMember）互补：仓库成员决定「属于所有仓库」，
        频道成员决定 @ 与成员列表可见。未启用时不动（禁用状态不污染成员列表）。
        """
        try:
            from app.core.config import get_config

            if not get_config().agent.enabled:
                return
            from app.models.repository_member import RepositoryMember

            bot = await self.ensure_bot_user(db, commit=False)
            existing = (
                await db.execute(
                    select(RepositoryMember).where(
                        RepositoryMember.repository_id == repository_id,
                        RepositoryMember.user_id == bot.id,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                return
            db.add(
                RepositoryMember(
                    repository_id=repository_id,
                    user_id=bot.id,
                    role="developer",
                    is_active=True,
                )
            )
            await db.flush()
            if commit:
                await db.commit()
        except Exception:  # noqa: BLE001 — 成员入驻属增强信息，绝不阻断调用方
            logger.exception("bot 入驻仓库失败 repo=%s", repository_id)

    async def add_bot_to_repositories(self, db: AsyncSession, bot_id: uuid.UUID) -> int:
        """Agent 启用后回填：bot 入驻全部仓库（幂等，返回新增数）"""
        from app.models.repository_member import RepositoryMember

        repo_ids = (await db.execute(select(Repository.id))).scalars().all()
        if not repo_ids:
            return 0
        existing = set(
            (
                await db.execute(
                    select(RepositoryMember.repository_id).where(
                        RepositoryMember.user_id == bot_id,
                        RepositoryMember.repository_id.in_(repo_ids),
                    )
                )
            ).scalars().all()
        )
        added = 0
        for rid in repo_ids:
            if rid in existing:
                continue
            db.add(
                RepositoryMember(
                    repository_id=rid, user_id=bot_id, role="developer", is_active=True
                )
            )
            added += 1
        if added:
            await db.flush()
        return added

    async def post_bot_message(
        self, db: AsyncSession, room_id: uuid.UUID, content: str
    ) -> None:
        """以 bot 身份向聊天房间发消息并广播（对话进团队消息流）。

        bot 无仓库访问权、走不进 ``_ensure_membership`` 的自动加入逻辑——
        这里显式补 ``RoomMember``（bot 出现在成员列表是预期行为）；广播与
        WS 发送处理器同型（worker 内经 realtime_bus 跨进程投递）。
        回帖属尽力而为：失败只记日志，绝不影响作业主流程。
        """
        if not content or not content.strip():
            return
        try:
            bot = await self.ensure_bot_user(db)
            from app.models.realtime_room import RoomMember

            member = (
                await db.execute(
                    select(RoomMember).where(
                        RoomMember.room_id == room_id,
                        RoomMember.user_id == bot.id,
                    )
                )
            ).scalar_one_or_none()
            if member is None:
                db.add(
                    RoomMember(
                        room_id=room_id,
                        user_id=bot.id,
                        role="member",
                        joined_at=_now(),
                    )
                )
                await db.flush()
            from app.services.realtime.chat_service import ChatService

            msg = await ChatService.send_message(db, room_id, bot.id, content)
            await db.commit()
            # 注意：模块导出名是 manager（ConnectionManager 为真单例）——
            # 历史代码误写 websocket_manager 被 except 静默吞掉，WS 流式实际从未生效
            from app.api.ws.manager import manager as websocket_manager

            # 先撤「思考中」指示再发消息：动画消失与气泡出现无缝衔接
            await websocket_manager.send_to_room(
                room_id,
                {
                    "type": "chat_typing",
                    "room_id": str(room_id),
                    "user_id": str(bot.id),
                    "username": bot.username,
                    "is_typing": False,
                },
            )
            await websocket_manager.send_to_room(
                room_id, {"type": "chat_message", "message": msg}
            )
        except Exception:  # noqa: BLE001 — 回帖失败不改变作业状态
            logger.exception("Agent 回帖失败: room=%s", room_id)

    async def _post_room_reply(
        self, room_id: Optional[uuid.UUID], content: str
    ) -> None:
        """作业状态回帖：仅 ``source_room_id`` 非空（聊天发起）的作业回帖。

        独立短会话执行，不搅动执行器/端点事务；调用点必须在**终态 CAS 已提交**
        之后（CAS 认领成功 = 单一写者，天然去重）。
        """
        if room_id is None:
            return
        async with get_async_db_context() as pdb:
            await self.post_bot_message(pdb, room_id, content)


#: 中断作业回收时写入 ``agent_jobs.error`` 的原因（区分两种中断方式）
_RECLAIM_REASON = {
    STATUS_RUNNING: "作业执行中断（执行进程已退出或重启），已自动回收为失败",
    STATUS_QUEUED: "作业投递后长时间未被执行（队列丢失或 worker 不可用），已自动回收为失败",
}


async def reclaim_stale_jobs(db: AsyncSession) -> int:
    """回收中断的僵尸作业：``running``/``queued`` 超过阈值无更新即判失败。

    执行进程被回收、部署重启或 Redis 清空都会让作业永远停在 ``running``/
    ``queued``——用户无从得知，且这两类状态计入并发配额
    （``services/agent/quota.py`` 的 ``ACTIVE_STATUSES``），会把并发名额长期占满。

    判定信号取 ``updated_at``（列级 ``onupdate``，每步 checkpoint 都会刷新）：
    合法作业两次写入之间的最长间隔远小于默认阈值。终态写入带状态条件，与执行器
    收尾、用户取消竞争时只有一方生效——迟到的 worker 随后 CAS 落空即自行退出。
    ``awaiting_approval``（等人审批）不在回收范围。

    Args:
        db: 调用方会话（逐条 CAS 时自带提交）

    Returns:
        int: 本次回收的作业数
    """
    cfg = get_config().agent
    if cfg.stale_job_timeout_minutes <= 0:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=cfg.stale_job_timeout_minutes)
    stale = or_(
        AgentJob.updated_at.is_(None),
        AgentJob.updated_at < cutoff,
    )
    rows = (
        await db.execute(
            select(AgentJob).where(
                AgentJob.status.in_((STATUS_RUNNING, STATUS_QUEUED)), stale
            )
        )
    ).scalars().all()

    reclaimed = 0
    for job in rows:
        reason = _RECLAIM_REASON[job.status]
        job_id, status, step_count = job.id, job.status, (job.step_count or 0)
        if not await AgentService._cas_status(
            db,
            job_id,
            from_status=status,
            to_status=STATUS_FAILED,
            error=reason,
            mark_finished=True,
            clear_runtime_state=True,
        ):
            continue  # 状态已被他人变更：既有结果生效，不得覆盖
        # 让用户在步骤时间线里看到失败原因（job.error 同步带出）
        seq = step_count + 1
        db.add(AgentStep(job_id=job_id, seq=seq, type="error", content=reason))
        await db.execute(
            update(AgentJob).where(AgentJob.id == job_id).values(step_count=seq)
        )
        await db.commit()
        await _stream_step(job, seq, "error", None, reason, None)
        # 频道围观者同样需要看到失败（来源房间广播 error 详情）
        if getattr(job, "source_room_id", None) is not None:
            await _stream_room_step(job.id, job.source_room_id, seq, "error", None, reason)
        reclaimed += 1

    if reclaimed:
        logger.warning(
            "回收中断的 Agent 作业 %d 个（阈值 %s 分钟）",
            reclaimed, cfg.stale_job_timeout_minutes,
        )
    return reclaimed


def _load_runtime_state(job: AgentJob) -> Optional[List[Dict[str, Any]]]:
    """从作业恢复挂起时的消息列表；数据损坏时降级为 None（从头执行）"""
    if not job.runtime_state:
        return None
    try:
        parsed = json.loads(job.runtime_state)
    except (TypeError, ValueError):
        logger.warning("作业 %s 的 runtime_state 解析失败，按从头执行处理", job.id)
        return None
    return parsed if isinstance(parsed, list) else None


def _load_approvals(job: AgentJob) -> Dict[str, str]:
    """从作业取出待批工具调用的用户决定"""
    if not job.pending_approval or not job.approval_decision:
        return {}
    try:
        pending = json.loads(job.pending_approval)
    except (TypeError, ValueError):
        return {}
    call_id = pending.get("tool_call_id") if isinstance(pending, dict) else None
    if not call_id:
        return {}
    return {str(call_id): job.approval_decision}


def _dump_runtime_state(messages: List[Dict[str, Any]]) -> str:
    """序列化消息列表；超过硬上限时**失败**而非截断。

    截断会产生不可解析的 JSON，导致恢复时静默从头执行（丢审批上下文）；
    写入超大行同样不可接受，因此超过上限直接抛错，由调用方走失败的 CAS 收尾。
    """
    payload = json.dumps(messages, ensure_ascii=False, default=str)
    if len(payload) > _RUNTIME_STATE_MAX_CHARS:
        raise ValueError(
            f"挂起态消息超过存储上限（{_RUNTIME_STATE_MAX_CHARS} 字符），"
            "无法安全保存，请重试本次任务"
        )
    return payload


def _json_dumps(data: Any) -> Optional[str]:
    if data is None:
        return None
    try:
        return json.dumps(data, ensure_ascii=False, default=str)[:20000]
    except (TypeError, ValueError):
        return str(data)[:20000]


async def _stream_step(
    job: AgentJob, seq: int, step_type: str, name: Optional[str],
    content: Optional[str], data: Optional[str],
) -> None:
    """经 WS 向作业所属用户流式推送单步（best-effort，失败不影响执行）"""
    try:
        # 模块导出名是 manager（单例）；历史误写 websocket_manager 被 except
        # 静默吞掉导致推送从未生效——修正导入让流式推送真正工作
        from app.api.ws.manager import manager as websocket_manager

        await websocket_manager.send_to_user(
            job.user_id,
            {
                "type": "agent_step",
                "job_id": str(job.id),
                "seq": seq,
                "step_type": step_type,
                "name": name,
                "content": content,
                "data": data,
            },
        )
    except Exception as exc:  # noqa: BLE001 — 推送失败不阻塞作业
        logger.debug("agent step 推送失败: %s", exc)


async def _stream_room_step(
    job_id: uuid.UUID, room_id: uuid.UUID, seq: int, step_type: str,
    name: Optional[str], content: Optional[str] = None,
) -> None:
    """向来源房间广播轻量步骤事件（频道「思考/工具」动画用，best-effort）。

    与 ``_stream_step`` 的按用户推送互补：频道内其他围观者也能看到进度；
    只带步骤元信息（类型/工具名），不带 content/data（内容可能很大）——
    唯 ``error`` 步骤例外：错误详情本身短小且是用户可见的关键反馈，
    房间事件照常携带，供频道内的工作气泡直接展示失败原因。
    """
    try:
        from app.api.ws.manager import manager as websocket_manager

        await websocket_manager.send_to_room(
            room_id,
            {
                "type": "agent_step",
                "room_id": str(room_id),
                "job_id": str(job_id),
                "seq": seq,
                "step_type": step_type,
                "name": name,
                "username": AGENT_BOT_USERNAME,
                "content": content,
            },
        )
    except Exception as exc:  # noqa: BLE001 — 推送失败不阻塞作业
        logger.debug("agent room step 推送失败: %s", exc)


async def _stream_room_delta(
    job_id: uuid.UUID, room_id: uuid.UUID, delta: str
) -> None:
    """向来源房间广播模型输出增量（打字机；best-effort，节流由调用方攒批负责）"""
    try:
        from app.api.ws.manager import manager as websocket_manager

        await websocket_manager.send_to_room(
            room_id,
            {
                "type": "agent_stream",
                "room_id": str(room_id),
                "job_id": str(job_id),
                "delta": delta,
                "username": AGENT_BOT_USERNAME,
            },
        )
    except Exception as exc:  # noqa: BLE001 — 推送失败不阻塞作业
        logger.debug("agent stream 推送失败: %s", exc)
