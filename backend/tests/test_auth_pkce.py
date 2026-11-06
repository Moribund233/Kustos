"""PKCE 授权码流测试

桌面端的登录缺口是：企业环境的 SSO/2FA 账号无法在应用内输入密码，只能被迫
开浏览器。PKCE 授权码流让桌面端把登录交给系统浏览器，再把授权码换回令牌，
全程不接触用户密码，也不需要为 `kustos://` 源开放 CORS。

安全要点（缺一即等于没有 PKCE）：

- **code_verifier 只在桌面端**，服务端只存它的 SHA256（code_challenge）；
- 授权码**一次性**：用过即失效，重放必须失败；
- 授权码**绑定** client_id / redirect_uri / code_challenge，换一个都不行；
- 授权码**短命**：默认 5 分钟，过期即失效。
"""

import base64
import hashlib
import uuid

import pytest

from app.models.user import User
from app.services.auth.token_service import create_access_token
from tests.test_helpers import create_test_repo


def _bearer(user):
    token = create_access_token(
        {
            "sub": str(user.id),
            "username": user.username,
            "is_admin": user.is_admin,
        }
    )
    return {"Authorization": f"Bearer {token}"}


def _pkce_pair():
    """生成 (verifier, challenge)：S256 是唯一推荐的变换。"""
    verifier = (
        base64.urlsafe_b64encode(uuid.uuid4().bytes + uuid.uuid4().bytes)
        .decode()
        .rstrip("=")
    )
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


CLIENT_ID = "kustos-desktop"
REDIRECT_URI = "kustos://auth/callback"


class TestAuthorize:
    """GET /auth/pkce/authorize —— 用户在浏览器里已登录后，同意授权"""

    def _authorize(self, client, user, challenge, **overrides):
        params = {
            "client_id": CLIENT_ID,
            "redirect_uri": REDIRECT_URI,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "st-123",
        }
        params.update(overrides)
        return client.get(
            "/api/v1/auth/pkce/authorize", params=params, headers=_bearer(user)
        )

    def test_requires_login(self, test_client):
        """浏览器里没登录就不能授权"""
        _, challenge = _pkce_pair()
        resp = test_client.get(
            "/api/v1/auth/pkce/authorize",
            params={
                "client_id": CLIENT_ID,
                "redirect_uri": REDIRECT_URI,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            },
        )
        assert resp.status_code in (401, 403)

    def test_returns_code_and_state(self, test_client, db, test_user):
        _, challenge = _pkce_pair()
        resp = self._authorize(test_client, test_user, challenge)
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"]
        assert body["state"] == "st-123"

    def test_rejects_plain_method(self, test_client, db, test_user):
        """只允许 S256；plain 等于把 verifier 明文传递，失去 PKCE 意义"""
        _, challenge = _pkce_pair()
        resp = self._authorize(
            test_client, test_user, challenge, code_challenge_method="plain"
        )
        assert resp.status_code == 400

    def test_rejects_unsupported_redirect_uri(self, test_client, db, test_user):
        """redirect_uri 必须与已注册的一致，否则授权码会流向任意地址"""
        _, challenge = _pkce_pair()
        resp = self._authorize(
            test_client, test_user, challenge, redirect_uri="https://evil.example/steal"
        )
        assert resp.status_code == 400

    def test_rejects_unknown_client(self, test_client, db, test_user):
        _, challenge = _pkce_pair()
        resp = self._authorize(
            test_client, test_user, challenge, client_id="unknown-app"
        )
        assert resp.status_code == 400


