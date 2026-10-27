"""
审计链路测试（死配置接线 / 日切轮转 / 自动保留 / 统一查询）

覆盖五块：

1. ``[logging] audit_log_*`` 四键从死配置变为运行期真实消费者
2. 日切轮转——修复「处理器永久绑定启动当天目录」导致的写错日期目录
   与「按日期清理会 rmtree 正在写入的目录」两个隐患
3. 自动保留——日期日志目录与 ``activities`` 表不再只靠 admin 手动清理
4. ``query_audit()`` 统一查询入口与 ``GET /api/app/audit``
5. 审计排除集收口——``_should_log`` 边界匹配与路由死路径清理
"""
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select, update

import app.services.audit_query_service as audit_qs
from app.middleware.audit_logger import AuditLoggerMiddleware
from app.models.activity import Activity
from app.services import activity_service
from app.services.audit_query_service import parse_audit_line, query_audit
from app.services.retention_service import RetentionService
from app.utils.logging import LogManager, cleanup_old_logs


# ---------------------------------------------------------------------------
# 隔离夹具：LogManager 会往全局根日志器与 kustos.audit 上挂处理器
# ---------------------------------------------------------------------------
# 受本文件支配的审计日志器（_make_manager 用 app_name=kustos_r13 建私有实例）
_AUDIT_LOGGERS = ("kustos.audit", "kustos_r13.audit")


@pytest.fixture(autouse=True)
def _isolate_logging():
    """
    每个用例前把根日志器与审计日志器归零、事后还原

    - 根日志器至少留一个 handler：``setup_root_logger`` 的 ``if not root.handlers``
      守卫因此永不为真，测试不会往仓库的 ``logs/`` 里塞真实文件
    - **受管文件处理器先摘下再还原**：``FileHandler.close()`` 会把 ``stream``
      置空，若被用例里的日切轮转 drain 掉再还原，根日志器会带着死句柄活到套件结束
    - 审计日志器清空：``kustos.audit`` 有 ``propagate=False``，pytest 会往它挂
      捕获器，且时序在夹具之后；这里清掉的是**夹具阶段**能看到的那部分
    """
    root = logging.getLogger()
    root_before = list(root.handlers)

    parked = [h for h in root_before if getattr(h, "_kustos_date_managed", False)]
    for handler in parked:
        root.removeHandler(handler)

    if not root.handlers:
        root.addHandler(logging.NullHandler())

    audit_snapshots = {}
    for name in _AUDIT_LOGGERS:
        target = logging.getLogger(name)
        audit_snapshots[name] = list(target.handlers)
        target.handlers = []

    try:
        yield
    finally:
        for handler in list(root.handlers):
            if handler not in root_before:
                root.removeHandler(handler)
                handler.close()
        root.handlers = list(root_before)

        for name, before in audit_snapshots.items():
            target = logging.getLogger(name)
            for handler in list(target.handlers):
                if handler not in before:
                    target.removeHandler(handler)
                    handler.close()
            target.handlers = list(before)


def _make_manager(tmp_path, **overrides) -> LogManager:
    params = dict(
        log_dir=str(tmp_path / "logs"),
        app_name="kustos_r13",
        console_output=False,
        websocket_output=False,
        use_date_directory=True,
        audit_enabled=True,
        audit_path=str(tmp_path / "logs" / "audit.log"),
        audit_max_bytes=1024,
        audit_backup_count=2,
    )
    params.update(overrides)
    manager = LogManager(**params)

    # pytest 的 catching_logs 会把 LogCaptureHandler 挂到所有非传播日志器上，
    # 且发生在**夹具之后、测试体之前**——此处（测试体内）归零才能拿到干净前缀，
    # 否则 get_audit_logger() 的 ``if not logger.handlers`` 守卫永远为假。
    logging.getLogger(f"{manager.app_name}.audit").handlers = []
    return manager


