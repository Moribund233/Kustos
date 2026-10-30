"""
消息编辑 — API 集成测试

`ChatService.edit_message` 早已实现，但此前没有任何入口调用它；这里守的是
`PATCH /rooms/{room_id}/messages/{msg_id}` 的路由、归属校验与本人校验。

消息通过 `db` 会话直接插入：发送消息只有 WebSocket 一条通路，REST 侧没有
发送端点，API 测试无法先发一条。
"""
import uuid
from datetime import datetime, timezone

import pytest


def _create_room(test_client, auth_headers, name: str) -> str:
    resp = test_client.post(
        "/api/v1/repositories",
        json={"name": name, "description": "test", "is_public": True},
        headers=auth_headers,
    )
    repo_id = resp.json()["id"]
    room = test_client.get(f"/api/v1/repositories/{repo_id}/room", headers=auth_headers)
    return room.json()["id"]


def _seed_message(db, room_id: str, sender_id, content: str = "原始内容") -> str:
    """直接插入一条消息，返回消息 ID."""
    from app.models.chat_message import ChatMessage

    message = ChatMessage(
        room_id=uuid.UUID(room_id),
        sender_id=sender_id,
        content=content,
        message_type="text",
        created_at=datetime.now(timezone.utc),
    )
    db.add(message)
    db.commit()
    db.refresh(message)
    return str(message.id)


def test_edit_own_message(test_client, auth_headers, test_user, db):
    room_id = _create_room(test_client, auth_headers, "msg-edit-repo")
    message_id = _seed_message(db, room_id, test_user.id)

    response = test_client.patch(
        f"/api/v1/rooms/{room_id}/messages/{message_id}",
        json={"content": "改过的内容"},
        headers=auth_headers,
    )

    assert response.status_code == 200
    data = response.json()
    assert data["content"] == "改过的内容"
    assert data["edited_at"] is not None


def test_edit_others_message_is_forbidden(test_client, auth_headers, peer_headers, peer_user, db):
    room_id = _create_room(test_client, auth_headers, "msg-edit-other-repo")
    message_id = _seed_message(db, room_id, peer_user.id, "别人发的")

    response = test_client.patch(
        f"/api/v1/rooms/{room_id}/messages/{message_id}",
        json={"content": "被改"},
        headers=auth_headers,
    )

    assert response.status_code in (400, 403)


def test_edit_message_empty_content_is_rejected(test_client, auth_headers, test_user, db):
    room_id = _create_room(test_client, auth_headers, "msg-edit-empty-repo")
    message_id = _seed_message(db, room_id, test_user.id)

    response = test_client.patch(
        f"/api/v1/rooms/{room_id}/messages/{message_id}",
        json={"content": ""},
        headers=auth_headers,
    )

    assert response.status_code in (400, 422)


def test_edit_message_of_another_room_returns_404(test_client, auth_headers, test_user, db):
    room_a = _create_room(test_client, auth_headers, "msg-edit-room-a")
    room_b = _create_room(test_client, auth_headers, "msg-edit-room-b")
    message_id = _seed_message(db, room_a, test_user.id)

    # 用另一个房间的路径去编辑：不得命中，避免把更新广播到错误房间
    response = test_client.patch(
        f"/api/v1/rooms/{room_b}/messages/{message_id}",
        json={"content": "跨房间"},
        headers=auth_headers,
    )

    assert response.status_code == 404


def test_edit_message_requires_auth(test_client, auth_headers, test_user, db):
    room_id = _create_room(test_client, auth_headers, "msg-edit-auth-repo")
    message_id = _seed_message(db, room_id, test_user.id)

    response = test_client.patch(
        f"/api/v1/rooms/{room_id}/messages/{message_id}",
        json={"content": "匿名"},
    )

    assert response.status_code in (401, 403)


@pytest.fixture
def peer_user(db):
    """第二个用户，用于验证「不能编辑别人的消息」."""
    from app.models.user import User

    user = User(
        username="msgeditpeer",
        email="msgeditpeer@example.com",
        password="hashed_password_string",
        is_active=True,
        is_admin=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def peer_headers(peer_user):
    from app.services.auth.token_service import create_access_token

    token = create_access_token(
        {"sub": str(peer_user.id), "username": peer_user.username, "is_admin": False}
    )
    return {"Authorization": f"Bearer {token}"}
