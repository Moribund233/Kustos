"""
错误面契约测试

覆盖：
1. 错误响应统一信封 ``{detail, error{code,message,type,error_code}}``
2. 稳定错误码 ``error.error_code``——前端按码分支，不解析文案
3. 静态文案按 ``Accept-Language`` 翻译（默认 locale 为 zh）
4. 动态文案（无 i18n 词条）原样返回，不被通用文案覆盖
5. FastAPI 参数校验 422 走同一信封（``detail`` 不再是数组）
6. 路由未匹配的 404 同样带 ``error`` 信封
7. 成功面保持「裸资源表示 + 统一分页 envelope」，不引入 ``{data}`` 包裹
8. 日志分级契约：预期 4xx 业务拒绝 → WARNING 无堆栈（不稀释 error.log），
   5xx / 未预期异常 → ERROR + 完整堆栈；DB 会话回滚日志同口径
"""
import json
import logging
import uuid

from fastapi.testclient import TestClient
from starlette.requests import Request

from app.core.exception import (
    AuthenticationException,
    ConflictException,
    HttpStatusException,
)
from app.utils.exception_handler import global_exception_handler
from app.utils.response_builder import build_pagination_response


def _envelope(resp):
    """断言响应同时带 detail 与 error 信封，返回 (body, error)"""
    body = resp.json()
    assert "detail" in body, f"缺少 detail 字段: {body}"
    assert "error" in body, f"缺少 error 信封: {body}"
    err = body["error"]
    assert isinstance(err, dict), f"error 应为对象: {body}"
    assert {"code", "message", "type", "error_code"} <= set(err), f"error 字段不全: {err}"
    return body, err


def _fake_request(accept_language: str | None = None) -> Request:
    headers = [] if accept_language is None else [(b"accept-language", accept_language.encode())]
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "headers": headers,
        "server": ("testserver", 80),
        "client": ("test", 50000),
        "scheme": "http",
        "http_version": "1.1",
    })


class TestErrorEnvelope:
    """错误信封 + error_code + i18n"""

    def test_401_carries_error_code_and_default_zh(self, test_client: TestClient):
        resp = test_client.get("/api/app/audit")
        assert resp.status_code == 401
        body, err = _envelope(resp)
        assert err["code"] == 401
        assert err["error_code"] == "auth_required"
        assert body["detail"] == "需要认证"
        assert err["message"] == body["detail"]
        # 401 必须继续带 WWW-Authenticate（自定义异常经 global handler 转发）
        assert resp.headers.get("www-authenticate") == "Bearer"

    def test_401_translates_with_accept_language_en(self, test_client: TestClient):
        resp = test_client.get("/api/app/audit", headers={"Accept-Language": "en"})
        assert resp.status_code == 401
        body, err = _envelope(resp)
        assert body["detail"] == "Authentication required"
        assert err["error_code"] == "auth_required"

    def test_403_admin_required_error_code(self, test_client: TestClient, auth_headers: dict):
        resp = test_client.get("/api/app/redis/status", headers=auth_headers)
        assert resp.status_code == 403
        body, err = _envelope(resp)
        assert err["error_code"] == "admin_required"
        assert body["detail"] == "需要管理员权限"

        resp_en = test_client.get(
            "/api/app/redis/status", headers={**auth_headers, "Accept-Language": "en"}
        )
        assert resp_en.json()["detail"] == "Admin privileges required"

    def test_403_app_admin_required_translates(self, test_client: TestClient, auth_headers: dict):
        """check_app_permission 这类既有 error_code 也补齐词条，文案不再只有中文

        审计端点收紧为 admin-only（改走 get_current_admin_user →
        `admin_required`），本码锚点改用同样依赖 check_app_permission 的
        `GET /api/app/config`。
        """
        resp = test_client.get("/api/app/config", headers=auth_headers)
        assert resp.status_code == 403
        body, err = _envelope(resp)
        assert err["error_code"] == "app_admin_or_debug_required"
        assert body["detail"] == "该操作需要管理员权限或调试模式"

        resp_en = test_client.get(
            "/api/app/config", headers={**auth_headers, "Accept-Language": "en"}
        )
        assert resp_en.json()["detail"] == (
            "This operation requires admin privileges or debug mode"
        )

    def test_403_audit_is_admin_only(self, test_client: TestClient, auth_headers: dict):
        """审计端点收紧 admin-only——非管理员（含 debug 关闭时）恒 403 admin_required"""
        resp = test_client.get("/api/app/audit", headers=auth_headers)
        assert resp.status_code == 403
        _, err = _envelope(resp)
        assert err["error_code"] == "admin_required"

    def test_404_resource_error_code_translates(self, test_client: TestClient, auth_headers: dict):
        url = f"/api/v1/rooms/{uuid.uuid4()}/members"
        resp = test_client.get(url, headers=auth_headers)
        assert resp.status_code == 404
        body, err = _envelope(resp)
        assert err["error_code"] == "room_not_found"
        assert body["detail"] == "房间不存在"

        resp_en = test_client.get(
            url, headers={**auth_headers, "Accept-Language": "en"}
        )
        assert resp_en.status_code == 404
        assert resp_en.json()["detail"] == "Room not found"
        assert resp_en.json()["error"]["error_code"] == "room_not_found"


