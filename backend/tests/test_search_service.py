"""搜索服务层测试 — 内容来自 Git 对象，索引持久化到主库（PostgreSQL 测试库）"""
import os
import shutil
import subprocess
import tempfile

import pytest
from sqlalchemy import func, select

from app.models.repo_search import RepoSearchState
from app.models.repo_search_chunk import RepoSearchChunk
from app.services.search.search_service import SearchResponse, SearchResult, SearchService


def _git(*args, cwd=None):
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
    )


def _make_bare_repo(files: dict, extra_branch: dict | None = None):
    """创建带提交的 bare 仓库（模拟 Kustos 存储形态），返回 (tmpdir, bare, work)"""
    tmp = tempfile.mkdtemp()
    work = os.path.join(tmp, "work")
    _git("init", "--initial-branch=main", work)
    _git("config", "user.email", "t@example.com", cwd=work)
    _git("config", "user.name", "T", cwd=work)

    def write(name, content):
        full = os.path.join(work, name)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)

    for name, content in files.items():
        write(name, content)
    _git("add", "-A", cwd=work)
    _git("commit", "-m", "init", cwd=work)

    if extra_branch:
        _git("checkout", "-b", "feature", cwd=work)
        for name, content in extra_branch.items():
            write(name, content)
        _git("add", "-A", cwd=work)
        _git("commit", "-m", "feature", cwd=work)
        _git("checkout", "main", cwd=work)

    bare = os.path.join(tmp, "repo.git")
    _git("clone", "--bare", work, bare)
    _git("remote", "add", "origin", bare, cwd=work)
    return tmp, bare, work


def _build_worktree_repo():
    """带三个变更 (修改/新增/删除) 的 non-bare 仓库，返回 (repo_path, old_sha, new_sha)"""
    tmpdir = tempfile.mkdtemp()
    repo_path = os.path.join(tmpdir, "repo")
    _git("init", "--initial-branch=main", repo_path)
    _git("config", "user.email", "t@example.com", cwd=repo_path)
    _git("config", "user.name", "T", cwd=repo_path)

    def write(name, content):
        with open(os.path.join(repo_path, name), "w", encoding="utf-8") as f:
            f.write(content)

    write("a.py", "def one():\n    pass\n")
    write("b.txt", "hello old\n")
    _git("add", ".", cwd=repo_path)
    _git("commit", "-m", "init", cwd=repo_path)
    old_sha = _git("rev-parse", "HEAD", cwd=repo_path).stdout.strip()

    write("a.py", "def one():\n    pass\n\ndef two():\n    return 2\n")
    write("c.py", "def three():\n    pass\n")
    os.remove(os.path.join(repo_path, "b.txt"))
    _git("add", "-A", cwd=repo_path)
    _git("commit", "-m", "second", cwd=repo_path)
    new_sha = _git("rev-parse", "HEAD", cwd=repo_path).stdout.strip()
    return repo_path, old_sha, new_sha


@pytest.fixture
def search_service():
    return SearchService()


