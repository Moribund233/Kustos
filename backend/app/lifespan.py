"""
应用生命周期管理模块

提供应用启动和关闭时的资源初始化和清理工作。

Docker/Uvicorn 单进程模式：
- 启动：验证数据库连接、初始化 WebSocket 心跳
- 关闭：优雅关闭 WebSocket 连接、释放数据库连接池

使用 FastAPI 的 lifespan 上下文管理器实现
"""
import os
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Dict, Any, Optional

from fastapi import FastAPI

from app.models.async_db import get_async_engine
from app.utils.ws_manager import manager as websocket_manager
from app.utils import process_control
from app.utils.realtime_bus import bus as realtime_bus
from app.services.realtime.presence_service import presence as presence_store
from app.services.platform.worker_registry import worker_registry

logger = logging.getLogger(__name__)


class AppLifecycleManager:
    """
    应用生命周期管理器

    管理应用启动和关闭时的资源初始化和清理工作。
    单进程模式（适用于 Uvicorn / Docker）。
    """

    def __init__(self):
        self._websocket_manager = websocket_manager
        self._realtime_bus = realtime_bus
        self._worker_task: Optional[asyncio.Task] = None
        self._is_shutting_down = False

    async def startup(self) -> None:
        """
        应用启动时执行的初始化操作

        包括：
        - 初始化数据库引擎
        - 验证数据库连接
        - 初始化 WebSocket 心跳检查

        Raises:
            Exception: 数据库引擎初始化或连接验证失败时抛出异常，
                       阻止应用在不健康状态下启动
        """
        # 初始化异步数据库引擎（延迟加载） — 致命错误，必须阻止启动
        await self._init_async_database()
        await self._verify_database_connection()

        # 撤销位图回填：Redis 重启（appendonly no）/ volatile-lru
        # 淘汰后从 RevokedToken 审计行恢复——非致命，失败仅告警
        try:
            await self._backfill_revocations()
        except Exception as e:
            logger.warning(f"撤销位图回填失败（下次重启重试，期间撤销可能漏拦）: {e}")

        # 初始化 WebSocket 心跳检查 — 非致命错误，打日志即可
        try:
            await self._init_websocket_manager()
        except Exception as e:
            logger.warning(f"WebSocket 管理器初始化失败（不影响服务启动）: {e}")

        # 启动跨 worker 广播总线 — 非致命错误，Redis 不可用时退化为进程内
        try:
            await self._init_realtime_bus()
        except Exception as e:
            logger.warning(f"实时广播总线初始化失败（退化为进程内广播）: {e}")

        # 启动 worker 心跳（写入 Redis 注册表，供 admin 观测）
        try:
            self._init_worker_heartbeat()
        except Exception as e:
            logger.warning(f"worker 心跳初始化失败（admin 将看不到本 worker）: {e}")

        # 启动进程指标采样（供 admin 概览趋势图的内存/CPU 曲线）
        try:
            await self._init_process_metrics()
        except Exception as e:
            logger.warning(f"进程指标采样初始化失败（概览趋势将缺少内存/CPU）: {e}")

        # 启动自动保留：日期日志目录 + Activity 审计表按 [logging] 保留期清理
        # — 非致命，失败仅告警；此前只能靠 admin 手动调 /api/app/logs/cleanup
        try:
            await self._init_retention()
        except Exception as e:
            logger.warning(f"自动保留任务启动失败（日志/Activity 将继续堆积）: {e}")

    async def _init_async_database(self) -> None:
        """初始化异步数据库引擎"""
        from app.models.async_db import get_async_engine
        engine = get_async_engine()
        if engine is None:
            raise Exception("异步数据库引擎初始化失败")

    async def shutdown(self) -> None:
        """
        应用关闭时执行的清理操作
        """
        if self._is_shutting_down:
            return

        self._is_shutting_down = True

        logger.info("开始执行关闭流程...")

        await self._shutdown_worker_heartbeat()
        await self._shutdown_process_metrics()
        await self._shutdown_retention()
        await self._shutdown_realtime_bus()
        await self._shutdown_websocket_connections()
        await self._drain_webhook_deliveries()
        await self._dispose_database_engine()

        logger.info("关闭流程执行完成")

    async def _verify_database_connection(self) -> None:
        """验证数据库连接是否正常"""
        from sqlalchemy import text
        from app.models.async_db import get_async_engine
        engine = get_async_engine()
        if engine is None:
            raise Exception("异步数据库引擎未初始化")
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
            await conn.commit()

    async def _backfill_revocations(self) -> None:
        """启动回填撤销位图：未过期的 RevokedToken 审计行 → Redis/内存"""
        from app.models.async_db import get_async_db_context
        from app.services.auth.token_service import backfill_revocations
        async with get_async_db_context() as db:
            count = await backfill_revocations(db)
        if count:
            logger.info(f"撤销位图回填完成: {count} 条未过期记录")

    async def _init_websocket_manager(self) -> None:
        """初始化 WebSocket 管理器"""
        try:
            asyncio.create_task(self._websocket_manager.heartbeat_checker())
        except Exception as e:
            logger.error(f"WebSocket 管理器初始化失败: {e}")
            raise

    async def _init_realtime_bus(self) -> None:
        """绑定跨 worker 在线状态注册表，并启动广播总线"""
        self._websocket_manager.set_presence(presence_store)
        self._realtime_bus.bind(self._websocket_manager)
        started = await self._realtime_bus.start()
        if not started:
            logger.info("实时广播总线未启用（Redis 不可用），使用进程内广播")

    def _init_worker_heartbeat(self) -> None:
        """启动 worker 心跳后台任务（立即写一次，之后周期续期）"""
        self._worker_task = asyncio.create_task(self._worker_heartbeat_loop())

    async def _worker_heartbeat_loop(self) -> None:
        try:
            while True:
                try:
                    await worker_registry.heartbeat(
                        self._websocket_manager, self._realtime_bus
                    )
                except Exception as e:  # noqa: BLE001 — 单次失败不影响循环
                    logger.warning(f"worker 心跳写入失败: {e}")
                await asyncio.sleep(20)
        except asyncio.CancelledError:
            pass

    async def _shutdown_worker_heartbeat(self) -> None:
        if self._worker_task is not None:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._worker_task = None

    async def _init_process_metrics(self) -> None:
        """启动进程指标后台采样"""
        from app.services.platform.process_metrics import get_process_metrics

        await get_process_metrics().start()

    async def _shutdown_process_metrics(self) -> None:
        """停止进程指标后台采样"""
        try:
            from app.services.platform.process_metrics import get_process_metrics

            await get_process_metrics().stop()
        except Exception as e:  # noqa: BLE001
            logger.error(f"停止进程指标采样时出错: {e}")

    async def _init_retention(self) -> None:
        """启动自动保留任务：日期日志目录 + Activity 审计表"""
        from app.services.platform.retention_service import get_retention_service

        await get_retention_service().start()

    async def _shutdown_retention(self) -> None:
        """停止自动保留任务"""
        try:
            from app.services.platform.retention_service import get_retention_service

            await get_retention_service().stop()
        except Exception as e:  # noqa: BLE001
            logger.error(f"停止自动保留任务时出错: {e}")

    async def _shutdown_realtime_bus(self) -> None:
        """停止广播总线"""
        try:
            await self._realtime_bus.stop()
        except Exception as e:  # noqa: BLE001
            logger.error(f"停止实时广播总线时出错: {e}")

    async def _shutdown_websocket_connections(self) -> None:
        """优雅关闭所有 WebSocket 连接"""
        try:
            import copy
            async with self._websocket_manager._lock:
                active_connections = list(self._websocket_manager._connections.values())

            if not active_connections:
                return

            close_message = {
                "type": "system",
                "event": "shutdown",
                "message": "服务器即将关闭，连接将被断开"
            }

            await self._websocket_manager.broadcast(close_message)
            await asyncio.sleep(0.5)

            for connection in active_connections:
                try:
                    await connection.websocket.close(code=1001, reason="服务器关闭")
                except Exception:
                    pass
                await self._websocket_manager.disconnect(connection)

        except Exception as e:
            logger.error(f"关闭 WebSocket 连接时出错: {e}")

    async def _dispose_database_engine(self) -> None:
        """释放数据库连接池"""
        try:
            from app.models.async_db import close_async_engine
            await close_async_engine()
        except Exception as e:
            logger.error(f"释放异步数据库连接池时出错: {e}")

    async def _drain_webhook_deliveries(self) -> None:
        """有界等待未完成的 WebHook 后台投递（尽力而为，超时放弃）。

        必须在 dispose 数据库引擎之前调用：投递任务使用独立会话写
        投递历史，引擎关闭后它们只会报错并静默丢失。
        """
        try:
            from app.services.integration.webhook_service import wait_for_pending_deliveries
            remaining = await wait_for_pending_deliveries()
            if remaining:
                logger.warning(f"关闭超时，仍有 {remaining} 个 WebHook 投递未完成")
        except Exception as e:
            logger.error(f"等待 WebHook 投递完成时出错: {e}")

    def is_shutting_down(self) -> bool:
        """检查是否正在关闭"""
        return self._is_shutting_down


