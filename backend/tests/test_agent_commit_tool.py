"""Agent commit_file 工具：默认分支与分支校验 / 作者（bot）与提交者（用户）分离"""
import shutil

import pygit2
import pytest
from sqlalchemy import select

from app.core.config import get_config
from app.services.agent.tool_registry import ToolContext
from app.services.agent.tools_write import _commit_file
from app.utils.git_utils import commit_file_changes, get_repository_storage_path, init_bare_repo


@pytest.fixture
async def commit_ctx(async_db, async_test_user, async_test_repo, tmp_path, monkeypatch):
    """指向临时目录的 bare 仓库（含一个 master 分支）+ 工具执行上下文"""
    monkeypatch.setattr(get_config().storage, "repo_root", str(tmp_path))
    path = get_repository_storage_path(async_test_repo.path)
    assert init_bare_repo(path)
    commit_file_changes(
        path, "master", "README.md", "seed", "seed", "seed@example.com", "init"
    )
    ctx = ToolContext(
        db=async_db,
        repository_id=async_test_repo.id,
        user_id=async_test_user.id,
        repo_path=path,
        allow_write=True,
    )
    yield ctx, path
    shutil.rmtree(path, ignore_errors=True)


def _branches(path: str) -> list:
    return sorted(pygit2.Repository(path).branches.local)


@pytest.mark.asyncio
async def test_branch_defaults_to_repository_default_branch(commit_ctx):
    """未指定 branch 时用仓库默认分支，而不是硬编码 main"""
    ctx, path = commit_ctx

    result = await _commit_file(
        ctx, {"path": "docs/note.md", "content": "hi", "message": "add note"}
    )

    assert "error" not in result, result
    assert result["branch"] == "master"
    assert _branches(path) == ["master"], "不得静默创建 main 分支"


@pytest.mark.asyncio
async def test_unknown_branch_is_rejected_with_hint(commit_ctx):
    """目标分支不存在必须回灌模型，而不是从 HEAD 分叉出一条同名新分支"""
    ctx, path = commit_ctx

    result = await _commit_file(
        ctx, {"path": "a.md", "content": "x", "branch": "feature-nope"}
    )

    assert "error" in result, result
    assert "不存在" in result["error"]
    assert "master" in result["error"]  # 提示里带上现有分支
    assert _branches(path) == ["master"], "拒绝时不得产生写副作用"


@pytest.mark.asyncio
async def test_commit_signed_by_bot_author_and_user_committer(
    commit_ctx, async_test_user
):
    """作者=内置 Agent（可与人类提交区分），提交者=触发用户（可追溯是谁让它写的）"""
    ctx, path = commit_ctx

    result = await _commit_file(
        ctx, {"path": "b.md", "content": "y", "message": "agent write"}
    )
    assert "error" not in result, result

    commit = pygit2.Repository(path).revparse_single("master").peel(pygit2.Commit)
    assert commit.author.name == "Kustos Agent"
    assert commit.author.email == "agent@kustos.local"
    assert commit.committer.name == async_test_user.username
    assert commit.committer.email == async_test_user.email

    from app.models.user import User

    bot = (await ctx.db.execute(
        select(User).where(User.is_bot.is_(True))
    )).scalar_one_or_none()
    assert bot is not None and bot.username == "kustos-agent"


@pytest.mark.asyncio
async def test_commit_file_refused_on_protected_branch(
    commit_ctx, async_db, async_test_repo
):
    """受保护分支（require_code_review 禁直推）→ commit_file 拒绝且无写副作用
    （agent commit_file 接线；error_code 由异常对象承载）"""
    ctx, path = commit_ctx
    from app.models.branch import Branch

    got = await async_db.execute(select(Branch).filter(
        Branch.repository_id == async_test_repo.id, Branch.name == "master"
    ))
    branch = got.scalar_one_or_none()
    if branch is None:
        branch = Branch(repository_id=async_test_repo.id, name="master")
        async_db.add(branch)
    branch.is_protected = True
    branch.require_code_review = True
    await async_db.commit()

    result = await _commit_file(
        ctx, {"path": "prot.md", "content": "x", "branch": "master"}
    )

    assert "error" in result, "受保护分支直写应被拒绝并回灌模型"
    assert "requires a pull request" in result["error"]
    assert _branches(path) == ["master"], "拒绝时不得产生写副作用"

    from app.core.exception import AuthorizationException
    from app.services.git_event_service import ensure_local_write

    with pytest.raises(AuthorizationException) as ei:
        await ensure_local_write(async_db, async_test_repo.id, "master")
    assert ei.value.error_code == "branch_direct_write_forbidden"
