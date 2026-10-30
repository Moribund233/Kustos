"""配置存储测试：DB 源优先级 / 播种幂等 / 降级 / 半生效修复。"""
import pytest
from sqlalchemy import create_engine

from app.core.config import (
    ConfigManager,
    ConfigWriteError,
    reset_module_config_manager,
)
from app.core.exception import ValidationException
from app.models.app_config import AppConfig
from app.core.config_store import (
    BOOTSTRAP_EXCLUDED_KEYS,
    BOOTSTRAP_EXCLUDED_SECTIONS,
    example_seed_data,
    load_all_section_values,
    seed_from_example,
)


@pytest.fixture(autouse=True)
def _fresh_config_manager():
    """每个用例前后重置单例，避免上一个用例的 Config/DB 源泄漏"""
    reset_module_config_manager()
    yield
    reset_module_config_manager()


def _seed_db_file(url: str) -> str:
    """在独立空库（conftest.isolated_db_url）上建 app_config 表，返回该库 URL"""
    engine = create_engine(url)
    try:
        AppConfig.__table__.create(engine, checkfirst=True)
    finally:
        engine.dispose()
    return url


def _write_toml(tmp_path, content: str) -> str:
    p = tmp_path / "config.toml"
    p.write_text(content, encoding="utf-8")
    return str(p)


class TestExampleSeedData:
    """种子来源：模板 → 引导层剔除 + 未知键过滤"""

    def test_excludes_bootstrap_sections_and_keys(self):
        data = example_seed_data()

        # 引导层以**键**为粒度排除（database 其余键可播种，与前端 READONLY_FIELDS 对齐）
        assert "url" not in data.get("database", {}), "引导层：连接串不得入表"
        assert "is_stress_test" not in data.get("database", {}), "引导层：压测开关不得入表"
        assert "secret_key" not in data.get("security", {}), "引导层：签名密钥不得入表"
        assert not (BOOTSTRAP_EXCLUDED_SECTIONS & set(data)), "整节排除清单与实际播种一致"
        for section, keys in BOOTSTRAP_EXCLUDED_KEYS.items():
            assert not (keys & set(data.get(section, {}))), f"[{section}] 排除键被播种"

    def test_only_known_fields_are_seeded(self):
        from app.core.config import Config

        data = example_seed_data()
        assert data, "config.example.toml 应能产出非空种子"
        for section, values in data.items():
            assert section in Config.model_fields, f"未知节 [{section}]"
            section_cls = Config.model_fields[section].annotation
            for key in values:
                assert key in section_cls.model_fields, f"[{section}].{key} 无对应字段"

    def test_missing_template_returns_empty(self, monkeypatch, tmp_path):
        from app.core import config_store

        monkeypatch.setattr(
            config_store, "_example_path", lambda: tmp_path / "nope.toml"
        )
        assert config_store.example_seed_data() == {}


