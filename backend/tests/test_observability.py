"""
观测层中间件测试（合并）

覆盖：
- 中间件栈结构：BaseHTTPMiddleware 6 层 → 3 层（concurrency / audit / observability）
- 安全响应头（原 SecurityHeadersMiddleware 合并后的语义）
- 慢请求告警（原 RequestTimeLoggerMiddleware 合并后的语义）
- 记录韧性：指标记录失败**绝不**影响请求响应
- 记录范围（middleware.scope）统一裁决
- 统计与 Prometheus 计数**同源对账**（同一进程内写入路径）
"""
import asyncio

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

import app.middleware.observability as observability_mod
from app.middleware.observability import ObservabilityMiddleware
from app.middleware.prometheus_metrics import (
    get_prometheus_metrics,
    reset_prometheus_metrics,
)
from app.middleware.request_stats import RequestStats
from app.middleware.scope import DEFAULT_EXCLUDE_PATHS, should_record


# ---------------------------------------------------------------------------
# 结构：3 层中间件栈
# ---------------------------------------------------------------------------


class TestMiddlewareStack:
    def test_stack_reduced_to_three_layers(self, test_client):
        """timeout / security_headers / request_stats / prometheus
        四层 BaseHTTPMiddleware 已合并，整栈只剩 3 层。"""
        app = test_client.app
        names = [m.cls.__name__ for m in app.user_middleware]
        assert len(names) == 3, f"中间件层数应为 3，实际: {names}"
        # add_middleware 逐次 insert(0)：先加的在内、后加的在外
        assert names == [
            "ObservabilityMiddleware",   # 最外层：安全头 + 慢请求 + 记录
            "AuditLoggerMiddleware",
            "ConcurrencyMiddleware",     # 最内层：准入控制
        ]

    def test_deleted_middleware_modules_are_gone(self):
        import importlib

        for mod in ("app.middleware.timeout", "app.middleware.security_headers"):
            with pytest.raises(ModuleNotFoundError):
                importlib.import_module(mod)


# ---------------------------------------------------------------------------
# 安全响应头（合并进观测层）
# ---------------------------------------------------------------------------


def _mini_app(**kwargs) -> Starlette:
    """独立小应用：只挂观测层，隔离 DB / 配置依赖"""

    async def ok(request):
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/ok", ok)])
    app.add_middleware(ObservabilityMiddleware, **kwargs)
    return app


class TestSecurityHeaders:
    def test_default_security_headers(self):
        with TestClient(_mini_app()) as client:
            r = client.get("/ok")
        assert r.status_code == 200
        assert r.headers["X-Content-Type-Options"] == "nosniff"
        assert r.headers["X-Frame-Options"] == "DENY"
        assert r.headers["X-XSS-Protection"] == "1; mode=block"
        assert r.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
        assert "camera=()" in r.headers["Permissions-Policy"]
        # HSTS 默认关闭（由 app.py 按 debug 决定）
        assert "Strict-Transport-Security" not in r.headers

    def test_hsts_enabled_when_requested(self):
        with TestClient(_mini_app(enable_hsts=True, hsts_max_age=1234)) as client:
            r = client.get("/ok")
        assert r.headers["Strict-Transport-Security"] == (
            "max-age=1234; includeSubDomains; preload"
        )

    def test_allow_iframe_relaxes_frame_options(self):
        with TestClient(_mini_app(allow_iframe=True)) as client:
            r = client.get("/ok")
        assert r.headers["X-Frame-Options"] == "SAMEORIGIN"

    def test_security_headers_can_be_disabled(self):
        """Nginx 统一处理安全头时可整体关闭（避免双份下发）"""
        with TestClient(_mini_app(add_security_headers=False)) as client:
            r = client.get("/ok")
        assert "X-Frame-Options" not in r.headers
        assert "X-Content-Type-Options" not in r.headers

    def test_no_server_fingerprint_header(self):
        with TestClient(_mini_app()) as client:
            r = client.get("/ok")
        assert "server" not in {k.lower() for k in r.headers}


# ---------------------------------------------------------------------------
# 记录韧性 + 慢请求告警
# ---------------------------------------------------------------------------