# ---------------------------------------------------------------------------
# 1. [logging] audit_log_* 接线
# ---------------------------------------------------------------------------
class TestAuditConfigWiring:
    def test_audit_settings_are_read_from_config(self):
        """四个键确实被运行期读取（此前只在 validate_config 里露过面）"""
        from app.core.config import get_config
        from app.utils.logging import _load_audit_settings

        cfg = get_config().logging
        loaded = _load_audit_settings()

        assert loaded["audit_enabled"] == cfg.audit_log_enabled
        assert loaded["audit_path"] == cfg.audit_log_path
        assert loaded["audit_max_bytes"] == cfg.audit_log_max_size
        assert loaded["audit_backup_count"] == cfg.audit_log_backup_count

    @pytest.mark.parametrize(
        "key", ["log_keep_days", "activity_keep_days", "retention_interval_hours"]
    )
    def test_new_retention_keys_exist(self, key):
        from app.core.config import get_config

        assert hasattr(get_config().logging, key)

    def test_audit_file_lands_under_date_directory(self, tmp_path):
        """默认 audit_log_path 落位 <父目录>/<日期>/<文件名>，与接线前一致"""
        manager = _make_manager(tmp_path)
        audit_file = manager._get_audit_file()

        today = datetime.now().strftime("%Y-%m-%d")
        assert audit_file == tmp_path / "logs" / today / "audit.log"
        assert audit_file.parent.is_dir()

    def test_audit_rotation_follows_config(self, tmp_path):
        """audit_log_max_size / audit_log_backup_count 真正接管轮转参数"""
        manager = _make_manager(tmp_path)
        handler = manager._create_audit_handler()
        try:
            assert handler.maxBytes == 1024
            assert handler.backupCount == 2
        finally:
            handler.close()

    def test_disabled_audit_produces_no_output(self, tmp_path):
        """audit_log_enabled=false → 空记录器，文件/控制台/WebSocket 全关"""
        manager = _make_manager(tmp_path, audit_enabled=False)
        logger = manager.get_audit_logger()

        assert logger.handlers
        assert all(isinstance(h, logging.NullHandler) for h in logger.handlers)

        logger.info('{"path": "/api/x", "status_code": 200}')
        assert list(tmp_path.rglob("audit*")) == []

    def test_middleware_respects_audit_switch(self, monkeypatch):
        import app.middleware.audit_logger as audit_mw

        monkeypatch.setattr(audit_mw, "is_audit_enabled", lambda: False)
        disabled = AuditLoggerMiddleware(None)
        assert disabled.enabled is False
        assert disabled._audit_logger is None

        monkeypatch.setattr(audit_mw, "is_audit_enabled", lambda: True)
        enabled = AuditLoggerMiddleware(None)
        assert enabled.enabled is True
        assert enabled._audit_logger is not None

    def test_middleware_constructor_flag_wins(self, monkeypatch):
        import app.middleware.audit_logger as audit_mw

        monkeypatch.setattr(audit_mw, "is_audit_enabled", lambda: True)
        assert AuditLoggerMiddleware(None, enabled=False).enabled is False


