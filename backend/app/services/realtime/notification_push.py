"""服务端出站通知推送

把「向用户 / 仓库订阅者推一条消息」的构造逻辑收在服务层。放在这里而不是
``api.ws.handlers.notification``：调用方是 ``services.notification_service``
等业务服务，服务层不得反向依赖 ``api``；本模块只依赖 ``utils.ws_manager``
的连接管理器，不涉及 WebSocket 协议解析。

``api.ws.handlers.notification`` 保留入站消息处理器（ping / 订阅 / 广播），
两者职责不同：那边解析客户端消息，这边构造服务端主动推送。
"""
from datetime import datetime
from typing import Any, Dict, Optional
import uuid

from app.utils.ws_manager import manager


async def notify_commit_new(
    repository_id: uuid.UUID,
    commit_data: Dict[str, Any],
    exclude_user_id: uuid.UUID | None = None,
) -> int:
    """
    通知仓库有新提交

    Args:
        repository_id: 仓库ID
        commit_data: 提交信息
        exclude_user_id: 排除的用户ID（提交者自己）

    Returns:
        int: 通知到的连接数
    """
    message = {
        "type": "notification",
        "action": "commit_new",
        "repository_id": repository_id,
        "data": commit_data,
        "timestamp": datetime.now().isoformat(),
    }

    return await manager.send_to_repository(repository_id, message, exclude_user_id)


async def notify_branch_update(repository_id: uuid.UUID, branch_data: Dict[str, Any]) -> int:
    """
    通知分支更新

    Args:
        repository_id: 仓库ID
        branch_data: 分支信息

    Returns:
        int: 通知到的连接数
    """
    message = {
        "type": "notification",
        "action": "branch_update",
        "repository_id": repository_id,
        "data": branch_data,
        "timestamp": datetime.now().isoformat(),
    }

    return await manager.send_to_repository(repository_id, message)


async def notify_repository_event(
    repository_id: uuid.UUID, event_type: str, event_data: Dict[str, Any]
) -> int:
    """
    通用仓库事件通知

    Args:
        repository_id: 仓库ID
        event_type: 事件类型
        event_data: 事件数据

    Returns:
        int: 通知到的连接数
    """
    message = {
        "type": "notification",
        "action": event_type,
        "repository_id": repository_id,
        "data": event_data,
        "timestamp": datetime.now().isoformat(),
    }

    return await manager.send_to_repository(repository_id, message)


async def notify_user(
    user_id: uuid.UUID,
    notification_type: str,
    data: Dict[str, Any],
    unread_count: Optional[int] = None,
) -> int:
    """
    向用户发送个人通知

    Args:
        user_id: 用户ID
        notification_type: 通知类型
        data: 通知数据
        unread_count: 推送时刻的未读数（可选，随消息下发省去客户端回查）

    Returns:
        int: 通知到的连接数
    """
    message = {
        "type": "user_notification",
        "notification_type": notification_type,
        "data": data,
        "timestamp": datetime.now().isoformat(),
    }
    if unread_count is not None:
        message["unread_count"] = unread_count

    return await manager.send_to_user(user_id, message)
