"""Agent 作业配额 / 成本控制。

四道闸门，全部基于 ``agent_jobs`` 表统计，**不依赖 Redis**（跨 worker 天然一致，
且无缓存层故障导致的误放行/误拒绝）：

1. 每用户并发作业上限（``queued``/``running``/``awaiting_approval`` 计为在跑）；
2. 全局并发作业上限（保护 ``agent-worker`` 容量，避免单用户占满）；
3. 每用户每日（UTC）作业数上限；
4. 每用户每日（UTC）token 预算（结算 ``tokens_used`` 累计值）。

配置项为 0 表示该闸门关闭。任一超限抛 :class:`RateLimitException`（HTTP 429），
由控制器返回给调用方。纯读校验不做预留，因此并发创建时存在极小的竞态窗口
（软上限）——对成本控制而言足够，且避免引入易泄漏的分布式预留。
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_config
from app.core.exception import RateLimitException
from app.models.agent import AgentJob

#: 计入"在跑"的状态（终态不占用配额）
ACTIVE_STATUSES = ("queued", "running", "awaiting_approval")


def _utc_day_start() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


async def _count(db: AsyncSession, *conditions) -> int:
    stmt = select(func.count()).select_from(AgentJob)
    if conditions:
        stmt = stmt.where(*conditions)
    return int((await db.execute(stmt)).scalar_one())


async def enforce_agent_quota(db: AsyncSession, user) -> None:
    """校验用户是否有余量创建新作业；超限抛 :class:`RateLimitException`。

    Args:
        db: 异步会话
        user: 当前用户（``user.id`` 用于按用户聚合）

    Raises:
        RateLimitException: 命中任一配额上限（error_code 标识具体闸门）
    """
    cfg = get_config().agent

    if cfg.max_active_jobs_per_user > 0:
        active = await _count(
            db,
            AgentJob.user_id == user.id,
            AgentJob.status.in_(ACTIVE_STATUSES),
        )
        if active >= cfg.max_active_jobs_per_user:
            raise RateLimitException(
                detail="当前并发 Agent 作业数已达上限，请等待既有作业结束后重试",
                error_code="agent_user_concurrency_exceeded",
            )

    if cfg.max_active_jobs_global > 0:
        active_all = await _count(db, AgentJob.status.in_(ACTIVE_STATUSES))
        if active_all >= cfg.max_active_jobs_global:
            raise RateLimitException(
                detail="Agent 服务繁忙，请稍后再试",
                error_code="agent_global_concurrency_exceeded",
            )

    day_start = _utc_day_start()

    if cfg.daily_job_limit_per_user > 0:
        today = await _count(
            db, AgentJob.user_id == user.id, AgentJob.created_at >= day_start
        )
        if today >= cfg.daily_job_limit_per_user:
            raise RateLimitException(
                detail="今日 Agent 作业数已达上限",
                error_code="agent_daily_job_limit_exceeded",
                retry_after=3600,
            )

    if cfg.daily_token_budget_per_user > 0:
        used = int(
            (
                await db.execute(
                    select(func.coalesce(func.sum(AgentJob.tokens_used), 0)).where(
                        AgentJob.user_id == user.id,
                        AgentJob.created_at >= day_start,
                    )
                )
            ).scalar_one()
        )
        if used >= cfg.daily_token_budget_per_user:
            raise RateLimitException(
                detail="今日 Agent token 预算已用尽",
                error_code="agent_token_budget_exceeded",
                retry_after=3600,
            )