# ---------------------------------------------------------------------------
# 2. 日切轮转
# ---------------------------------------------------------------------------
class TestDateRollover:
    def test_no_rollover_within_same_day(self, tmp_path):
        manager = _make_manager(tmp_path)
        manager.get_audit_logger()

        assert manager.ensure_date_rollover() is False

    def test_rollover_rebinds_audit_handler_to_new_date_dir(self, tmp_path, monkeypatch):
        """跨天后审计文件处理器必须搬到新日期目录，并同步更新活跃目录登记"""
        import app.utils.logging as logging_mod

        class _FrozenDate(datetime):
            _at = (2026, 3, 1, 12, 0, 0)

            @classmethod
            def now(cls, tz=None):
                return cls(*cls._at)

        monkeypatch.setattr(logging_mod, "datetime", _FrozenDate)

        manager = _make_manager(tmp_path)
        audit_logger = manager.get_audit_logger()
        old_file = manager._get_audit_file()
        assert old_file.parent.name == "2026-03-01"
        old_handlers = list(audit_logger.handlers)

        _FrozenDate._at = (2026, 3, 2, 12, 0, 0)  # 跨天
        assert manager.ensure_date_rollover() is True

        new_file = manager._get_audit_file()
        assert new_file.parent.name == "2026-03-02"

        managed = [
            h for h in audit_logger.handlers
            if getattr(h, "_kustos_date_managed", False)
        ]
        assert len(managed) == 1
        assert Path(managed[0].baseFilename) == new_file
        # 旧处理器被换掉，而不是原地复用
        assert all(h not in old_handlers for h in managed)
        # 新目录登记为活跃（自动清理豁免），旧目录注销
        assert str(new_file.parent) in manager.active_log_dirs
        assert str(old_file.parent) not in manager.active_log_dirs

    def test_rollover_rebinds_root_file_handlers(self, tmp_path):
        manager = _make_manager(tmp_path)
        manager._initialized = True
        root = logging.getLogger()
        stale = manager._create_app_handler()
        root.addHandler(stale)

        manager._current_date = "2000-01-01"
        assert manager.ensure_date_rollover() is True

        managed = [
            h for h in root.handlers if getattr(h, "_kustos_date_managed", False)
        ]
        assert stale not in root.handlers
        assert len(managed) == 2  # app.log + error.log

        today = datetime.now().strftime("%Y-%m-%d")
        for handler in managed:
            assert Path(handler.baseFilename).parent.name == today

    def test_rollover_leaves_unmanaged_handlers_alone(self, tmp_path):
        """轮转只动带受管标记的文件处理器，控制台/第三方 handler 原样保留"""
        manager = _make_manager(tmp_path)
        manager._initialized = True
        root = logging.getLogger()
        sentinel = logging.StreamHandler()
        stale = manager._create_app_handler()
        root.addHandler(sentinel)
        root.addHandler(stale)

        manager._current_date = "2000-01-01"
        manager.ensure_date_rollover()

        # 未受管 handler 原样保留
        assert sentinel in root.handlers
        # 受管 handler 被重建（不可能复用旧实例），且指向本管理器的日志根
        assert stale not in root.handlers
        reborn = [
            h for h in root.handlers
            if getattr(h, "_kustos_date_managed", False) and h is not stale
        ]
        assert reborn
        for handler in reborn:
            assert str(manager.log_dir) in str(handler.baseFilename)

    def test_rollover_disabled_without_date_directory(self, tmp_path):
        manager = _make_manager(tmp_path, use_date_directory=False)
        manager._current_date = "2000-01-01"

        assert manager.ensure_date_rollover() is False


# ---------------------------------------------------------------------------
# 3. 自动保留
# ---------------------------------------------------------------------------
class TestLogRetention:
    def test_cleanup_removes_expired_date_dirs(self, tmp_path):
        root = tmp_path / "logs"
        expired = root / "2020-01-01"
        expired.mkdir(parents=True)
        (expired / "audit.log").write_text("{}", encoding="utf-8")

        assert cleanup_old_logs(str(root), keep_days=30, active_dirs=set()) == 1
        assert not expired.exists()

    def test_cleanup_never_touches_active_dir(self, tmp_path):
        """正在写入的目录即使超期也豁免，否则审计日志会被静默清掉"""
        root = tmp_path / "logs"
        active = root / "2020-01-01"
        stale = root / "2020-01-02"
        active.mkdir(parents=True)
        stale.mkdir(parents=True)
        (active / "audit.log").write_text("{}", encoding="utf-8")

        assert cleanup_old_logs(str(root), keep_days=30, active_dirs={str(active)}) == 1
        assert active.exists()
        assert not stale.exists()

    def test_cleanup_keeps_recent_and_non_date_dirs(self, tmp_path):
        root = tmp_path / "logs"
        today = root / datetime.now().strftime("%Y-%m-%d")
        archive = root / "archive"
        today.mkdir(parents=True)
        archive.mkdir(parents=True)

        assert cleanup_old_logs(str(root), keep_days=30, active_dirs=set()) == 0
        assert today.exists()
        assert archive.exists()

    def test_active_dirs_registered_when_locating_audit_file(self, tmp_path):
        manager = _make_manager(tmp_path)
        audit_file = manager._get_audit_file()

        assert str(audit_file.parent) in manager.active_log_dirs

    def test_service_cleanup_logs_honours_keep_days(self, tmp_path):
        service = RetentionService()
        root = tmp_path / "logs"
        (root / "2020-01-01").mkdir(parents=True)

        assert service.cleanup_logs(30, log_dir=str(root)) == 1
        assert service.cleanup_logs(0, log_dir=str(root)) == 0