class _CapturingLogger:
    def __init__(self):
        self.warnings = []
        self.errors = []
        self.infos = []

    def warning(self, msg, *a, **k):
        self.warnings.append(str(msg))

    def error(self, msg, *a, **k):
        self.errors.append(str(msg))

    def info(self, msg, *a, **k):
        self.infos.append(str(msg))

    def debug(self, msg, *a, **k):
        pass


class TestRecordResilience:
    @pytest.fixture(autouse=True)
    def _fresh(self):
        reset_prometheus_metrics()
        yield
        reset_prometheus_metrics()

    def test_record_failure_does_not_break_response(self, monkeypatch):
        """韧性：指标面故障不得把成功的请求变成 5xx"""
        cap = _CapturingLogger()
        monkeypatch.setattr(observability_mod, "logger", cap)

        async def _boom(*a, **k):
            raise RuntimeError("metrics store down")

        monkeypatch.setattr(RequestStats, "record_request", _boom)

        with TestClient(_mini_app()) as client:
            r = client.get("/ok")

        assert r.status_code == 200
        assert r.text == "ok"
        # 安全头照常下发
        assert r.headers["X-Content-Type-Options"] == "nosniff"
        # 失败被吞掉并告警
        assert any("记录失败" in w for w in cap.warnings)
        # 在途数必须归零（否则 gauge 泄漏）
        assert get_prometheus_metrics()._inflight == 0

    def test_record_timeout_is_isolated(self, monkeypatch):
        """延迟隔离：指标面（Redis pipeline + 全局锁）卡死不拖慢响应，
        超时有界放弃并告警（wait_for 取消挂起协程）"""
        cap = _CapturingLogger()
        monkeypatch.setattr(observability_mod, "logger", cap)
        monkeypatch.setattr(observability_mod, "RECORD_TIMEOUT_SECONDS", 0.05)

        async def _hung(*a, **k):
            await asyncio.sleep(30)  # 远超超时的假卡死，wait_for 会在截止时取消

        monkeypatch.setattr(RequestStats, "record_request", _hung)

        with TestClient(_mini_app()) as client:
            r = client.get("/ok")

        assert r.status_code == 200
        assert r.text == "ok"
        assert any("记录超时" in w for w in cap.warnings)
        assert get_prometheus_metrics()._inflight == 0

    def test_exception_path_records_and_releases_inflight(self, monkeypatch):
        """下游抛异常 → 记为失败 + 释放在途，异常继续上抛"""
        cap = _CapturingLogger()
        monkeypatch.setattr(observability_mod, "logger", cap)
        recorded = []

        async def _rec(*a, **k):
            recorded.append(k)

        monkeypatch.setattr(RequestStats, "record_request", _rec)

        async def boom(request):
            raise RuntimeError("handler exploded")

        app = Starlette(routes=[Route("/boom", boom)])
        app.add_middleware(ObservabilityMiddleware)

        with pytest.raises(RuntimeError):
            with TestClient(app, raise_server_exceptions=True) as client:
                client.get("/boom")

        assert get_prometheus_metrics()._inflight == 0
        assert cap.errors, "异常路径应记录 error 日志"

    async def test_cancelled_error_releases_inflight(self):
        """CancelledError（客户端断开/任务取消）绕过 except Exception，
        归还必须在 finally——否则 inflight gauge 泄漏"""
        reset_prometheus_metrics()
        try:
            mw = ObservabilityMiddleware(app=None)

            async def cancel_next(request):
                raise asyncio.CancelledError()

            req = Request({
                "type": "http",
                "method": "GET",
                "path": "/ok",
                "headers": [],
                "query_string": b"",
                "server": ("test", 80),
                "client": ("test", 1),
                "scheme": "http",
            })
            with pytest.raises(asyncio.CancelledError):
                await mw.dispatch(req, cancel_next)

            assert get_prometheus_metrics()._inflight == 0
        finally:
            reset_prometheus_metrics()

    def test_slow_request_warning_emitted(self, monkeypatch):
        cap = _CapturingLogger()
        monkeypatch.setattr(observability_mod, "logger", cap)

        with TestClient(_mini_app(threshold_seconds=-1.0)) as client:
            r = client.get("/ok")

        assert r.status_code == 200
        assert any("超过阈值" in w for w in cap.warnings)

    def test_no_slow_warning_under_threshold(self, monkeypatch):
        cap = _CapturingLogger()
        monkeypatch.setattr(observability_mod, "logger", cap)

        with TestClient(_mini_app(threshold_seconds=30.0)) as client:
            client.get("/ok")

        assert not any("超过阈值" in w for w in cap.warnings)

    def test_inflight_returns_to_zero_after_requests(self):
        with TestClient(_mini_app()) as client:
            for _ in range(5):
                assert client.get("/ok").status_code == 200
        assert get_prometheus_metrics()._inflight == 0