class TestRequestValidationEnvelope:
    """FastAPI 默认的 RequestValidationError 处理器被替换为统一信封"""

    def test_422_returns_string_detail_and_error_envelope(self, test_client: TestClient):
        resp = test_client.post("/api/v1/auth/login", json={"username": "someone"})
        assert resp.status_code == 422
        body, err = _envelope(resp)
        # 关键回归点：detail 不能是 FastAPI 默认的数组
        assert isinstance(body["detail"], str), f"detail 应为字符串: {body['detail']!r}"
        assert body["detail"] == "请求参数校验失败"
        assert err["code"] == 422
        assert err["error_code"] == "request_validation_error"
        assert err["type"] == "RequestValidationError"
        assert isinstance(err["details"], list) and err["details"]
        assert {"field", "message", "type"} <= set(err["details"][0])

    def test_422_translates_with_accept_language_en(self, test_client: TestClient):
        resp = test_client.post(
            "/api/v1/auth/login",
            json={"username": "someone"},
            headers={"Accept-Language": "en"},
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "Validation Error"
        assert resp.json()["error"]["error_code"] == "request_validation_error"


class TestUnmatchedRoute:
    def test_unknown_route_still_has_error_envelope(self, test_client: TestClient):
        """Starlette 自己抛的 404 不是 fastapi.HTTPException，也要带 error 信封"""
        resp = test_client.get("/api/definitely-not-a-route")
        assert resp.status_code == 404
        body, err = _envelope(resp)
        assert err["code"] == 404
        assert err["error_code"] is None
        assert body["detail"] == "Not Found"


class TestHandlerUnits:
    """直接驱动异常处理器，覆盖 i18n 与动态 detail 两条分支"""

    async def test_mapped_error_code_is_translated(self):
        resp = await global_exception_handler(
            _fake_request(),
            AuthenticationException(
                detail="Authentication required", error_code="auth_required"
            ),
        )
        payload = json.loads(resp.body)
        assert payload["detail"] == "需要认证"
        assert payload["error"]["error_code"] == "auth_required"

        resp_en = await global_exception_handler(
            _fake_request("en"),
            AuthenticationException(
                detail="Authentication required", error_code="auth_required"
            ),
        )
        assert json.loads(resp_en.body)["detail"] == "Authentication required"

    async def test_unmapped_error_code_keeps_dynamic_detail(self):
        """无 i18n 词条的 error_code 不得用通用文案覆盖动态诊断"""
        detail = "disk exploded: /data (errno 28)"
        resp = await global_exception_handler(
            _fake_request(),
            HttpStatusException(status_code=500, detail=detail, error_code="not_a_mapped_code"),
        )
        payload = json.loads(resp.body)
        assert resp.status_code == 500
        assert payload["detail"] == detail
        assert payload["error"]["message"] == detail
        assert payload["error"]["error_code"] == "not_a_mapped_code"

    async def test_401_forwards_www_authenticate_header(self):
        resp = await global_exception_handler(
            _fake_request(), AuthenticationException(detail="Authentication required")
        )
        assert resp.headers["www-authenticate"] == "Bearer"


class TestLogHygiene:
    """日志分级契约：预期 4xx 不得 ERROR + 堆栈稀释 error.log"""

    async def test_client_error_logs_warning_without_traceback(self, caplog):
        """409 等业务拒绝 → WARNING 单行，无堆栈"""
        try:
            raise ConflictException(detail="Username already exists")
        except ConflictException as exc:
            with caplog.at_level(logging.INFO):
                await global_exception_handler(_fake_request(), exc)
        records = [
            r for r in caplog.records if "ConflictException" in r.getMessage()
        ]
        assert records, "4xx 业务异常应被记录"
        assert all(r.levelno == logging.WARNING for r in records)
        assert not any("Traceback" in r.getMessage() for r in records)

    async def test_server_error_logs_error_with_traceback(self, caplog):
        """5xx / 未预期异常保持 ERROR + 完整堆栈"""
        try:
            raise HttpStatusException(status_code=500, detail="boom")
        except HttpStatusException as exc:
            with caplog.at_level(logging.INFO):
                await global_exception_handler(_fake_request(), exc)
        records = [
            r for r in caplog.records if "HttpStatusException" in r.getMessage()
        ]
        assert records
        assert all(r.levelno == logging.ERROR for r in records)
        assert any("Traceback" in r.getMessage() for r in records)

    def test_db_session_rollback_log_downgrades_client_error(self, caplog):
        """会话回滚日志同口径：4xx → debug，其余 → error（避免双重 ERROR）"""
        from app.models.async_db import _log_session_exception

        # 用例断言 debug 级日志：显式把目标 logger 提到 DEBUG，
        # 否则容器里 LOG_LEVEL=warning 会把这条记录直接丢掉
        with caplog.at_level(logging.DEBUG, logger="app.models.async_db"):
            _log_session_exception(ConflictException(detail="duplicate"))
            _log_session_exception(RuntimeError("connection reset"))

        conflict = [r for r in caplog.records if "duplicate" in r.getMessage()]
        boom = [r for r in caplog.records if "connection reset" in r.getMessage()]
        assert conflict and conflict[0].levelno == logging.DEBUG
        assert boom and boom[0].levelno == logging.ERROR


class TestSuccessFaceContract:
    """成功面定契约不改形：裸资源表示 + 7 键分页 envelope"""

    def test_pagination_envelope_shape_is_stable(self):
        payload = build_pagination_response([1, 2, 3], total=10, page=2, limit=3)
        assert set(payload) == {
            "items", "total", "page", "limit", "pages", "has_next", "has_prev",
        }
        assert payload["pages"] == 4
        assert payload["has_next"] is True
        assert payload["has_prev"] is True

    def test_success_response_is_bare_resource_without_data_wrapper(
        self, test_client: TestClient, auth_headers: dict
    ):
        resp = test_client.get("/api/app/status", headers=auth_headers)
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, dict)
        assert "error" not in body, "成功响应不应带 error 信封"
        assert "data" not in body, "成功面维持裸资源表示，不引入 {data} 包裹"
