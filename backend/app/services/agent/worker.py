"""arq worker 入口。

运行（独立进程/容器）：
    arq services.agent.worker.WorkerSettings

worker 读取服务器环境变量中的 provider key（``KUSTOS_AGENT_*``），
不接收也不持久化密钥；带内存密钥的作业由 app 进程内联执行。
"""
from __future__ import annotations

import logging
import uuid

from arq import cron
from arq.connections import RedisSettings

from app.core.config import get_config, get_config_value

logger = logging.getLogger(__name__)


async def process_agent_job(ctx, job_id: str) -> str:
    """arq 任务：执行一个 Agent 作业"""
    from app.services.agent_service import AgentService

    await AgentService().process_job(uuid.UUID(str(job_id)))
    return str(job_id)


async def sweep_scheduled_triggers(ctx) -> int:
    """arq cron：周期扫描 ``schedule`` 触发器并派发（best-effort）。

    每个触发器按其 ``min_interval_seconds`` 决定实际节流窗口（每日/每小时等），
    由 ``AgentTriggerService.dispatch_scheduled`` 统一处理去重与节流。
    """
    try:
        from app.models.async_db import get_async_db_context
        from app.services.agent.triggers import AgentTriggerService

        async with get_async_db_context() as db:
            return len(await AgentTriggerService().dispatch_scheduled(db))
    except Exception:  # noqa: BLE001 — 定时扫描失败不得拖垮 worker
        logger.exception("定时触发器扫描失败")
        return 0


async def on_startup(ctx) -> None:
    # 预热异步数据库引擎（process_job 会用 get_async_db_context 自管会话）
    from app.models.async_db import get_async_engine

    get_async_engine()
    # 注入并启动跨 worker 广播总线。worker 进程不持有任何用户 WS 连接，
    # 但 send_to_user 的 _publish 依赖总线把 agent_step 投递到 app worker 持有的
    # 连接；不启动则生产 compose 下推送链路完全断开（只剩轮询）。
    from app.api.ws.manager import manager as websocket_manager
    from app.utils.realtime_bus import bus as realtime_bus

    try:
        realtime_bus.bind(websocket_manager)
        started = await realtime_bus.start()
        if not started:
            logger.warning("Agent worker: Redis 不可用，agent_step 流式推送退化为轮询")
    except Exception as exc:  # noqa: BLE001 — 总线失败不阻塞作业执行
        logger.warning("Agent worker: 实时广播总线启动失败（退化为轮询）: %s", exc)
    logger.info("Agent worker 已启动")


async def on_shutdown(ctx) -> None:
    """停止广播总线，释放 pub/sub 连接"""
    from app.utils.realtime_bus import bus as realtime_bus

    try:
        await realtime_bus.stop()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Agent worker: 停止实时广播总线失败: %s", exc)


def _redis_settings() -> RedisSettings:
    url = (get_config().redis.url or "redis://127.0.0.1:6379").strip()
    return RedisSettings.from_dsn(url)


class WorkerSettings:
    """arq worker 设置。

    ``max_jobs`` / ``job_timeout`` 读 ``[agent]`` 配置——**必须是类体求值的值**：
    arq 经 ``get_kwargs(settings_cls)`` 直接读 ``settings_cls.__dict__``（不实例化、
    不解包 property），写成 ``@property`` 会把 property 对象原样传进
    ``Worker(max_jobs=...)`` → ``Semaphore`` 处 TypeError、worker 启动即崩。
    类体求值发生在 import 期 = worker 进程启动时生效，与 ``restart_keys``（重启
    才生效）语义一致。
    """
    functions = [process_agent_job]
    on_startup = on_startup
    on_shutdown = on_shutdown
    redis_settings = _redis_settings()
    keep_result = 0
    max_jobs = int(get_config_value("agent", "worker_max_jobs", 4))
    job_timeout = int(get_config_value("agent", "worker_job_timeout_seconds", 600))
    #: 定时巡航：每小时第 N 分钟扫描 ``schedule`` 触发器（N 可配；须为类体值，
    #: arq 经 ``__dict__`` 取参——与 max_jobs 同）
    cron_jobs = [
        cron(
            sweep_scheduled_triggers,
            minute={int(get_config_value("agent", "trigger_sweep_minute", 0))},
        )
    ]
