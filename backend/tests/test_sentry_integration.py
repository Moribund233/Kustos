"""
Sentry 错误监控集成测试

覆盖：
- SentrySettings 配置解析（环境变量 / TOML 合并 / 采样率校验）
- DSN 为空时 init_sentry 零开销跳过（不导入 sentry-sdk）
- DSN 配置后 init_sentry 调用 sentry_sdk.init 并传递正确参数
- environment 推导（debug → development / production）
- 重复调用幂等性
"""
import sys
import types

import pytest

from app.core.config import Config, SentrySettings


class FakeSentrySDK:
    """伪造 sentry_sdk 模块, 验证 init 调用参数而不发起真实网络连接"""

    def __init__(self):
        self.init_calls = []
        self.reset_calls = []

    def init(self, **kwargs):
        self.init_calls.append(kwargs)
        return None


def _install_fake_sentry(monkeypatch, fake: FakeSentrySDK):
    """将伪造的 sentry_sdk 包（含 integrations 子包）注入 sys.modules"""
    sentry_mod = types.ModuleType("sentry_sdk")
    sentry_mod.init = fake.init
    sentry_mod.__path__ = []  # 标记为包, 允许子模块注册

    integrations_pkg = types.ModuleType("sentry_sdk.integrations")
    integrations_pkg.__path__ = []

    def integration_cls():
        class Integration:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

        return Integration

    for sub in ("fastapi", "logging", "starlette"):
        mod = types.ModuleType(f"sentry_sdk.integrations.{sub}")
        if sub == "fastapi":
            mod.FastApiIntegration = integration_cls()
        elif sub == "logging":
            mod.LoggingIntegration = integration_cls()
        else:
            mod.StarletteIntegration = integration_cls()
            mod.SentryAsgiMiddleware = integration_cls
        integrations_pkg.__dict__[sub] = mod
        monkeypatch.setitem(sys.modules, f"sentry_sdk.integrations.{sub}", mod)

    monkeypatch.setitem(sys.modules, "sentry_sdk", sentry_mod)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations", integrations_pkg)


def _make_config(sentry: SentrySettings, debug: bool = False) -> Config:
    config = Config()
    config.sentry = sentry
    config.app.debug = debug
    return config


class TestSentrySettings:
    def test_defaults_disable(self):
        s = SentrySettings()
        assert s.dsn == ""
        assert s.traces_sample_rate == 1.0
        assert s.environment == ""

    def test_dsn_from_env(self, monkeypatch):
        monkeypatch.setenv("KUSTOS_SENTRY_DSN", "https://example@sentry.example/1")
        s = SentrySettings()
        assert s.dsn == "https://example@sentry.example/1"

    def test_sample_rate_validated(self):
        with pytest.raises(ValueError):
            SentrySettings(traces_sample_rate=1.5)
        with pytest.raises(ValueError):
            SentrySettings(traces_sample_rate=-0.1)

    def test_db_merge_takes_effect(self, isolated_db_url, monkeypatch):
        """DB 覆盖层的 sentry 值生效（源链：env > app_config > 默认值；TOML 层已移除）"""
        from sqlalchemy import create_engine

        from app.core.config import ConfigManager, reset_module_config_manager
        from app.models.app_config import AppConfig

        url = isolated_db_url
        engine = create_engine(url)
        try:
            table = AppConfig.__table__
            table.create(engine, checkfirst=True)
            with engine.begin() as conn:
                conn.execute(table.insert().values(
                    section="sentry",
                    payload={
                        "dsn": "https://db@sentry.example/2",
                        "traces_sample_rate": 0.5,
                    },
                    version=1,
                ))
        finally:
            engine.dispose()

        monkeypatch.setenv("DATABASE_URL", url)
        # 排除 env 覆盖，确认值来自数据库层
        monkeypatch.delenv("KUSTOS_SENTRY_DSN", raising=False)
        monkeypatch.delenv("KUSTOS_SENTRY_TRACES_SAMPLE_RATE", raising=False)
        reset_module_config_manager()
        try:
            manager = ConfigManager("config.toml")
            assert manager.config.sentry.dsn == "https://db@sentry.example/2"
            assert manager.config.sentry.traces_sample_rate == 0.5
        finally:
            reset_module_config_manager()


