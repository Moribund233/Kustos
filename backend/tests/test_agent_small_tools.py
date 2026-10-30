"""分诊 + 责任域的只读小工具：list_issues 过滤 / list_members / responsible_for。"""
import pytest

from app.services.agent import tool_registry as tr
from app.services.agent.tool_registry import ToolContext
from app.services.agent.tools_server import load_server_tools


def _ctx(db, repo_id, repo_path=None):
    return ToolContext(db=db, repository_id=repo_id, user_id=None, repo_path=repo_path)


def test_small_tools_registered():
    load_server_tools()
    for name in ("list_members", "responsible_for", "list_issues"):
        assert tr.get_tool(name).scope == "repo:read"


@pytest.mark.asyncio
async def test_list_members_filters_by_role(
    async_db, async_test_user, async_another_user, async_test_repo
):
    from app.models.repository_member import RepositoryMember

    async_db.add_all([
        RepositoryMember(repository_id=async_test_repo.id, user_id=async_test_user.id,
                         role="admin", is_active=True),
        RepositoryMember(repository_id=async_test_repo.id, user_id=async_another_user.id,
                         role="read", is_active=True),
    ])
    await async_db.commit()

    out = await tr.get_tool("list_members").handler(
        _ctx(async_db, async_test_repo.id), {"role": "read"}
    )
    assert [m["username"] for m in out["members"]] == [async_another_user.username]
    assert out["members"][0]["role"] == "read"


@pytest.mark.asyncio
async def test_list_issues_priority_filter(async_db, async_test_user, async_test_repo):
    from app.services.collaboration.issue_service import create_issue

    await create_issue(async_db, async_test_repo.id, async_test_user.id,
                       title="hi", priority="high")
    await create_issue(async_db, async_test_repo.id, async_test_user.id,
                       title="lo", priority="low")
    await async_db.commit()

    out = await tr.get_tool("list_issues").handler(
        _ctx(async_db, async_test_repo.id), {"priority": "high"}
    )
    assert out["total"] == 1 and out["items"][0]["title"] == "hi"


@pytest.mark.asyncio
async def test_list_issues_unknown_assignee_rejected(async_db, async_test_repo):
    out = await tr.get_tool("list_issues").handler(
        _ctx(async_db, async_test_repo.id), {"assignee": "no-such-user"}
    )
    assert "error" in out


@pytest.mark.asyncio
async def test_set_priority_and_apply_label(async_db, async_test_user, async_test_repo):
    from app.models.issue import Label
    from app.services.agent.tools_write import load_write_tools
    from app.services.collaboration.issue_service import create_issue, get_issue

    load_write_tools()
    await create_issue(async_db, async_test_repo.id, async_test_user.id,
                       title="bug", priority="low")
    async_db.add(Label(repository_id=async_test_repo.id, name="bug", color="#f00"))
    await async_db.commit()

    ctx = ToolContext(db=async_db, repository_id=async_test_repo.id,
                      user_id=async_test_user.id)
    out = await tr.get_tool("set_priority").handler(ctx, {"number": 1, "priority": "high"})
    assert out and "error" not in out

    lab = await tr.get_tool("apply_label").handler(ctx, {"number": 1, "label": "bug"})
    assert lab and "error" not in lab

    detail = await get_issue(async_db, async_test_repo.id, 1, include_details=True)
    assert detail["priority"] == "high"
    assert "bug" in [l["name"] for l in (detail.get("labels") or [])]

    bad = await tr.get_tool("apply_label").handler(ctx, {"number": 1, "label": "nope"})
    assert "error" in bad

    from app.models.commit import Commit
    from tests.test_search_service import _build_worktree_repo

    load_server_tools()
    repo_path, old_sha, new_sha = _build_worktree_repo()
    import shutil
    import os

    try:
        for sha, author in ((old_sha, "Alice"), (new_sha, "Bob")):
            async_db.add(Commit(
                hash=sha, repository_id=async_test_repo.id,
                author_name=author, author_email=f"{author}@x",
                committer_name=author, committer_email=f"{author}@x",
                commit_message="m",
            ))
        await async_db.commit()

        out = await tr.get_tool("responsible_for").handler(
            _ctx(async_db, async_test_repo.id, repo_path), {"path": "a.py"}
        )
        assert out["source"] == "commit_index"
        assert {a["author"] for a in out["authors"]} == {"Alice", "Bob"}
    finally:
        shutil.rmtree(os.path.dirname(repo_path), ignore_errors=True)