class TestActivityRetention:
    async def test_cleanup_activities_removes_expired_rows(
        self, async_db, async_test_repo, async_test_user
    ):
        await activity_service.record_activity(
            async_test_repo.id, async_test_user.id,
            "repository", async_test_repo.id, "created", "old row", async_db,
        )
        await async_db.execute(
            update(Activity)
            .where(Activity.repository_id == async_test_repo.id)
            .values(created_at=datetime.now() - timedelta(days=400))
        )
        await async_db.commit()

        service = RetentionService()
        deleted = await service.cleanup_activities(async_db, keep_days=180)
        assert deleted >= 1

        remaining = (
            await async_db.execute(
                select(func.count()).select_from(Activity)
                .where(Activity.repository_id == async_test_repo.id)
            )
        ).scalar_one()
        assert remaining == 0

    async def test_cleanup_activities_keeps_recent_rows(
        self, async_db, async_test_repo, async_test_user
    ):
        await activity_service.record_activity(
            async_test_repo.id, async_test_user.id,
            "repository", async_test_repo.id, "created", "fresh row", async_db,
        )

        service = RetentionService()
        assert await service.cleanup_activities(async_db, keep_days=180) == 0

        remaining = (
            await async_db.execute(
                select(func.count()).select_from(Activity)
                .where(Activity.repository_id == async_test_repo.id)
            )
        ).scalar_one()
        assert remaining == 1

    async def test_keep_days_zero_disables_cleanup(self, async_db):
        service = RetentionService()

        assert await service.cleanup_activities(async_db, keep_days=0) == 0
        assert service.cleanup_logs(0, log_dir="/nonexistent") == 0

    async def test_run_once_is_skippable_via_config(self, async_db, monkeypatch):
        """keep_days 全为 0 时 run_once 不删磁盘也不删表

        断言各计数键均为 0（日志目录 / Activity / 撤销行 / 中断作业 / Agent 步骤）；
        中断作业回收另按 agent 配置开关，这里一并关掉以聚焦保留语义。
        """
        fake_config = SimpleNamespace(
            logging=SimpleNamespace(
                log_keep_days=0, activity_keep_days=0, agent_steps_keep_days=0
            )
        )
        # 先取真实配置单例（补丁只作用于 core.config.get_config 属性）
        from app.core.config import get_config

        agent_cfg = get_config().agent
        monkeypatch.setattr("app.core.config.get_config", lambda *a, **k: fake_config)
        monkeypatch.setattr(agent_cfg, "stale_job_timeout_minutes", 0, raising=False)

        service = RetentionService()
        result = await service.run_once(db=async_db)

        assert result == {
            "log_dirs_deleted": 0,
            "activities_deleted": 0,
            "revoked_tokens_deleted": 0,
            "stale_jobs_reclaimed": 0,
            "agent_steps_deleted": 0,
        }


