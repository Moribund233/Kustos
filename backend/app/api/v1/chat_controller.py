from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.models.async_db import get_async_db
from app.models.user import User
from app.api.deps import get_current_user
from app.services.realtime.chat_service import ChatService
from app.services.realtime.room_service import RoomService
from app.core.exception import NotFoundException
from app.core.constants import DEFAULT_PAGE_SIZE_LARGE, MAX_PAGE_SIZE
import uuid


router = APIRouter(tags=["chat"])


@router.get("/api/v1/rooms/unread")
async def get_unread_counts(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    return await ChatService.get_unread_counts(db, current_user.id)


@router.post("/api/v1/rooms/{room_id}/read")
async def mark_room_read(
    room_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    success = await ChatService.mark_read(db, room_id, current_user.id)
    return {"success": success}


@router.get("/api/v1/rooms/{room_id}/messages")
async def get_room_messages(
    room_id: uuid.UUID,
    before: Optional[uuid.UUID] = Query(None),
    limit: int = Query(DEFAULT_PAGE_SIZE_LARGE, ge=1, le=MAX_PAGE_SIZE),
    q: Optional[str] = Query(None, description="按内容关键词筛选消息"),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    room = await RoomService.get_room(db, room_id)
    if not room:
        raise NotFoundException("Room not found", error_code="room_not_found")
    return await ChatService.get_messages(db, room_id, current_user.id, before=before, limit=limit, q=q)


@router.get("/api/v1/messages/search")
async def search_messages(
    q: str = Query(..., description="搜索关键词"),
    limit: int = Query(DEFAULT_PAGE_SIZE_LARGE, ge=1, le=MAX_PAGE_SIZE),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """跨当前用户加入的全部会话检索消息（聊天侧边栏搜索框）"""
    return await ChatService.search_messages(db, current_user.id, q=q, limit=limit)


class MessageEditRequest(BaseModel):
    """编辑消息请求体"""

    content: str = Field(..., min_length=1, description="新的消息内容")


@router.patch("/api/v1/rooms/{room_id}/messages/{msg_id}")
async def edit_room_message(
    room_id: uuid.UUID,
    msg_id: uuid.UUID,
    data: MessageEditRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    编辑自己发送的消息

    编辑后向房间广播 `chat_message_updated`，其余在线端据此就地替换文本，
    不必重新拉取整页历史。

    Args:
        room_id: 房间 ID（消息必须属于该房间）
        msg_id: 消息 ID
        data: 新内容
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 更新后的消息

    Raises:
        NotFoundException: 房间或消息不存在
        ValidationException: 非本人消息或内容为空
    """
    room = await RoomService.get_room(db, room_id)
    if not room:
        raise NotFoundException("Room not found", error_code="room_not_found")

    updated = await ChatService.edit_message(db, msg_id, current_user.id, data.content, room_id=room_id)

    # 广播失败不影响编辑结果：消息已落库，其他端下次拉取时自然一致
    try:
        from app.utils.ws_manager import ConnectionManager

        await ConnectionManager().send_to_room(
            room_id,
            {"type": "chat_message_updated", "room_id": room_id, "message": updated},
            exclude_user_id=current_user.id,
        )
    except Exception:  # noqa: BLE001 - 实时推送是尽力而为
        pass

    return updated


@router.delete("/api/v1/rooms/{room_id}/messages/{msg_id}")
async def delete_message(
    room_id: uuid.UUID,
    msg_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    success = await ChatService.delete_message(db, msg_id, current_user.id)
    if not success:
        raise NotFoundException("Message not found", error_code="message_not_found")
    return {"success": True}


@router.post("/api/v1/rooms/{room_id}/messages/{msg_id}/reactions")
async def add_message_reaction(
    room_id: uuid.UUID,
    msg_id: uuid.UUID,
    payload: dict,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    emoji: str = (payload or {}).get("emoji") or ""
    return await ChatService.add_reaction(db, msg_id, current_user.id, emoji)


@router.delete("/api/v1/rooms/{room_id}/messages/{msg_id}/reactions")
async def remove_message_reaction(
    room_id: uuid.UUID,
    msg_id: uuid.UUID,
    payload: dict,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    emoji: str = (payload or {}).get("emoji") or ""
    return await ChatService.remove_reaction(db, msg_id, current_user.id, emoji)
