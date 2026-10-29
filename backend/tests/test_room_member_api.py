"""
房间成员管理 — API 集成测试

覆盖加成/改角色/禁言/移除四条路径与权限边界。成员管理的服务层方法早已存在，
这里守的是「路由与守卫」这一层。
"""
import pytest


def _headers_for(user) -> dict:
    """为任意用户生成访问令牌（造第二个用户时用）."""
    from app.services.token_service import create_access_token

    token = create_access_token(
        {"sub": str(user.id), "username": user.username, "is_admin": user.is_admin}
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def peer_user(db):
    """第二个非管理员用户，用作被加/被移除的成员."""
    from app.models.user import User

    user = User(
        username="peeruser",
        email="peer@example.com",
        password="hashed_password_string",
        full_name="Peer User",
        is_active=True,
        is_admin=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def peer_headers(peer_user):
    return _headers_for(peer_user)


def _create_room(test_client, auth_headers, name: str) -> str:
    """建一个公开仓库并取它按需补建的频道 ID."""
    resp = test_client.post(
        "/api/v1/repositories",
        json={"name": name, "description": "test", "is_public": True},
        headers=auth_headers,
    )
    repo_id = resp.json()["id"]
    room = test_client.get(f"/api/v1/repositories/{repo_id}/room", headers=auth_headers)
    return room.json()["id"]


def test_add_member_by_room_admin(test_client, auth_headers, peer_user):
    room_id = _create_room(test_client, auth_headers, "member-add-repo")

    response = test_client.post(
        f"/api/v1/rooms/{room_id}/members",
        json={"user_id": str(peer_user.id)},
        headers=auth_headers,
    )

    assert response.status_code == 201
    data = response.json()
    assert data["user_id"] == str(peer_user.id)
    assert data["username"] == "peeruser"
    assert data["role"] == "member"


def test_add_member_is_idempotent(test_client, auth_headers, peer_user):
    room_id = _create_room(test_client, auth_headers, "member-idempotent-repo")

    first = test_client.post(
        f"/api/v1/rooms/{room_id}/members",
        json={"user_id": str(peer_user.id)},
        headers=auth_headers,
    )
    second = test_client.post(
        f"/api/v1/rooms/{room_id}/members",
        json={"user_id": str(peer_user.id)},
        headers=auth_headers,
    )

    assert first.status_code == 201
    assert second.status_code == 201
    members = test_client.get(f"/api/v1/rooms/{room_id}/members", headers=auth_headers).json()
    assert len([m for m in members if m["user_id"] == str(peer_user.id)]) == 1


def test_add_member_requires_admin(test_client, auth_headers, peer_user, peer_headers):
    room_id = _create_room(test_client, auth_headers, "member-perm-repo")

    # 非成员的其他用户既不是房间管理员也无仓库权限
    response = test_client.post(
        f"/api/v1/rooms/{room_id}/members",
        json={"user_id": str(peer_user.id)},
        headers=peer_headers,
    )

    assert response.status_code == 403


def test_add_unknown_user_returns_404(test_client, auth_headers):
    room_id = _create_room(test_client, auth_headers, "member-unknown-repo")
    response = test_client.post(
        f"/api/v1/rooms/{room_id}/members",
        json={"user_id": "00000000-0000-0000-0000-000000000000"},
        headers=auth_headers,
    )
    assert response.status_code == 404


def test_update_member_role(test_client, auth_headers, peer_user):
    room_id = _create_room(test_client, auth_headers, "member-role-repo")
    test_client.post(
        f"/api/v1/rooms/{room_id}/members",
        json={"user_id": str(peer_user.id)},
        headers=auth_headers,
    )

    response = test_client.patch(
        f"/api/v1/rooms/{room_id}/members/{peer_user.id}",
        json={"role": "admin"},
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json()["role"] == "admin"


def test_update_member_without_fields_is_rejected(test_client, auth_headers, peer_user):
    room_id = _create_room(test_client, auth_headers, "member-empty-repo")
    test_client.post(
        f"/api/v1/rooms/{room_id}/members",
        json={"user_id": str(peer_user.id)},
        headers=auth_headers,
    )

    response = test_client.patch(
        f"/api/v1/rooms/{room_id}/members/{peer_user.id}",
        json={},
        headers=auth_headers,
    )

    assert response.status_code in (400, 422)


def test_update_member_muted(test_client, auth_headers, peer_user):
    room_id = _create_room(test_client, auth_headers, "member-mute-repo")
    test_client.post(
        f"/api/v1/rooms/{room_id}/members",
        json={"user_id": str(peer_user.id)},
        headers=auth_headers,
    )

    response = test_client.patch(
        f"/api/v1/rooms/{room_id}/members/{peer_user.id}",
        json={"muted": True},
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json()["is_muted"] is True


def test_remove_member_by_admin(test_client, auth_headers, peer_user):
    room_id = _create_room(test_client, auth_headers, "member-remove-repo")
    test_client.post(
        f"/api/v1/rooms/{room_id}/members",
        json={"user_id": str(peer_user.id)},
        headers=auth_headers,
    )

    response = test_client.delete(
        f"/api/v1/rooms/{room_id}/members/{peer_user.id}", headers=auth_headers
    )

    assert response.status_code == 200
    members = test_client.get(f"/api/v1/rooms/{room_id}/members", headers=auth_headers).json()
    assert all(m["user_id"] != str(peer_user.id) for m in members)


def test_member_can_leave_without_admin(test_client, auth_headers, peer_user, peer_headers):
    room_id = _create_room(test_client, auth_headers, "member-leave-repo")
    test_client.post(
        f"/api/v1/rooms/{room_id}/members",
        json={"user_id": str(peer_user.id)},
        headers=auth_headers,
    )

    # 移除自己不需要管理权限
    response = test_client.delete(
        f"/api/v1/rooms/{room_id}/members/{peer_user.id}", headers=peer_headers
    )

    assert response.status_code == 200


def test_remove_non_member_returns_404(test_client, auth_headers, peer_user):
    room_id = _create_room(test_client, auth_headers, "member-missing-repo")
    response = test_client.delete(
        f"/api/v1/rooms/{room_id}/members/{peer_user.id}", headers=auth_headers
    )
    assert response.status_code == 404