class TestAgentStepsRetention:
    """agent_steps 保留：只清「已收尾且过期」作业的步骤"""

    @staticmethod
    async def _job(db, user, repo, *, status, finished_days_ago=None):
        from app.models.agent import AgentJob, AgentSession, AgentStep

        session = AgentSession(user_id=user.id, repository_id=repo.id, title="t")
        db.add(session)
        await db.commit()
        await db.refresh(session)
        job = AgentJob(
            session_id=session.id, repository_id=repo.id, user_id=user.id,
            status=status, prompt="q",
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        db.add(AgentStep(job_id=job.id, seq=1, type="user", content="q"))
        db.add(AgentStep(job_id=job.id, seq=2, type="assistant", content="a"))
        await db.commit()
        if finished_days_ago is not None:
            await db.execute(
                update(AgentJob).where(AgentJob.id == job.id).values(
                    finished_at=datetime.now(timezone.utc)
                    - timedelta(days=finished_days_ago)
                )
            )
            await db.commit()
        return job

    async def test_cleanup_removes_expired_steps_of_finished_jobs(
        self, async_db, async_test_user, async_test_repo
    ):
        from app.models.agent import AgentStep

        expired = await self._job(
            async_db, async_test_user, async_test_repo,
            status="succeeded", finished_days_ago=40,
        )
        await self._job(
            async_db, async_test_user, async_test_repo,
            status="failed", finished_days_ago=5,
        )

        deleted = await RetentionService().cleanup_agent_steps(async_db, keep_days=30)

        assert deleted == 2
        remaining = (await async_db.execute(
            select(func.count()).select_from(AgentStep)
            .where(AgentStep.job_id == expired.id)
        )).scalar_one()
        assert remaining == 0

    async def test_keeps_running_and_awaiting_jobs(
        self, async_db, async_test_user, async_test_repo
    ):
        from app.models.agent import AgentStep

        running = await self._job(
            async_db, async_test_user, async_test_repo, status="running"
        )
        awaiting = await self._job(
            async_db, async_test_user, async_test_repo, status="awaiting_approval"
        )

        # 进行中作业没有 finished_at：即便步骤很旧也不动（是续跑上下文）
        deleted = await RetentionService().cleanup_agent_steps(async_db, keep_days=30)
        assert deleted == 0

        for job in (running, awaiting):
            count = (await async_db.execute(
                select(func.count()).select_from(AgentStep)
                .where(AgentStep.job_id == job.id)
            )).scalar_one()
            assert count == 2

    async def test_keep_days_zero_disables_cleanup(
        self, async_db, async_test_user, async_test_repo
    ):
        from app.models.agent import AgentStep

        job = await self._job(
            async_db, async_test_user, async_test_repo,
            status="succeeded", finished_days_ago=40,
        )
        assert await RetentionService().cleanup_agent_steps(async_db, keep_days=0) == 0
        count = (await async_db.execute(
            select(func.count()).select_from(AgentStep)
            .where(AgentStep.job_id == job.id)
        )).scalar_one()
        assert count == 2


# ---------------------------------------------------------------------------
# 4. 统一查询
# ---------------------------------------------------------------------------
def _line(payload, level="INFO", ts=None, sensitive=False) -> str:
    ts = ts or datetime.now().isoformat(sep=" ", timespec="seconds")
    message = json.dumps(payload, ensure_ascii=False)
    if sensitive:
        message = "[SENSITIVE] " + message
    return f"{ts} - kustos.audit - {level} - {message}"


def _write_audit(root: Path, date: str, lines) -> None:
    day_dir = root / date
    day_dir.mkdir(parents=True, exist_ok=True)
    (day_dir / "audit.log").write_text("\n".join(lines) + "\n", encoding="utf-8")


class TestAuditParsing:
    def test_parses_plain_entry(self):
        entry = parse_audit_line(_line({"path": "/api/x", "status_code": 200}))

        assert entry["source"] == "http"
        assert entry["level"] == "INFO"
        assert entry["path"] == "/api/x"
        assert entry["timestamp"].startswith(datetime.now().strftime("%Y-%m-%d"))

    def test_parses_sensitive_prefix(self):
        entry = parse_audit_line(_line({"path": "/api/users"}, sensitive=True))

        assert entry["is_sensitive"] is True
        assert entry["path"] == "/api/users"
        # 前缀必须被剥掉，否则 path 会带上 "[SENSITIVE] " 前缀
        assert not entry["path"].startswith("[SENSITIVE]")

    def test_parses_error_and_warning_levels(self):
        assert parse_audit_line(_line({"path": "/x"}, level="ERROR"))["level"] == "ERROR"
        assert parse_audit_line(_line({"path": "/x"}, level="WARNING"))["level"] == "WARNING"

    @pytest.mark.parametrize(
        "raw",
        [
            "",
            "not a log line",
            "2026-01-01 00:00:00 - kustos.audit - INFO - plain text",
            "2026-01-01 00:00:00 - kustos.audit - INFO - [1,2,3]",
        ],
    )
    def test_rejects_non_audit_lines(self, raw):
        assert parse_audit_line(raw) is None

    def test_json_containing_separator_still_parses(self):
        """message 里含 ' - ' 不能打断前缀切分（split 限 3 次）"""
        entry = parse_audit_line(_line({"path": "/a - b", "q": "x - y"}))

        assert entry["path"] == "/a - b"
        assert entry["q"] == "x - y"


class TestQueryAuditHttpSource:
    async def test_returns_entries_newest_first(self, tmp_path, monkeypatch):
        today = datetime.now().strftime("%Y-%m-%d")
        _write_audit(tmp_path, today, [
            _line({"path": "/api/older", "method": "GET", "status_code": 200},
                  ts="2020-01-01 00:00:00"),
            _line({"path": "/api/newer", "method": "GET", "status_code": 200},
                  ts="2020-01-01 00:00:01"),
        ])
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path), "audit"))

        out = await query_audit(None, days=7, source="http")

        assert out["total"] == 2
        assert [i["path"] for i in out["items"]] == ["/api/newer", "/api/older"]
        assert out["truncated"] is False
        assert out["pages"] == 1

    async def test_filters_by_method_status_and_username(self, tmp_path, monkeypatch):
        today = datetime.now().strftime("%Y-%m-%d")
        _write_audit(tmp_path, today, [
            _line({"path": "/a", "method": "GET", "status_code": 200, "username": "alice"}),
            _line({"path": "/b", "method": "POST", "status_code": 500, "username": "bob"},
                  level="ERROR"),
        ])
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path), "audit"))

        by_method = await query_audit(None, source="http", method="post")
        assert [i["path"] for i in by_method["items"]] == ["/b"]

        by_status = await query_audit(None, source="http", status_code=200)
        assert [i["path"] for i in by_status["items"]] == ["/a"]

        by_user = await query_audit(None, source="http", username="ALI")
        assert [i["path"] for i in by_user["items"]] == ["/a"]

    async def test_keyword_matches_path_and_username(self, tmp_path, monkeypatch):
        today = datetime.now().strftime("%Y-%m-%d")
        _write_audit(tmp_path, today, [
            _line({"path": "/api/repositories", "username": "alice"}),
            _line({"path": "/api/issues", "username": "bob"}),
        ])
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path), "audit"))

        out = await query_audit(None, source="http", q="repositor")
        assert [i["path"] for i in out["items"]] == ["/api/repositories"]

    async def test_window_excludes_older_date_dirs(self, tmp_path, monkeypatch):
        old = (datetime.now().date() - timedelta(days=10)).strftime("%Y-%m-%d")
        _write_audit(tmp_path, old, [_line({"path": "/too-old"})])
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path), "audit"))

        out = await query_audit(None, days=7, source="http")

        assert out["total"] == 0
        assert out["items"] == []

    async def test_pagination_window_slicing(self, tmp_path, monkeypatch):
        today = datetime.now().strftime("%Y-%m-%d")
        _write_audit(tmp_path, today, [
            _line({"path": f"/api/{i}"}, ts=f"2020-01-01 00:00:{i:02d}")
            for i in range(5)
        ])
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path), "audit"))

        page1 = await query_audit(None, source="http", page=1, limit=2)
        page3 = await query_audit(None, source="http", page=3, limit=2)

        assert page1["total"] == 5
        assert page1["pages"] == 3
        assert page1["has_next"] is True
        assert page1["has_prev"] is False
        assert len(page1["items"]) == 2
        assert len(page3["items"]) == 1
        assert page3["has_next"] is False
        assert page3["has_prev"] is True

    async def test_truncated_when_scan_cap_reached(self, tmp_path, monkeypatch):
        today = datetime.now().strftime("%Y-%m-%d")
        _write_audit(tmp_path, today, [
            _line({"path": f"/api/{i}"}) for i in range(4)
        ])
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path), "audit"))
        monkeypatch.setattr(audit_qs, "MAX_SCAN_LINES", 2)

        out = await query_audit(None, source="http")

        assert out["truncated"] is True
        assert out["total"] <= 2

    async def test_missing_log_dir_is_not_an_error(self, tmp_path, monkeypatch):
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path / "nope"), "audit"))

        out = await query_audit(None, source="http")

        assert out["total"] == 0
        assert out["items"] == []