class TestTokenExchange:
    """POST /auth/pkce/token —— 桌面端用 code + verifier 换令牌"""

    def _code(self, client, user):
        _, challenge = _pkce_pair()
        resp = client.get(
            "/api/v1/auth/pkce/authorize",
            params={
                "client_id": CLIENT_ID,
                "redirect_uri": REDIRECT_URI,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": "s",
            },
            headers=_bearer(user),
        )
        assert resp.status_code == 200
        return resp.json()["code"]

    def _exchange(self, client, code, verifier, **overrides):
        payload = {
            "grant_type": "authorization_code",
            "client_id": CLIENT_ID,
            "redirect_uri": REDIRECT_URI,
            "code": code,
            "code_verifier": verifier,
        }
        payload.update(overrides)
        return client.post("/api/v1/auth/pkce/token", json=payload)

    def test_happy_path_issues_tokens(self, test_client, db, test_user):
        verifier, challenge = _pkce_pair()
        code = self._code_for(test_client, test_user, challenge)
        resp = self._exchange(test_client, code, verifier)
        assert resp.status_code == 200
        body = resp.json()
        assert body["access_token"]
        assert body["refresh_token"]
        assert body["token_type"] == "bearer"

    def test_code_is_single_use(self, test_client, db, test_user):
        """重放同一个授权码必须失败——否则截获一次即可无限换令牌"""
        verifier, challenge = _pkce_pair()
        code = self._code_for(test_client, test_user, challenge)
        assert self._exchange(test_client, code, verifier).status_code == 200
        assert self._exchange(test_client, code, verifier).status_code in (400, 401)

    def test_wrong_verifier_rejected(self, test_client, db, test_user):
        """verifier 与 challenge 不匹配，说明换令牌的不是发起授权的那一方"""
        _, challenge = _pkce_pair()
        code = self._code_for(test_client, test_user, challenge)
        wrong_verifier, _ = _pkce_pair()
        resp = self._exchange(test_client, code, wrong_verifier)
        assert resp.status_code in (400, 401)

    def test_redirect_uri_must_match(self, test_client, db, test_user):
        """换令牌时 redirect_uri 与授权时不一致必须失败。

        返回 401 而非 400：校验失败一律同一状态码与文案，避免把"码是否存在"
        "是否过期""回调是否匹配"区分开，成为枚举工具。
        """
        verifier, challenge = _pkce_pair()
        code = self._code_for(test_client, test_user, challenge)
        resp = self._exchange(
            test_client, code, verifier, redirect_uri="https://evil.example/cb"
        )
        assert resp.status_code == 401

    def test_unknown_code_rejected(self, test_client, db, test_user):
        verifier, _ = _pkce_pair()
        resp = self._exchange(test_client, "not-a-real-code", verifier)
        assert resp.status_code in (400, 401)

    def _code_for(self, client, user, challenge):
        resp = client.get(
            "/api/v1/auth/pkce/authorize",
            params={
                "client_id": CLIENT_ID,
                "redirect_uri": REDIRECT_URI,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": "s",
            },
            headers=_bearer(user),
        )
        assert resp.status_code == 200, resp.text
        return resp.json()["code"]


class TestDeviceRegistration:
    def test_exchange_registers_device(self, test_client, db, test_user):
        """换令牌时应登记设备，否则"已登录设备"里看不到桌面端这台"""
        verifier, challenge = _pkce_pair()
        code = test_client.get(
            "/api/v1/auth/pkce/authorize",
            params={
                "client_id": CLIENT_ID,
                "redirect_uri": REDIRECT_URI,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": "s",
            },
            headers=_bearer(test_user),
        ).json()["code"]

        resp = test_client.post(
            "/api/v1/auth/pkce/token",
            json={
                "grant_type": "authorization_code",
                "client_id": CLIENT_ID,
                "redirect_uri": REDIRECT_URI,
                "code": code,
                "code_verifier": verifier,
                "device_id": "desk-1",
                "device_name": "Kustos Desktop",
                "platform": "desktop",
            },
        )
        assert resp.status_code == 200

        sessions = test_client.get("/api/v1/auth/sessions", headers=_bearer(test_user))
        assert sessions.status_code == 200
        names = [s["device_name"] for s in sessions.json()["sessions"]]
        assert "Kustos Desktop" in names