class TestSeedIdempotent:
    """播种幂等：只补缺键，不覆盖既有值"""

    def test_seed_twice_and_preserve_manual_value(self, isolated_db_url, tmp_path):
        url = _seed_db_file(isolated_db_url)

        first = seed_from_example(db_url=url)
        assert first.get("error") is None, first
        assert first["created"] > 0, "首轮应写入种子节"

        from app.models.app_config import AppConfig as _Cfg

        table = _Cfg.__table__
        engine = create_engine(url)
        try:
            with engine.begin() as conn:
                conn.execute(
                    table.update()
                    .where(table.c.section == "app")
                    .values(payload={"title": "Manually Changed", "debug": True})
                )
        finally:
            engine.dispose()

        second = seed_from_example(db_url=url)
        assert second.get("error") is None, second
        assert second["created"] == 0, "已有节不得重复创建"
        # 上一步把 app 节精简到 2 个键 → 二次播种应补齐模板其余键（updated=1）
        assert second["updated"] == 1, f"缺键补齐只应命中被精简的 app 节: {second}"

        engine = create_engine(url)
        try:
            with engine.connect() as conn:
                payload = conn.execute(
                    table.select().where(table.c.section == "app")
                ).mappings().first()["payload"]
        finally:
            engine.dispose()
        assert payload["title"] == "Manually Changed", "人工修改的值不得被种子覆盖"
        assert len(payload) > 2, "模板中该节的其余缺键应被补齐"

    def test_missing_table_is_skipped_not_raised(self, unreachable_db_url, tmp_path):
        url = unreachable_db_url  # 库不存在
        result = seed_from_example(db_url=url)
        assert result.get("skipped") in {"table_missing", "no_seed_data"} or "error" in result

    def test_no_database_url_is_skipped(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("KUSTOS_DATABASE_URL", raising=False)
        assert seed_from_example().get("skipped") == "no_database_url"


class TestDbSourcePriority:
    """源链矩阵：env > app_config(DB) > 字段默认值（TOML 层已移除）"""

    TOML = """
[app]
title = "TOML Title"
version = "1.0.0"
"""

    def _db_with_app_title(self, db_url, title: str) -> str:
        url = _seed_db_file(db_url)
        engine = create_engine(url)
        try:
            with engine.begin() as conn:
                conn.execute(
                    AppConfig.__table__.insert().values(
                        section="app", payload={"title": title}, version=1
                    )
                )
        finally:
            engine.dispose()
        return url

    def test_db_beats_defaults_for_uncovered_keys(self, isolated_db_url, tmp_path, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", self._db_with_app_title(isolated_db_url, "DB Title"))
        monkeypatch.delenv("KUSTOS_APP_TITLE", raising=False)
        config_path = _write_toml(tmp_path, self.TOML)

        config = ConfigManager(config_path).config

        assert config.app.title == "DB Title", "DB 层应生效"
        # TOML 层已移除：DB 未提供的键落到字段默认值，而非 config.toml
        assert config.app.version == "0.1.0", "DB 未提供的键应落到字段默认值"

    def test_env_beats_db(self, isolated_db_url, tmp_path, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", self._db_with_app_title(isolated_db_url, "DB Title"))
        monkeypatch.setenv("KUSTOS_APP_TITLE", "Env Title")
        config_path = _write_toml(tmp_path, self.TOML)

        config = ConfigManager(config_path).config

        assert config.app.title == "Env Title", "env 是部署硬约束，必须最高优先"

    def test_db_unavailable_falls_back_to_defaults(self, unreachable_db_url, tmp_path, monkeypatch):
        # 库/表不存在 → load 返回 None → 该节跳过 DB 层 → 字段默认值
        monkeypatch.setenv("DATABASE_URL", unreachable_db_url)
        monkeypatch.delenv("KUSTOS_APP_TITLE", raising=False)
        config_path = _write_toml(tmp_path, self.TOML)

        config = ConfigManager(config_path).config

        assert config.app.title == "Kustos API", "DB 不可用时必须退回默认值"

    def test_direct_section_instantiation_skips_db(self, isolated_db_url, tmp_path, monkeypatch):
        """直接实例化单节 = env + 默认值（DB/TOML 仅在 Config() 构造期激活）"""
        from app.core.config import AppSettings

        monkeypatch.setenv("DATABASE_URL", self._db_with_app_title(isolated_db_url, "DB Title"))
        monkeypatch.delenv("KUSTOS_APP_TITLE", raising=False)

        assert AppSettings().title != "DB Title"

    def test_load_all_returns_none_on_bad_url(self, unreachable_db_url, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", unreachable_db_url)
        assert load_all_section_values() is None, "读库失败必须降级为 None，不抛异常"


class TestNoHalfAppliedUpdate:
    """持久化失败不得留下「内存已改、库里未改」（DB 写路径同样先持久化）"""

    @staticmethod
    def _fresh_manager(monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("KUSTOS_DATABASE_URL", raising=False)
        reset_module_config_manager()
        return ConfigManager("config.toml")

    def test_config_manager_write_failure_keeps_memory(self, monkeypatch):
        manager = self._fresh_manager(monkeypatch)
        before = manager.config.server.port

        with pytest.raises(ConfigWriteError):
            manager.update_config({"server": {"port": 9999}})

        assert manager.config.server.port == before, "写失败时内存配置不得被改动"

    def test_config_service_returns_persist_failed(self, monkeypatch):
        from app.services.config_service import ConfigService

        self._fresh_manager(monkeypatch)

        with pytest.raises(ValidationException) as exc:
            ConfigService().update_config(
                {"server": {"log_level": "warning"}}, is_admin=True
            )

        assert exc.value.error_code == "config_persist_failed"


class TestWriteValidation:
    """写入校验：引导层键拒绝、坏值拒绝、死键剔除、未知节拒绝"""

    def test_bootstrap_key_rejected(self, isolated_db_url, tmp_path):
        from app.core.config_store import update_sections

        url = _seed_db_file(isolated_db_url)
        with pytest.raises(ValueError):
            update_sections({"database": {"url": "postgresql://evil/db"}}, db_url=url)
        with pytest.raises(ValueError):
            update_sections({"security": {"secret_key": "leak"}}, db_url=url)

    def test_bootstrap_key_returns_4xx_via_service(self, monkeypatch):
        """服务层前置校验即拒绝引导层键；config_store 的拒绝是第二道防线"""
        from app.services.config_service import ConfigService

        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("KUSTOS_DATABASE_URL", raising=False)
        reset_module_config_manager()

        with pytest.raises(ValidationException) as exc:
            # database 在白名单内，但 url 属只读引导层字段 → 前置校验拒绝
            ConfigService().update_config(
                {"database": {"url": "postgresql://evil/db"}}, is_admin=True
            )

        assert exc.value.error_code == "config_validation_failed"
        assert exc.value.status_code == 400 or exc.value.status_code == 422

    def test_invalid_value_rejected_and_db_unchanged(self, isolated_db_url, tmp_path):
        from app.core.config_store import update_sections

        url = _seed_db_file(isolated_db_url)
        engine = create_engine(url)
        try:
            with engine.begin() as conn:
                conn.execute(
                    AppConfig.__table__.insert().values(
                        section="server", payload={"port": 8000}, version=1
                    )
                )
        finally:
            engine.dispose()

        with pytest.raises(ValueError):
            update_sections({"server": {"port": "not-a-port"}}, db_url=url)

        engine = create_engine(url)
        try:
            with engine.connect() as conn:
                row = conn.execute(
                    AppConfig.__table__.select()
                    .where(AppConfig.__table__.c.section == "server")
                ).mappings().first()
        finally:
            engine.dispose()
        assert row["payload"]["port"] == 8000, "校验失败必须回滚，坏值不得入库"

    def test_unknown_section_rejected(self, isolated_db_url, tmp_path):
        from app.core.config_store import update_sections

        url = _seed_db_file(isolated_db_url)
        with pytest.raises(ValueError):
            update_sections({"proxy": {"proxy": True}}, db_url=url)

    def test_dead_keys_stripped_on_write(self, isolated_db_url, tmp_path):
        """写入时顺手剔除字段定义已删的死键（脏行自愈）"""
        from app.core.config_store import update_sections

        url = _seed_db_file(isolated_db_url)
        engine = create_engine(url)
        try:
            with engine.begin() as conn:
                conn.execute(
                    AppConfig.__table__.insert().values(
                        section="storage",
                        payload={"repo_root": "./repositories", "enable_lfs": True},
                        version=1,
                    )
                )
        finally:
            engine.dispose()

        update_sections({"storage": {"max_file_size": 1024}}, db_url=url)

        engine = create_engine(url)
        try:
            with engine.connect() as conn:
                payload = conn.execute(
                    AppConfig.__table__.select()
                    .where(AppConfig.__table__.c.section == "storage")
                ).mappings().first()["payload"]
        finally:
            engine.dispose()
        assert "enable_lfs" not in payload, "死键应在写入时被剔除"
        assert payload["max_file_size"] == 1024
        assert payload["repo_root"] == "./repositories"


class TestReloadAndVersionCheck:
    """reload 与跨进程版本检测（后台保存 → 各进程 ≤5s 收敛）"""

    @staticmethod
    def _db_with_title(db_url, title: str) -> str:
        url = _seed_db_file(db_url)
        engine = create_engine(url)
        try:
            with engine.begin() as conn:
                conn.execute(
                    AppConfig.__table__.insert().values(
                        section="app", payload={"title": title}, version=1
                    )
                )
        finally:
            engine.dispose()
        return url

    @staticmethod
    def _bump_title(url: str, title: str) -> None:
        engine = create_engine(url)
        try:
            with engine.begin() as conn:
                conn.execute(
                    AppConfig.__table__.update()
                    .where(AppConfig.__table__.c.section == "app")
                    .values(payload={"title": title}, version=AppConfig.__table__.c.version + 1)
                )
        finally:
            engine.dispose()

    def test_reload_picks_up_db_change(self, isolated_db_url, tmp_path, monkeypatch):
        url = self._db_with_title(isolated_db_url, "First")
        monkeypatch.setenv("DATABASE_URL", url)
        monkeypatch.delenv("KUSTOS_APP_TITLE", raising=False)
        reset_module_config_manager()
        manager = ConfigManager("config.toml")
        assert manager.config.app.title == "First"

        self._bump_title(url, "Second")
        manager.reload()

        assert manager.config.app.title == "Second"

    def test_version_check_reloads_on_access(self, isolated_db_url, tmp_path, monkeypatch):
        """不显式 reload，仅靠版本检测：后台保存后各进程访问配置即收敛"""
        url = self._db_with_title(isolated_db_url, "First")
        monkeypatch.setenv("DATABASE_URL", url)
        monkeypatch.delenv("KUSTOS_APP_TITLE", raising=False)
        reset_module_config_manager()
        manager = ConfigManager("config.toml")
        assert manager.config.app.title == "First"

        self._bump_title(url, "Second")
        manager._db_check_at = 0.0  # 让检测窗口到期（真实场景最迟 5s）

        assert manager.config.app.title == "Second", "版本检测应触发重载"


class TestConfigSourceAndGunicornConf:
    """config_source 源链健康态 + gunicorn.conf 降级为 env + 字段默认值"""

    def test_config_source_db_when_readable(self, isolated_db_url, tmp_path, monkeypatch):
        url = _seed_db_file(isolated_db_url)
        seed_from_example(db_url=url)
        monkeypatch.setenv("DATABASE_URL", url)
        monkeypatch.delenv("KUSTOS_APP_TITLE", raising=False)
        reset_module_config_manager()
        assert ConfigManager("config.toml").config_source == "db"

    def test_config_source_degraded_when_db_unreadable(self, unreachable_db_url, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", unreachable_db_url)
        reset_module_config_manager()
        assert ConfigManager("config.toml").config_source == "degraded"

    def test_gunicorn_conf_loads_without_db_or_file(self, monkeypatch):
        """gunicorn master 只按 env + 默认加载：DB 指向不可达地址也不连接"""
        import os
        import runpy
        from pathlib import Path

        monkeypatch.setenv(
            "DATABASE_URL", "postgresql://nobody:pass@127.0.0.1:1/nope"
        )
        conf = Path(__file__).resolve().parent.parent / "app" / "core" / "gunicorn.conf.py"
        try:
            ns = runpy.run_path(str(conf))
        finally:
            os.environ.pop("GUNICORN_REUSE_PORT", None)  # 配置节默认开启，避免泄漏
        assert ns["workers"] >= 1
        assert ns["bind"]
        assert ns["proc_name"] == "kustos"
