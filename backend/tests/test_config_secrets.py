"""配置密钥（``config_secrets``）测试：加密工具 + 同事务写入 + API 契约零回显。

安全红线：
主密钥域分隔派生 · AEAD+版本前缀+AAD · GET 零回显 · 解密失败显式错误码 ·
密钥写入 admin-only · 审计只记键名 · 两链路（LLM/embedding）分键存储。
"""
import pytest

from app.core.exception import AuthorizationException
from app.core.config_store import (
    get_secret,
    invalidate_secret_cache,
    update_sections,
)
from app.utils.config_crypto import (
    ConfigSecretError,
    decrypt_secret,
    encrypt_secret,
    is_encrypted,
    reset_master_cache,
)

#: 本文件内统一的主密钥环境（autouse 每例重置，防跨例串状态）
MASTER_ENVS = ("KUSTOS_CONFIG_MASTER_KEY", "KUSTOS_SECURITY_SECRET_KEY",)


@pytest.fixture(autouse=True)
def _master(monkeypatch):
    monkeypatch.delenv("KUSTOS_CONFIG_MASTER_KEY", raising=False)
    monkeypatch.setenv("KUSTOS_SECURITY_SECRET_KEY", "unit-test-secret-key")
    reset_master_cache()
    invalidate_secret_cache()
    yield
    reset_master_cache()
    invalidate_secret_cache()


def _raw_secret_row(section: str, name: str):
    """直查 ``config_secrets`` 原始行（绕过解密层，验证密文落库）"""
    from sqlalchemy import text

    from app.core.config_store import _make_engine, _resolve_sync_url

    engine = _make_engine(_resolve_sync_url())
    try:
        with engine.connect() as conn:
            return conn.execute(
                text(
                    "SELECT ciphertext FROM config_secrets "
                    "WHERE section = :s AND name = :n"
                ),
                {"s": section, "n": name},
            ).scalar()
    finally:
        engine.dispose()


class TestCrypto:
    """AES-GCM 工具：往返 / AAD / 篡改 / 主密钥派生"""

    def test_roundtrip_and_no_plaintext_in_ciphertext(self):
        ct = encrypt_secret("sk-live-123", section="agent", name="api_key")
        assert is_encrypted(ct) and ct.startswith("enc:v1:")
        assert "sk-live-123" not in ct
        assert decrypt_secret(ct, section="agent", name="api_key") == "sk-live-123"

    def test_aad_binds_section_and_name(self):
        ct = encrypt_secret("sk-x", section="agent", name="api_key")
        with pytest.raises(ConfigSecretError):
            decrypt_secret(ct, section="search", name="api_key")
        with pytest.raises(ConfigSecretError):
            decrypt_secret(ct, section="agent", name="embedding_api_key")

    def test_tampered_ciphertext_rejected(self):
        ct = encrypt_secret("sk-x", section="agent", name="api_key")
        tail = "A" if not ct.endswith("A") else "B"
        tampered = ct[:-1] + tail
        with pytest.raises(ConfigSecretError):
            decrypt_secret(tampered, section="agent", name="api_key")

    def test_plaintext_passthrough_rejected(self):
        with pytest.raises(ConfigSecretError):
            decrypt_secret("sk-plain", section="agent", name="api_key")

    def test_empty_plaintext_rejected(self):
        with pytest.raises(ConfigSecretError):
            encrypt_secret("", section="agent", name="api_key")

    def test_dedicated_master_key_isolated_from_jwt_secret(self, monkeypatch):
        """专用主密钥存在时优先使用；且与 JWT 密钥派生结果不同（域分隔）"""
        ct_with_jwt = encrypt_secret("sk-a", section="agent", name="api_key")
        monkeypatch.setenv("KUSTOS_CONFIG_MASTER_KEY", "dedicated-master-key")
        reset_master_cache()
        ct_with_dedicated = encrypt_secret("sk-a", section="agent", name="api_key")
        # 同明文不同主密钥 → 密文不同（域分隔生效）
        assert ct_with_jwt != ct_with_dedicated
        assert (
            decrypt_secret(ct_with_dedicated, section="agent", name="api_key")
            == "sk-a"
        )
        # 旧密文在新主密钥下不可解（轮换语义）
        with pytest.raises(ConfigSecretError):
            decrypt_secret(ct_with_jwt, section="agent", name="api_key")

    def test_master_key_missing_raises(self, monkeypatch):
        for name in MASTER_ENVS:
            monkeypatch.delenv(name, raising=False)
        reset_master_cache()
        with pytest.raises(ConfigSecretError):
            encrypt_secret("sk-x", section="agent", name="api_key")


