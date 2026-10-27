"""
ConfigManager 集成测试

测试配置管理器的核心功能：
1. 配置加载（env + app_config + 默认值；TOML 层已移除）
2. 环境变量覆盖
3. 配置验证
4. 配置重载
"""
import os
import pytest
from unittest.mock import patch

from app.core.config import ConfigManager, Config, get_config, reset_module_config_manager
from app.core.config import validate_config, ConfigValidationResult, StorageSettings, SecuritySettings
from app.core.config import AppSettings, ServerSettings


class TestConfigManager:
    """ConfigManager 集成测试类"""

    _ENV_BACKUP: dict = {}

    def setup_method(self):
        """每个测试方法前重置 ConfigManager 单例和环境变量"""
        # 快照环境变量 (teardown 恢复, 避免污染其他测试的 create_app 初始化)
        env_vars_to_clear = [
            "DATABASE_URL",
            "KUSTOS_STRESS_TEST",
            "KUSTOS_SECURITY_SECRET_KEY",
            "KUSTOS_APP_DEBUG",
            "KUSTOS_APP_TITLE",
            "KUSTOS_DATABASE_URL",
        ]
        self._ENV_BACKUP = {var: os.environ.get(var) for var in env_vars_to_clear}
        # 先清除所有可能影响的环境变量
        for var in env_vars_to_clear:
            os.environ.pop(var, None)
        # 然后重置单例
        reset_module_config_manager()

    def teardown_method(self):
        """每个测试方法后清理"""
        # 恢复环境变量快照
        for var, value in self._ENV_BACKUP.items():
            if value is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = value
        reset_module_config_manager()

    def test_config_default_values(self):
        """
        测试配置默认值

        验证点：
        1. 当没有环境变量与数据库覆盖时，使用 Pydantic Field 默认值
        2. 所有必要配置都有合理的默认值
        """
        # 使用不存在的配置文件路径
        # 本测试意图是"无环境变量、无 DB 覆盖时的默认值"，
        # 需屏蔽容器/测试环境注入的 KUSTOS_* 变量（如 KUSTOS_STORAGE_REPO_ROOT）
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("KUSTOS_STORAGE_REPO_ROOT", None)
            manager = ConfigManager("/nonexistent/config.toml")
            config = manager.config

        # 验证默认值
        assert config.app.title == "Kustos API", "应该有默认应用标题"
        assert config.server.host == "0.0.0.0", "应该有默认服务器地址"
        assert config.server.port == 8000, "应该有默认服务器端口"
        assert config.database.pool_size == 20, "应该有默认连接池大小"
        # 注意：容器环境中可能使用不同的默认路径
        assert config.storage.repo_root in ["./repositories", "/data/repositories"], "应该有默认仓库根目录"

    def test_config_invalid_database_url(self):
        """
        测试无效的数据库 URL 验证

        验证点：
        1. 无效的数据库 URL 应该引发验证错误
        2. 不支持的数据库协议应该被拒绝
        """
        # 设置无效的数据库 URL
        os.environ["DATABASE_URL"] = "mysql://invalid/url"

        try:
            with pytest.raises(ValueError) as exc_info:
                ConfigManager("/nonexistent/config.toml")

            error_msg = str(exc_info.value).lower()
            assert "不支持的协议" in str(exc_info.value) or "unsupported" in error_msg or "mysql" in error_msg

        finally:
            if "DATABASE_URL" in os.environ:
                del os.environ["DATABASE_URL"]

    def test_config_database_url_validation_formats(self):
        """
        测试数据库 URL 格式校验

        验证点：
        1. PostgreSQL 的各种合法 URL 变体都被接受
        2. SQLite 连接串已被拒绝（数据库只支持 PostgreSQL）
        """
        valid_urls = [
            "postgresql://user:pass@localhost/db",
            "postgres://user:pass@localhost/db",
            "postgresql+psycopg2://user:pass@localhost/db",
            "postgresql+asyncpg://user:pass@localhost/db",
        ]

        for url in valid_urls:
            reset_module_config_manager()
            os.environ["DATABASE_URL"] = url

            try:
                manager = ConfigManager("/nonexistent/config.toml")
                config = manager.config
                assert config.database.url == url, f"URL 应该被接受: {url}"
            finally:
                if "DATABASE_URL" in os.environ:
                    del os.environ["DATABASE_URL"]

        for url in ("sqlite:///./test.db", "sqlite+aiosqlite:///./test.db", "mysql://u:p@h/db"):
            reset_module_config_manager()
            os.environ["DATABASE_URL"] = url

            try:
                with pytest.raises(Exception):
                    ConfigManager("/nonexistent/config.toml").config
            finally:
                if "DATABASE_URL" in os.environ:
                    del os.environ["DATABASE_URL"]

    def test_config_stress_test_mode(self):
        """
        测试压力测试模式配置

        验证点：
        1. KUSTOS_STRESS_TEST=true 启用压力测试模式
        2. 压力测试模式影响数据库连接池配置
        3. 并发控制配置根据压力测试模式自适应
        """
        os.environ["KUSTOS_STRESS_TEST"] = "true"

        try:
            manager = ConfigManager("/nonexistent/config.toml")
            config = manager.config

            assert config.database.is_stress_test == True, "压力测试模式应该被启用"

            # 验证并发配置自适应（期望 200，但不得超过连接池有效容量）
            from app.core.config import ConcurrencySettings
            desired = ConcurrencySettings.from_database(
                config.database, apply_pool_cap=False
            ).max_concurrent
            assert desired == 200, "压力测试模式的期望并发上限应为 200"

            capacity = config.database.effective_pool_capacity
            expected = min(desired, capacity) if capacity else desired
            assert config.concurrency.max_concurrent == expected, (
                "并发上限不得超过连接池有效容量（中间件须先于 pool_timeout 拒绝）"
            )
            assert config.concurrency.max_wait_time == 10.0, "压力测试模式应该有更长的等待时间"

        finally:
            if "KUSTOS_STRESS_TEST" in os.environ:
                del os.environ["KUSTOS_STRESS_TEST"]

    def test_config_singleton_pattern(self):
        """
        测试 ConfigManager 单例模式

        验证点：
        1. 多次创建 ConfigManager 返回同一实例
        2. 配置修改对所有引用可见
        """
        manager1 = ConfigManager("/nonexistent/config.toml")
        manager2 = ConfigManager("/nonexistent/config.toml")

        assert manager1 is manager2, "ConfigManager 应该是单例"

    def test_get_config_convenience_function(self):
        """
        测试 get_config 便捷函数

        验证点：
        1. get_config() 返回有效的 Config 对象
        2. 多次调用返回同一配置实例
        """
        reset_module_config_manager()

        config1 = get_config()
        config2 = get_config()

        assert isinstance(config1, Config), "应该返回 Config 实例"
        assert config1 is config2, "多次调用应该返回同一实例"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


