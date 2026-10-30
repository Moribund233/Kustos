import uuid
import logging
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models.realtime_room import RealtimeRoom, RoomMember, DirectMessage
from app.models.user import User
from app.core.exception import ValidationException, NotFoundException

logger = logging.getLogger(__name__)


VALID_ROLES = {"member", "admin"}


class RoomService:

    @staticmethod
    async def create_room(
        db: AsyncSession,
        repository_id: uuid.UUID,
        name: str,
        created_by_user_id: uuid.UUID
    ) -> RealtimeRoom:
        existing = await RoomService.get_repository_room(db, repository_id)
        if existing:
            raise ValidationException(f"仓库 {repository_id} 已有关联房间", error_code="room_already_exists")

        room = RealtimeRoom(
            repository_id=repository_id,
            name=name,
            is_active=True
        )
        db.add(room)
        await db.flush()
        await db.refresh(room)

        member = RoomMember(
            room_id=room.id,
            user_id=created_by_user_id,
            role="admin",
            joined_at=datetime.now(timezone.utc),
            last_read_at=datetime.now(timezone.utc),
        )
        db.add(member)
        await db.flush()

        # Agent 启用时 bot 预置为频道成员（成员列表/@ 选择器从建房即可见）
        await RoomService.ensure_bot_member(db, room.id)

        return room

    @staticmethod
    async def ensure_bot_member(db: AsyncSession, room_id: uuid.UUID) -> None:
        """把 bot 加入指定房间（幂等；Agent 未启用时跳过）。

        失败绝不阻断建房主流程——首条回帖时 ``post_bot_message`` 仍会懒加入。
        """
        try:
            from app.core.config import get_config

            if not get_config().agent.enabled:
                return
            from app.services.agent.agent_service import AgentService

            bot = await AgentService().ensure_bot_user(db, commit=False)
            existing = (
                await db.execute(
                    select(RoomMember).where(
                        RoomMember.room_id == room_id,
                        RoomMember.user_id == bot.id,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                return
            db.add(
                RoomMember(
                    room_id=room_id,
                    user_id=bot.id,
                    role="member",
                    joined_at=datetime.now(timezone.utc),
                )
            )
            await db.flush()
        except Exception:  # noqa: BLE001 — 频道成员属增强信息，不阻断建房
            logger.exception("bot 加入频道失败 room=%s", room_id)

    @staticmethod
    async def add_bot_to_repository_rooms(db: AsyncSession, bot_id: uuid.UUID) -> int:
        """Agent 启用后回填：bot 加入全部活跃仓库频道（幂等，返回新增数）"""
        room_ids = (
            (
                await db.execute(
                    select(RealtimeRoom.id).where(
                        RealtimeRoom.is_active.is_(True),
                        RealtimeRoom.room_type == "repository",
                        RealtimeRoom.repository_id.is_not(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        if not room_ids:
            return 0
        existing = set(
            (
                await db.execute(
                    select(RoomMember.room_id).where(
                        RoomMember.user_id == bot_id,
                        RoomMember.room_id.in_(room_ids),
                    )
                )
            )
            .scalars()
            .all()
        )
        added = 0
        for rid in room_ids:
            if rid in existing:
                continue
            db.add(
                RoomMember(
                    room_id=rid,
                    user_id=bot_id,
                    role="member",
                    joined_at=datetime.now(timezone.utc),
                )
            )
            added += 1
        if added:
            await db.flush()
        return added

    @staticmethod
    async def get_room(db: AsyncSession, room_id: uuid.UUID) -> Optional[RealtimeRoom]:
        result = await db.execute(
            select(RealtimeRoom).filter(RealtimeRoom.id == room_id)
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def get_repository_room(db: AsyncSession, repository_id: uuid.UUID) -> Optional[RealtimeRoom]:
        result = await db.execute(
            select(RealtimeRoom).filter(
                RealtimeRoom.repository_id == repository_id,
                RealtimeRoom.is_active.is_(True)
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def list_rooms(db: AsyncSession, user_id: uuid.UUID) -> List[RealtimeRoom]:
        result = await db.execute(
            select(RealtimeRoom)
            .join(RoomMember, RoomMember.room_id == RealtimeRoom.id)
            .filter(
                RoomMember.user_id == user_id,
                RealtimeRoom.is_active.is_(True),
                RealtimeRoom.room_type == "repository",
            )
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_or_create_dm_room(
        db: AsyncSession,
        user_a_id: uuid.UUID,
        user_b_id: uuid.UUID
    ) -> RealtimeRoom:
        """获取或创建两个用户之间的私聊会话（幂等，任一发起方向命中同一会话）."""
        if user_a_id == user_b_id:
            raise ValidationException("不能与自己建立私聊会话", error_code="dm_self_chat_forbidden")

        result = await db.execute(
            select(User).filter(User.id.in_([user_a_id, user_b_id]))
        )
        users = result.scalars().all()
        if len(users) != 2:
            raise ValidationException("私聊用户不存在", error_code="dm_user_not_found")
        user_map = {u.id: u for u in users}

        a, b = sorted([user_a_id, user_b_id], key=str)
        dm_result = await db.execute(
            select(DirectMessage)
            .options(selectinload(DirectMessage.room))
            .filter(
                DirectMessage.user_a_id == a,
                DirectMessage.user_b_id == b,
            )
        )
        existing = dm_result.scalar_one_or_none()
        if existing and existing.room and existing.room.is_active:
            return existing.room

        room = RealtimeRoom(
            repository_id=None,
            name=f"{user_map[user_a_id].username} & {user_map[user_b_id].username}",
            is_active=True,
            room_type="dm",
        )
        db.add(room)
        await db.flush()

        dm = DirectMessage(
            room_id=room.id,
            user_a_id=a,
            user_b_id=b,
        )
        db.add(dm)

        now = datetime.now(timezone.utc)
        db.add(RoomMember(
            room_id=room.id,
            user_id=user_a_id,
            role="member",
            joined_at=now,
            last_read_at=now,
        ))
        db.add(RoomMember(
            room_id=room.id,
            user_id=user_b_id,
            role="member",
            joined_at=now,
            last_read_at=now,
        ))
        await db.flush()
        await db.refresh(room)
        return room

    @staticmethod
    async def list_dm_rooms(db: AsyncSession, user_id: uuid.UUID) -> List[Dict[str, Any]]:
        """列出当前用户参与的私聊会话（含对方信息）."""
        result = await db.execute(
            select(DirectMessage)
            .options(
                selectinload(DirectMessage.room),
                selectinload(DirectMessage.user_a),
                selectinload(DirectMessage.user_b),
            )
            .filter(
                (DirectMessage.user_a_id == user_id) | (DirectMessage.user_b_id == user_id)
            )
            .order_by(DirectMessage.created_at.desc())
        )
        rows = result.scalars().all()

        items = []
        for dm in rows:
            room = dm.room
            if not room or not room.is_active:
                continue
            peer = dm.user_b if dm.user_a_id == user_id else dm.user_a
            items.append({
                "room_id": room.id,
                "room_name": room.name,
                "room_type": room.room_type,
                "peer_user_id": peer.id,
                "peer_username": peer.username,
                "created_at": room.created_at.isoformat() if room.created_at else None,
            })
        return items

    @staticmethod
    async def join_room(db: AsyncSession, room_id: uuid.UUID, user_id: uuid.UUID) -> RoomMember:
        result = await db.execute(
            select(RoomMember).filter(
                RoomMember.room_id == room_id,
                RoomMember.user_id == user_id
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            return existing

        member = RoomMember(
            room_id=room_id,
            user_id=user_id,
            role="member",
            joined_at=datetime.now(timezone.utc),
            last_read_at=datetime.now(timezone.utc),
        )
        db.add(member)
        await db.flush()
        await db.refresh(member)
        return member

    @staticmethod
    async def leave_room(db: AsyncSession, room_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        result = await db.execute(
            select(RoomMember).filter(
                RoomMember.room_id == room_id,
                RoomMember.user_id == user_id
            )
        )
        member = result.scalar_one_or_none()
        if not member:
            return False
        await db.delete(member)
        await db.flush()
        return True

    @staticmethod
    async def get_members(db: AsyncSession, room_id: uuid.UUID) -> List[Dict[str, Any]]:
        result = await db.execute(
            select(RoomMember)
            .options(selectinload(RoomMember.user))
            .filter(RoomMember.room_id == room_id)
        )
        members = result.scalars().all()
        return [
            {
                "id": m.id,
                "room_id": m.room_id,
                "user_id": m.user_id,
                "username": m.user.username,
                "role": m.role,
                "joined_at": m.joined_at.isoformat() if m.joined_at else None,
                "is_muted": m.is_muted,
                # 前端据此置顶 bot 并固定「在线」（bot 无 WS 连接，presence 永远不含它）
                "is_bot": bool(getattr(m.user, "is_bot", False)),
            }
            for m in members
        ]

    @staticmethod
    async def set_member_muted(
        db: AsyncSession,
        room_id: uuid.UUID,
        user_id: uuid.UUID,
        muted: bool,
    ) -> Dict[str, Any]:
        """设置本人对某一会话的静音状态（不改变其他成员维度）."""
        result = await db.execute(
            select(RoomMember).filter(
                RoomMember.room_id == room_id,
                RoomMember.user_id == user_id
            )
        )
        member = result.scalar_one_or_none()
        if member is None:
            raise NotFoundException("你不是该房间的成员", error_code="room_member_not_found")

        member.is_muted = bool(muted)
        await db.flush()
        await db.refresh(member)
        return {
            "room_id": str(member.room_id),
            "user_id": str(member.user_id),
            "role": member.role,
            "is_muted": member.is_muted,
        }

    @staticmethod
    async def update_member_role(
        db: AsyncSession,
        room_id: uuid.UUID,
        user_id: uuid.UUID,
        role: str
    ) -> RoomMember:
        if role not in VALID_ROLES:
            raise ValidationException(f"无效的角色: {role}，有效值: {', '.join(sorted(VALID_ROLES))}", error_code="room_invalid_role")

        result = await db.execute(
            select(RoomMember).filter(
                RoomMember.room_id == room_id,
                RoomMember.user_id == user_id
            )
        )
        member = result.scalar_one_or_none()
        if not member:
            raise ValidationException("成员不存在", error_code="room_member_not_found")

        member.role = role
        await db.flush()
        await db.refresh(member)
        return member

    @staticmethod
    async def remove_member(db: AsyncSession, room_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        result = await db.execute(
            select(RoomMember).filter(
                RoomMember.room_id == room_id,
                RoomMember.user_id == user_id
            )
        )
        member = result.scalar_one_or_none()
        if not member:
            return False
        await db.delete(member)
        await db.flush()
        return True

    @staticmethod
    async def delete_room(db: AsyncSession, room_id: uuid.UUID) -> bool:
        result = await db.execute(
            select(RealtimeRoom).filter(RealtimeRoom.id == room_id)
        )
        room = result.scalar_one_or_none()
        if not room:
            return False
        room.is_active = False
        await db.flush()
        return True
