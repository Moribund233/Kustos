"""配置接线与常量收敛的行为护栏。

覆盖：
- SECTION_META 派生可用 + arq WorkerSettings 必须是**类体值**（property 会崩 worker）；
- 结果上限同源夹取、kill switch 三工具同口径；
- pre-receive 侧超限 blob 定位（纯 pygit2 单元）；
- 默认值：webhook 超时 30s、prompt 上限 8000。
"""
import pytest
from pydantic import ValidationError

from app.core.config import get_config_value
from app.core.config_schema import SECTION_META, writable_sections


class TestConfigSchemaDerivation:
    def test_writable_sections_contains_search_and_storage(self):
        """search 整节 + storage 逐键放开（可写节集合派生自 SECTION_META）"""
        writable = writable_sections()
        assert "search" in writable and "storage" in writable
        # 受保护节仍然整节拒绝
        assert "security" not in writable and "app" not in writable

    def test_storage_protected_keys(self):
        meta = SECTION_META["storage"]
        assert meta.writable
        assert {"repo_root", "upload_root"} <= set(meta.protected_keys)

    def test_agent_restart_keys_declared(self):
        """worker 进程参数标记为重启生效（applied 会返回 restart 提示）"""
        assert {"worker_max_jobs", "worker_job_timeout_seconds"} <= set(
            SECTION_META["agent"].restart_keys
        )


class TestAgentWorkerSettingsArqCompat:
    def test_worker_settings_attrs_are_values_not_properties(self):
        """回归：arq 经 ``settings_cls.__dict__`` 取参，property 对象会直接
        传进 ``Worker(max_jobs=...)`` 导致 ``Semaphore`` TypeError、worker 启动即崩。"""
        from app.services.agent.worker import WorkerSettings

        for key, expected in (("max_jobs", 4), ("job_timeout", 600)):
            value = WorkerSettings.__dict__[key]
            assert isinstance(value, int), f"{key} 必须是类体求值的 int，而非 {type(value)}"
            assert value == expected

    def test_worker_settings_reads_config(self):
        from app.services.agent.worker import WorkerSettings

        assert WorkerSettings.max_jobs == int(
            get_config_value("agent", "worker_max_jobs", 4)
        )


class TestWebhookDefaults:
    def test_delivery_timeout_default_matches_legacy_30s(self):
        """默认投递超时为 30s（曾误写 10.0，属行为回归）"""
        from app.core.config import Config

        assert Config().webhook.delivery_timeout_seconds == 30.0

    def test_delivery_helper_fallback_is_30s(self):
        from app.services.integration.webhook_service import _delivery_timeout

        assert _delivery_timeout() == 30.0


class TestSearchResultsCap:
    def test_cap_reads_config(self):
        from app.services.search.search_service import search_results_cap

        assert search_results_cap() == int(
            get_config_value("search", "max_results", 100) or 100
        )

    def test_clamp_semantics(self):
        """显式传参夹取到上限；None 取方法缺省（仍受上限约束）"""
        from app.services.search.search_service import _clamp_results, search_results_cap

        cap = search_results_cap()
        assert _clamp_results(None, default=20) == 20
        assert _clamp_results(1, default=20) == 1
        assert _clamp_results(cap * 5, default=20) == cap
        assert _clamp_results(200, default=200) == min(200, cap)  # 缺省超上限同样收敛


class TestSearchKillSwitch:
    @pytest.mark.asyncio
    async def test_search_code_disabled_returns_empty(self, async_db, monkeypatch):
        """search.enabled=false → search_code 空结果（source=none，不触仓）"""
        import uuid as uuid_mod

        from app.core.config import get_config
        from app.services.search.search_service import SearchService

        monkeypatch.setattr(get_config().search, "enabled", False, raising=False)
        res = await SearchService().search_code(
            async_db, uuid_mod.uuid4(), "/nonexistent/repo", "query"
        )
        assert res.source == "none" and res.results == []

    @pytest.mark.asyncio
    async def test_agent_search_tools_disabled(self, monkeypatch):
        """三个搜索类 agent 工具在 kill switch 关闭时同口径禁用"""
        from app.core.config import get_config
        from app.services.agent.tools_server import _find_definition, _find_usages, _search_code

        monkeypatch.setattr(get_config().search, "enabled", False, raising=False)

        r1 = await _search_code(None, {"query": "q"})  # ctx 在禁用分支前不被访问
        assert r1.get("source") == "none" and r1.get("error")

        r2 = await _find_definition(None, {"name": "N"})
        assert r2.get("source") == "none" and r2.get("definitions") == []

        r3 = await _find_usages(None, {"name": "N"})
        assert r3.get("source") == "none" and r3.get("usages") == []


class TestPromptLengthValidator:
    def test_prompt_over_limit_rejected(self):
        """controller 与 service 同键（agent.max_prompt_chars，默认 8000）"""
        from app.api.v1.agent_controller import CreateJobRequest

        limit = int(get_config_value("agent", "max_prompt_chars", 8000))
        with pytest.raises(ValidationError):
            CreateJobRequest(prompt="x" * (limit + 1))
        assert CreateJobRequest(prompt="x" * limit).prompt == "x" * limit