class TestSearchService:
    @pytest.mark.asyncio
    async def test_search_code(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = _make_bare_repo({"main.py": "def hello():\n    pass\n"})
        try:
            res = await search_service.search_code(async_db, async_test_repo.id, bare, "hello")
            assert isinstance(res, SearchResponse)
            assert res.total_count > 0
            assert res.results[0].file == "main.py"
            assert res.results[0].line == 1
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_search_code_with_path(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = _make_bare_repo({"src/a.py": "hello\n", "other.py": "hello\n"})
        try:
            res = await search_service.search_code(async_db, async_test_repo.id, bare, "hello", path="src")
            assert len(res.results) == 1
            assert res.results[0].file == "src/a.py"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_search_code_no_results(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = _make_bare_repo({"main.py": "def hello():\n"})
        try:
            res = await search_service.search_code(async_db, async_test_repo.id, bare, "nonexistent")
            assert res.total_count == 0
            assert res.results == []
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_search_result_structure(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = _make_bare_repo({"main.py": "def hello():\n"})
        try:
            res = await search_service.search_code(async_db, async_test_repo.id, bare, "hello")
            assert res.results
            result = res.results[0]
            assert isinstance(result, SearchResult)
            assert hasattr(result, "file") and hasattr(result, "line") and hasattr(result, "content")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_search_result_carries_chunk_span(self, async_db, async_test_repo, search_service):
        """块级索引：命中结果附带 file:start-end 区间（chunk 引用）"""
        tmp, bare, _ = _make_bare_repo({"app.py": "def greet():\n    return 'hi'\n"})
        try:
            res = await search_service.search_code(async_db, async_test_repo.id, bare, "greet")
            assert res.total_count > 0
            result = res.results[0]
            assert result.chunk is not None
            assert result.chunk.start_line == 1
            assert result.chunk.kind == "function"
            assert result.chunk.symbol == "greet"
            assert result.line == 1
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_search_response_truncation(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = _make_bare_repo({"a.py": "def a():\n", "b.py": "def b():\n"})
        try:
            res = await search_service.search_code(async_db, async_test_repo.id, bare, "def", max_results=1)
            assert len(res.results) <= 1
            assert res.truncated is True
            assert res.total_count == -1
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_search_ref_branch(self, async_db, async_test_repo, search_service):
        """非默认 ref 走进程内 Git tree 扫描"""
        tmp, bare, _ = _make_bare_repo(
            {"main.py": "def hello():\n"},
            extra_branch={"feature.py": "def feature_only():\n"},
        )
        try:
            assert (await search_service.search_code(async_db, async_test_repo.id, bare, "feature_only")).total_count == 0
            res = await search_service.search_code(async_db, async_test_repo.id, bare, "feature_only", ref="feature")
            assert res.total_count > 0
            assert res.results[0].file == "feature.py"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestSearchIndexPersistence:
    @pytest.mark.asyncio
    async def test_index_rows_in_db(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = _make_bare_repo({"src/main.py": "def hello():\n", "README.md": "# Test\n"})
        try:
            count = await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            assert count == 2
            chunks = (await async_db.execute(
                select(RepoSearchChunk).where(
                    RepoSearchChunk.repository_id == async_test_repo.id
                )
            )).scalars().all()
            assert len(chunks) == 2
            main = [c for c in chunks if c.path == "src/main.py"]
            assert main and "def hello" in main[0].content
            state = (await async_db.execute(
                select(RepoSearchState).where(RepoSearchState.repository_id == async_test_repo.id)
            )).scalar_one()
            assert state.indexed_commit
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_update_files_reindexes(self, async_db, async_test_repo, search_service):
        tmp, bare, work = _make_bare_repo(
            {"src/keep.py": "def keep():\n", "src/change.py": "def old():\n"}
        )
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            with open(os.path.join(work, "src", "change.py"), "w", encoding="utf-8") as f:
                f.write("def changed_func():\n")
            _git("add", "-A", cwd=work)
            _git("commit", "-m", "change", cwd=work)
            _git("push", "origin", "main", cwd=work)

            await search_service.update_files(async_db, async_test_repo.id, bare, ["src/change.py"])
            res = await search_service.search_code(async_db, async_test_repo.id, bare, "changed_func")
            assert res.total_count > 0
            keep = await search_service.search_code(async_db, async_test_repo.id, bare, "keep")
            assert keep.total_count > 0
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_find_definition_and_usages(self, async_db, async_test_repo, search_service):
        """符号/引用图：find-definition / find-usages"""
        from app.models.repo_search_ref import RepoSearchRef

        tmp, bare, _ = _make_bare_repo({
            "a.py": "def greet():\n    return hello()\n",
            "b.py": "def hello():\n    return 1\n",
        })
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            defs = await search_service.find_definition(async_db, async_test_repo.id, "hello")
            assert defs.hits and defs.hits[0].file == "b.py" and defs.hits[0].kind == "function"
            assert defs.source == "index" and defs.partial is False
            usages = await search_service.find_usages(async_db, async_test_repo.id, "hello")
            locs = {(u.file, u.line) for u in usages.hits}
            assert ("a.py", 2) in locs   # 调用点
            assert ("b.py", 1) in locs   # 定义点
            call = next(u for u in usages.hits if (u.file, u.line) == ("a.py", 2))
            assert call.symbol == "greet" and call.start_line == 1  # 调用点所在符号块
            empty = await search_service.find_usages(async_db, async_test_repo.id, "nonexistent")
            assert empty.hits == []
            # 清理后引用行一并删除
            await search_service.cleanup_index(async_db, async_test_repo.id)
            remaining = (await async_db.execute(
                select(func.count()).select_from(RepoSearchRef).where(
                    RepoSearchRef.repository_id == async_test_repo.id
                )
            )).scalar_one()
            assert remaining == 0
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_find_usages_filters(self, async_db, async_test_repo, search_service):
        """path 前缀 + exclude_tests 过滤"""
        tmp, bare, _ = _make_bare_repo({
            "svc.py": "def helper():\n    pass\n",
            "other.py": "def other():\n    helper()\n",
            "tests/test_svc.py": "def test_x():\n    helper()\n",
        })
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            all_u = await search_service.find_usages(async_db, async_test_repo.id, "helper")
            assert any(u.file.startswith("tests/") for u in all_u.hits)
            prod = await search_service.find_usages(
                async_db, async_test_repo.id, "helper", exclude_tests=True
            )
            assert prod.hits and all(not u.file.startswith("tests/") for u in prod.hits)
            only_tests = await search_service.find_usages(
                async_db, async_test_repo.id, "helper", path="tests"
            )
            assert only_tests.hits and all(
                u.file.startswith("tests/") for u in only_tests.hits
            )
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_cleanup_index(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = _make_bare_repo({"a.py": "def a():\n"})
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            await search_service.cleanup_index(async_db, async_test_repo.id)
            rows = (await async_db.execute(
                select(func.count()).select_from(RepoSearchChunk).where(
                    RepoSearchChunk.repository_id == async_test_repo.id
                )
            )).scalar_one()
            assert rows == 0
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_update_files_noop_for_empty_list(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = _make_bare_repo({"a.py": "def a():\n"})
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            await search_service.update_files(async_db, async_test_repo.id, bare, [])
            rows = (await async_db.execute(
                select(func.count()).select_from(RepoSearchChunk).where(
                    RepoSearchChunk.repository_id == async_test_repo.id
                )
            )).scalar_one()
            assert rows == 1
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestIndexGuards:
    @pytest.mark.asyncio
    async def test_rebuild_skips_when_over_file_cap(self, async_db, async_test_repo, search_service, monkeypatch):
        """超过构建上限：跳过索引并标记 state，搜索退回 Git tree 全扫且结果完整"""
        # 上限读配置：改配置源而非模块常量（常量仅是降级默认）
        from app.core.config import get_config

        monkeypatch.setattr(get_config().search, "index_max_files", 1, raising=False)
        tmp, bare, _ = _make_bare_repo({"a.py": "def a():\n", "b.py": "def b():\n"})
        try:
            count = await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            assert count == 0
            rows = (await async_db.execute(
                select(func.count()).select_from(RepoSearchChunk).where(
                    RepoSearchChunk.repository_id == async_test_repo.id
                )
            )).scalar_one()
            assert rows == 0
            state = (await async_db.execute(
                select(RepoSearchState).where(RepoSearchState.repository_id == async_test_repo.id)
            )).scalar_one_or_none()
            assert state is not None and state.indexed_commit
            res = await search_service.search_code(async_db, async_test_repo.id, bare, "def")
            assert res.total_count > 0
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_rebuild_skipped_when_lock_held(self, async_db, async_test_repo, search_service):
        """同一仓库重建锁被占用时，本次重建直接放弃"""
        from app.services.search.search_service import _local_rebuild_lock

        tmp, bare, _ = _make_bare_repo({"a.py": "def a():\n"})
        try:
            lock = await _local_rebuild_lock(async_test_repo.id)
            async with lock:
                count = await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            assert count == 0
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestIncrementalIndex:
    def test_diff_changed_files_returns_only_changed(self):
        repo_path, old_sha, new_sha = _build_worktree_repo()
        try:
            changed = SearchService.diff_changed_files(repo_path, old_sha, new_sha)
            assert changed is not None
            assert set(changed) == {"a.py", "b.txt", "c.py"}
        finally:
            shutil.rmtree(os.path.dirname(repo_path), ignore_errors=True)

    def test_diff_changed_files_none_for_missing_ref(self):
        repo_path, old_sha, new_sha = _build_worktree_repo()
        try:
            assert SearchService.diff_changed_files(repo_path, "does-not-exist", new_sha) is None
            assert SearchService.diff_changed_files(repo_path, None, new_sha) is None
            assert SearchService.diff_changed_files(repo_path, old_sha, None) is None
        finally:
            shutil.rmtree(os.path.dirname(repo_path), ignore_errors=True)

    def test_diff_changed_files_none_empty_range(self):
        repo_path, old_sha, _ = _build_worktree_repo()
        try:
            assert SearchService.diff_changed_files(repo_path, old_sha, old_sha) == []
        finally:
            shutil.rmtree(os.path.dirname(repo_path), ignore_errors=True)


class TestKeywordRanking:
    """``_search_db`` 必须按相关性排序，且结果稳定可复现。

    修复前为无 ORDER BY 的 ``LIMIT 200``：命中数超过上限时返回的是**任意** 200 个
    chunk，且同一查询两次调用可能给出不同结果，调用方（Agent）会据此得出
    「符号不存在」的错误结论。
    """

    @pytest.mark.asyncio
    async def test_denser_chunk_ranks_first(self, async_db, async_test_repo, search_service, monkeypatch):
        """命中数多的 chunk 排在前面（截断上限调小以确定性地暴露旧行为）"""
        monkeypatch.setattr("app.services.search.search_service.SCAN_FILE_LIMIT", 2)
        tmp, bare, _ = _make_bare_repo({
            "a_sparse.py": "def f():\n    return needle\n",
            "b_dense.py": "".join(f"    x = needle  # {i}\n" for i in range(5)),
        })
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            res = await search_service.search_code(
                async_db, async_test_repo.id, bare, "needle", max_results=100
            )
            assert res.results
            assert res.results[0].file == "b_dense.py"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_ranking_is_deterministic(self, async_db, async_test_repo, search_service, monkeypatch):
        """同样查询两次调用必须给出完全一致的顺序"""
        monkeypatch.setattr("app.services.search.search_service.SCAN_FILE_LIMIT", 2)
        tmp, bare, _ = _make_bare_repo({
            "a.py": "def f():\n    return needle\n",
            "b.py": "def g():\n    return needle\n",
            "c.py": "def h():\n    return needle\n",
        })
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            first = await search_code_files(search_service, async_db, async_test_repo.id, bare, "needle")
            second = await search_code_files(search_service, async_db, async_test_repo.id, bare, "needle")
            assert first == second
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_ranking_case_insensitive(self, async_db, async_test_repo, search_service, monkeypatch):
        """大小写不敏感命中同样参与排序（排名表达式两侧都 lower）"""
        monkeypatch.setattr("app.services.search.search_service.SCAN_FILE_LIMIT", 1)
        tmp, bare, _ = _make_bare_repo({
            "a_sparse.py": "def f():\n    return NEEDLE\n",
            "b_dense.py": "".join(f"    x = needle  # {i}\n" for i in range(4)),
        })
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            res = await search_service.search_code(
                async_db, async_test_repo.id, bare, "needle", max_results=100
            )
            assert res.results and res.results[0].file == "b_dense.py"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


async def search_code_files(service, db, repository_id, bare, query):
    res = await service.search_code(db, repository_id, bare, query, max_results=100)
    return [(r.file, r.line) for r in res.results]


class TestSymbolRefLookup:
    """符号/引用查找必须尊重 ``ref``。

    块级索引只覆盖**默认分支 HEAD**，修复前 ``find_definition`` / ``find_usages``
    完全忽略调用方传入的 ref，分析 PR 分支时会**静默返回默认分支的答案**——
    不是「退化」而是「给错答案」，调用方无从察觉。
    """

    @staticmethod
    def _branched_repo():
        """main 与 feature 上同一文件内容不同：alpha.py 定义 alpha ↔ gamma，
        caller.py 的调用点随之改变。"""
        return _make_bare_repo(
            {
                "alpha.py": "def alpha():\n    pass\n",
                "caller.py": "def caller():\n    alpha()\n",
            },
            extra_branch={
                "alpha.py": "def gamma():\n    pass\n",
                "caller.py": "def caller():\n    gamma()\n",
            },
        )

    @pytest.mark.asyncio
    async def test_definition_uses_index_for_default_ref(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = self._branched_repo()
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            hit = await search_service.find_definition(async_db, async_test_repo.id, "alpha")
            assert hit.source == "index" and hit.hits
            assert hit.hits[0].file == "alpha.py" and hit.hits[0].kind == "function"
            # feature 上的符号在索引（main）里查不到
            miss = await search_service.find_definition(async_db, async_test_repo.id, "gamma")
            assert miss.hits == []
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_definition_honors_ref(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = self._branched_repo()
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            res = await search_service.find_definition(
                async_db, async_test_repo.id, "gamma", repo_path=bare, ref="feature"
            )
            assert res.source == "ref_scan" and res.partial is False
            assert res.hits and res.hits[0].file == "alpha.py"
            assert res.hits[0].symbol == "gamma" and res.hits[0].kind == "function"
            # 关键回归：main 上的定义不得作为 feature 的答案返回
            stale = await search_service.find_definition(
                async_db, async_test_repo.id, "alpha", repo_path=bare, ref="feature"
            )
            assert stale.hits == []
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_usages_honor_ref(self, async_db, async_test_repo, search_service):
        tmp, bare, _ = self._branched_repo()
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            on_feature = await search_service.find_usages(
                async_db, async_test_repo.id, "gamma", repo_path=bare, ref="feature"
            )
            assert on_feature.source == "ref_scan"
            # 定义点与调用点都在 feature 上
            assert {(u.file, u.line) for u in on_feature.hits} == {
                ("alpha.py", 1), ("caller.py", 2),
            }
            # 引用点所在符号块随 ref 一起给出
            call = next(u for u in on_feature.hits if u.file == "caller.py")
            assert call.symbol == "caller" and call.start_line == 1
            stale = await search_service.find_usages(
                async_db, async_test_repo.id, "alpha", repo_path=bare, ref="feature"
            )
            assert stale.hits == []
            on_main = await search_service.find_usages(async_db, async_test_repo.id, "alpha")
            assert on_main.source == "index" and on_main.hits
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_ref_scan_applies_path_and_exclude_tests(
        self, async_db, async_test_repo, search_service
    ):
        tmp, bare, _ = _make_bare_repo(
            {
                "src/svc.py": "def helper():\n    pass\n",
                "other.py": "def helper():\n    pass\n",
                "tests/test_svc.py": "def helper():\n    pass\n\n\ndef test_x():\n    helper()\n",
            },
            extra_branch={"src/extra.py": "def helper():\n    pass\n"},
        )
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            res = await search_service.find_definition(
                async_db, async_test_repo.id, "helper",
                repo_path=bare, ref="feature", exclude_tests=True,
            )
            assert sorted(h.file for h in res.hits) == [
                "other.py", "src/extra.py", "src/svc.py",
            ]
            with_tests = await search_service.find_definition(
                async_db, async_test_repo.id, "helper", repo_path=bare, ref="feature"
            )
            assert any(h.file.startswith("tests/") for h in with_tests.hits)
            scoped = await search_service.find_definition(
                async_db, async_test_repo.id, "helper", repo_path=bare, ref="feature", path="src"
            )
            assert sorted(h.file for h in scoped.hits) == ["src/extra.py", "src/svc.py"]
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_ref_scan_reports_partial_when_capped(
        self, async_db, async_test_repo, search_service, monkeypatch
    ):
        """扫描被护栏截断时必须显式标记 partial=True，不得静默返回不完整结果"""
        # 护栏读配置：改配置源而非模块常量（常量仅是降级默认）
        from app.core.config import get_config

        monkeypatch.setattr(get_config().search, "symbol_scan_max_files", 1, raising=False)
        tmp, bare, _ = _make_bare_repo(
            {"a_one.py": "def caller():\n    alpha()\n"},
            extra_branch={"b_two.py": "def caller():\n    gamma()\n"},
        )
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            res = await search_service.find_usages(
                async_db, async_test_repo.id, "caller", repo_path=bare, ref="feature"
            )
            assert res.source == "ref_scan" and res.partial is True
            # 未被扫描到的文件不得出现（护栏确实生效，而非只是打个标记）
            assert all(h.file == "a_one.py" for h in res.hits)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_default_branch_name_resolves_to_index(
        self, async_db, async_test_repo, search_service
    ):
        """显式传入默认分支名时走索引，不做无谓的 ref 扫描"""
        tmp, bare, _ = self._branched_repo()
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            res = await search_service.find_definition(
                async_db, async_test_repo.id, "alpha", repo_path=bare, ref="main"
            )
            assert res.source == "index" and res.hits
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_unknown_ref_raises(self, async_db, async_test_repo, search_service):
        from app.core.exception import NotFoundException

        tmp, bare, _ = self._branched_repo()
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            with pytest.raises(NotFoundException) as exc:
                await search_service.find_definition(
                    async_db, async_test_repo.id, "alpha", repo_path=bare, ref="no-such-branch"
                )
            assert exc.value.error_code == "search_ref_not_found"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_ref_without_repo_path_rejected(self, async_db, async_test_repo, search_service):
        """给了非默认 ref 却没有仓库路径 → 明确拒绝，而不是回落到索引给错答案"""
        from app.core.exception import ValidationException

        tmp, bare, _ = self._branched_repo()
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)
            with pytest.raises(ValidationException) as exc:
                await search_service.find_definition(
                    async_db, async_test_repo.id, "alpha", ref="feature"
                )
            assert exc.value.error_code == "search_ref_scan_requires_repo"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestSearchProvenance:
    """结果溯源：调用方（Agent/前端）能区分「索引召回」与「兜底全扫」"""

    @pytest.mark.asyncio
    async def test_index_hit_reports_source_index(
        self, async_db, async_test_repo, search_service
    ):
        """索引命中 → source=index；provider 未配置 → semantic_used=False"""
        tmp, bare, _ = _make_bare_repo({"a.py": "def alpha():\n    pass\n"})
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)

            res = await search_service.search_code(
                async_db, async_test_repo.id, bare, "alpha"
            )

            assert res.source == "index"
            assert res.results and res.results[0].chunk is not None
            assert res.semantic_used is False  # 未配 embedding provider，语义未参与
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_index_miss_reports_source_git_tree(
        self, async_db, async_test_repo, search_service, monkeypatch
    ):
        """索引无命中 → 现场 Git tree 全扫兜底，来源如实标记（命中不带符号块）"""
        tmp, bare, _ = _make_bare_repo({"a.py": "def alpha():\n    pass\n"})
        try:
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)

            async def _no_index_hits(*args, **kwargs):
                return []

            monkeypatch.setattr(SearchService, "_search_db", _no_index_hits)

            res = await search_service.search_code(
                async_db, async_test_repo.id, bare, "alpha"
            )

            assert res.source == "git_tree"
            assert res.results and res.results[0].chunk is None
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_empty_query_reports_source_none(
        self, async_db, async_test_repo, search_service
    ):
        """空查询未执行检索 → source=none"""
        res = await search_service.search_code(async_db, async_test_repo.id, "", "   ")
        assert res.source == "none"
        assert res.results == [] and res.semantic_used is False

    @pytest.mark.asyncio
    async def test_semantic_used_follows_provider(
        self, async_db, async_test_repo, search_service
    ):
        """provider 就位且语义命中 → semantic_used=True；显式关闭语义 → False"""
        from app.services.indexing import embeddings

        class _FakeEmbed:
            name = "fake"
            model = "fake-embed"
            dim = 1536  # 与 PG vector(1536) 对齐

            async def embed(self, texts):
                return [[1.0] + [0.0] * 1535 for _ in texts]

        tmp, bare, _ = _make_bare_repo({"a.py": "def alpha():\n    pass\n"})
        try:
            embeddings.set_embedding_provider(_FakeEmbed())
            await search_service.rebuild_index(async_db, async_test_repo.id, bare)

            on = await search_service.search_code(
                async_db, async_test_repo.id, bare, "alpha", semantic=True
            )
            assert on.source == "index"
            assert on.semantic_used is True

            off = await search_service.search_code(
                async_db, async_test_repo.id, bare, "alpha", semantic=False
            )
            assert off.semantic_used is False
        finally:
            embeddings.reset_embedding_provider()
            shutil.rmtree(tmp, ignore_errors=True)