"""WebSocket 认证改走握手头

原实现把 access token 放 URL query（``/ws?token=<jwt>``）——Nginx 的
``access_log`` 记录完整 URI，等于把密钥写进日志。改为
``Sec-WebSocket-Protocol: kustos-bearer, <jwt>``（握手头不进访问日志），
并保留 query 作为兼容通道（服务端告警）。

两个容易踩的点由本文件固化：
1. **服务端必须回显子协议**（RFC 6455：响应的子协议必须来自客户端提供的列表），
   否则浏览器直接报 "server did not accept the offered subprotocol"；
2. 无 token 的握手（匿名端点）也要能连——客户端仍提供固定协议名。
"""
import pytest
from starlette.websockets import WebSocketDisconnect

#: 与 ``api/websocket/auth.py::SUBPROTOCOL`` / ``api/wsAuth.ts`` 保持一致
SUBPROTOCOL = "kustos-bearer"


def _token(auth_headers: dict) -> str:
    return auth_headers["Authorization"].split(" ", 1)[1]


class TestTokenViaSubprotocol:
    """新路径：token 走 Sec-WebSocket-Protocol"""

    def test_logs_ws_echoes_subprotocol(self, test_client, admin_headers):
        token = _token(admin_headers)
        with test_client.websocket_connect(
            "/ws/logs", subprotocols=[SUBPROTOCOL, token]
        ) as ws:
            # 服务端必须回显其一，否则浏览器拒绝连接（的关键约束）
            assert ws.accepted_subprotocol == SUBPROTOCOL
            connected = ws.receive_json()
            assert connected["type"] == "connected"
            assert connected["authenticated"] is True

    def test_general_ws_header_token(self, test_client, auth_headers):
        token = _token(auth_headers)
        with test_client.websocket_connect(
            "/ws/", subprotocols=[SUBPROTOCOL, token]
        ) as ws:
            assert ws.accepted_subprotocol == SUBPROTOCOL
            connected = ws.receive_json()
            assert connected["type"] == "connected"
            assert connected["authenticated"] is True

    def test_notifications_ws_header_token(self, test_client, auth_headers):
        token = _token(auth_headers)
        with test_client.websocket_connect(
            "/ws/notifications", subprotocols=[SUBPROTOCOL, token]
        ) as ws:
            assert ws.accepted_subprotocol == SUBPROTOCOL

    def test_anonymous_offering_protocol_still_connects(self, test_client):
        """匿名端点只提供固定协议名（无 token）也要能连，且服务端照旧回显"""
        with test_client.websocket_connect("/ws/", subprotocols=[SUBPROTOCOL]) as ws:
            assert ws.accepted_subprotocol == SUBPROTOCOL
            connected = ws.receive_json()
            assert connected["type"] == "connected"
            assert not connected.get("authenticated")

    def test_missing_token_rejected(self, test_client):
        with pytest.raises(WebSocketDisconnect):
            with test_client.websocket_connect("/ws/logs", subprotocols=[SUBPROTOCOL]):
                pass

    def test_invalid_token_rejected(self, test_client):
        with pytest.raises(WebSocketDisconnect):
            with test_client.websocket_connect(
                "/ws/logs", subprotocols=[SUBPROTOCOL, "not.a.jwt.token"]
            ):
                pass


class TestQueryFallback:
    """兼容路径：URL query 仍可用（服务端告警），避免旧客户端瞬间全断"""

    def test_legacy_query_token_still_works(self, test_client, admin_headers):
        token = _token(admin_headers)
        with test_client.websocket_connect(f"/ws/logs?token={token}") as ws:
            connected = ws.receive_json()
            assert connected["type"] == "connected"
            assert connected["authenticated"] is True

    def test_legacy_access_token_param_still_works(self, test_client, admin_headers):
        token = _token(admin_headers)
        with test_client.websocket_connect(f"/ws/?access_token={token}") as ws:
            connected = ws.receive_json()
            assert connected["authenticated"] is True
