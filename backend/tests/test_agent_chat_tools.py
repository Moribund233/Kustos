"""聊天/知识域工具：list_channel_messages / search_chat_decisions。"""
from datetime import datetime, timezone

import pytest
import pytest_asyncio

from app.services.agent import tool_registry as tr
from app.services.agent.tool_registry import ToolContext
from app.services.agent.tools_server import load_server_tools


def _ctx(db, user_id=None, repo_id=None):
    return ToolContext(db=db, repository_id=repo_id, user_id=user_id)


@pytest_asyncio.fixture
async def chat_room(async_db, async_test_user):
    from app.models.chat_message import ChatMessage
    from app.models.realtime_room import RealtimeRoom, RoomMember

    room = RealtimeRoom(name="decision-room", room_type="public", is_active=True)
    async_db.add(room)
    await async_db.commit()
    await async_db.refresh(room)
    async_db.add(RoomMember(
        room_id=room.id, user_id=async_test_user.id, role="member",
        joined_at=datetime.now(timezone.utc),
    ))
    for i in range(3):
        async_db.add(ChatMessage(
            room_id=room.id, sender_id=async_test_user.id,
            content=f"决策 {i}：选择方案 X，因为延迟更低",
        ))
    await async_db.commit()
    return room


def test_chat_tools_registered():
    load_server_tools()
    assert tr.get_tool("list_channel_messages").scope == "repo:read"
    assert tr.get_tool("search_chat_decisions").scope == "repo:read"


@pytest.mark.asyncio
async def test_list_channel_messages(async_db, async_test_user, chat_room):
    load_server_tools()
    out = await tr.get_tool("list_channel_messages").handler(
        _ctx(async_db, user_id=async_test_user.id), {"room": str(chat_room.id)}
    )
    assert len(out["messages"]) == 3
    assert all("方案 X" in m["content"] for m in out["messages"])


@pytest.mark.asyncio
async def test_list_channel_messages_keyword_and_since(async_db, async_test_user, chat_room):
    load_server_tools()
    handler = tr.get_tool("list_channel_messages").handler
    kw = await handler(
        _ctx(async_db, user_id=async_test_user.id),
        {"room": str(chat_room.id), "q": "延迟"},
    )
    assert len(kw["messages"]) == 3

    since = datetime.now(timezone.utc).isoformat()
    none_yet = await handler(
        _ctx(async_db, user_id=async_test_user.id),
        {"room": str(chat_room.id), "since": since},
    )
    assert none_yet["messages"] == []  # 都在 since 之前

    bad = await handler(
        _ctx(async_db, user_id=async_test_user.id),
        {"room": str(chat_room.id), "since": "not-a-time"},
    )
    assert "error" in bad


@pytest.mark.asyncio
async def test_search_chat_decisions(async_db, async_test_user, chat_room):
    load_server_tools()
    out = await tr.get_tool("search_chat_decisions").handler(
        _ctx(async_db, user_id=async_test_user.id), {"query": "方案 X"}
    )
    assert len(out["messages"]) == 3
    assert all(m["room_name"] == "decision-room" for m in out["messages"])


@pytest.mark.asyncio
async def test_search_chat_decisions_scoped_to_membership(
    async_db, async_another_user, chat_room
):
    """非成员用户检索不到该房间消息（走权限边界）。"""
    load_server_tools()
    out = await tr.get_tool("search_chat_decisions").handler(
        _ctx(async_db, user_id=async_another_user.id), {"query": "方案 X"}
    )
    assert out["messages"] == []
