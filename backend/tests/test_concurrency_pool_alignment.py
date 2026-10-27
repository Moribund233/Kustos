"""并发准入上限与连接池容量对齐

约束：``max_concurrent ≤ database.effective_pool_capacity``，
使压测/慢 DB 下由**中间件有界 503** 拒绝，而不是先抛 ``pool_timeout``（500）。

背景：中间件上限（常态 100 / 压测 200）与池容量（20+40=60 / 30+60=90）
互不知情，且每个请求自认证起持有 session 至响应——池先于中间件耗尽。
"""
import pytest

from app.core.config import (
    AppSettings,
    Config,
    ConcurrencySettings,
    DatabaseSettings,
    SecuritySettings,
    validate_config,
)

PG_URL = "postgresql+asyncpg://user:pass@localhost:5432/kustos"


def _config(db: DatabaseSettings) -> Config:
    return Config(
        app=AppSettings(debug=True),
        database=db,
        security=SecuritySettings(secret_key="test-key"),
    )


class TestPoolCapacity:
    def test_normal_mode(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", PG_URL)
        db = DatabaseSettings(pool_size=20, max_overflow=40)
        assert db.effective_pool_capacity == 60

    def test_stress_mode_uses_stress_pool(self, monkeypatch):
        # is_stress_test 有 before 校验器：环境变量 KUSTOS_STRESS_TEST 优先于构造入参
        monkeypatch.setenv("DATABASE_URL", PG_URL)
        monkeypatch.setenv("KUSTOS_STRESS_TEST", "true")
        db = DatabaseSettings(is_stress_test=True)
        assert db.is_stress_test is True
        assert db.effective_pool_capacity == db.stress_pool_size + db.stress_max_overflow


class TestConcurrencyDerivation:
    def test_default_clamped_to_pool_capacity(self, monkeypatch):
        """常态默认期望 100 > 池容量 60 → 收窄到 60（原缺陷）"""
        monkeypatch.setenv("DATABASE_URL", PG_URL)
        monkeypatch.delenv("MAX_CONCURRENT", raising=False)
        db = DatabaseSettings(pool_size=20, max_overflow=40)

        assert ConcurrencySettings.from_database(
            db, apply_pool_cap=False
        ).max_concurrent == 100, "期望值应维持历史默认 100"

        concurrency = _config(db).concurrency
        assert concurrency.max_concurrent == 60
        assert concurrency.max_wait_time == 5.0

    def test_large_pool_keeps_desired_ceiling(self, monkeypatch):
        """调大连接池后回到期望上限，而不是无限跟随池容量"""
        monkeypatch.setenv("DATABASE_URL", PG_URL)
        monkeypatch.delenv("MAX_CONCURRENT", raising=False)
        concurrency = _config(
            DatabaseSettings(pool_size=150, max_overflow=0)
        ).concurrency
        assert concurrency.max_concurrent == 100

    def test_stress_mode_clamped(self, monkeypatch):
        """压测期望 200，但 stress 池容量 90 → 收窄到 90（原缺陷更严重）"""
        monkeypatch.setenv("DATABASE_URL", PG_URL)
        monkeypatch.setenv("KUSTOS_STRESS_TEST", "true")
        monkeypatch.delenv("MAX_CONCURRENT", raising=False)
        db = DatabaseSettings()

        desired = ConcurrencySettings.from_database(db, apply_pool_cap=False)
        assert desired.max_concurrent == 200
        assert desired.max_wait_time == 10.0

        concurrency = _config(db).concurrency
        assert concurrency.max_concurrent == db.effective_pool_capacity == 90
        assert concurrency.max_wait_time == 10.0

    def test_env_override_cannot_break_invariant(self, monkeypatch):
        """即使环境变量抬高上限，也必须被池容量收窄（不变式优先）"""
        monkeypatch.setenv("DATABASE_URL", PG_URL)
        monkeypatch.setenv("MAX_CONCURRENT", "500")
        db = DatabaseSettings(pool_size=20, max_overflow=40)

        assert ConcurrencySettings.from_database(
            db, apply_pool_cap=False
        ).max_concurrent == 500, "env 仍是期望值入口"
        assert _config(db).concurrency.max_concurrent == 60

    @pytest.mark.parametrize(
        "pool_size,max_overflow",
        [(20, 40), (10, 0), (50, 10), (150, 0), (5, 5)],
    )
    def test_invariant_max_concurrent_le_capacity(self, monkeypatch,
                                                  pool_size, max_overflow):
        monkeypatch.setenv("DATABASE_URL", PG_URL)
        monkeypatch.delenv("MAX_CONCURRENT", raising=False)
        db = DatabaseSettings(pool_size=pool_size, max_overflow=max_overflow)
        concurrency = _config(db).concurrency
        assert concurrency.max_concurrent <= db.effective_pool_capacity


class TestValidationReport:
    def test_warns_when_clamped(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", PG_URL)
        monkeypatch.delenv("MAX_CONCURRENT", raising=False)
        config = _config(DatabaseSettings(pool_size=20, max_overflow=40))

        result = validate_config(config)

        assert result.is_valid
        clamp_warnings = [w for w in result.warnings if "收窄" in w]
        assert clamp_warnings, "配置报告应提示并发上限已被池容量收窄"
        assert "60" in clamp_warnings[0] and "100" in clamp_warnings[0]

    def test_no_warning_when_capacity_sufficient(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", PG_URL)
        monkeypatch.delenv("MAX_CONCURRENT", raising=False)
        config = _config(DatabaseSettings(pool_size=150, max_overflow=0))

        result = validate_config(config)

        assert not [w for w in result.warnings if "收窄" in w]