# 全局生命周期管理器实例
_lifecycle_manager: AppLifecycleManager = AppLifecycleManager()


def get_lifecycle_manager() -> AppLifecycleManager:
    """
    获取生命周期管理器实例

    Returns:
        AppLifecycleManager: 生命周期管理器实例
    """
    return _lifecycle_manager


def reset_lifecycle_manager() -> None:
    """重置生命周期管理器实例（用于测试）"""
    global _lifecycle_manager
    _lifecycle_manager = AppLifecycleManager()


@asynccontextmanager
async def app_lifespan(app: FastAPI) -> AsyncGenerator[Dict[str, Any], None]:
    """
    FastAPI lifespan 上下文管理器

    用法:
        app = FastAPI(lifespan=app_lifespan)

    Args:
        app: FastAPI 应用实例

    Yields:
        Dict[str, Any]: 应用状态字典
    """
    manager = get_lifecycle_manager()

    try:
        await manager.startup()
        # 标记「本进程确实在提供服务」：重启/关闭的单进程分支据此放行，
        # 误入该分支的非服务进程（如 docker exec / 脚本）不会去拉起新进程
        process_control.mark_serving()
        yield {"lifecycle_manager": manager}
    finally:
        await manager.shutdown()


def trigger_graceful_shutdown(reason: str = "manual") -> bool:
    """
    触发优雅关闭（不再自建事件循环，也不再只杀单个 worker）

    关闭流程交给服务器自己：SIGTERM → uvicorn/gunicorn 在**主事件循环**里执行
    lifespan shutdown（``app_lifespan`` 的 finally → ``manager.shutdown()``）：

    - 有进程管理器（``uvicorn --workers`` / gunicorn）→ 信号发给管理器，
      由它带**全部 worker** 一起优雅退出；
    - 单进程 → 发给自己。

    原实现在独立 ``asyncio.new_event_loop()`` 里跑 ``manager.shutdown()``——
    manager 的 ``asyncio.Lock`` 与 WebSocket 连接都绑定主 loop，跨 loop 使用
    为未定义行为；随后的 SIGTERM 只终止收到请求的那个 worker（4 worker 下
    「关闭应用」实际只关 1/4）。这两点即上述病灶。

    Args:
        reason: 关闭原因（日志用）

    Returns:
        bool: 是否成功发出关闭信号
    """
    manager = get_lifecycle_manager()
    if manager.is_shutting_down():
        logger.info(f"关闭已在进行中（{reason}），跳过重复触发")
        return True

    import signal

    from app.utils import process_control

    supervisor_pid = process_control.signal_supervisor(signal.SIGTERM)
    if supervisor_pid is not None:
        logger.info(
            f"触发优雅关闭（{reason}）：SIGTERM → 进程管理器 pid={supervisor_pid}，"
            f"全部 worker 一起优雅退出"
        )
        return True

    # 单进程路径：只有「本进程确实在提供服务」才允许自我终止——
    # docker exec / 脚本里误调本函数时不应杀掉调用者
    if not process_control.is_serving():
        logger.error(
            f"触发关闭失败（{reason}）：无进程管理器且本进程未在提供服务，拒绝自我终止"
        )
        return False

    try:
        self_pid = os.getpid()
        os.kill(self_pid, signal.SIGTERM)
        logger.info(
            f"触发优雅关闭（{reason}）：SIGTERM → 本进程 pid={self_pid}，"
            f"由服务器在主事件循环执行 lifespan shutdown"
        )
        return True
    except Exception as e:
        logger.error(f"执行关闭流程时出错: {e}")
        return False


def is_shutdown_requested() -> bool:
    """
    检查是否已请求关闭

    Returns:
        bool: 是否已请求关闭
    """
    return get_lifecycle_manager().is_shutting_down()