class TestStoreRoundtrip:
    """同事务写入 / 读取 / 清除 / 乐观锁原子性（真实 PG）

    用例挂 ``db`` 夹具：保证 ``test_engine``（临时库 + ``create_all`` +
    ``DATABASE_URL`` 指向）先行初始化，且 teardown 清行防跨文件残留。
    """

    def test_secret_write_is_ciphertext_at_rest(self, db):
        # 直连存储层种数据：不关心 CAS（服务层 PUT 才负责带 expected）
        update_sections(secrets={"agent": {"api_key": "sk-db-raw"}})
        raw = _raw_secret_row("agent", "api_key")
        assert raw and is_encrypted(raw) and "sk-db-raw" not in raw
        assert get_secret("agent", "api_key") == "sk-db-raw"

    def test_clear_secret(self, db):
        update_sections(secrets={"agent": {"api_key": "sk-x"}})
        assert get_secret("agent", "api_key") == "sk-x"
        update_sections(secrets={"agent": {"api_key": None}})
        assert get_secret("agent", "api_key") is None
        assert _raw_secret_row("agent", "api_key") is None

    def test_version_conflict_leaves_secret_untouched(self, db):
        from app.core.config import ConfigVersionConflictError

        update_sections(secrets={"agent": {"api_key": "sk-first"}})
        # 必然不匹配的期望版本（行版本恒 ≥0）→ 409 且密钥保持不变
        with pytest.raises(ConfigVersionConflictError):
            update_sections(
                {},
                expected={"agent": -1},
                secrets={"agent": {"api_key": "sk-second"}},
            )
        assert get_secret("agent", "api_key") == "sk-first"

    def test_secret_and_config_share_one_transaction(self, db):
        """配置 CAS 通过后密钥与配置一起生效；校验失败时一起回滚"""
        from app.core.config import ConfigVersionConflictError

        with pytest.raises(ConfigVersionConflictError):
            update_sections(
                {"agent": {"model": "m2"}},
                expected={"agent": 99},
                secrets={"agent": {"api_key": "sk-rollback"}},
            )
        assert get_secret("agent", "api_key") is None

    def test_agent_and_embedding_secrets_are_independent(self, db):
        update_sections(
            secrets={
                "agent": {"api_key": "sk-llm"},
                "search": {"embedding_api_key": "emb-key"},
            },
        )
        assert get_secret("agent", "api_key") == "sk-llm"
        assert get_secret("search", "embedding_api_key") == "emb-key"
        assert get_secret("agent", "api_key") != get_secret(
            "search", "embedding_api_key"
        )