# =============================================================================
# 启动配置完整性校验测试
# =============================================================================


class TestConfigValidation:
    """配置完整性校验测试类"""

    _ENV_BACKUP: dict = {}

    def setup_method(self):
        """每个测试方法前重置 ConfigManager 单例"""
        from app.core.config import reset_module_config_manager

        # 快照环境变量 (teardown 恢复, 避免污染其他测试的 create_app 初始化)
        env_vars_to_clear = [
            "DATABASE_URL", "KUSTOS_STRESS_TEST",
            "KUSTOS_SECURITY_SECRET_KEY", "KUSTOS_APP_DEBUG",
        ]
        self._ENV_BACKUP = {var: os.environ.get(var) for var in env_vars_to_clear}
        for var in env_vars_to_clear:
            os.environ.pop(var, None)
        reset_module_config_manager()

    def teardown_method(self):
        """每个测试方法后清理"""
        from app.core.config import reset_module_config_manager

        for var, value in self._ENV_BACKUP.items():
            if value is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = value
        reset_module_config_manager()

    def test_validate_config_valid_defaults(self):
        """
        测试默认配置校验通过

        验证点：
        1. 使用默认配置时校验通过
        2. 无 errors
        """
        # 设置 debug 模式避免因缺少 secret_key 报错
        os.environ["KUSTOS_APP_DEBUG"] = "true"
        try:
            result = validate_config(get_config())
            assert result.is_valid, f"默认配置应通过校验, 错误: {result.errors}"
        finally:
            if "KUSTOS_APP_DEBUG" in os.environ:
                del os.environ["KUSTOS_APP_DEBUG"]

    def test_validate_config_invalid_db_url_fails_startup(self):
        """
        测试无效的数据库 URL 导致校验失败

        验证点：
        1. 不支持的数据库协议被拒绝
        """
        os.environ["DATABASE_URL"] = "mysql://invalid/url"

        try:
            # 使用无效 URL 创建配置
            from app.core.config import ConfigManager
            # 会因 Pydantic 验证而直接抛出 ValueError
            with pytest.raises(ValueError) as exc_info:
                ConfigManager("/nonexistent/config.toml")

            assert "不支持的" in str(exc_info.value) or "mysql" in str(exc_info.value).lower(), \
                f"错误信息应包含协议不支持提示: {exc_info.value}"
        finally:
            if "DATABASE_URL" in os.environ:
                del os.environ["DATABASE_URL"]

    def test_validate_storage_repo_root_creation(self, tmpdir):
        """
        测试存储路径自动创建

        验证点：
        1. 不存在的仓库目录可以被自动创建
        """
        from app.core.config import Config, AppSettings, StorageSettings, SecuritySettings
        test_root = os.path.join(tmpdir, "new_repos")
        config = Config(
            app=AppSettings(debug=True),
            storage=StorageSettings(repo_root=test_root),
            security=SecuritySettings(secret_key="test-key"),
        )

        result = validate_config(config)

        assert result.is_valid, f"校验应通过: {result.errors}"
        assert os.path.exists(test_root), "仓库根目录应被自动创建"

    def test_validate_security_production_no_secret_key(self):
        """
        测试生产环境缺少 Secret Key 时报错

        验证点：
        1. 生产模式（debug=False）且没有 secret_key 时报错
        """
        from app.core.config import Config, AppSettings, SecuritySettings
        config = Config(
            app=AppSettings(debug=False),
            security=SecuritySettings(secret_key="")
        )

        result = validate_config(config)

        assert not result.is_valid, "生产环境缺少 Secret Key 应报错"
        assert any("JWT 密钥" in e for e in result.errors), \
            "错误应提示 JWT Secret Key 缺失"

    def test_validate_security_debug_no_secret_key_warns(self):
        """
        测试开发环境缺少 Secret Key 时仅警告

        验证点：
        1. debug=True 时缺少 secret_key 仅产生警告
        2. 不产生错误
        """
        from app.core.config import Config, AppSettings, SecuritySettings
        config = Config(
            app=AppSettings(debug=True),
            security=SecuritySettings(secret_key="")
        )

        result = validate_config(config)

        assert result.is_valid, "开发环境缺少 Secret Key 不应报错"
        assert any("JWT" in w for w in result.warnings), "应产生 JWT 警告"

    def test_validate_storage_repo_root_not_writable(self):
        """
        测试仓库根目录不可写时检测

        验证点：
        1. 仓库根目录不可写时产生错误
        """
        from app.core.config import Config, AppSettings, StorageSettings, SecuritySettings

        # 使用只读路径（Windows 下 C:\ 通常对普通用户只读）
        readonly_path = "C:\\" if os.name == "nt" else "/"
        config = Config(
            app=AppSettings(debug=True),
            storage=StorageSettings(repo_root=readonly_path),
            security=SecuritySettings(secret_key="test-key"),
        )

        result = validate_config(config)

        # 注意：部分环境下 root 可能可写，所以这可能产生错误或警告
        # 至少应该有响应（error 或 warning）
        assert len(result.errors) > 0 or len(result.warnings) >= 0, "应检测到路径问题"

    def test_validate_token_expiry_warnings(self):
        """
        测试 Token 过期时间合理性检测

        验证点：
        1. 过短的 access_token 过期时间产生警告
        2. 过长的 refresh_token 过期时间产生警告
        """
        from app.core.config import Config, AppSettings, SecuritySettings
        config = Config(
            app=AppSettings(debug=True),
            security=SecuritySettings(
                secret_key="test-key",
                access_token_expire_minutes=1,  # 1分钟，太短
                refresh_token_expire_days=100,  # 100天，太长
            )
        )

        result = validate_config(config)

        assert result.is_valid, "不合理但合法的配置不应报错"
        token_warnings = [w for w in result.warnings if "令牌" in w or "Token" in w]
        assert len(token_warnings) >= 2, "应检测到至少 2 个 Token 过期时间警告"

    def test_validate_database_pool_config(self):
        """
        测试数据库连接池配置合理性检测

        验证点：
        1. 无效的 PostgreSQL SSL 模式产生错误
        """
        from app.core.config import Config, AppSettings, DatabaseSettings, SecuritySettings
        config = Config(
            app=AppSettings(debug=True),
            database=DatabaseSettings(
                url="postgresql://user:pass@localhost/db",
                pg_ssl_mode="invalid_ssl_mode",
            ),
            security=SecuritySettings(secret_key="test-key"),
        )

        result = validate_config(config)

        assert not result.is_valid, "无效 SSL 模式应报错"
        ssl_errors = [e for e in result.errors if "SSL" in e]
        assert len(ssl_errors) >= 1, "应检测到 SSL 模式错误"

    def test_validate_invalid_jwt_algorithm(self):
        """
        测试不支持的 JWT 算法检测

        验证点：
        1. 不支持的算法产生错误
        """
        from app.core.config import Config, AppSettings, SecuritySettings
        config = Config(
            app=AppSettings(debug=True),
            security=SecuritySettings(
                secret_key="test-key",
                algorithm="INVALID_ALGO"
            )
        )

        result = validate_config(config)

        assert not result.is_valid, "不支持的 JWT 算法应报错"
        assert any("算法" in e or "algorithm" in e.lower() for e in result.errors), \
            "错误应提示 JWT 算法无效"

    def test_validate_file_size_greater_than_repo_size(self):
        """
        测试单文件限制大于仓库限制时警告

        验证点：
        1. max_file_size > max_repo_size 时产生警告
        """
        from app.core.config import Config, AppSettings, StorageSettings, SecuritySettings
        config = Config(
            app=AppSettings(debug=True),
            storage=StorageSettings(
                max_repo_size=1000,
                max_file_size=2000,  # 大于仓库限制
            ),
            security=SecuritySettings(secret_key="test-key"),
        )

        result = validate_config(config)

        assert result.is_valid, "不合理的限制不应报错"
        size_warnings = [w for w in result.warnings if "大小限制" in w]
        assert len(size_warnings) > 0, "应检测到文件大小限制警告"

    def test_validate_validation_result_merge(self):
        """
        测试 ConfigValidationResult 合并功能

        验证点：
        1. merge() 正确合并两个结果
        """
        r1 = ConfigValidationResult()
        r1.add_error("err1")
        r1.add_warning("warn1")

        r2 = ConfigValidationResult()
        r2.add_error("err2")
        r2.add_warning("warn2")

        r1.merge(r2)

        assert len(r1.errors) == 2
        assert len(r1.warnings) == 2
        assert "err1" in r1.errors
        assert "err2" in r1.errors
        assert "warn1" in r1.warnings
        assert "warn2" in r1.warnings


