"""Agent 触发器派发：把平台事件映射为**只读**Agent 作业。

安全边界（自主作业）：
- 执行者为内置 bot 用户（可追溯）；
- ``AgentJob.origin="trigger"`` → ``process_job`` 不暴露写工具——无人值守时写审批
  无人可批会永久挂起，故触发器作业只读；结论由作业终态回帖到 ``target_room_id``。

去重与节流：
- ``agent_trigger_runs(trigger_id, dedup_key)`` 唯一去重（如 push 的 ``ref:new_sha``）；
- ``min_interval_seconds`` 限制同一触发器的最小触发间隔。

派发为 **best-effort**：任何异常只记日志，绝不影响事件主流程（push / 构建回调）。
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_config
from app.models.agent_trigger import (
    EVENT_SCHEDULE,
    VALID_EVENT_TYPES,
    AgentTrigger,
    AgentTriggerRun,
)

logger = logging.getLogger(__name__)


class _SafeDict(dict):
    """缺键时原样保留 ``{key}``，避免模板因缺占位抛错。"""

    def __missing__(self, key):  # noqa: D105
        return "{" + key + "}"


def _render(template: str, context: Dict[str, Any]) -> str:
    try:
        return template.format_map(_SafeDict(context))
    except Exception:  # noqa: BLE001 — 模板异常时原样返回（不阻断派发）
        return template


class AgentTriggerService:
    """触发器 CRUD + 事件派发"""

    # ---- CRUD ----

    async def create_trigger(
        self,
        db: AsyncSession,
        repository_id: uuid.UUID,
        *,
        event_type: str,
        prompt_template: str,
        target_room_id: Optional[uuid.UUID] = None,
        min_interval_seconds: int = 0,
        created_by: Optional[uuid.UUID] = None,
        enabled: bool = True,
    ) -> AgentTrigger:
        if event_type not in VALID_EVENT_TYPES:
            raise ValueError(f"未知事件类型: {event_type}")
        if not (prompt_template or "").strip():
            raise ValueError("prompt_template 不能为空")
        trig = AgentTrigger(
            repository_id=repository_id,
            event_type=event_type,
            prompt_template=prompt_template,
            target_room_id=target_room_id,
            min_interval_seconds=max(0, int(min_interval_seconds)),
            created_by=created_by,
            enabled=enabled,
        )
        db.add(trig)
        await db.commit()
        await db.refresh(trig)
        # 触发器作业的执行者（bot）需具备仓库读权限
        from app.services.agent_service import AgentService

        await AgentService().ensure_bot_repo_member(db, repository_id, commit=True)
        return trig

    async def list_triggers(
        self, db: AsyncSession, repository_id: uuid.UUID
    ) -> List[AgentTrigger]:
        return list(
            (
                await db.execute(
                    select(AgentTrigger).where(
                        AgentTrigger.repository_id == repository_id
                    )
                )
            ).scalars().all()
        )

    async def set_enabled(
        self, db: AsyncSession, trigger_id: uuid.UUID, enabled: bool
    ) -> Optional[AgentTrigger]:
        trig = (
            await db.execute(select(AgentTrigger).where(AgentTrigger.id == trigger_id))
        ).scalar_one_or_none()
        if trig is None:
            return None
        trig.enabled = enabled
        await db.commit()
        await db.refresh(trig)
        return trig

    async def delete_trigger(self, db: AsyncSession, trigger_id: uuid.UUID) -> bool:
        trig = (
            await db.execute(select(AgentTrigger).where(AgentTrigger.id == trigger_id))
        ).scalar_one_or_none()
        if trig is None:
            return False
        await db.delete(trig)
        await db.commit()
        return True

    # ---- 派发 ----

    async def dispatch_event(
        self,
        db: AsyncSession,
        repository_id: uuid.UUID,
        event_type: str,
        dedup_key: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> List[uuid.UUID]:
        """按事件匹配启用触发器并各自派发；返回新建作业 id（best-effort）。

        ``dedup_key`` 由调用方按事件语义构造（如 push 的 ``ref:new_sha``），
        保证同一事件重复到达不会重复触发。
        """
        try:
            if not get_config().agent.triggers_enabled:
                return []
            triggers = (
                await db.execute(
                    select(AgentTrigger).where(
                        AgentTrigger.repository_id == repository_id,
                        AgentTrigger.event_type == event_type,
                        AgentTrigger.enabled.is_(True),
                    )
                )
            ).scalars().all()
            job_ids: List[uuid.UUID] = []
            for trig in triggers:
                job_id = await self._fire(db, trig, dedup_key, context or {})
                if job_id is not None:
                    job_ids.append(job_id)
            return job_ids
        except Exception as exc:  # noqa: BLE001 — 派发失败不影响事件主流程
            logger.warning(
                "触发器派发失败 repo=%s event=%s（忽略）: %s",
                repository_id, event_type, exc,
            )
            return []

    async def dispatch_scheduled(self, db: AsyncSession) -> List[uuid.UUID]:
        """扫描所有启用 ``schedule`` 触发器并按节流窗口派发（arq cron 调用）。

        每个触发器以 ``min_interval_seconds`` 决定实际频率；``dedup_key`` 取
        「时间片」桶（如 86400 秒/片 = 每日一次），保证同一片内只触发一次。
        """
        try:
            if not get_config().agent.triggers_enabled:
                return []
            now = datetime.now(timezone.utc)
            triggers = (
                await db.execute(
                    select(AgentTrigger).where(
                        AgentTrigger.event_type == EVENT_SCHEDULE,
                        AgentTrigger.enabled.is_(True),
                    )
                )
            ).scalars().all()
            job_ids: List[uuid.UUID] = []
            for trig in triggers:
                slot = max(60, int(trig.min_interval_seconds or 0))
                dedup_key = f"schedule:{int(now.timestamp() // slot)}"
                job_id = await self._fire(
                    db, trig, dedup_key,
                    {"date": now.date().isoformat(), "time": now.isoformat()},
                )
                if job_id is not None:
                    job_ids.append(job_id)
            return job_ids
        except Exception as exc:  # noqa: BLE001 — 扫描失败不得影响 worker
            logger.warning("定时触发器扫描失败（忽略）: %s", exc)
            return []

    async def _fire(
        self,
        db: AsyncSession,
        trig: AgentTrigger,
        dedup_key: str,
        context: Dict[str, Any],
    ) -> Optional[uuid.UUID]:
        # 前序触发器的提交会 expire 本对象；刷新以拿到当前属性（避免 async 惰性加载）
        await db.refresh(trig)
        trig_id = trig.id
        # 去重：同 (trigger, dedup_key) 已执行则跳过
        seen = (
            await db.execute(
                select(AgentTriggerRun.id).where(
                    AgentTriggerRun.trigger_id == trig_id,
                    AgentTriggerRun.dedup_key == dedup_key,
                )
            )
        ).scalar_one_or_none()
        if seen is not None:
            return None

        now = datetime.now(timezone.utc)
        if trig.min_interval_seconds and trig.last_fired_at is not None:
            elapsed = (now - trig.last_fired_at).total_seconds()
            if elapsed < trig.min_interval_seconds:
                return None

        prompt = _render(trig.prompt_template, context).strip()
        if not prompt:
            return None
        repository_id = trig.repository_id
        target_room_id = trig.target_room_id

        from app.services.agent_service import AgentService

        service = AgentService()
        bot = await service.ensure_bot_user(db)
        # origin=trigger：作业为自主**只读**，结论由终态回帖 target_room_id
        job = await service.create_job(
            db, bot, repository_id, prompt,
            source_room_id=target_room_id, origin="trigger",
        )
        db.add(AgentTriggerRun(trigger_id=trig_id, dedup_key=dedup_key, job_id=job.id))
        await db.execute(
            update(AgentTrigger)
            .where(AgentTrigger.id == trig_id)
            .values(last_fired_at=now)
        )
        await db.commit()
        return job.id
