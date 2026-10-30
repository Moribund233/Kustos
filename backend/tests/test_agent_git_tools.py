"""git 审查工具：list_commits / get_commit / get_diff / blame_file / compare_refs。

全部为 ``repository_browser_service`` 的薄包装，输出遵循「结论+指针」：默认只给
文件级统计与改动行区间，正文需显式 ``include_patch`` 且有界。
"""
import os
import shutil

import pytest

from app.services.agent import tool_registry as tr
from app.services.agent.tool_registry import ToolContext
from app.services.agent.tools_server import load_server_tools


@pytest.fixture
def work_repo():
    from tests.test_search_service import _build_worktree_repo

    repo_path, old_sha, new_sha = _build_worktree_repo()
    try:
        yield repo_path, old_sha, new_sha
    finally:
        shutil.rmtree(os.path.dirname(repo_path), ignore_errors=True)


def _ctx(repo_path):
    return ToolContext(db=None, repository_id=None, user_id=None, repo_path=repo_path)


def test_git_tools_registered_read_only():
    load_server_tools()
    for name in ("list_commits", "get_commit", "get_diff", "blame_file", "compare_refs"):
        spec = tr.get_tool(name)
        assert spec is not None and spec.scope == "repo:read"


@pytest.mark.asyncio
async def test_list_commits(work_repo):
    repo_path, old_sha, new_sha = work_repo
    out = await tr.get_tool("list_commits").handler(_ctx(repo_path), {"per_page": 10})
    shas = [c["sha"] for c in out["commits"]]
    assert new_sha in shas and old_sha in shas
    assert all("author" in c and "date" in c for c in out["commits"])


@pytest.mark.asyncio
async def test_get_commit_regions_without_patch(work_repo):
    repo_path, _old, new_sha = work_repo
    out = await tr.get_tool("get_commit").handler(_ctx(repo_path), {"ref": new_sha})
    by_path = {f["path"]: f for f in out["files"]}
    assert by_path["a.py"]["status"] == "M"
    assert by_path["c.py"]["status"] == "A"
    assert by_path["b.txt"]["status"] == "D"
    assert by_path["a.py"]["ranges"]  # 新增两行 → 非空区间
    assert "patch" not in out  # 默认不回灌正文


@pytest.mark.asyncio
async def test_get_commit_include_patch_is_bounded(work_repo):
    repo_path, _old, new_sha = work_repo
    out = await tr.get_tool("get_commit").handler(
        _ctx(repo_path), {"ref": new_sha, "include_patch": True}
    )
    assert "patch" in out and out["patch"]
    assert isinstance(out["patch_truncated"], bool)


@pytest.mark.asyncio
async def test_get_commit_root_has_no_parent_diff(work_repo):
    repo_path, old_sha, _new = work_repo
    out = await tr.get_tool("get_commit").handler(_ctx(repo_path), {"ref": old_sha})
    assert out["parents"] == []
    by_path = {f["path"]: f for f in out["files"]}
    assert by_path["a.py"]["status"] == "A"  # 与空树对比


@pytest.mark.asyncio
async def test_get_diff_between_refs(work_repo):
    repo_path, old_sha, new_sha = work_repo
    out = await tr.get_tool("get_diff").handler(
        _ctx(repo_path), {"base": old_sha, "head": new_sha}
    )
    paths = {f["path"] for f in out["files"]}
    assert {"a.py", "c.py", "b.txt"} <= paths


@pytest.mark.asyncio
async def test_blame_file_hunks(work_repo):
    repo_path, _old, _new = work_repo
    out = await tr.get_tool("blame_file").handler(_ctx(repo_path), {"path": "a.py"})
    assert out["path"] == "a.py"
    assert out["hunks"] and all("commit" in h for h in out["hunks"])


@pytest.mark.asyncio
async def test_compare_refs(work_repo):
    repo_path, old_sha, new_sha = work_repo
    out = await tr.get_tool("compare_refs").handler(
        _ctx(repo_path), {"base": old_sha, "head": new_sha}
    )
    assert out["ahead_by"] == 1
    assert {f["path"] for f in out["files"]} >= {"a.py", "c.py", "b.txt"}
    assert out["commits"] and out["commits"][0]["sha"] == new_sha


# ---- 复合审查（索引 × 索引）----

def _ctx_db(repo_path, db, repo_id):
    return ToolContext(db=db, repository_id=repo_id, user_id=None, repo_path=repo_path)


@pytest.mark.asyncio
async def test_review_recent_changes(async_db, async_test_repo, work_repo):
    load_server_tools()
    repo_path, _old, new_sha = work_repo
    out = await tr.get_tool("review_recent_changes").handler(
        _ctx_db(repo_path, async_db, async_test_repo.id), {"n_commits": 5}
    )
    by_sha = {c["sha"]: c for c in out["commits"]}
    assert new_sha in by_sha
    assert by_sha[new_sha]["source"] == "commit_index"  # 走已构建的变更图索引
    assert {f["path"] for f in by_sha[new_sha]["files"]} >= {"a.py", "c.py", "b.txt"}


@pytest.mark.asyncio
async def test_who_changed_by_path(async_db, async_test_repo, work_repo):
    load_server_tools()
    repo_path, old_sha, new_sha = work_repo
    out = await tr.get_tool("who_changed").handler(
        _ctx_db(repo_path, async_db, async_test_repo.id), {"path": "a.py"}
    )
    shas = {c["sha"] for c in out["commits"]}
    # a.py 在两次提交都被改动
    assert {old_sha, new_sha} <= shas
    assert out["source"] == "commit_index"


@pytest.mark.asyncio
async def test_who_changed_by_symbol_is_approximate(async_db, async_test_repo, work_repo):
    load_server_tools()
    repo_path, old_sha, _new = work_repo
    from app.services.search.search_service import SearchService

    await SearchService().rebuild_index(async_db, async_test_repo.id, repo_path)
    out = await tr.get_tool("who_changed").handler(
        _ctx_db(repo_path, async_db, async_test_repo.id), {"symbol": "one"}
    )
    assert out["approximate"] is True
    assert out["path"] == "a.py"
    # def one 的行区间（1-2）由根提交引入；第二提交改的是下方新增行 → 不重叠
    shas = {c["sha"] for c in out["commits"]}
    assert old_sha in shas