class TestQueryAuditMerged:
    async def test_merges_http_and_activity_sources(
        self, async_db, async_test_repo, async_test_user, tmp_path, monkeypatch
    ):
        today = datetime.now().strftime("%Y-%m-%d")
        _write_audit(tmp_path, today, [
            _line({"path": "/api/http-only", "username": "alice"}),
        ])
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path), "audit"))

        await activity_service.record_activity(
            async_test_repo.id, async_test_user.id,
            "repository", async_test_repo.id, "created", "repo made", async_db,
        )

        out = await query_audit(
            async_db, days=7, source="all",
            repository_id=str(async_test_repo.id), limit=200,
        )

        assert out["total"] >= 2
        sources = {item["source"] for item in out["items"]}
        assert sources == {"http", "activity"}

    async def test_activity_only_source_ignores_log_files(
        self, async_db, async_test_repo, async_test_user, tmp_path, monkeypatch
    ):
        today = datetime.now().strftime("%Y-%m-%d")
        _write_audit(tmp_path, today, [_line({"path": "/api/skip-me"})])
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path), "audit"))

        out = await query_audit(
            async_db, days=7, source="activity",
            repository_id=str(async_test_repo.id),
        )

        assert all(i["source"] == "activity" for i in out["items"])
        assert out["truncated"] is False

    async def test_user_id_filters_activity_actor(
        self, async_db, async_test_repo, async_test_user
    ):
        await activity_service.record_activity(
            async_test_repo.id, async_test_user.id,
            "repository", async_test_repo.id, "created", None, async_db,
        )

        out = await query_audit(
            async_db, days=7, source="activity",
            user_id=str(async_test_user.id),
        )

        assert out["total"] >= 1
        assert all(i["actor_id"] == str(async_test_user.id) for i in out["items"])

    async def test_activity_q_wildcards_matched_literally(
        self, async_db, async_test_repo, async_test_user
    ):
        """q 中 %/_ 按字面匹配（口径同 HTTP 侧子串匹配），不解释为 LIKE 通配"""
        for details in ("push 100% done", "push 100 done",
                        "err_code hit", "errXcode hit"):
            await activity_service.record_activity(
                async_test_repo.id, async_test_user.id,
                "repository", async_test_repo.id, "created", details, async_db,
            )

        out_pct = await query_audit(
            async_db, days=7, source="activity",
            repository_id=str(async_test_repo.id), q="100%",
        )
        # 字面 %：只命中含 "100%" 的行；未转义时通配会连 "100 done" 一起命中
        assert {i["details"] for i in out_pct["items"]} == {"push 100% done"}

        out_under = await query_audit(
            async_db, days=7, source="activity",
            repository_id=str(async_test_repo.id), q="err_code",
        )
        # 字面 _：只命中 "err_code"；未转义时通配会连 "errXcode" 一起命中
        assert {i["details"] for i in out_under["items"]} == {"err_code hit"}


