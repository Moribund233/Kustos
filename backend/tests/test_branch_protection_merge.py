"""
分支保护合并裁决测试

覆盖：
- require_code_review：无 approve 拒绝合并；非作者 approve 后可合并；
- 自我 approve 禁止（无论角色）：提交侧拒绝 + 既有自审记录不计数；
- admin bypass 通道：非 owner/admin 拒绝；owner override 可合并并写 PR 活动流审计；
- require_status_checks："无 CI 即通过"（默认）/ 严格模式（零检查记录拒绝）开关。
"""
import os

from app.services.repository import branch_service
import pygit2
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exception import AuthorizationException, ValidationException
from app.models import Branch, Repository
from app.models.pull_request import PullRequest, PRReview
from app.models.user import User
from app.services.collaboration import pull_request_service
from app.services.collaboration.pr_activity_service import list_activities
from app.utils.git_utils import get_repository_storage_path


def _init_bare_with_branches(repository: Repository):
    """bare 仓：main 一个提交 + feature（基于 main）一个提交"""
    path = get_repository_storage_path(repository.path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bare = pygit2.init_repository(path, bare=True)
    sig = pygit2.Signature("Prot Tester", "prot@example.com")

    blob = bare.create_blob("base\n")
    builder = bare.TreeBuilder()
    builder.insert("README.md", blob, pygit2.GIT_FILEMODE_BLOB)
    tree = builder.write()
    main_oid = bare.create_commit("refs/heads/main", sig, sig, "init", tree, [])

    # feature 分支：基于 main 的树增加一个文件
    builder2 = bare.TreeBuilder(tree)
    builder2.insert("feature.txt", bare.create_blob("feature\n"), pygit2.GIT_FILEMODE_BLOB)
    tree2 = builder2.write()
    bare.create_commit("refs/heads/feature", sig, sig, "feat", tree2, [main_oid])

    return str(main_oid)


async def _make_user(db, username: str, is_admin: bool = False) -> User:
    user = User(
        username=username,
        email=f"{username}@example.com",
        password="hashed_password_string",
        full_name=username.title(),
        is_active=True,
        is_admin=is_admin,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _make_member(db, repo, user, role: str) -> None:
    from app.models.repository_member import RepositoryMember

    db.add(RepositoryMember(
        repository_id=repo.id, user_id=user.id, role=role, is_active=True,
    ))
    await db.commit()


@pytest_asyncio.fixture
async def env(async_db: AsyncSession):
    """owner（可 override）+ author（PR 作者）+ dev（可合并不可 override）"""
    owner = await _make_user(async_db, "protowner")
    author = await _make_user(async_db, "protauthor")
    dev = await _make_user(async_db, "protdev")

    repo = Repository(
        name="prot-repo",
        path="protowner/prot-repo",
        description="branch protection merge test",
        is_public=False,
        owner_id=owner.id,
        default_branch="main",
    )
    async_db.add(repo)
    await async_db.commit()
    await async_db.refresh(repo)

    await _make_member(async_db, repo, author, "developer")
    await _make_member(async_db, repo, dev, "developer")

    main_tip = _init_bare_with_branches(repo)
    async_db.add(Branch(
        repository_id=repo.id, name="main", commit_hash=main_tip,
        is_protected=False, is_default=True,
    ))
    async_db.add(Branch(
        repository_id=repo.id, name="feature", commit_hash=None, is_protected=False,
    ))
    await async_db.commit()

    pr = PullRequest(
        repository_id=repo.id,
        pr_number=1,
        title="Protected PR",
        description="needs review",
        source_branch="feature",
        target_branch="main",
        author_id=author.id,
        status="open",
    )
    async_db.add(pr)
    await async_db.commit()
    await async_db.refresh(pr)

    return {"owner": owner, "author": author, "dev": dev, "repo": repo, "pr": pr}


@pytest.mark.asyncio
async def test_merge_requires_approval(async_db, env):
    await branch_service.protect_branch(
        env["repo"].id, "main", {"require_code_review": True}, async_db
    )

    with pytest.raises(ValidationException) as exc:
        await pull_request_service.merge_pull_request(
            async_db, env["repo"].id, 1, env["dev"].id
        )
    assert exc.value.error_code == "pr_merge_requires_review"


@pytest.mark.asyncio
async def test_self_approve_forbidden_regardless_of_role(async_db, env):
    """作者不得批准自己的 PR（即便作者是仓库 owner）"""
    with pytest.raises(ValidationException) as exc:
        await pull_request_service.create_pr_review(
            async_db, env["repo"].id, 1, env["author"].id, status="approved"
        )
    assert exc.value.error_code == "pr_self_approve_forbidden"

    # 仓库 owner 批准自己的 PR 同样禁止（owner 是 PR 作者场景）
    pr2 = PullRequest(
        repository_id=env["repo"].id, pr_number=2, title="owner PR",
        source_branch="feature", target_branch="main",
        author_id=env["owner"].id, status="open",
    )
    async_db.add(pr2)
    await async_db.commit()
    with pytest.raises(ValidationException) as exc:
        await pull_request_service.create_pr_review(
            async_db, env["repo"].id, 2, env["owner"].id, status="approved"
        )
    assert exc.value.error_code == "pr_self_approve_forbidden"


@pytest.mark.asyncio
async def test_self_review_does_not_count_for_merge(async_db, env):
    """历史/旁路写入的自审记录不计数（合并仍被拒）"""
    await branch_service.protect_branch(
        env["repo"].id, "main", {"require_code_review": True}, async_db
    )
    async_db.add(PRReview(
        pull_request_id=env["pr"].id, reviewer_id=env["author"].id, status="approved",
    ))
    await async_db.commit()

    with pytest.raises(ValidationException) as exc:
        await pull_request_service.merge_pull_request(
            async_db, env["repo"].id, 1, env["dev"].id
        )
    assert exc.value.error_code == "pr_merge_requires_review"


@pytest.mark.asyncio
async def test_merge_with_non_author_approval_succeeds(async_db, env):
    await branch_service.protect_branch(
        env["repo"].id, "main", {"require_code_review": True}, async_db
    )
    await pull_request_service.create_pr_review(
        async_db, env["repo"].id, 1, env["dev"].id, status="approved"
    )

    result = await pull_request_service.merge_pull_request(
        async_db, env["repo"].id, 1, env["dev"].id
    )
    assert result["status"] == "merged"


@pytest.mark.asyncio
async def test_override_forbidden_for_non_admin(async_db, env):
    await branch_service.protect_branch(
        env["repo"].id, "main", {"require_code_review": True}, async_db
    )
    with pytest.raises(AuthorizationException) as exc:
        await pull_request_service.merge_pull_request(
            async_db, env["repo"].id, 1, env["dev"].id,
            override=True, override_reason="emergency",
        )
    assert exc.value.error_code == "pr_merge_override_forbidden"


@pytest.mark.asyncio
async def test_override_by_owner_merges_and_writes_audit(async_db, env):
    await branch_service.protect_branch(
        env["repo"].id, "main", {"require_code_review": True}, async_db
    )

    result = await pull_request_service.merge_pull_request(
        async_db, env["repo"].id, 1, env["owner"].id,
        override=True, override_reason="emergency hotfix",
    )
    assert result["status"] == "merged"

    activities = await list_activities(env["pr"].id, async_db)
    overrides = [a for a in activities if a.get("action") == "merge_override"]
    assert overrides, "override 必须写入 PR 活动流审计"
    assert "emergency hotfix" in (overrides[0].get("details") or "")


@pytest.mark.asyncio
async def test_status_checks_pass_without_ci(async_db, env):
    """默认（非严格）：无 CI 检查来源即通过"""
    await branch_service.protect_branch(
        env["repo"].id, "main", {"require_status_checks": True}, async_db
    )
    result = await pull_request_service.merge_pull_request(
        async_db, env["repo"].id, 1, env["dev"].id
    )
    assert result["status"] == "merged"


@pytest.mark.asyncio
async def test_status_checks_strict_mode_blocks(async_db, env, monkeypatch):
    """严格模式开关：零检查记录视为未通过"""
    from app.core.config import get_config

    await branch_service.protect_branch(
        env["repo"].id, "main", {"require_status_checks": True}, async_db
    )
    monkeypatch.setattr(get_config().security, "strict_status_checks", True)

    with pytest.raises(ValidationException) as exc:
        await pull_request_service.merge_pull_request(
            async_db, env["repo"].id, 1, env["dev"].id
        )
    assert exc.value.error_code == "pr_merge_status_checks_failed"
