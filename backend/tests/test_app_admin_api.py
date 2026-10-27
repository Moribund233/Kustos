"""
应用管理层端点补充测试

补齐 tests/test_controller_coverage.py 未覆盖的路径：
- 非管理员且非 debug 时，配置 / 日志 / 运维端点应返回 403（check_app_permission 负路径）
- 管理员成功路径：config/reset、config 更新重启提示、shutdown、restart、logs/cleanup
  （以桩替换服务层，避免真实关停进程 / 写文件 / 删日志等副作用）
- debug initdb / initconf 成功路径（模拟 debug 开启 + 桩，避免真实重置数据库 / 配置文件）

说明：测试环境 KUSTOS_APP_DEBUG 默认为 false，debug 端点正常走 403；
本文件通过 monkeypatch 显式控制，保证结果与环境无关。
"""
from types import SimpleNamespace

import pytest
from starlette.websockets import WebSocketDisconnect

import app.api.v1.app_controller as app_ctl
import app.api.v1.debug_controller as dbg_ctl


def _debug_off(monkeypatch):
    """让 check_app_permission 判定为非 debug，确保门控负路径可复现"""
    monkeypatch.setattr(
        app_ctl,
        "get_config",
        lambda: SimpleNamespace(app=SimpleNamespace(debug=False)),
    )


def _debug_on(monkeypatch):
    """模拟 debug 模式开启（供 require_debug_mode 通过）"""
    monkeypatch.setattr(
        dbg_ctl,
        "get_config",
        lambda: SimpleNamespace(app=SimpleNamespace(debug=True)),
    )


# (method, path, json_payload)
NON_ADMIN_CALLS = [
    ("GET", "/api/app/config", None),
    ("POST", "/api/app/config", {"config": {"server": {"port": 8001}}}),
    ("POST", "/api/app/config/reset", None),
    ("POST", "/api/app/config/validate", None),
    ("GET", "/api/app/logs", None),
    ("GET", "/api/app/logs/content", None),
    ("GET", "/api/app/audit", None),
    ("POST", "/api/app/logs/cleanup", None),
    ("POST", "/api/app/shutdown", None),
    ("POST", "/api/app/restart", None),
]


class TestAppAdminGating:
    """非管理员且非 debug：全部应用管理端点应 403"""

    @pytest.mark.parametrize("method,path,payload", NON_ADMIN_CALLS)
    def test_non_admin_non_debug_forbidden(
        self, test_client, auth_headers, monkeypatch, method, path, payload
    ):
        _debug_off(monkeypatch)
        r = test_client.request(method, path, json=payload, headers=auth_headers)
        assert r.status_code == 403, (method, path, r.status_code, r.text)


class TestStatusEndpoint:
    """状态端点已收紧为「登录可见」：匿名 401，任意登录用户 200"""

    def test_status_requires_auth(self, test_client):
        assert test_client.get("/api/app/status").status_code == 401

    def test_status_ok_for_authenticated(self, test_client, auth_headers):
        r = test_client.get("/api/app/status", headers=auth_headers)
        assert r.status_code == 200
        assert "status" in r.json()


class TestLogsContentLineCap:
    """日志行数上限：>5000 拒绝、=5000 允许（配合前端虚拟滚动扩大取行）"""

    def test_lines_over_cap_rejected(self, test_client, admin_headers):
        r = test_client.get(
            "/api/app/logs/content", params={"lines": 5001}, headers=admin_headers
        )
        assert r.status_code == 422

    def test_lines_at_cap_ok(self, test_client, admin_headers):
        r = test_client.get(
            "/api/app/logs/content", params={"lines": 5000}, headers=admin_headers
        )
        assert r.status_code == 200