class TestAuditExcludePaths:
    """审计排除集收口：边界匹配裁决 + 无路由死路径清理"""

    def test_should_log_boundary_match(self):
        mw = AuditLoggerMiddleware(app=None, enabled=False)
        # 精确与子路径排除
        assert mw._should_log("/health") is False
        assert mw._should_log("/health/live") is False
        assert mw._should_log("/metrics") is False
        assert mw._should_log("/api/app/status") is False
        # 仅共享前缀、非边界命中 → 照常记录（裸 startswith 会误排除）
        assert mw._should_log("/healthz") is True
        assert mw._should_log("/api/app/status-probe") is True
        assert mw._should_log("/api/v1/repositories") is True

    def test_no_dead_paths_in_default_exclude(self):
        excludes = AuditLoggerMiddleware.DEFAULT_EXCLUDE_PATHS
        # 历史死路径（全仓无对应路由）已移除
        assert "/api/app/metrics" not in excludes
        assert "/api/app/health" not in excludes
        # 原「指标监控」意图由真实端点 /metrics 承接
        assert "/metrics" in excludes


class TestAuditEndpoint:
    def test_requires_admin(self, test_client, auth_headers):
        assert test_client.get("/api/app/audit", headers=auth_headers).status_code == 403

    def test_admin_gets_pagination_shape(
        self, test_client, admin_headers, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path), "audit"))

        r = test_client.get("/api/app/audit", headers=admin_headers)

        assert r.status_code == 200
        body = r.json()
        assert set(body) >= {
            "items", "total", "page", "limit", "pages", "has_next", "has_prev",
            "truncated",
        }
        assert isinstance(body["items"], list)

    @pytest.mark.parametrize("params", [
        {"days": 0}, {"days": 91}, {"limit": 0}, {"limit": 201}, {"page": 0},
        {"status_code": 99}, {"source": "bogus"},
    ])
    def test_invalid_params_rejected(self, test_client, admin_headers, params):
        r = test_client.get("/api/app/audit", params=params, headers=admin_headers)
        assert r.status_code == 422

    def test_filter_end_to_end(
        self, test_client, admin_headers, tmp_path, monkeypatch
    ):
        today = datetime.now().strftime("%Y-%m-%d")
        _write_audit(tmp_path, today, [
            _line({"path": "/api/users", "method": "DELETE", "status_code": 204,
                   "username": "admin"}),
        ])
        monkeypatch.setattr(audit_qs, "audit_source", lambda: (str(tmp_path), "audit"))

        r = test_client.get(
            "/api/app/audit",
            params={"source": "http", "method": "delete", "status_code": 204},
            headers=admin_headers,
        )

        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) == 1
        assert items[0]["path"] == "/api/users"
        assert items[0]["source"] == "http"
