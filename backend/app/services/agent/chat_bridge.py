"""聊天 → Agent 作业桥：消息 @``kustos-agent`` 唤醒作业。

设计（对话进团队消息流，panel 只承担流程）：

- 用户在**仓库频道**发含 ``@kustos-agent`` 的普通消息 → 创建 Agent 作业，
  prompt = 去掉 mention 后的任务描述，``source_room_id`` 关联来源房间；
- 作业各终态由 ``AgentService._post_room_reply`` 以 bot 身份回帖（气泡进频道）；
- 桥接失败（配额超限 / 未启用 / 无权限…）只记日志并回一句提示，
  **绝不影响消息本身的发送**。

收口在 ``ChatService.send_message``（REST/WS 两条入口共用），避免各 handler
各接一遍、新入口漏接。
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from sqlalchemy import select

from app.core.exception import (
    AuthorizationException,
    ConflictException,
    HttpStatusException,
    NotFoundException,
    RateLimitException,
    ValidationException,
)

logger = logging.getLogger(__name__)

#: ``create_job`` 可能抛出的业务异常——**全部继承 BaseException**（非 Exception），
#: 必须显式列出；漏一个就会让消息发送被业务拒绝打崩。
_BRIDGE_EXPECTED = (
    Exception,
    AuthorizationException,
    ConflictException,
    HttpStatusException,
    NotFoundException,
    RateLimitException,
    ValidationException,
)


async def maybe_enqueue_from_mention(
    db: Any, room: Any, sender_id: uuid.UUID, content: str
) -> Optional[Any]:
    """消息含 ``@bot`` 且房间绑定仓库 → 创建作业（``source_room_id`` 关联房间）。

    Returns:
        创建的 AgentJob；不满足条件/失败 → ``None``（消息照常发送）。

    Raises: 无——一切异常在内部收敛。
    """
    if room is None or getattr(room, "repository_id", None) is None:
        return None  # 私聊/无仓库房间不接桥

    from app.services.agent_service import AGENT_BOT_USERNAME, AgentService

    mention = f"@{AGENT_BOT_USERNAME}"
    text = content or ""
    if mention not in text:
        return None

    from app.models.user import User

    sender = (
        await db.execute(select(User).where(User.id == sender_id))
    ).scalar_one_or_none()
    if sender is None or sender.is_bot:
        # bot/机器人身份的自身消息不触发桥（usage 提示里带 @bot——不设防会自递归建作业）
        return None

    prompt = " ".join(text.replace(mention, " ").split())
    service = AgentService()
    if not prompt:
        # 只 @ 不带任务：回 usage 提示（bot 气泡）
        await service.post_bot_message(
            db,
            room.id,
            f"我是 @{AGENT_BOT_USERNAME}——在 mention 后带上任务描述即可唤醒，"
            f"例如 `{mention} 解释一下 _ensure_index 的自愈逻辑`。",
        )
        return None

    try:
        # provider 预检：无 key 时不落失败作业行、不进队列——
        # 此前会入队 → worker 瞬败，用户白等一轮且多一条 0-token 失败记录
        from app.services.agent.providers import (
            NOT_CONFIGURED_MSG,
            NotConfiguredProvider,
            ProviderNotConfigured,
            get_provider,
        )

        if isinstance(get_provider(), NotConfiguredProvider):
            raise ProviderNotConfigured(NOT_CONFIGURED_MSG)

        job = await service.create_job(
            db, sender, room.repository_id, prompt, source_room_id=room.id
        )
        # 思考动画起点：入队即广播 bot typing，回帖（post_bot_message）时撤除；
        # 执行时长不可预期，前端另设超时兜底防止指示器僵死
        await _set_agent_typing(db, room.id, True)
        return job
    except _BRIDGE_EXPECTED as exc:  # noqa: BLE001 — 唤醒失败绝不阻断消息
        logger.warning("聊天唤醒 Agent 失败（消息已正常发送）: %s", exc)
        detail = getattr(exc, "detail", None) or str(exc) or type(exc).__name__
        await service.post_bot_message(db, room.id, f"⚠️ 无法创建 Agent 作业：{detail}"[:500])
        return None


async def _set_agent_typing(db: Any, room_id: uuid.UUID, is_typing: bool) -> None:
    """向房间广播 bot 的 ``chat_typing``（思考/响应动画信号；best-effort）"""
    try:
        from app.models.user import User
        from app.services.agent_service import AGENT_BOT_USERNAME

        bot = (
            await db.execute(select(User).where(User.username == AGENT_BOT_USERNAME))
        ).scalar_one_or_none()
        if bot is None:
            return
        from app.api.ws.manager import manager as websocket_manager

        await websocket_manager.send_to_room(
            room_id,
            {
                "type": "chat_typing",
                "room_id": str(room_id),
                "user_id": str(bot.id),
                "username": bot.username,
                "is_typing": is_typing,
            },
        )
    except Exception:  # noqa: BLE001 — 动画信号失败不影响作业
        logger.debug("agent typing 广播失败 room=%s", room_id, exc_info=True)