class TestAppAdminActions:
    """管理员成功路径（服务层以桩替换，避免副作用）"""

    def test_config_reset_ok(self, test_client, admin_headers, monkeypatch):
        class FakeCfgSvc:
            def reset_config(self, is_debug=False, is_admin=False):
                return True, []

        monkeypatch.setattr(app_ctl, "get_config_service", lambda: FakeCfgSvc())
        r = test_client.post("/api/app/config/reset", headers=admin_headers)
        assert r.status_code == 200
        assert r.json()["success"] is True

    def test_config_update_returns_restart_hints(
        self, test_client, admin_headers, monkeypatch
    ):
        class FakeCfgSvc:
            def update_config(self, data, is_debug=False, is_admin=False, updated_by=None):
                return True, [], ["server.port 需要重启服务才能生效"]

        monkeypatch.setattr(app_ctl, "get_config_service", lambda: FakeCfgSvc())
        r = test_client.post(
            "/api/app/config",
            json={"config": {"server": {"port": 8001}}},
            headers=admin_headers,
        )
        assert r.status_code == 200
        body = r.json()
        assert body["success"] is True
        assert body["hints"] and "server.port" in body["hints"][0]

    def test_shutdown_ok(self, test_client, admin_headers, monkeypatch):
        class FakeApp:
            def shutdown(self, is_debug=False, is_admin=False):
                return True

        monkeypatch.setattr(app_ctl, "get_app_service", lambda: FakeApp())
        r = test_client.post("/api/app/shutdown", headers=admin_headers)
        assert r.status_code == 200
        assert r.json()["success"] is True

    def test_restart_ok(self, test_client, admin_headers, monkeypatch):
        class FakeApp:
            def restart(self, is_debug=False, is_admin=False):
                return True

        monkeypatch.setattr(app_ctl, "get_app_service", lambda: FakeApp())
        r = test_client.post("/api/app/restart", headers=admin_headers)
        assert r.status_code == 200
        assert r.json()["success"] is True

    def test_logs_cleanup_ok(self, test_client, admin_headers, monkeypatch):
        class FakeApp:
            def cleanup_old_logs(self, keep_days=30, is_debug=False, is_admin=False):
                return {"success": True, "deleted_count": 3, "keep_days": keep_days}

        monkeypatch.setattr(app_ctl, "get_app_service", lambda: FakeApp())
        r = test_client.post(
            "/api/app/logs/cleanup", params={"keep_days": 7}, headers=admin_headers
        )
        assert r.status_code == 200
        body = r.json()
        assert body["success"] is True
        assert body["deleted_count"] == 3
        assert body["keep_days"] == 7


class TestDebugActions:
    """debug initdb / initconf 成功路径（桩替换，避免破坏性副作用）"""

    def test_initdb_ok(self, test_client, admin_headers, monkeypatch):
        _debug_on(monkeypatch)

        class FakeReset:
            async def reset_database(self, preserve_config=True):
                return {"database_type": "postgresql"}

        monkeypatch.setattr(dbg_ctl, "DatabaseResetManager", FakeReset)
        r = test_client.post("/api/v1/debug/initdb", headers=admin_headers)
        assert r.status_code == 200
        body = r.json()
        assert body["success"] is True
        assert "postgresql" in body["message"]

    def test_initconf_resets_db_config(
        self, test_client, admin_headers, monkeypatch, isolated_db_url
    ):
        """initconf 把模板种子**覆盖**写入 app_config（不再产生配置文件）"""
        from sqlalchemy import create_engine

        from app.models.app_config import AppConfig

        _debug_on(monkeypatch)

        url = isolated_db_url
        engine = create_engine(url)
        try:
            AppConfig.__table__.create(engine, checkfirst=True)
            with engine.begin() as conn:
                conn.execute(
                    AppConfig.__table__.insert().values(
                        section="app", payload={"title": "Hacked"}, version=1
                    )
                )
        finally:
            engine.dispose()
        monkeypatch.setenv("DATABASE_URL", url)

        r = test_client.post("/api/v1/debug/initconf", headers=admin_headers)
        assert r.status_code == 200
        body = r.json()
        assert body["success"] is True
        assert body["config_path"] is None, "TOML 层移除后不再产生配置文件"
        assert body["backup_path"] is None

        engine = create_engine(url)
        try:
            with engine.connect() as conn:
                payload = conn.execute(
                    AppConfig.__table__.select()
                    .where(AppConfig.__table__.c.section == "app")
                ).mappings().first()["payload"]
        finally:
            engine.dispose()
        from app.services.config_store import example_seed_data

        assert payload["title"] == example_seed_data()["app"]["title"], "未被模板值覆盖"

    def test_initconf_failure_returns_500(
        self, test_client, admin_headers, monkeypatch
    ):
        """重置失败（如 DB 不可达）应返回明确的 500，而不是静默成功"""
        _debug_on(monkeypatch)

        from app.services import config_store

        def boom(*args, **kwargs):
            raise RuntimeError("Read-only file system")

        monkeypatch.setattr(config_store, "reset_to_seed", boom)
        r = test_client.post("/api/v1/debug/initconf", headers=admin_headers)
        assert r.status_code == 500
        assert r.json()["error"]["error_code"] == "debug_config_reset_failed"