# ---------------------------------------------------------------------------
# 记录范围：单一裁决点
# ---------------------------------------------------------------------------


class TestScopeDecision:
    @pytest.fixture(autouse=True)
    def _fresh(self):
        reset_prometheus_metrics()
        yield
        reset_prometheus_metrics()

    @pytest.mark.parametrize("path", [
        "/health",
        "/health/live",
        "/docs",
        "/docs/redoc",
        "/redoc",
        "/openapi.json",
        "/metrics",
        "/metrics/extra",
    ])
    def test_excluded_paths(self, path):
        assert should_record(path) is False

    @pytest.mark.parametrize("path", [
        "/healthz",          # 带前缀但非边界匹配 → 仍记录
        "/docsredoc",
        "/metrics2",
        "/",
        "/api/v1/users",
        "/definitely-not-a-route",
    ])
    def test_recorded_paths(self, path):
        assert should_record(path) is True

    def test_custom_exclude_override(self):
        assert should_record("/health", exclude_paths=["/api"]) is True
        assert should_record("/api", exclude_paths=["/api"]) is False

    def test_default_exclude_set_is_the_five_paths(self):
        assert set(DEFAULT_EXCLUDE_PATHS) == {
            "/health", "/docs", "/redoc", "/openapi.json", "/metrics",
        }

    def test_scope_and_prometheus_share_decision(self, test_client):
        """范围裁决只有一处：/health 既不进统计也不进计数"""
        for _ in range(3):
            test_client.get("/health")
        r = test_client.get("/metrics")
        assert "kustos_http_requests_total_total 0" in r.text


# ---------------------------------------------------------------------------
# 同源对账：统计 与 Prometheus 计数来自同一条写入路径
# ---------------------------------------------------------------------------


class TestSameSourceReconciliation:
    @pytest.fixture(autouse=True)
    def _fresh(self):
        reset_prometheus_metrics()
        yield
        reset_prometheus_metrics()

    async def test_stats_and_counters_stay_in_sync(self):
        stats = RequestStats(window_minutes=5)
        await stats.record_request(12.0, True, 200, method="GET")
        await stats.record_request(45.0, True, 301, method="GET")
        await stats.record_request(800.0, False, 500, method="POST")

        s = await stats.get_stats()
        text = get_prometheus_metrics().render()

        # 总量对账
        assert s["total"] == 3
        assert "kustos_http_requests_total_total 3" in text
        # 状态类对账（统计 s2xx/s3xx/s5xx vs 计数 2xx/3xx/5xx）
        assert 'kustos_http_requests_total{method="GET",status="2xx"} 1' in text
        assert 'kustos_http_requests_total{method="GET",status="3xx"} 1' in text
        assert 'kustos_http_requests_total{method="POST",status="5xx"} 1' in text
        assert "kustos_http_5xx_total 1" in text
        # 样本数对账
        assert 'kustos_http_request_duration_seconds_count{method="GET"} 2' in text
        assert 'kustos_http_request_duration_seconds_count{method="POST"} 1' in text

    async def test_legacy_call_without_method_does_not_touch_counters(self):
        """不带 method 的旧调用（历史测试/内部调用）不影响计数器"""
        stats = RequestStats(window_minutes=5)
        await stats.record_request(10.0, True)
        assert (await stats.get_stats())["total"] == 1
        assert "kustos_http_requests_total_total 0" in get_prometheus_metrics().render()
