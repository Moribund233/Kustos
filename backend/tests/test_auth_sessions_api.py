"""
登录会话（设备）管理 HTTP 接口

覆盖 ``GET /auth/sessions`` 与 ``DELETE /auth/sessions/{id}``：
列表只返回本人设备、吊销他人设备 404、吊销后该 family 的 refresh 立即失效。
"""
import uuid

import pytest
from fastapi.testclient import TestClient

PASSWORD = "password123"


@pytest.fixture
def device_user(db):
    """创建密码可用的测试用户（conftest 的 test_user 存的是占位哈希）"""
    from app.models.user import User
    from app.utils.password_utils import get_password_hash

    user = User(
        username="sessionuser",
        email="session@example.com",
        password=get_password_hash(PASSWORD),
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _login(client: TestClient, device_id: str) -> dict:
    response = client.post(
        "/api/v1/auth/login",
        json={
            "username": "sessionuser",
            "password": PASSWORD,
            "device_id": device_id,
            "device_name": f"Device {device_id}",
            "platform": "desktop",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_login_lists_device_and_delete_revokes(test_client, device_user):
    login = _login(test_client, "desk-1")
    headers = {"Authorization": f"Bearer {login['token']}"}

    listed = test_client.get("/api/v1/auth/sessions", headers=headers)
    assert listed.status_code == 200
    sessions = listed.json()["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["device_name"] == "Device desk-1"
    assert sessions[0]["platform"] == "desktop"
    assert sessions[0]["revoked"] is False

    deleted = test_client.delete(
        f"/api/v1/auth/sessions/{sessions[0]['id']}", headers=headers
    )
    assert deleted.status_code == 204

    # 吊销是该设备签发的 bearer 自己的家族：令牌立即失效且 refresh 也被拒
    assert test_client.get("/api/v1/auth/sessions", headers=headers).status_code == 401
    refreshed = test_client.post(
        "/api/v1/auth/refresh", json={"refresh_token": login["refresh_token"]}
    )
    assert refreshed.status_code == 401

    # 用另一台设备的会话观察：被吊销的设备在列表里标记为已登出
    other = _login(test_client, "desk-other")
    other_headers = {"Authorization": f"Bearer {other['token']}"}
    after = test_client.get("/api/v1/auth/sessions", headers=other_headers).json()["sessions"]
    by_name = {s["device_name"]: s for s in after}
    assert by_name["Device desk-1"]["revoked"] is True
    assert by_name["Device desk-other"]["revoked"] is False


def test_sessions_requires_auth(test_client):
    assert test_client.get("/api/v1/auth/sessions").status_code in (401, 403)


def test_delete_unknown_session_is_404(test_client, device_user):
    login = _login(test_client, "desk-2")
    headers = {"Authorization": f"Bearer {login['token']}"}
    response = test_client.delete(
        f"/api/v1/auth/sessions/{uuid.uuid4()}", headers=headers
    )
    assert response.status_code == 404
