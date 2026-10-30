"""
通知消息处理器

处理客户端发来的通知类 WebSocket 消息（心跳 / 订阅 / 退订 / 广播）。
服务端主动推送的构造逻辑在 ``services.realtime.notification_push``——
服务层不得反向依赖 ``api``，故出站推送下沉到服务层。
"""
from typing import Dict, Any
from datetime import datetime
from app.utils.ws_manager import Connection, manager
import logging

logger = logging.getLogger(__name__)


async def handle_ping(connection: Connection, message: Dict[str, Any]) -> None:
    """
    处理心跳ping消息
    
    客户端发送: {"type": "ping", "timestamp": "2024-01-01T12:00:00Z"}
    服务端响应: {"type": "pong", "timestamp": "...", "server_time": "..."}
    """
    connection.update_ping()
    
    await connection.send({
        "type": "pong",
        "timestamp": message.get("timestamp"),
        "server_time": datetime.now().isoformat(),
    })


async def handle_subscribe(connection: Connection, message: Dict[str, Any]) -> None:
    """
    处理订阅请求
    
    客户端发送:
    {
        "type": "subscribe",
        "channel": "repository",
        "repository_id": 123
    }
    
    或订阅用户通知:
    {
        "type": "subscribe",
        "channel": "user_notifications"
    }
    """
    channel = message.get("channel", "")
    
    if channel == "repository":
        repository_id = message.get("repository_id")
        if repository_id is None:
            await connection.send({
                "type": "error",
                "error": "订阅仓库需要提供repository_id",
                "original_type": "subscribe"
            })
            return
        
        await manager.subscribe_repository(connection, repository_id)
        
        await connection.send({
            "type": "subscribed",
            "channel": "repository",
            "repository_id": repository_id,
            "message": f"成功订阅仓库 {repository_id} 的通知"
        })
        
        logger.info(f"用户 {connection.username} 订阅仓库 {repository_id}")
    
    elif channel == "user_notifications":
        # 用户通知订阅（自动基于用户绑定）
        await connection.send({
            "type": "subscribed",
            "channel": "user_notifications",
            "message": "成功订阅用户通知"
        })
    
    else:
        await connection.send({
            "type": "error",
            "error": f"未知的订阅频道: {channel}",
            "supported_channels": ["repository", "user_notifications"]
        })


async def handle_unsubscribe(connection: Connection, message: Dict[str, Any]) -> None:
    """
    处理取消订阅请求
    
    客户端发送:
    {
        "type": "unsubscribe",
        "channel": "repository",
        "repository_id": 123
    }
    """
    channel = message.get("channel", "")
    
    if channel == "repository":
        repository_id = message.get("repository_id")
        if repository_id:
            await manager.unsubscribe_repository(connection, repository_id)
            
            await connection.send({
                "type": "unsubscribed",
                "channel": "repository",
                "repository_id": repository_id,
                "message": f"已取消订阅仓库 {repository_id}"
            })
    
    elif channel == "user_notifications":
        await connection.send({
            "type": "unsubscribed",
            "channel": "user_notifications",
            "message": "已取消订阅用户通知"
        })


async def handle_broadcast(connection: Connection, message: Dict[str, Any]) -> None:
    """
    处理广播请求（管理员功能）
    
    客户端发送:
    {
        "type": "broadcast",
        "content": {
            "type": "system_notification",
            "title": "系统维护通知",
            "message": "系统将于今晚10点维护"
        }
    }
    """
    # 检查是否为管理员
    if not connection.metadata.get("is_admin", False):
        await connection.send({
            "type": "error",
            "error": "权限不足，只有管理员可以发送广播"
        })
        return
    
    content = message.get("content", {})
    
    # 添加广播元数据
    broadcast_message = {
        **content,
        "broadcast_at": datetime.now().isoformat(),
        "broadcast_by": connection.username,
    }
    
    # 发送给所有连接
    count = await manager.broadcast(broadcast_message)
    
    await connection.send({
        "type": "broadcast_sent",
        "recipient_count": count,
        "message": f"广播已发送给 {count} 个连接"
    })
    
    logger.info(f"管理员 {connection.username} 发送广播，覆盖 {count} 个连接")
