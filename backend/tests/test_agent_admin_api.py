"""Agent 管理面 API 测试（``/api/app/agent/*`` 契约）

覆盖契约项：
响应形状 + 错误码 + 脱敏（key 永不出现在响应里）+ SSRF 形态校验 + 权限。
上游 HTTP 一律 monkeypatch ``AgentAdminService`` 的 HTTP 原语（不打真网）。
"""
import httpx

from app.services.agent_admin_service import AgentAdminService, _UpstreamAuthRejected

#: 所有可能被解析的 key 候选环境变量（测试内统一清空/注入，保证确定性）
PROVIDER_ENVS = (
    "KUSTOS_AGENT_API_KEY",
    "KUSTOS_OPENAI_API_KEY",
    "KUSTOS_DEEPSEEK_API_KEY",
    "KUSTOS_MOONSHOT_API_KEY",
    "KUSTOS_KIMI_API_KEY",
    "KUSTOS_ZAI_API_KEY",
    "KUSTOS_GLM_API_KEY",
    "KUSTOS_OLLAMA_API_KEY",
)


def _err(resp) -> dict:
    """断言错误信封并返回 ``error`` 对象"""
    body = resp.json()
    assert "error" in body, f"缺少 error 信封: {body}"
    return body["error"]


def _clear_keys(monkeypatch) -> None:
    for name in PROVIDER_ENVS:
        monkeypatch.delenv(name, raising=False)


async def _fake_models_ok(self, base_url, api_key, timeout=5.0):
    """成功拉取（记录入参以便断言服务端确实用 env key 代理）"""
    _fake_models_ok.calls.append((base_url, api_key, timeout))
    return ["gpt-4o-mini", "gpt-4o"]


_fake_models_ok.calls = []


class TestPermissions:
    """读 check_app_permission / 探测 check_app_danger_permission"""

    def test_requires_auth(self, test_client):
        for path in (
            "/api/app/agent/config",
            "/api/app/agent/providers",
            "/api/app/agent/key-status",
            "/api/app/agent/models",
        ):
            resp = test_client.get(path)
            assert resp.status_code == 401, path
        resp = test_client.put(
            "/api/app/agent/config", json={"values": {}, "version": 0}
        )
        assert resp.status_code == 401

    def test_non_admin_read_denied(self, test_client, auth_headers):
        # 测试环境 debug=false → 非管理员一律 403（与 /api/app/config 同口径）
        for path in (
            "/api/app/agent/config",
            "/api/app/agent/providers",
            "/api/app/agent/key-status",
            "/api/app/agent/models",
        ):
            resp = test_client.get(path, headers=auth_headers)
            assert resp.status_code == 403, path
            assert _err(resp)["error_code"] == "app_admin_or_debug_required"

    def test_non_admin_probe_denied(self, test_client, auth_headers):
        resp = test_client.post(
            "/api/app/agent/test-connection", json={}, headers=auth_headers
        )
        assert resp.status_code == 403

    def test_config_write_requires_danger_permission(
        self, test_client, auth_headers
    ):
        resp = test_client.put(
            "/api/app/agent/config",
            json={"values": {"model": "x"}, "version": 0},
            headers=auth_headers,
        )
        assert resp.status_code == 403