class TestPushedBlobTooLarge:
    @staticmethod
    def _repo_with(tmp_path, files_by_commit):
        """构建非裸临时仓：每项 dict 为一次提交的变更（name→bytes，None=删除）。

        Returns:
            (repo_path, [commit hex])；失败返回 None。
        """
        import pygit2

        work = tmp_path / "work"
        work.mkdir(exist_ok=True)
        r = pygit2.init_repository(str(work))
        sig = pygit2.Signature("t", "t@t")
        commits = []
        for files in files_by_commit:
            for name, content in files.items():
                if content is None:
                    r.index.remove(name)
                else:
                    (work / name).write_bytes(content)
                    r.index.add(name)
            tree_id = r.index.write_tree()
            parents = [commits[-1]] if commits else []
            commits.append(
                str(r.create_commit("HEAD", sig, sig, "c", tree_id, parents))
            )
        return str(work), commits

    def test_root_commit_added_oversized_blob_detected(self, tmp_path):
        """push 强制点：新分支（old 全零）根提交引入的超限 blob 被定位到路径。

        回归背景：``Tree.diff_to_tree`` 的 **self 是旧侧**——曾按「提交树→父」方向
        构造，根提交出 DELETED 漏判（本测试首跑即抓到该方向 bug）。
        """
        from app.services.integration.git_event_service import _pushed_blob_too_large

        work, commits = self._repo_with(tmp_path, [{"big.bin": b"a" * 4096}])
        zero = "0" * 40

        hit = _pushed_blob_too_large(work, zero, commits[-1], max_file=1024)
        assert hit is not None and "big.bin" in hit

        # 未超限 → 放行
        assert (
            _pushed_blob_too_large(work, zero, commits[-1], max_file=1 << 20) is None
        )

    def test_parent_commit_growth_detected(self, tmp_path):
        """非根提交：同一文件由小变大（父树旧、本提交新）必须命中新增侧大小。"""
        from app.services.integration.git_event_service import _pushed_blob_too_large

        work, commits = self._repo_with(
            tmp_path, [{"f.bin": b"a" * 64}, {"f.bin": b"b" * 4096}]
        )
        hit = _pushed_blob_too_large(work, commits[0], commits[1], max_file=1024)
        assert hit is not None and "f.bin" in hit

    def test_deleted_large_file_not_flagged(self, tmp_path):
        """推送**删除**超限文件是修复行为，不得反被 ADDED 方向误伤拒绝。"""
        from app.services.integration.git_event_service import _pushed_blob_too_large

        work, commits = self._repo_with(
            tmp_path, [{"big.bin": b"a" * 4096}, {"big.bin": None}]
        )
        assert (
            _pushed_blob_too_large(work, commits[0], commits[1], max_file=1024) is None
        )


class TestPaginationConstantsAlign:
    def test_paginate_defaults_match_constants(self):
        """db_utils.paginate 与 core/constants 同一契约值"""
        import inspect

        from app.core.constants import DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE
        from app.utils.db_utils import paginate

        params = inspect.signature(paginate).parameters
        assert params["page"].default == DEFAULT_PAGE
        assert params["limit"].default == DEFAULT_PAGE_SIZE
        assert params["max_limit"].default == MAX_PAGE_SIZE


class TestToolResultBudget:
    """工具结果预算：工具自夹取（可配置）→ runtime 兜底（结构化截断，非裸切 JSON）。

    迁移前：``tools_server._MAX_CONTENT_CHARS``（12000）不可配，却恒被 runtime
    的 ``max_tool_result_chars``（8000）在 JSON 层裸切 → 排查须翻代码找阈值。
    """

    def test_agent_tool_cap_defaults(self):
        from app.core.config import AgentSettings

        cfg = AgentSettings()
        assert cfg.read_file_max_chars == 12000
        assert cfg.list_tree_max_entries == 300
        assert cfg.list_items_max == 50
        # runtime 兜底必须大于 read_file 正文上限，否则工具产出被兜底裸切
        assert cfg.max_tool_result_chars > cfg.read_file_max_chars

    @pytest.mark.asyncio
    async def test_read_file_clamps_and_flags(self, monkeypatch):
        from app.core.config import get_config
        from app.services.agent import tools_server as ts
        from app.services.agent.tool_registry import ToolContext

        monkeypatch.setattr(
            get_config().agent, "read_file_max_chars", 256, raising=False
        )
        ctx = ToolContext(db=None, repository_id=None, user_id=None, repo_path="/r")

        async def big_blob(repo_path, ref="HEAD", path=""):
            return {"content": "x" * 5000, "language": "python"}

        monkeypatch.setattr(ts, "get_blob_content", big_blob)
        out = await ts._read_file(ctx, {"path": "a.py"})
        assert len(out["content"]) == 256 and out["truncated"] is True

        async def small_blob(repo_path, ref="HEAD", path=""):
            return {"content": "short", "language": "python"}

        monkeypatch.setattr(ts, "get_blob_content", small_blob)
        out2 = await ts._read_file(ctx, {"path": "a.py"})
        assert out2["content"] == "short" and out2["truncated"] is False

    @pytest.mark.asyncio
    async def test_list_tree_clamps_and_flags(self, monkeypatch):
        from app.core.config import get_config
        from app.services.agent import tools_server as ts
        from app.services.agent.tool_registry import ToolContext

        monkeypatch.setattr(
            get_config().agent, "list_tree_max_entries", 3, raising=False
        )

        async def fake_tree(repo_path, ref="HEAD", path=""):
            return {"entries": [{"name": str(i)} for i in range(10)]}

        monkeypatch.setattr(ts, "get_tree_entries", fake_tree)
        ctx = ToolContext(db=None, repository_id=None, user_id=None, repo_path="/r")
        out = await ts._list_tree(ctx, {})
        assert len(out["entries"]) == 3 and out["truncated"] is True

    def test_runtime_backstop_marks_truncation(self):
        from app.services.agent.runtime import _tool_result_content

        assert _tool_result_content({"a": 1}, 1000) == '{"a": 1}'

        big = _tool_result_content({"big": "y" * 500}, 100)
        assert len(big) <= 100
        assert "_truncated" in big