class TestInitSentry:
    def test_skipped_when_dsn_empty(self, monkeypatch):
        """DSN 为空时不导入 sentry-sdk, 不产生任何副作用"""
        called = {"imported": False}

        def patched_import(name, *args, **kwargs):
            if name == "sentry_sdk":
                called["imported"] = True
                raise ImportError("should not import")
            return original_import(name, *args, **kwargs)

        original_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__
        monkeypatch.setattr("builtins.__import__", patched_import)

        from app.core.sentry import init_sentry, reset_sentry, sentry_enabled

        reset_sentry()
        assert init_sentry(_make_config(SentrySettings())) is False
        assert called["imported"] is False
        assert sentry_enabled() is False
        reset_sentry()

    def test_enabled_with_dsn(self, monkeypatch):
        fake_sdk = FakeSentrySDK()
        _install_fake_sentry(monkeypatch, fake_sdk)

        from app.core.sentry import init_sentry, reset_sentry, sentry_enabled

        reset_sentry()
        s = SentrySettings(dsn="https://example@sentry.example/1", traces_sample_rate=0.75)
        assert init_sentry(_make_config(s)) is True
        assert sentry_enabled() is True
        assert len(fake_sdk.init_calls) == 1
        kwargs = fake_sdk.init_calls[0]
        assert kwargs["dsn"] == "https://example@sentry.example/1"
        assert kwargs["traces_sample_rate"] == 0.75
        reset_sentry()

    def test_environment_derived_production(self, monkeypatch):
        fake_sdk = FakeSentrySDK()
        _install_fake_sentry(monkeypatch, fake_sdk)

        from app.core.sentry import init_sentry, reset_sentry

        reset_sentry()
        s = SentrySettings(dsn="https://example@sentry.example/1")
        init_sentry(_make_config(s, debug=False))
        assert fake_sdk.init_calls[0]["environment"] == "production"
        reset_sentry()

    def test_environment_derived_development(self, monkeypatch):
        fake_sdk = FakeSentrySDK()
        _install_fake_sentry(monkeypatch, fake_sdk)

        from app.core.sentry import init_sentry, reset_sentry

        reset_sentry()
        s = SentrySettings(dsn="https://example@sentry.example/1")
        init_sentry(_make_config(s, debug=True))
        assert fake_sdk.init_calls[0]["environment"] == "development"
        reset_sentry()

    def test_explicit_environment_wins(self, monkeypatch):
        fake_sdk = FakeSentrySDK()
        _install_fake_sentry(monkeypatch, fake_sdk)

        from app.core.sentry import init_sentry, reset_sentry

        reset_sentry()
        s = SentrySettings(dsn="https://example@sentry.example/1", environment="staging")
        init_sentry(_make_config(s, debug=False))
        assert fake_sdk.init_calls[0]["environment"] == "staging"
        reset_sentry()

    def test_idempotent_after_initialize(self, monkeypatch):
        fake_sdk = FakeSentrySDK()
        _install_fake_sentry(monkeypatch, fake_sdk)

        from app.core.sentry import init_sentry, reset_sentry

        reset_sentry()
        s = SentrySettings(dsn="https://example@sentry.example/1")
        assert init_sentry(_make_config(s)) is True
        assert init_sentry(_make_config(s)) is True  # 已初始化, 不重复 init
        assert len(fake_sdk.init_calls) == 1
        reset_sentry()

    def test_does_not_send_pii_by_default(self, monkeypatch):
        fake_sdk = FakeSentrySDK()
        _install_fake_sentry(monkeypatch, fake_sdk)

        from app.core.sentry import init_sentry, reset_sentry

        reset_sentry()
        s = SentrySettings(dsn="https://example@sentry.example/1")
        init_sentry(_make_config(s))
        assert fake_sdk.init_calls[0].get("send_default_pii") is False
        reset_sentry()

    def test_app_environments_no_sentry_when_disabled(self):
        """默认未配置 DSN 时应用创建不受影响 (不导入 sentry-sdk)"""
        from app.main import create_app

        app = create_app()
        assert app is not None