class TestAgentKeyApi:
    """LLM key 的 admin 面：写入/读取/权限/零回显/运行期解析"""

    def test_put_api_key_roundtrip_no_echo(
        self, test_client, admin_headers, monkeypatch
    ):
        for name in ("KUSTOS_AGENT_API_KEY", "KUSTOS_OPENAI_API_KEY"):
            monkeypatch.delenv(name, raising=False)
        # 初始：无 env 无 DB
        status0 = test_client.get(
            "/api/app/agent/key-status", headers=admin_headers
        ).json()
        assert status0["configured"] is False and status0["source"] == "unset"

        resp = test_client.get("/api/app/agent/config", headers=admin_headers)
        version = resp.json()["meta"]["version"]

        # 带密钥保存
        resp = test_client.put(
            "/api/app/agent/config",
            json={
                "values": {"model": "mimo-v2.6-flash"},
                "version": version,
                "api_key": "sk-ui-secret",
            },
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "sk-ui-secret" not in resp.text
        assert body["key_state"] == {"configured": True, "source": "db"}
        assert body["applied"]["api_key"] == "immediate"

        # 三个读端点均零回显
        for path in (
            "/api/app/agent/config",
            "/api/app/agent/key-status",
            "/api/app/config?section=agent",
        ):
            resp = test_client.get(path, headers=admin_headers)
            assert resp.status_code == 200, path
            assert "sk-ui-secret" not in resp.text, path

        # key-status 生效来源 = db
        status = test_client.get(
            "/api/app/agent/key-status", headers=admin_headers
        ).json()
        assert status["configured"] is True
        assert status["source"] == "db" and status["injection"] == "database"

        # 读回配置 meta.key_state 与 model 已更新
        cfg = test_client.get("/api/app/agent/config", headers=admin_headers).json()
        assert cfg["meta"]["key_state"] == {"configured": True, "source": "db"}
        assert cfg["config"]["model"] == "mimo-v2.6-flash"

    def test_env_key_beats_db_key(self, test_client, admin_headers, monkeypatch):
        monkeypatch.setenv("KUSTOS_AGENT_API_KEY", "sk-from-env")
        update_sections(
            {}, secrets={"agent": {"api_key": "sk-from-db"}}
        )
        status = test_client.get(
            "/api/app/agent/key-status", headers=admin_headers
        ).json()
        assert status["source"] == "env" and status["injection"] == "compose_env"
        # PUT 提交新 key → 入库但被 env 压过（env_overridden 如实回报）
        resp = test_client.get("/api/app/agent/config", headers=admin_headers)
        version = resp.json()["meta"]["version"]
        resp = test_client.put(
            "/api/app/agent/config",
            json={"values": {}, "version": version, "api_key": "sk-ignored"},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        assert "api_key" in resp.json()["env_overridden"]

    def test_clear_api_key(self, test_client, admin_headers, monkeypatch):
        monkeypatch.delenv("KUSTOS_AGENT_API_KEY", raising=False)
        update_sections(
            {}, secrets={"agent": {"api_key": "sk-x"}}
        )
        resp = test_client.get("/api/app/agent/config", headers=admin_headers)
        version = resp.json()["meta"]["version"]
        resp = test_client.put(
            "/api/app/agent/config",
            json={"values": {}, "version": version, "clear_api_key": True},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["key_state"]["configured"] is False
        assert get_secret("agent", "api_key") is None

    def test_api_key_and_clear_are_mutually_exclusive(
        self, test_client, admin_headers
    ):
        resp = test_client.put(
            "/api/app/agent/config",
            json={
                "values": {},
                "version": 0,
                "api_key": "sk",
                "clear_api_key": True,
            },
            headers=admin_headers,
        )
        assert resp.status_code == 422
        body = resp.json()
        code = body.get("error", {}).get("error_code") or body.get("error_code")
        assert code == "agent_config_invalid"

    def test_api_key_write_requires_admin(self):
        """密钥写入 admin-only：debug 态的 danger 权限不足以换 key"""
        with pytest.raises(AuthorizationException) as exc:
            AgentAdminServiceShim().update_as_non_admin()
        assert exc.value.error_code == "app_admin_required"

    def test_runtime_provider_falls_back_to_db_key(self, monkeypatch, db):
        from app.services.agent.providers import (
            NotConfiguredProvider,
            get_provider,
        )

        for name in ("KUSTOS_AGENT_API_KEY", "KUSTOS_OPENAI_API_KEY"):
            monkeypatch.delenv(name, raising=False)
        assert isinstance(get_provider(), NotConfiguredProvider)
        update_sections(
            {}, secrets={"agent": {"api_key": "sk-runtime"}}
        )
        invalidate_secret_cache()
        provider = get_provider()
        assert type(provider).__name__ == "OpenAICompatProvider"
        assert provider._api_key == "sk-runtime"
        # repr 脱敏红线
        assert "sk-runtime" not in repr(provider)


class AgentAdminServiceShim:
    """直接调服务层以覆盖 admin-only 分支（HTTP 层 debug=false 会先被 danger 挡住）"""

    @staticmethod
    def update_as_non_admin():
        from app.services.agent.agent_admin_service import AgentAdminService

        return AgentAdminService().update_config(
            values={}, version=0, api_key="sk-x", is_admin=False
        )


class TestEmbeddingKeyApi:
    """embedding key 的 admin 面：与 LLM 链路分端点、分键"""

    def test_get_search_config_shape_no_key_fields(
        self, test_client, admin_headers
    ):
        resp = test_client.get("/api/app/search/config", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "embedding_enabled" in data["meta"]["editable_keys"]
        # 配置模型里没有任何 key 字段（结构性零回显）
        assert not [k for k in data["config"] if k.endswith("api_key") and k != "embedding_api_key_env"]
        assert data["config"]["embedding_api_key_env"]  # 只有变量名
        assert "key_state" in data["meta"]

    def test_put_embedding_key_roundtrip_no_echo(
        self, test_client, admin_headers, monkeypatch
    ):
        monkeypatch.delenv("KUSTOS_SEARCH_EMBEDDING_API_KEY_ENV", raising=False)
        monkeypatch.delenv("KUSTOS_AGENT_API_KEY", raising=False)
        resp = test_client.get("/api/app/search/config", headers=admin_headers)
        version = resp.json()["meta"]["version"]

        resp = test_client.put(
            "/api/app/search/config",
            json={
                "values": {"embedding_enabled": True, "embedding_dim": 1536},
                "version": version,
                "embedding_api_key": "emb-ui-secret",
            },
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text
        assert "emb-ui-secret" not in resp.text
        assert resp.json()["key_state"] == {"configured": True, "source": "db"}

        for path in ("/api/app/search/config", "/api/app/config?section=search"):
            resp = test_client.get(path, headers=admin_headers)
            assert resp.status_code == 200, path
            assert "emb-ui-secret" not in resp.text, path

        # 与 LLM 链路互不可见：agent 面的 key 状态不受影响
        status = test_client.get(
            "/api/app/agent/key-status", headers=admin_headers
        ).json()
        assert status["configured"] is False

    def test_search_conflict_error_code(self, test_client, admin_headers):
        resp = test_client.put(
            "/api/app/search/config",
            json={"values": {"embedding_dim": 1024}, "version": 999},
            headers=admin_headers,
        )
        assert resp.status_code == 409
        body = resp.json()
        code = body.get("error", {}).get("error_code") or body.get("error_code")
        assert code == "search_config_version_conflict"

    def test_search_invalid_key_error_code(self, test_client, admin_headers):
        resp = test_client.put(
            "/api/app/search/config",
            json={"values": {"not_a_key": 1}, "version": 0},
            headers=admin_headers,
        )
        assert resp.status_code == 422
        body = resp.json()
        code = body.get("error", {}).get("error_code") or body.get("error_code")
        assert code == "search_config_invalid"

    def test_non_admin_read_denied(self, test_client, auth_headers):
        resp = test_client.get("/api/app/search/config", headers=auth_headers)
        assert resp.status_code == 403

    def test_runtime_embedding_provider_falls_back_to_db_key(self, monkeypatch, db):
        from app.services.indexing.embeddings import (
            NotConfiguredEmbeddingProvider,
            get_embedding_provider,
        )

        monkeypatch.delenv("KUSTOS_AGENT_API_KEY", raising=False)
        monkeypatch.setenv("KUSTOS_SEARCH_EMBEDDING_API_KEY_ENV", "KUSTOS_EMB_KEY")
        monkeypatch.delenv("KUSTOS_EMB_KEY", raising=False)
        assert isinstance(get_embedding_provider(), NotConfiguredEmbeddingProvider)
        update_sections(
            {},
            secrets={"search": {"embedding_api_key": "emb-runtime"}},
        )
        invalidate_secret_cache()
        provider = get_embedding_provider()
        assert type(provider).__name__ == "OpenAICompatEmbeddingProvider"
        assert provider._api_key == "emb-runtime"
        assert "emb-runtime" not in repr(provider)


class TestDecryptFailureIsExplicit:
    """解密失败必须显式错误码，不得静默成「未配置」"""

    def test_get_secret_raises_on_wrong_master(self, monkeypatch, db):
        update_sections(
            {}, secrets={"agent": {"api_key": "sk-x"}}
        )
        # 换主密钥 → 解密失败
        monkeypatch.setenv("KUSTOS_CONFIG_MASTER_KEY", "another-master")
        reset_master_cache()
        invalidate_secret_cache()
        with pytest.raises(ConfigSecretError):
            get_secret("agent", "api_key")

    def test_runtime_get_provider_surfaces_error(self, monkeypatch, db):
        """运行期解密失败显式抛错（作业侧由 process_job 落 job.error，不静默）"""
        from app.utils.config_crypto import ConfigSecretError

        from app.services.agent.providers import get_provider

        monkeypatch.delenv("KUSTOS_AGENT_API_KEY", raising=False)
        update_sections(
            {}, secrets={"agent": {"api_key": "sk-x"}}
        )
        monkeypatch.setenv("KUSTOS_CONFIG_MASTER_KEY", "another-master")
        reset_master_cache()
        invalidate_secret_cache()
        with pytest.raises(ConfigSecretError):
            get_provider()