class TestProvidersCatalog:
    def test_catalog_shape(self, test_client, admin_headers):
        resp = test_client.get("/api/app/agent/providers", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["allow_custom"] is True
        ids = {p["id"] for p in data["providers"]}
        assert {"openai", "deepseek", "moonshot", "zai", "ollama", "vllm"} <= ids
        # 国内供应商批次（均为 OpenAI 兼容端点）
        cn = {
            "alibaba", "volcengine", "siliconflow", "minimax",
            "qianfan", "spark", "xiaomi", "stepfun",
        }
        assert cn <= ids
        alibaba = next(p for p in data["providers"] if p["id"] == "alibaba")
        assert alibaba["key_env"] == "KUSTOS_DASHSCOPE_API_KEY"
        assert alibaba["base_url"].startswith("https://")
        volc = next(p for p in data["providers"] if p["id"] == "volcengine")
        assert volc["requires_key"] is True and volc["custom"] is False
        openai = next(p for p in data["providers"] if p["id"] == "openai")
        # 契约字段
        assert openai["key_env"] == "KUSTOS_OPENAI_API_KEY"
        assert openai["base_url"].startswith("https://")
        assert isinstance(openai["models"], list)
        assert openai["custom"] is False
        # 自托管条目：无鉴权 + 可改 base_url
        ollama = next(p for p in data["providers"] if p["id"] == "ollama")
        assert ollama["requires_key"] is False
        assert ollama["custom"] is True


class TestKeyStatus:
    def test_configured_reports_env_and_never_returns_key(
        self, test_client, admin_headers, monkeypatch
    ):
        _clear_keys(monkeypatch)
        monkeypatch.setenv("KUSTOS_AGENT_API_KEY", "sk-super-secret-xyz")
        resp = test_client.get("/api/app/agent/key-status", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["env_name"] == "KUSTOS_AGENT_API_KEY"
        assert data["configured"] is True
        assert data["injection"] == "compose_env"
        # 永不回 key 值
        assert "sk-super-secret-xyz" not in resp.text
        # 分供应商：deepseek 无专属 key → 兜底命中通用 env
        deepseek = next(p for p in data["providers"] if p["id"] == "deepseek")
        assert deepseek["configured"] is True
        assert deepseek["source_env"] == "KUSTOS_AGENT_API_KEY"

    def test_unset_state(self, test_client, admin_headers, monkeypatch):
        _clear_keys(monkeypatch)
        data = test_client.get(
            "/api/app/agent/key-status", headers=admin_headers
        ).json()
        assert data["configured"] is False
        assert data["injection"] == "unset"
        assert all(p["configured"] is False for p in data["providers"])


class TestModelsEndpoint:
    def test_missing_key_400(self, test_client, admin_headers, monkeypatch):
        _clear_keys(monkeypatch)
        resp = test_client.get(
            "/api/app/agent/models",
            params={"provider": "openai"},
            headers=admin_headers,
        )
        assert resp.status_code == 400
        assert _err(resp)["error_code"] == "agent_key_missing"

    def test_forbidden_base_url_shape_400(self, test_client, admin_headers, monkeypatch):
        monkeypatch.setenv("KUSTOS_AGENT_API_KEY", "sk-test")
        # 非 http(s) 协议
        resp = test_client.get(
            "/api/app/agent/models",
            params={"base_url": "ftp://evil.example/v1"},
            headers=admin_headers,
        )
        assert resp.status_code == 400
        assert _err(resp)["error_code"] == "agent_base_url_forbidden"
        # userinfo（凭据走私）
        resp = test_client.get(
            "/api/app/agent/models",
            params={"base_url": "https://user:pass@example.com/v1"},
            headers=admin_headers,
        )
        assert _err(resp)["error_code"] == "agent_base_url_forbidden"

    def test_unknown_provider_400(self, test_client, admin_headers):
        resp = test_client.get(
            "/api/app/agent/models",
            params={"provider": "nope"},
            headers=admin_headers,
        )
        assert resp.status_code == 400
        assert _err(resp)["error_code"] == "agent_provider_not_found"

    def test_remote_success_uses_env_key(
        self, test_client, admin_headers, monkeypatch
    ):
        _clear_keys(monkeypatch)
        monkeypatch.setenv("KUSTOS_AGENT_API_KEY", "sk-test")
        monkeypatch.setattr(AgentAdminService, "_http_get_models", _fake_models_ok)
        resp = test_client.get(
            "/api/app/agent/models",
            params={"provider": "openai"},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["source"] == "remote"
        assert [m["id"] for m in data["models"]] == ["gpt-4o-mini", "gpt-4o"]
        # 服务端注入 env key、目标为目录 base_url、5s 超时
        base_url, api_key, timeout = _fake_models_ok.calls[-1]
        assert base_url == "https://api.openai.com/v1"
        assert api_key == "sk-test"
        assert timeout == 5.0
        assert "sk-test" not in resp.text

    def test_upstream_down_falls_back_to_static_catalog(
        self, test_client, admin_headers, monkeypatch
    ):
        _clear_keys(monkeypatch)
        monkeypatch.setenv("KUSTOS_AGENT_API_KEY", "sk-test")

        def _boom(self, base_url, api_key, timeout=5.0):
            raise httpx.ConnectError(
                "conn refused", request=httpx.Request("GET", f"{base_url}/models")
            )

        monkeypatch.setattr(AgentAdminService, "_http_get_models", _boom)
        data = test_client.get(
            "/api/app/agent/models",
            params={"provider": "deepseek"},
            headers=admin_headers,
        ).json()
        assert data["source"] == "static"
        assert data["error_code"] == "agent_models_unavailable"
        assert "deepseek-chat" in [m["id"] for m in data["models"]]

    def test_upstream_down_502_without_static_catalog(
        self, test_client, admin_headers, monkeypatch
    ):
        _clear_keys(monkeypatch)  # vllm 无鉴权，缺 key 也放行

        def _boom(self, base_url, api_key, timeout=5.0):
            raise httpx.ConnectError(
                "conn refused", request=httpx.Request("GET", f"{base_url}/models")
            )

        monkeypatch.setattr(AgentAdminService, "_http_get_models", _boom)
        resp = test_client.get(
            "/api/app/agent/models",
            params={"provider": "vllm"},
            headers=admin_headers,
        )
        assert resp.status_code == 502
        assert _err(resp)["error_code"] == "agent_models_unavailable"


class TestTestConnection:
    def test_success_via_models_endpoint(
        self, test_client, admin_headers, monkeypatch
    ):
        _clear_keys(monkeypatch)
        monkeypatch.setenv("KUSTOS_AGENT_API_KEY", "sk-test")
        monkeypatch.setattr(AgentAdminService, "_http_get_models", _fake_models_ok)
        resp = test_client.post(
            "/api/app/agent/test-connection",
            json={"provider": "openai"},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["source"] == "models"
        assert data["base_url"] == "https://api.openai.com/v1"
        assert data["latency_ms"] >= 0
        assert data["checked_at"]
        assert "sk-test" not in resp.text

    def test_key_missing_soft_failure(
        self, test_client, admin_headers, monkeypatch
    ):
        _clear_keys(monkeypatch)
        resp = test_client.post(
            "/api/app/agent/test-connection",
            json={"provider": "openai"},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert data["error_code"] == "agent_key_missing"
        # 软失败允许动态诊断（带候选 env 名，内联文案）
        assert "KUSTOS_AGENT_API_KEY" in data["error"]

    def test_fallback_to_chat_probe(self, test_client, admin_headers, monkeypatch):
        _clear_keys(monkeypatch)
        monkeypatch.setenv("KUSTOS_AGENT_API_KEY", "sk-test")
        req = httpx.Request("GET", "https://api.deepseek.com/v1/models")

        def _models_404(self, base_url, api_key, timeout=5.0):
            raise httpx.HTTPStatusError(
                "404", request=req, response=httpx.Response(404, request=req)
            )

        probed = {}

        async def _probe_ok(self, base_url, api_key, model, timeout=10.0):
            probed.update(base_url=base_url, model=model)

        monkeypatch.setattr(AgentAdminService, "_http_get_models", _models_404)
        monkeypatch.setattr(AgentAdminService, "_http_chat_probe", _probe_ok)
        data = test_client.post(
            "/api/app/agent/test-connection",
            json={"provider": "deepseek"},
            headers=admin_headers,
        ).json()
        assert data["ok"] is True
        assert data["source"] == "chat"
        assert probed["model"]  # 缺省取 agent.model

    def test_upstream_unreachable_soft_failure(
        self, test_client, admin_headers, monkeypatch
    ):
        _clear_keys(monkeypatch)

        def _boom(self, base_url, api_key, timeout=5.0):
            raise httpx.ConnectError(
                "conn refused", request=httpx.Request("GET", f"{base_url}/models")
            )

        monkeypatch.setattr(AgentAdminService, "_http_get_models", _boom)
        data = test_client.post(
            "/api/app/agent/test-connection",
            json={"provider": "vllm"},
            headers=admin_headers,
        ).json()
        assert data["ok"] is False
        assert data["error_code"] == "agent_models_unavailable"

    def test_auth_rejected_soft_failure(
        self, test_client, admin_headers, monkeypatch
    ):
        _clear_keys(monkeypatch)
        monkeypatch.setenv("KUSTOS_AGENT_API_KEY", "sk-wrong")

        def _denied(self, base_url, api_key, timeout=5.0):
            raise _UpstreamAuthRejected("上游拒绝凭证（HTTP 401）")

        monkeypatch.setattr(AgentAdminService, "_http_get_models", _denied)
        data = test_client.post(
            "/api/app/agent/test-connection",
            json={"provider": "openai"},
            headers=admin_headers,
        ).json()
        assert data["ok"] is False
        assert data["error_code"] == "agent_upstream_auth_rejected"
        assert "sk-wrong" not in str(data)

    def test_invalid_base_url_400(self, test_client, admin_headers):
        resp = test_client.post(
            "/api/app/agent/test-connection",
            json={"base_url": "javascript:alert(1)"},
            headers=admin_headers,
        )
        assert resp.status_code == 400
        assert _err(resp)["error_code"] == "agent_base_url_forbidden"

    def test_unknown_provider_400(self, test_client, admin_headers):
        resp = test_client.post(
            "/api/app/agent/test-connection",
            json={"provider": "nope"},
            headers=admin_headers,
        )
        assert resp.status_code == 400
        assert _err(resp)["error_code"] == "agent_provider_not_found"


class TestAgentConfigView:
    def test_shape_and_meta(self, test_client, admin_headers):
        from app.core.config import AgentSettings

        resp = test_client.get("/api/app/agent/config", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        cfg, meta = data["config"], data["meta"]
        # key 只存环境变量名，配置里没有 api_key 字段（红线）
        assert "api_key" not in cfg
        assert cfg["api_key_env"] == "KUSTOS_AGENT_API_KEY"
        assert isinstance(cfg["enabled"], bool)
        # 白名单分区 + meta 契约；白名单键必须都是真实字段
        assert "model" in meta["hot_keys"]
        assert set(meta["editable_keys"]) <= set(AgentSettings.model_fields)
        assert set(meta["restart_keys"]) <= set(meta["editable_keys"])
        # worker 进程参数需重启生效（arq WorkerSettings 启动时读取）；其余热生效
        assert meta["restart_keys"] == ["worker_job_timeout_seconds", "worker_max_jobs"]
        assert isinstance(meta["source"], dict)
        assert isinstance(meta["version"], int) and meta["version"] >= 0
        # PUT 已开放
        assert meta["writable"] is True


class TestAgentConfigPut:
    """PUT /api/app/agent/config：白名单 + 乐观锁 + 热生效"""

    @staticmethod
    def _version(test_client, admin_headers) -> int:
        view = test_client.get("/api/app/agent/config", headers=admin_headers).json()
        return view["meta"]["version"]

    def test_save_applies_immediately(self, test_client, admin_headers):
        version = self._version(test_client, admin_headers)
        resp = test_client.put(
            "/api/app/agent/config",
            json={
                "values": {"model": "gpt-4o-test", "temperature": 0.7},
                "version": version,
            },
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["version"] > version  # 行不存在 → 1；已存在 → +1
        # 修订后全部键热生效，无 worker_restart 分区
        assert data["applied"] == {"model": "immediate", "temperature": "immediate"}
        assert data["env_overridden"] == []
        # 本进程 GET 立即可见新值（source=db，version 同步推进）
        view = test_client.get("/api/app/agent/config", headers=admin_headers).json()
        assert view["config"]["model"] == "gpt-4o-test"
        assert view["config"]["temperature"] == 0.7
        assert view["meta"]["source"]["model"] == "db"
        assert view["meta"]["version"] == data["version"]

    def test_stale_version_409(self, test_client, admin_headers):
        version = self._version(test_client, admin_headers)
        resp = test_client.put(
            "/api/app/agent/config",
            json={"values": {"max_steps": 9}, "version": version + 100},
            headers=admin_headers,
        )
        assert resp.status_code == 409
        assert resp.json()["error"]["error_code"] == "agent_config_version_conflict"

    def test_double_save_same_version_conflicts(
        self, test_client, admin_headers
    ):
        version = self._version(test_client, admin_headers)
        body = {"values": {"max_steps": 5}, "version": version}
        first = test_client.put(
            "/api/app/agent/config", json=body, headers=admin_headers
        )
        assert first.status_code == 200, first.text
        # 首次保存已推进版本 → 同版本二次保存必须被乐观锁挡住
        second = test_client.put(
            "/api/app/agent/config", json=body, headers=admin_headers
        )
        assert second.status_code == 409
        assert second.json()["error"]["error_code"] == "agent_config_version_conflict"

    def test_non_whitelisted_key_422(self, test_client, admin_headers):
        version = self._version(test_client, admin_headers)
        resp = test_client.put(
            "/api/app/agent/config",
            json={"values": {"api_key": "sk-should-never-land"}, "version": version},
            headers=admin_headers,
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["error_code"] == "agent_config_invalid"
        # 未落库：GET 配置无该键
        view = test_client.get("/api/app/agent/config", headers=admin_headers).json()
        assert "api_key" not in view["config"]

    def test_out_of_range_value_422(self, test_client, admin_headers):
        version = self._version(test_client, admin_headers)
        resp = test_client.put(
            "/api/app/agent/config",
            json={"values": {"temperature": 9.0}, "version": version},
            headers=admin_headers,
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["error_code"] == "agent_config_invalid"
        # 校验失败不落库、不推进版本
        assert self._version(test_client, admin_headers) == version

    def test_env_overridden_key_reported_and_env_wins(
        self, test_client, admin_headers, monkeypatch
    ):
        monkeypatch.setenv("KUSTOS_AGENT_MODEL", "gpt-env-pinned")
        version = self._version(test_client, admin_headers)
        resp = test_client.put(
            "/api/app/agent/config",
            json={"values": {"model": "gpt-4o-test"}, "version": version},
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text
        # 提交键被 env 压过 → 回报给前端提示
        assert resp.json()["env_overridden"] == ["model"]
        # 写入进程同样遵守 env > db（写后全量 reload，kill switch 不被绕过）
        view = test_client.get("/api/app/agent/config", headers=admin_headers).json()
        assert view["config"]["model"] == "gpt-env-pinned"
        assert view["meta"]["source"]["model"] == "env"

    def test_updated_by_audit_lands(
        self, test_client, admin_headers, admin_user, db
    ):
        from sqlalchemy import select

        from app.models.app_config import AppConfig

        version = self._version(test_client, admin_headers)
        resp = test_client.put(
            "/api/app/agent/config",
            json={"values": {"max_tokens": 2048}, "version": version},
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text
        row = db.execute(
            select(AppConfig).where(AppConfig.section == "agent")
        ).scalar_one()
        assert row.updated_by == admin_user.id
        assert row.payload["max_tokens"] == 2048

    def test_save_reaches_runtime_provider(self, test_client, admin_headers, monkeypatch):
        """应用链：保存并 reload 后，运行时 ``get_provider()`` 取到新值。

        作业侧每作业重建 provider（``services/agent_service.py``），故管理面
        保存的 model/base_url 无需任何额外步骤即被下一次作业消费。
        """
        monkeypatch.setenv("KUSTOS_AGENT_API_KEY", "sk-runtime-smoke")
        version = self._version(test_client, admin_headers)
        resp = test_client.put(
            "/api/app/agent/config",
            json={
                "values": {
                    "model": "runtime-model-x",
                    "base_url": "http://127.0.0.1:9/v1",
                },
                "version": version,
            },
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text

        from app.services.agent.providers import OpenAICompatProvider, get_provider

        provider = get_provider()
        assert isinstance(provider, OpenAICompatProvider)
        assert provider.model == "runtime-model-x"
        assert provider.base_url == "http://127.0.0.1:9/v1"

    def test_cross_process_convergence_via_ttl(
        self, test_client, admin_headers, monkeypatch
    ):
        """应用链：另一 worker 直写 ``app_config``（绕过本进程 reload）后，
        本进程经 TTL 版本检测窗口（≤5s）在下次访问时收敛到新值。
        """
        from app.core.config import ConfigManager
        from app.services.config_store import update_sections

        monkeypatch.delenv("KUSTOS_AGENT_MODEL", raising=False)
        manager = ConfigManager()
        before = manager.config.agent.model  # 刷新检测窗口
        update_sections({"agent": {"model": "from-other-worker"}})
        # 窗口未到期：不打库，仍是旧值
        assert manager.config.agent.model == before
        manager._db_check_at = 0.0  # 让窗口到期（真实场景最迟 5s）
        assert manager.config.agent.model == "from-other-worker"
