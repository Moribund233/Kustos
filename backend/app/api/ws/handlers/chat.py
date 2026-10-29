"""WebSocket chat message handlers"""
from typing import Dict, Any
from uuid import UUID

from app.api.ws.manager import Connection, ConnectionManager
from app.core.exception import ValidationException, NotFoundException


def _parse_uuid(value: Any) -> UUID | None:
    """WS 消息里的 id 是客户端传来的字符串, 转 UUID 供 ORM 使用"""
    if value is None:
        return None
    try:
        return value if isinstance(value, UUID) else UUID(str(value))
    except (ValueError, AttributeError):
        return None


def _get_manager():
    return ConnectionManager()


async def handle_chat_message(connection: Connection, message: Dict[str, Any]) -> None:
    user_id = connection.user_id
    if user_id is None:
        await connection.send({
            "type": "error", "error": "需要认证才能发送消息",
            "original_type": "chat_message"
        })
        return

    room_id = _parse_uuid(message.get("room_id"))
    content = message.get("content")
    reply_to = _parse_uuid(message.get("reply_to"))

    if room_id is None or not content:
        await connection.send({
            "type": "error", "error": "缺少必要字段: room_id, content",
            "original_type": "chat_message"
        })
        return

    try:
        from app.services.realtime.chat_service import ChatService
        from app.models.async_db import get_async_db_context

        async with get_async_db_context() as db:
            msg = await ChatService.send_message(db, room_id, user_id, content,
                                                  reply_to=reply_to)

            mgr = _get_manager()
            broadcast_data = {
                "type": "chat_message",
                "message": msg,
            }
            await mgr.send_to_room(room_id, broadcast_data, exclude_user_id=user_id)

            await connection.send({
                "type": "chat_message_ack",
                "message": msg,
            })
    except (ValidationException, NotFoundException) as e:
        await connection.send({
            "type": "error", "error": str(e.detail),
            "original_type": "chat_message"
        })


async def handle_chat_typing(connection: Connection, message: Dict[str, Any]) -> None:
    user_id = connection.user_id
    if user_id is None:
        await connection.send({
            "type": "error", "error": "需要认证才能发送状态",
            "original_type": "chat_typing"
        })
        return

    # 订阅索引以 UUID 为键，字符串 room_id 广播不到任何连接
    room_id = _parse_uuid(message.get("room_id"))
    is_typing = message.get("is_typing", True)

    if room_id is None:
        await connection.send({
            "type": "error", "error": "缺少或非法的 room_id",
            "original_type": "chat_typing"
        })
        return

    mgr = _get_manager()
    await mgr.send_to_room(room_id, {
        "type": "chat_typing",
        "room_id": room_id,
        "user_id": user_id,
        "username": connection.username,
        "is_typing": bool(is_typing),
    }, exclude_user_id=user_id)


async def handle_chat_reaction(connection: Connection, message: Dict[str, Any]) -> None:
    user_id = connection.user_id
    if user_id is None:
        await connection.send({
            "type": "error", "error": "需要认证才能发送回应",
            "original_type": "chat_reaction"
        })
        return

    room_id = _parse_uuid(message.get("room_id"))
    message_id = _parse_uuid(message.get("message_id"))
    emoji = message.get("emoji")

    if room_id is None or message_id is None or not emoji:
        await connection.send({
            "type": "error", "error": "缺少必要字段: room_id, message_id, emoji",
            "original_type": "chat_reaction"
        })
        return

    action = "add" if message.get("add", True) else "remove"

    try:
        from app.services.realtime.chat_service import ChatService
        from app.models.async_db import get_async_db_context

        async with get_async_db_context() as db:
            if action == "add":
                msg = await ChatService.add_reaction(db, message_id, user_id, emoji)
            else:
                msg = await ChatService.remove_reaction(db, message_id, user_id, emoji)

            mgr = _get_manager()
            broadcast_data = {
                "type": "chat_reaction",
                "room_id": room_id,
                "message": msg,
            }
            await mgr.send_to_room(room_id, broadcast_data, exclude_user_id=user_id)

            await connection.send({
                "type": "chat_reaction_ack",
                "message": msg,
            })
    except (ValidationException, NotFoundException) as e:
        await connection.send({
            "type": "error", "error": str(e.detail),
            "original_type": "chat_reaction"
        })
