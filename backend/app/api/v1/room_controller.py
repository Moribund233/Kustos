from fastapi import APIRouter, Depends, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.models.async_db import get_async_db
from app.models.user import User
from app.api.deps import get_current_user, get_current_admin_user
from app.services.realtime.room_service import RoomService
from app.services.repository.repository_service import get_repository_by_id
from app.services.messaging.attachment_service import upload_attachment, get_attachment_file
from app.core.exception import AuthorizationException, NotFoundException, ValidationException
import uuid
from app.core.permissions import Action, has_repo_action
from app.api.guards import require_repo_read


router = APIRouter(
    tags=["rooms"],
    dependencies=[Depends(require_repo_read())],
)


@router.get("/api/v1/repositories/{repo_id}/room")
async def get_repository_room(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    room = await RoomService.get_repository_room(db, repo_id)
    if not room:
        # Fork/历史数据等路径不会创建房间, 按需补建保证仓库始终有频道
        repo = await get_repository_by_id(repo_id, db)
        if not repo:
            raise NotFoundException(detail="Repository not found", error_code="repository_not_found")
        try:
            room = await RoomService.create_room(db, repo_id, repo["name"], current_user.id)
        except ValidationException:
            # 并发请求已创建
            room = await RoomService.get_repository_room(db, repo_id)
            if not room:
                raise NotFoundException(detail="Room not found", error_code="room_not_found")
    # 存量补种（打开频道必经、会话结束自动 commit）：env 直启的部署不经过后台
    # 保存、触发不了「启用回填」钩子——建房预置只覆盖新建房间，这里按需补齐
    # bot 的频道/仓库成员（helper 内部按 agent.enabled 门禁，未启用零开销）。
    await RoomService.ensure_bot_member(db, room.id)
    if room.repository_id is not None:
        from app.services.agent.agent_service import AgentService

        await AgentService().ensure_bot_repo_member(db, room.repository_id)
    return {
        "id": room.id,
        "repository_id": room.repository_id,
        "name": room.name,
        "topic": room.topic,
        "is_active": room.is_active,
        "created_at": room.created_at.isoformat() if room.created_at else None,
    }


@router.get("/api/v1/rooms")
async def list_rooms(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    列出当前用户已加入的所有活跃房间

    Args:
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        list[dict]: 房间列表（id/repository_id/name/topic/is_active/created_at）
    """
    rooms = await RoomService.list_rooms(db, current_user.id)
    return [
        {
            "id": room.id,
            "repository_id": room.repository_id,
            "name": room.name,
            "topic": room.topic,
            "is_active": room.is_active,
            "created_at": room.created_at.isoformat() if room.created_at else None,
        }
        for room in rooms
    ]


@router.get("/api/v1/rooms/{room_id}/members")
async def get_room_members(
    room_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    room = await RoomService.get_room(db, room_id)
    if not room:
        raise NotFoundException(detail="Room not found", error_code="room_not_found")
    members = await RoomService.get_members(db, room_id)
    return members


class RoomMemberAddRequest(BaseModel):
    """添加房间成员请求体"""

    user_id: uuid.UUID
    role: str = "member"


class RoomMemberUpdateRequest(BaseModel):
    """更新房间成员请求体；`role` 与 `muted` 至少给一个"""

    role: Optional[str] = None
    muted: Optional[bool] = None


async def _require_room_admin(db: AsyncSession, room, user: User) -> None:
    """
    要求当前用户能管理该房间.

    三种身份放行：全局管理员、房间内角色 admin、以及房间所属仓库的仓库管理员
    （仓库频道是仓库的附属，仓库管理员不该因为不是建房人而被挡在外面）。

    Args:
        db: 数据库会话
        room: 房间实例
        user: 当前用户

    Raises:
        AuthorizationException: 非房间成员且无仓库管理权限，或房间角色不是 admin
    """
    if user.is_admin:
        return
    if room.repository_id is not None:
        if await has_repo_action(db, user.id, room.repository_id, Action.REPO_ADMIN):
            return
    members = await RoomService.get_members(db, room.id)
    me = next((m for m in members if str(m["user_id"]) == str(user.id)), None)
    if me is None:
        raise AuthorizationException(
            detail="You are not a member of this room", error_code="room_not_member"
        )
    if me.get("role") != "admin":
        raise AuthorizationException(
            detail="Room admin privileges required", error_code="room_admin_required"
        )


@router.post("/api/v1/rooms/{room_id}/members", status_code=201)
async def add_room_member(
    room_id: uuid.UUID,
    data: RoomMemberAddRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    把用户加入房间

    重复加入是幂等的（已存在直接返回现有成员）；指定 `role` 时同步角色。

    Args:
        room_id: 房间 ID
        data: 成员用户 ID 与角色
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 成员信息

    Raises:
        NotFoundException: 房间或用户不存在
        AuthorizationException: 无房间管理权限
    """
    room = await RoomService.get_room(db, room_id)
    if not room:
        raise NotFoundException(detail="Room not found", error_code="room_not_found")
    await _require_room_admin(db, room, current_user)

    target = await db.get(User, data.user_id)
    if not target:
        raise NotFoundException(detail="User not found", error_code="user_not_found")

    member = await RoomService.join_room(db, room_id, data.user_id)
    if data.role != member.role:
        member = await RoomService.update_member_role(db, room_id, data.user_id, data.role)

    return {
        "id": str(member.id),
        "room_id": str(member.room_id),
        "user_id": str(member.user_id),
        "username": target.username,
        "role": member.role,
        "is_muted": member.is_muted,
        "joined_at": member.joined_at.isoformat() if member.joined_at else None,
    }


@router.patch("/api/v1/rooms/{room_id}/members/{user_id}")
async def update_room_member(
    room_id: uuid.UUID,
    user_id: uuid.UUID,
    data: RoomMemberUpdateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    调整成员角色或静音状态

    Args:
        room_id: 房间 ID
        user_id: 目标成员用户 ID
        data: 角色与静音状态，至少给一个
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 成员当前状态

    Raises:
        NotFoundException: 房间或成员不存在
        ValidationException: 未提供任何可更新字段
        AuthorizationException: 无房间管理权限
    """
    room = await RoomService.get_room(db, room_id)
    if not room:
        raise NotFoundException(detail="Room not found", error_code="room_not_found")
    await _require_room_admin(db, room, current_user)

    if data.role is None and data.muted is None:
        raise ValidationException(
            detail="Nothing to update: provide role or muted", error_code="validation_error"
        )

    if data.role is not None:
        await RoomService.update_member_role(db, room_id, user_id, data.role)
    if data.muted is not None:
        return await RoomService.set_member_muted(db, room_id, user_id, data.muted)

    members = await RoomService.get_members(db, room_id)
    return next((m for m in members if str(m["user_id"]) == str(user_id)), None)


@router.delete("/api/v1/rooms/{room_id}/members/{user_id}")
async def remove_room_member(
    room_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    移除房间成员

    本人的退出请求不需要管理权限；移除他人需要房间管理员或全局管理员。

    Args:
        room_id: 房间 ID
        user_id: 目标成员用户 ID
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 是否移除成功

    Raises:
        NotFoundException: 房间不存在或目标不是成员
        AuthorizationException: 无房间管理权限
    """
    room = await RoomService.get_room(db, room_id)
    if not room:
        raise NotFoundException(detail="Room not found", error_code="room_not_found")

    if user_id != current_user.id:
        await _require_room_admin(db, room, current_user)

    removed = await RoomService.remove_member(db, room_id, user_id)
    if not removed:
        raise NotFoundException(detail="Member not found", error_code="room_member_not_found")
    return {"success": True}


class RoomMemberMuteRequest(BaseModel):
    """设置本人对某一会话的静音状态"""
    muted: bool


@router.post("/api/v1/rooms/{room_id}/members/me")
async def set_room_member_muted(
    room_id: uuid.UUID,
    data: RoomMemberMuteRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """本人静音/取消静音某会话（频道或私聊）。静音后该会话不再累计未读。"""
    room = await RoomService.get_room(db, room_id)
    if not room:
        raise NotFoundException(detail="Room not found", error_code="room_not_found")
    return await RoomService.set_member_muted(db, room_id, current_user.id, data.muted)


@router.delete("/api/v1/rooms/{room_id}")
async def delete_room(
    room_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_admin_user)
):
    room = await RoomService.get_room(db, room_id)
    if not room:
        raise NotFoundException(detail="Room not found", error_code="room_not_found")
    success = await RoomService.delete_room(db, room_id)
    return {"success": success}


@router.post("/api/v1/rooms/{room_id}/attachments")
async def upload_room_attachment(
    room_id: uuid.UUID,
    file: UploadFile = File(..., description="附件文件（最大 20MB）"),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    上传聊天附件

    仅房间成员可上传；返回的 url 可直接作为 Markdown 链接/图片插入消息内容
    """
    room = await RoomService.get_room(db, room_id)
    if not room:
        raise NotFoundException(detail="Room not found", error_code="room_not_found")

    members = await RoomService.get_members(db, room_id)
    member_ids = {str(m["user_id"]) if isinstance(m, dict) else str(m.user_id) for m in members}
    if str(current_user.id) not in member_ids:
        raise AuthorizationException(detail="You are not a member of this room", error_code="room_not_member")

    return await upload_attachment(room_id, file)


@router.get("/api/v1/attachments/{room_id}/{stored_name}")
async def download_room_attachment(
    room_id: uuid.UUID,
    stored_name: str,
    current_user: User = Depends(get_current_user),
):
    """下载聊天附件（需认证，文件名含随机 token 防遍历/猜测）"""
    file_path, content_type = await get_attachment_file(room_id, stored_name)
    return FileResponse(path=str(file_path), media_type=content_type, filename=stored_name.split("_", 1)[1])