class TestComponentsEndpoint:
    """编排组件状态端点（仅管理员）"""

    def test_components_requires_admin(self, test_client, auth_headers):
        r = test_client.get("/api/app/components", headers=auth_headers)
        assert r.status_code == 403

    def test_components_requires_auth(self, test_client):
        assert test_client.get("/api/app/components").status_code == 401

    def test_components_admin_ok(self, test_client, admin_headers, monkeypatch):
        class FakeOrch:
            async def get_components(self):
                return {
                    "available": True,
                    "runtime": "docker",
                    "project": "kustos",
                    "reason": None,
                    "generated_at": "2026-09-18T00:00:00+00:00",
                    "components": [
                        {
                            "service": "app",
                            "name": "kustos-app",
                            "label": "后端 (FastAPI)",
                            "state": "running",
                            "health": "healthy",
                            "running": True,
                            "image": "kustos-app:latest",
                            "started_at": "2026-09-18T00:00:00+00:00",
                            "uptime_seconds": 10,
                            "restart_count": 0,
                            "exit_code": 0,
                            "status_text": "Up (healthy)",
                        }
                    ],
                    "summary": {
                        "total": 1, "running": 1, "stopped": 0,
                        "healthy": 1, "unhealthy": 0, "starting": 0,
                    },
                }

        monkeypatch.setattr(app_ctl, "get_orchestration_service", lambda: FakeOrch())
        r = test_client.get("/api/app/components", headers=admin_headers)
        assert r.status_code == 200
        body = r.json()
        assert body["available"] is True
        assert body["project"] == "kustos"
        assert body["components"][0]["service"] == "app"
        assert body["components"][0]["health"] == "healthy"
        assert body["summary"]["healthy"] == 1

    def test_components_unavailable_returns_200(self, test_client, admin_headers, monkeypatch):
        class FakeOrch:
            async def get_components(self):
                return {
                    "available": False,
                    "runtime": "docker",
                    "project": None,
                    "reason": "docker proxy 不可用",
                    "generated_at": "2026-09-18T00:00:00+00:00",
                    "components": [],
                    "summary": {
                        "total": 0, "running": 0, "stopped": 0,
                        "healthy": 0, "unhealthy": 0, "starting": 0,
                    },
                }

        monkeypatch.setattr(app_ctl, "get_orchestration_service", lambda: FakeOrch())
        r = test_client.get("/api/app/components", headers=admin_headers)
        assert r.status_code == 200
        assert r.json()["available"] is False


class TestLogsWebSocketAdmin:
    """/ws/logs 实时日志流仅管理员可订阅（收紧原匿名可读）"""

    @staticmethod
    def _token(headers: dict) -> str:
        return headers["Authorization"].split(" ", 1)[1]

    def test_anonymous_rejected(self, test_client):
        with pytest.raises(WebSocketDisconnect):
            with test_client.websocket_connect("/ws/logs"):
                pass

    def test_non_admin_rejected(self, test_client, auth_headers):
        token = self._token(auth_headers)
        with pytest.raises(WebSocketDisconnect):
            with test_client.websocket_connect(f"/ws/logs?token={token}"):
                pass

    def test_admin_can_subscribe(self, test_client, admin_headers):
        token = self._token(admin_headers)
        with test_client.websocket_connect(f"/ws/logs?token={token}") as ws:
            connected = ws.receive_json()
            assert connected["type"] == "connected"
            assert connected["authenticated"] is True

            ws.send_json({
                "type": "subscribe_logs",
                "filters": {"levels": ["INFO"]},
                "history_count": 5,
            })
            subscribed = ws.receive_json()
            assert subscribed["type"] == "logs_subscribed"

    def test_general_ws_anonymous_cannot_subscribe(self, test_client):
        """通用 /ws/ 端点匿名连接不得订阅日志流（handler 层兜底）"""
        with test_client.websocket_connect("/ws/") as ws:
            assert ws.receive_json()["type"] == "connected"
            ws.send_json({"type": "subscribe_logs", "filters": {"levels": ["INFO"]}})
            reply = ws.receive_json()
            assert reply["type"] == "error"
            assert "Admin" in reply["error"]

    def test_general_ws_admin_can_subscribe(self, test_client, admin_headers):
        token = self._token(admin_headers)
        with test_client.websocket_connect(f"/ws/?token={token}") as ws:
            connected = ws.receive_json()
            assert connected["type"] == "connected"
            assert connected["authenticated"] is True
            ws.send_json({"type": "subscribe_logs", "filters": {"levels": ["INFO"]}})
            assert ws.receive_json()["type"] == "logs_subscribed"


class TestDebugModeToggle:
    """POST /api/app/debug：仅管理员可切换调试模式（重启后生效）"""

    def test_requires_auth(self, test_client):
        r = test_client.post("/api/app/debug", json={"enabled": True})
        assert r.status_code == 401

    def test_requires_admin(self, test_client, auth_headers):
        r = test_client.post("/api/app/debug", json={"enabled": True}, headers=auth_headers)
        assert r.status_code == 403

    def test_admin_ok(self, test_client, admin_headers, monkeypatch):
        class FakeCfgSvc:
            def set_debug_mode(self, enabled, is_admin=False):
                return {
                    "success": True,
                    "debug": enabled,
                    "restart_required": True,
                    "message": "调试模式已开启，重启服务后生效",
                }

        monkeypatch.setattr(app_ctl, "get_config_service", lambda: FakeCfgSvc())
        r = test_client.post("/api/app/debug", json={"enabled": True}, headers=admin_headers)
        assert r.status_code == 200
        body = r.json()
        assert body["success"] is True
        assert body["debug"] is True
        assert body["restart_required"] is True
