"""构建/CI 工具：get_build_status / get_build_logs / retry_build + 失败摘要。"""
import uuid

import pytest
from sqlalchemy import select

from app.models.build_status import BuildStatus
from app.services.agent import tool_registry as tr
from app.services.agent.tool_registry import ToolContext
from app.services.agent.tools_server import load_server_tools
from app.services.agent.tools_write import load_write_tools
from app.services.build_service import BuildService


def _ctx(db, repo_id, user_id=None):
    return ToolContext(db=db, repository_id=repo_id, user_id=user_id)


async def _make_build(db, repo_id, user_id, *, status="pending"):
    build = await BuildService.create_build(
        db=db, repo_id=repo_id, branch="main", commit_sha="a" * 40,
        triggered_by=user_id, commit_message="init",
    )
    if status != "pending":
        build = await BuildService.update_build_status(db=db, build_id=build.id, status=status)
    await db.commit()
    return build


def test_build_tools_registered():
    load_server_tools()
    assert tr.get_tool("get_build_status").scope == "repo:read"
    assert tr.get_tool("get_build_logs").scope == "repo:read"
    retry = tr.get_tool("retry_build")
    assert retry.scope == "repo:write" and retry.requires_approval is True


@pytest.mark.asyncio
async def test_get_build_status(async_db, async_test_user, async_test_repo):
    await _make_build(async_db, async_test_repo.id, async_test_user.id, status="failure")
    out = await tr.get_tool("get_build_status").handler(
        _ctx(async_db, async_test_repo.id), {}
    )
    assert out["builds"] and out["builds"][0]["branch"] == "main"
    assert out["builds"][0]["status"] == "failure"


@pytest.mark.asyncio
async def test_failure_summary_extracted(async_db, async_test_user, async_test_repo):
    build = await _make_build(async_db, async_test_repo.id, async_test_user.id)
    await BuildService.update_build_status(
        async_db, build_id=build.id, status="failure",
        log_entries=[
            {"stream": "stdout", "line": "running tests"},
            {"stream": "stderr", "line": "AssertionError: boom"},
            {"stream": "stderr", "line": "exit code 1"},
        ],
    )
    await async_db.commit()
    await async_db.refresh(build)
    assert build.failure_summary
    assert "exit code 1" in build.failure_summary


@pytest.mark.asyncio
async def test_get_build_logs_tail_and_keyword(async_db, async_test_user, async_test_repo):
    build = await BuildService.create_build(
        db=async_db, repo_id=async_test_repo.id, branch="main",
        commit_sha="b" * 40, triggered_by=async_test_user.id,
    )
    await BuildService.append_build_log_entries(
        async_db, build.id,
        [{"stream": "stdout", "line": f"line {i}"} for i in range(300)]
        + [{"stream": "stderr", "line": "FATAL: disk full"}],
    )
    await async_db.commit()

    handler = tr.get_tool("get_build_logs").handler

    tail = await handler(_ctx(async_db, async_test_repo.id), {"build_id": str(build.id), "tail": 5})
    assert len(tail["entries"]) == 5
    assert tail["total"] == 301 and tail["truncated"] is True
    assert tail["entries"][-1]["line"] == "FATAL: disk full"  # 尾部

    kw = await handler(_ctx(async_db, async_test_repo.id), {"build_id": str(build.id), "keyword": "FATAL"})
    assert len(kw["entries"]) == 1 and "disk full" in kw["entries"][0]["line"]

    # 空关键字不误伤：过滤后统计正确
    assert kw["total"] == 1


@pytest.mark.asyncio
async def test_get_build_logs_rejects_foreign_repo(async_db, async_test_user, async_test_repo):
    build = await _make_build(async_db, async_test_repo.id, async_test_user.id)
    out = await tr.get_tool("get_build_logs").handler(
        _ctx(async_db, uuid.uuid4()), {"build_id": str(build.id)}
    )
    assert "error" in out


@pytest.mark.asyncio
async def test_retry_build_creates_new_build(async_db, async_test_user, async_test_repo):
    load_write_tools()
    src = await _make_build(async_db, async_test_repo.id, async_test_user.id, status="failure")
    out = await tr.get_tool("retry_build").handler(
        _ctx(async_db, async_test_repo.id, async_test_user.id), {"build_id": str(src.id)}
    )
    assert out["status"] == "pending" and out["id"] != str(src.id)
    assert out["branch"] == "main" and out["commit_sha"] == "a" * 40

    count = len(
        (await async_db.execute(select(BuildStatus).where(BuildStatus.repo_id == async_test_repo.id)))
        .scalars().all()
    )
    assert count == 2