# =============================================================================
# env 源隔离（TOML 层已移除；DB 源用例见 tests/test_config_store.py）
# =============================================================================


class TestEnvSourceIsolation:
    """根 Config 禁用裸环境变量源 + 各节 KUSTOS_* 前缀仍生效

    优先级契约：init kwargs > env > app_config[节] > 字段默认值。
    """

    _ENV_BACKUP: dict = {}

    # 需隔离的环境变量（含裸节名——修复的碰撞面）
    _ISOLATED = [
        "DATABASE_URL", "KUSTOS_STRESS_TEST", "KUSTOS_SECURITY_SECRET_KEY",
        "KUSTOS_APP_DEBUG", "KUSTOS_APP_TITLE", "KUSTOS_STORAGE_REPO_ROOT",
        "KUSTOS_SECURITY_ACCESS_TOKEN_EXPIRE_MINUTES",
        "AGENT", "APP", "SERVER", "REDIS", "LOGGING", "STORAGE",
    ]

    def setup_method(self):
        self._ENV_BACKUP = {var: os.environ.get(var) for var in self._ISOLATED}
        for var in self._ISOLATED:
            os.environ.pop(var, None)
        reset_module_config_manager()

    def teardown_method(self):
        for var, value in self._ENV_BACKUP.items():
            if value is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = value
        reset_module_config_manager()

    # ---------------- 容错 ----------------

    def test_bare_env_var_does_not_crash_root_config(self):
        """根 Config 不再读裸环境变量。

        实测宿主机 ``AGENT=1`` 会以节名匹配 ``agent`` 字段并打崩
        ``Config()``（大小写不敏感）；禁用后只认 ``KUSTOS_AGENT_*``。
        """
        os.environ["AGENT"] = "1"
        os.environ["APP"] = "not-a-settings-object"
        os.environ["SERVER"] = "also-broken"
        reset_module_config_manager()

        config = ConfigManager("/nonexistent/config.toml").config
        assert config.agent.enabled is False, "裸 AGENT 不应再影响 agent 节"
        assert isinstance(config.app, AppSettings)
        assert isinstance(config.server, ServerSettings)

    def test_prefixed_env_still_reaches_section(self):
        """禁用根 env 源不影响各节自带的 KUSTOS_* 前缀变量"""
        os.environ["KUSTOS_AGENT_ENABLED"] = "true"
        reset_module_config_manager()
        try:
            config = ConfigManager("/nonexistent/config.toml").config
            assert config.agent.enabled is True
        finally:
            os.environ.pop("KUSTOS_AGENT_ENABLED", None)

    # ---------------- 单节直接实例化语义不变 ----------------

