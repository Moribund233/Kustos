"""
WebSocket 日志消息处理器

处理日志订阅相关的 WebSocket 消息。日志管道（缓冲区 / 订阅管理器 /
``logging.Handler``）在 ``utils.ws_log_handler``——``utils.logging`` 要挂
这个 Handler，故实现在更低层；本模块只保留协议侧的订阅、退订、统计入口。
"""
from typing import Any, Dict

from app.utils.ws_log_handler import get_websocket_log_handler
from app.utils.ws_manager import Connection


async def handle_subscribe_logs(connection: Connection, data: Dict[str, Any]) -> None:
    """
    处理日志订阅请求

    日志流属管理面数据，仅管理员可订阅：匿名或非管理员连接一律拒绝。
    `/ws/logs` 与通用 `/ws/` 均经此处理器，故权限校验放在此处兜底。

    Args:
        connection: WebSocket 连接
        data: 消息数据，包含 filters
    """
    if not connection.metadata.get("is_admin", False):
        await connection.send({
            "type": "error",
            "error": "Admin permission required for log stream"
        })
        return

    handler = get_websocket_log_handler()
    filters = data.get("filters", {})

    levels = filters.get("levels", ["INFO", "WARNING", "ERROR"])
    loggers = filters.get("loggers")
    keywords = filters.get("keywords")

    await handler.subscription_manager.subscribe(
        connection,
        levels=levels,
        loggers=loggers,
        keywords=keywords
    )

    # 发送确认
    await connection.send({
        "type": "logs_subscribed",
        "filters": {
            "levels": levels,
            "loggers": loggers,
            "keywords": keywords
        }
    })

    # 发送最近的历史日志
    history_count = data.get("history_count", 50)
    recent_logs = await handler.buffer.get_recent(count=history_count)

    if recent_logs:
        await connection.send({
            "type": "log_history",
            "logs": [
                {
                    "timestamp": log.timestamp,
                    "level": log.level,
                    "logger": log.logger,
                    "message": log.message
                }
                for log in recent_logs
            ],
            "total": len(recent_logs)
        })


async def handle_unsubscribe_logs(connection: Connection, data: Dict[str, Any]) -> None:
    """处理取消订阅请求"""
    handler = get_websocket_log_handler()
    await handler.subscription_manager.unsubscribe(connection)

    await connection.send({
        "type": "logs_unsubscribed"
    })


async def handle_get_log_stats(connection: Connection, data: Dict[str, Any]) -> None:
    """处理获取日志统计请求（仅管理员）"""
    if not connection.metadata.get("is_admin", False):
        await connection.send({
            "type": "error",
            "error": "Admin permission required for log stream"
        })
        return

    handler = get_websocket_log_handler()
    stats = await handler.buffer.get_stats()

    await connection.send({
        "type": "log_stats",
        "stats": stats
    })
