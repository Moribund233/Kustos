"""
自动保留任务

收口此前「清理只靠 admin 手动调用 ``POST /api/app/logs/cleanup``」的状态——全仓
没有任何定时或启动触发，``logs/<YYYY-MM-DD>/`` 与 ``activities`` 表都会无限增长。

六类保留：

============ ==========================================================
对象         来源
============ ==========================================================
日期日志目录 ``logs/<YYYY-MM-DD>/``，按 ``[logging] log_keep_days``
审计日志文件 同上（audit.log 在日期目录内，随目录一起被清理）
Activity 表  ``activities``，按 ``[logging] activity_keep_days``
撤销审计行   ``revoked_tokens`` 已过期行（token TTL 即保留期）
中断作业     ``agent_jobs`` 中停在 running/queued 且超时无更新的僵尸行
Agent 步骤   ``agent_steps``，按 ``[logging] agent_steps_keep_days``（仅已收尾作业）
============ ==========================================================

多 worker 并发执行天然幂等：目录已删则跳过，行已删则影响 0 行。
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlalchemy import delete, select

from app.core.config import get_config_value
from app.models.activity import Activity
from app.models.agent import AgentJob, AgentStep
from app.models.idempotency_record import IdempotencyRecord
from app.models.pkce_auth_code import PkceAuthorizationCode
from app.models.revoked_token import RevokedToken
from app.utils.logging import LogManager, cleanup_old_logs, maybe_rollover

logger = logging.getLogger(__name__)

#: 幂等记录默认保留小时数（= [idempotency] record_keep_hours 的降级默认）。
#: 只需覆盖客户端补发窗口，离线 outbox 通常几分钟到几小时内完成。
DEFAULT_IDEMPOTENCY_KEEP_HOURS = 24


class RetentionService:
    """日志/审计表的自动保留、中断作业回收与 Agent 步骤清理"""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # 单次执行（测试与手动触发直接调用）
    # ------------------------------------------------------------------
    def cleanup_logs(self, keep_days: int, log_dir: str = LogManager.DEFAULT_LOG_DIR) -> int:
        """
        清理超期的日期日志目录

        先 ``maybe_rollover()``：确保日切后活跃目录登记已更新，
        再交给 ``cleanup_old_logs`` 做活跃目录豁免。
        """
        if keep_days <= 0:
            return 0
        maybe_rollover()
        return cleanup_old_logs(log_dir=log_dir, keep_days=keep_days)

    async def cleanup_activities(self, db, keep_days: int) -> int:
        """
        清理超期的 Activity 审计行，返回删除行数

        用**朴素本地时间**：``Activity.created_at`` 由 ``server_default=func.now()``
        生成，与审计日志里的 ``datetime.now().isoformat()`` 同为朴素时间，
        也与 ``dashboard_service`` 既有的 ``Activity.created_at >= since`` 口径一致。
        """
        if keep_days <= 0:
            return 0
        cutoff = datetime.now() - timedelta(days=keep_days)
        result = await db.execute(
            delete(Activity).where(Activity.created_at < cutoff)
        )
        return int(result.rowcount or 0)

    async def cleanup_revoked_tokens(self, db) -> int:
        """
        清理已过期的 ``RevokedToken`` 审计行，返回删除行数

        此前全仓无任何 ``DELETE RevokedToken``——每次登出写 2~3 行、表无限
        增长，启动回填的 ``expires_at > now`` 过滤随之退化为全表扫描。
        过期行对热路径（Redis 位图）与回填（只取未过期行）均无用，
        **token 自身 TTL 即保留期**，故不另设 keep_days。
        """
        cutoff = datetime.now(timezone.utc)
        result = await db.execute(
            delete(RevokedToken).where(
                RevokedToken.expires_at.is_not(None),
                RevokedToken.expires_at < cutoff,
            )
        )
        return int(result.rowcount or 0)

    async def cleanup_idempotency_records(self, db, keep_hours: int) -> int:
        """
        清理过期的幂等键记录，返回删除行数。

        幂等记录只在"补发窗口"内有意义：桌面端离线 outbox 的补发通常发生在
        几分钟到几小时内，超过窗口的键保留下来的唯一作用是占空间。而且这张表
        每次带键写入都追加一行，不清理会无限增长（与 ``revoked_tokens`` 同病）。

        Args:
            db: 异步会话。
            keep_hours: 保留小时数；``<=0`` 表示不清理。
        """
        if keep_hours <= 0:
            return 0
        cutoff = datetime.now(timezone.utc) - timedelta(hours=keep_hours)
        result = await db.execute(
            delete(IdempotencyRecord).where(IdempotencyRecord.created_at < cutoff)
        )
        return int(result.rowcount or 0)

    async def cleanup_pkce_codes(self, db) -> int:
        """
        清理已过期或已被兑换的 PKCE 授权码，返回删除行数。

        授权码的生命周期以分钟计（默认 5 分钟），用过的码立即失去价值；
        留着既占空间，也让唯一索引随登录次数线性增长。

        Args:
            db: 异步会话。
        """
        cutoff = datetime.now(timezone.utc)
        result = await db.execute(
            delete(PkceAuthorizationCode).where(
                (PkceAuthorizationCode.expires_at < cutoff)
                | (PkceAuthorizationCode.used_at.is_not(None))
            )
        )
        return int(result.rowcount or 0)

    async def cleanup_agent_steps(self, db, keep_days: int) -> int:
        """
        删除**已收尾**作业的过期步骤，返回删除行数。

        步骤既是时间线展示也是断点续跑的上下文：只按作业收尾时间清理
        ``succeeded``/``failed``/``cancelled`` 三类终态，进行中与待审批作业
        （可能跨越保留期）一律不动。时间口径取 ``AgentJob.finished_at``
        （作业收尾时以 UTC 写入）。
        """
        if keep_days <= 0:
            return 0
        cutoff = datetime.now(timezone.utc) - timedelta(days=keep_days)
        finished = select(AgentJob.id).where(
            AgentJob.status.in_(("succeeded", "failed", "cancelled")),
            AgentJob.finished_at.is_not(None),
            AgentJob.finished_at < cutoff,
        )
        result = await db.execute(
            delete(AgentStep).where(AgentStep.job_id.in_(finished))
        )
        return int(result.rowcount or 0)

    async def run_once(self, db=None) -> Dict[str, Any]:
        """
        执行一轮完整保留

        Args:
            db: 可选的数据库会话；为 None 时自行开一个

        Returns:
            Dict[str, Any]: 各类清理/回收的命中计数
        """
        from app.core.config import get_config

        logging_cfg = get_config().logging

        deleted_dirs = self.cleanup_logs(logging_cfg.log_keep_days)

        deleted_activities = 0
        if logging_cfg.activity_keep_days > 0:
            if db is not None:
                deleted_activities = await self.cleanup_activities(
                    db, logging_cfg.activity_keep_days
                )
            else:
                from app.models.async_db import get_async_db_context
                async with get_async_db_context() as session:
                    deleted_activities = await self.cleanup_activities(
                        session, logging_cfg.activity_keep_days
                    )

        # 已过期撤销行清理（保留清理；db 为 None 时与 Activity 同轮共用会话）
        deleted_revoked = 0
        if db is not None:
            deleted_revoked = await self.cleanup_revoked_tokens(db)
        else:
            from app.models.async_db import get_async_db_context
            async with get_async_db_context() as session:
                deleted_revoked = await self.cleanup_revoked_tokens(session)

        # 过期幂等键：补发窗口外的记录只占空间。
        # 用 get_config_value 而非直接取节属性：配置未就绪/被替换时能降级，
        # 不因为多接一类保留就让整轮清理抛错。
        deleted_idempotency = 0
        keep_hours = int(
            get_config_value(
                "idempotency", "record_keep_hours", DEFAULT_IDEMPOTENCY_KEEP_HOURS
            )
        )
        if keep_hours > 0:
            if db is not None:
                deleted_idempotency = await self.cleanup_idempotency_records(
                    db, keep_hours
                )
            else:
                from app.models.async_db import get_async_db_context

                async with get_async_db_context() as session:
                    deleted_idempotency = await self.cleanup_idempotency_records(
                        session, keep_hours
                    )

        # PKCE 授权码：分钟级寿命，过期或用过即无用
        deleted_pkce = 0
        if db is not None:
            deleted_pkce = await self.cleanup_pkce_codes(db)
        else:
            from app.models.async_db import get_async_db_context

            async with get_async_db_context() as session:
                deleted_pkce = await self.cleanup_pkce_codes(session)

        # 中断作业回收：执行进程死亡/投递丢失后停在 running/queued 的僵尸行，
        # 既让用户无从得知，也长期占着并发配额
        from app.services.agent.agent_service import reclaim_stale_jobs

        if db is not None:
            reclaimed_jobs = await reclaim_stale_jobs(db)
        else:
            from app.models.async_db import get_async_db_context
            async with get_async_db_context() as session:
                reclaimed_jobs = await reclaim_stale_jobs(session)

        # 已收尾作业的过期步骤：每步都带正文与 JSON 数据，不设保留期会无限膨胀
        deleted_steps = 0
        if logging_cfg.agent_steps_keep_days > 0:
            if db is not None:
                deleted_steps = await self.cleanup_agent_steps(
                    db, logging_cfg.agent_steps_keep_days
                )
            else:
                from app.models.async_db import get_async_db_context
                async with get_async_db_context() as session:
                    deleted_steps = await self.cleanup_agent_steps(
                        session, logging_cfg.agent_steps_keep_days
                    )

        if deleted_dirs or deleted_activities or deleted_revoked or reclaimed_jobs \
                or deleted_steps or deleted_idempotency or deleted_pkce:
            logger.info(
                "自动保留执行完成：日志目录 %d 个、Activity %d 条、撤销行 %d 条、"
                "幂等记录 %d 条、PKCE 授权码 %d 条、中断作业 %d 个、Agent 步骤 %d 条"
                "（log_keep_days=%s, activity_keep_days=%s, agent_steps_keep_days=%s）",
                deleted_dirs, deleted_activities, deleted_revoked, deleted_idempotency,
                deleted_pkce, reclaimed_jobs, deleted_steps, logging_cfg.log_keep_days,
                logging_cfg.activity_keep_days, logging_cfg.agent_steps_keep_days,
            )

        return {
            "log_dirs_deleted": deleted_dirs,
            "activities_deleted": deleted_activities,
            "revoked_tokens_deleted": deleted_revoked,
            "idempotency_records_deleted": deleted_idempotency,
            "pkce_codes_deleted": deleted_pkce,
            "stale_jobs_reclaimed": reclaimed_jobs,
            "agent_steps_deleted": deleted_steps,
        }

    # ------------------------------------------------------------------
    # 后台循环
    # ------------------------------------------------------------------
    async def start(self) -> None:
        """启动后台保留任务（幂等）；启动即跑一轮，随后按配置间隔重复"""
        if self._task is not None and not self._task.done():
            return
        try:
            await self.run_once()
        except Exception as exc:  # noqa: BLE001 — 保留失败不阻断启动
            logger.warning("自动保留首轮执行失败（不阻断启动）: %s", exc)
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        """停止后台保留任务"""
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def _loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(_interval_seconds())
                try:
                    await self.run_once()
                except Exception as exc:  # noqa: BLE001 — 单次失败不影响循环
                    logger.warning("自动保留任务执行失败: %s", exc)
        except asyncio.CancelledError:
            pass


def _interval_seconds() -> int:
    """保留任务运行间隔（秒），取自 ``[logging] retention_interval_hours``"""
    try:
        from app.core.config import get_config
        hours = get_config().logging.retention_interval_hours
    except Exception:  # noqa: BLE001 — 配置不可用时回落默认
        hours = 6
    return max(1, int(hours)) * 3600


_retention_service: Optional[RetentionService] = None


def get_retention_service() -> RetentionService:
    """获取全局自动保留服务实例"""
    global _retention_service
    if _retention_service is None:
        _retention_service = RetentionService()
    return _retention_service
