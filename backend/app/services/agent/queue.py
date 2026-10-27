"""作业队列：arq 生产 + 内联兜底。

- 生产：Redis 可用时用 arq（独立 worker 进程消费，新增 compose 服务）。
- 兜底：Redis 不可用（含 test 容器）时用 asyncio 后台任务，接口一致。
- 携带内存密钥（provider_override）的作业**必须内联**，密钥不进 Redis/arq 载荷；
  调用方（agent_service）负责选择。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional, Protocol

from app.core.config import get_config
from app.services.agent.providers import ModelProvider

logger = logging.getLogger(__name__)

_arq_pool = None
#: 上次尝试创建连接池的单调时刻（None = 尚未尝试）
_arq_pool_last_attempt: Optional[float] = None
_arq_lock: Optional[asyncio.Lock] = None


class JobQueue(Protocol):
    async def enqueue(self, job_id, provider: Optional[ModelProvider] = None) -> None:
        ...


class InlineJobQueue:
    """进程内后台执行（asyncio task）；测试与无 Redis 环境使用"""

    def __init__(self) -> None:
        self._tasks: set = set()

    async def enqueue(self, job_id, provider: Optional[ModelProvider] = None) -> None:
        task = asyncio.create_task(_run_inline(job_id, provider))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


async def _run_inline(job_id, provider: Optional[ModelProvider]) -> None:
    from app.services.agent_service import AgentService

    try:
        await AgentService().process_job(job_id, provider_override=provider)
    except Exception:  # noqa: BLE001 — 任务内已落库失败，这里只记录
        logger.exception("内联 Agent 作业 %s 执行异常", job_id)


def _attempt_cooldown() -> float:
    """连接池创建失败后的重试冷却（秒）——与 Redis 客户端共用同一配置键"""
    try:
        return max(0.0, float(get_config().redis.reconnect_cooldown))
    except Exception:  # noqa: BLE001 — 配置未就绪时回落默认
        return 5.0


def _get_arq_lock() -> asyncio.Lock:
    global _arq_lock
    if _arq_lock is None:
        _arq_lock = asyncio.Lock()
    return _arq_lock


async def _get_arq_pool():
    """取 arq 连接池；创建失败按冷却窗口**重试**，不会永久退化为内联。

    冷却语义与 ``utils/redis_client.get_redis`` 同型：冷却窗口内直接返回
    （不重复撞连接），窗口过后重试；成功即自愈。失败期间把降级登记到
    ``utils/degraded``，Admin 面板能看到「作业当前走进程内」。
    """
    global _arq_pool, _arq_pool_last_attempt
    if _arq_pool is not None:
        return _arq_pool
    url = (get_config().redis.url or "").strip()
    if not url:
        return None  # 未配置 Redis 属于既定形态，不算降级
    if _arq_pool_last_attempt is not None and \
            time.monotonic() - _arq_pool_last_attempt < _attempt_cooldown():
        return None
    async with _get_arq_lock():
        if _arq_pool is not None:
            return _arq_pool
        if _arq_pool_last_attempt is not None and \
                time.monotonic() - _arq_pool_last_attempt < _attempt_cooldown():
            return None
        _arq_pool_last_attempt = time.monotonic()
        try:
            from arq import create_pool
            from arq.connections import RedisSettings

            _arq_pool = await create_pool(RedisSettings.from_dsn(url))
        except Exception as exc:  # noqa: BLE001 — arq 不可用则暂走内联
            logger.warning(
                "arq 连接池创建失败，%.0fs 后重试；期间作业退化为内联执行: %s",
                _attempt_cooldown(), exc,
            )
            _arq_pool = None
            from app.utils.degraded import registry

            registry.set(
                "agent_queue", "inline",
                "arq 连接池不可用，Agent 作业退化为进程内执行",
            )
            return None
        from app.utils.degraded import registry

        registry.clear("agent_queue")
        logger.info("Agent 作业队列已接入 arq/Redis")
        return _arq_pool


class ArqJobQueue:
    """arq 队列（独立 worker 消费）"""

    def __init__(self, pool) -> None:
        self._pool = pool

    async def enqueue(self, job_id, provider: Optional[ModelProvider] = None) -> None:
        if provider is not None:
            raise ValueError("内存密钥作业不能投递到 arq（密钥不得进入队列载荷）")
        await self._pool.enqueue_job("process_agent_job", str(job_id))


async def get_job_queue() -> JobQueue:
    pool = await _get_arq_pool()
    if pool is not None:
        return ArqJobQueue(pool)
    return InlineJobQueue()


def reset_queue_state() -> None:
    """测试隔离用"""
    global _arq_pool, _arq_pool_last_attempt, _arq_lock
    _arq_pool = None
    _arq_pool_last_attempt = None
    _arq_lock = None
