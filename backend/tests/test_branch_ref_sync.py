"""
分支真相闭环测试：branches.commit_hash + create/delete 落 git ref

覆盖：
- create_branch 物化 git 引用并记录 tip 哈希（显式 ref / 默认分支起点）；
- 空仓库无提交可依附 → 仅登记 DB 行（commit_hash=NULL，首次推送后由对账补齐）；
- 显式起点不存在 → 422 拒绝，不留 DB 孤儿；
- delete_branch 同步删除物理引用；磁盘引用缺失（漂移）时仍删除 DB 行（自愈）；
- post-receive 对账同步 tip 哈希（新建写入 / 已存在分支刷新）。
"""
import logging
import os

import pygit2
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exception import ValidationException
from app.models import Branch, Repository
from app.models.user import User
from app.services import branch_service
from app.services.repository_service import sync_repository_default_branch
from tests.test_git_hook_api import (
    SECRET,
    _headers,
    _make_bare_with_commit as hook_make_commit,
    _make_repo_row,
    _payload,
)
from app.utils.git_utils import get_local_branch_heads, get_repository_storage_path


@pytest.fixture(autouse=True)
def _hook_secret(monkeypatch):
    monkeypatch.setenv("KUSTOS_GIT_HOOK_SECRET", SECRET)


def _make_bare_with_commit(repository: Repository, branch: str = "main", message: str = "first") -> str:
    """在裸仓中创建/推进分支与一个提交，返回 commit hash。"""
    path = get_repository_storage_path(repository.path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        bare = pygit2.Repository(path)
    else:
        bare = pygit2.init_repository(path, bare=True)
    blob = bare.create_blob("hello kustos\n")
    builder = bare.TreeBuilder()
    builder.insert("README.md", blob, pygit2.GIT_FILEMODE_BLOB)
    tree = builder.write()
    sig = pygit2.Signature("Branch Tester", "branch@example.com")
    parents = []
    try:
        parents = [bare.branches.local[branch].target]
    except KeyError:
        pass
    commit_id = bare.create_commit(
        f"refs/heads/{branch}", sig, sig, message, tree, parents
    )
    return str(commit_id)


def _init_empty_bare(repository: Repository) -> None:
    path = get_repository_storage_path(repository.path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pygit2.init_repository(path, bare=True)


def _heads(repository: Repository) -> dict:
    return get_local_branch_heads(get_repository_storage_path(repository.path))


@pytest_asyncio.fixture
async def branch_user(async_db: AsyncSession):
    user = User(
        username="branchrefuser",
        email="branchref@example.com",
        password="hashed_password_string",
        full_name="Branch Ref User",
        is_active=True,
        is_admin=False,
    )
    async_db.add(user)
    await async_db.commit()
    await async_db.refresh(user)
    return user


@pytest_asyncio.fixture
async def ref_repo(async_db: AsyncSession, branch_user):
    repo = Repository(
        name="branch-ref-repo",
        path="branchrefuser/branch-ref-repo",
        description="branch ref sync test repo",
        is_public=True,
        owner_id=branch_user.id,
        default_branch="main",
    )
    async_db.add(repo)
    await async_db.commit()
    await async_db.refresh(repo)
    return repo


# ============================== create_branch ==============================


@pytest.mark.asyncio
async def test_create_branch_writes_git_ref_and_tip(async_db, ref_repo):
    """显式 ref 起点：磁盘建 ref 且 DB 记录 tip 哈希"""
    tip = _make_bare_with_commit(ref_repo)

    created = await branch_service.create_branch(
        ref_repo.id, {"name": "feature/x", "ref": "main"}, async_db
    )

    assert created.commit_hash == tip
    assert _heads(ref_repo).get("feature/x") == tip


@pytest.mark.asyncio
async def test_create_branch_defaults_to_default_branch(async_db, ref_repo):
    """未给 ref：从默认分支 tip 建分支"""
    tip = _make_bare_with_commit(ref_repo)

    created = await branch_service.create_branch(
        ref_repo.id, {"name": "from-default"}, async_db
    )

    assert created.commit_hash == tip
    assert _heads(ref_repo).get("from-default") == tip


@pytest.mark.asyncio
async def test_create_branch_empty_repo_registers_only(async_db, ref_repo):
    """空仓库无提交可依附：仅登记 DB 行，commit_hash 为空"""
    _init_empty_bare(ref_repo)

    created = await branch_service.create_branch(
        ref_repo.id, {"name": "pending"}, async_db
    )

    assert created.commit_hash is None
    assert _heads(ref_repo) == {}


@pytest.mark.asyncio
async def test_create_branch_bad_explicit_ref_rejected(async_db, ref_repo):
    """显式起点不存在：拒绝且不留 DB 孤儿"""
    _make_bare_with_commit(ref_repo)

    with pytest.raises(ValidationException):
        await branch_service.create_branch(
            ref_repo.id, {"name": "bad-src", "ref": "no-such-ref"}, async_db
        )

    row = (
        await async_db.execute(
            select(Branch).where(
                Branch.repository_id == ref_repo.id, Branch.name == "bad-src"
            )
        )
    ).scalar_one_or_none()
    assert row is None
    assert "bad-src" not in _heads(ref_repo)


@pytest.mark.asyncio
async def test_update_branch_cannot_spoof_commit_hash(async_db, ref_repo):
    """API 更新分支不得改写身份/真相字段（commit_hash 只能来自磁盘）"""
    tip = _make_bare_with_commit(ref_repo)
    await branch_service.create_branch(ref_repo.id, {"name": "guarded", "ref": "main"}, async_db)

    updated = await branch_service.update_branch(
        ref_repo.id, "guarded",
        {"commit_hash": "f" * 40, "is_protected": True},
        async_db,
    )

    assert updated.commit_hash == tip
    assert updated.is_protected is True


# ============================== delete_branch ==============================
@pytest.mark.asyncio
async def test_delete_branch_removes_git_ref(async_db, ref_repo):
    """删除分支同步删除磁盘引用"""
    _make_bare_with_commit(ref_repo)
    await branch_service.create_branch(
        ref_repo.id, {"name": "doomed", "ref": "main"}, async_db
    )
    assert "doomed" in _heads(ref_repo)

    await branch_service.delete_branch(ref_repo.id, "doomed", async_db)

    assert "doomed" not in _heads(ref_repo)
    row = (
        await async_db.execute(
            select(Branch).where(
                Branch.repository_id == ref_repo.id, Branch.name == "doomed"
            )
        )
    ).scalar_one_or_none()
    assert row is None


@pytest.mark.asyncio
async def test_delete_branch_with_missing_ref_still_deletes_row(async_db, ref_repo):
    """磁盘引用缺失（历史漂移）：仍删除 DB 行（自愈）"""
    _make_bare_with_commit(ref_repo)
    await branch_service.create_branch(
        ref_repo.id, {"name": "ghost", "ref": "main"}, async_db
    )
    path = get_repository_storage_path(ref_repo.path)
    pygit2.Repository(path).references.delete("refs/heads/ghost")

    await branch_service.delete_branch(ref_repo.id, "ghost", async_db)

    row = (
        await async_db.execute(
            select(Branch).where(
                Branch.repository_id == ref_repo.id, Branch.name == "ghost"
            )
        )
    ).scalar_one_or_none()
    assert row is None


# ==================== post-receive 对账同步 tip ====================


def test_post_receive_syncs_branch_commit_hash(test_client, db, test_user):
    """对账：新建分支写 tip、已存在分支刷新 tip"""
    repository = _make_repo_row(db, test_user, name="tip-sync-user", repo="tip-sync-repo")
    tip = hook_make_commit(repository, branch="main")

    resp = test_client.post(
        "/api/v1/git-internal/post-receive",
        json=_payload(repository.path, "refs/heads/main", "0" * 40, tip),
        headers=_headers(SECRET),
    )
    assert resp.status_code == 200

    # 断言前结束 fixture 事务以获取跨连接新快照
    db.commit()
    row = (
        db.execute(
            select(Branch).where(
                Branch.repository_id == repository.id, Branch.name == "main"
            )
        )
    ).scalar_one()
    assert row.commit_hash == tip

    # 推进到新 tip 后再次对账 → 刷新 commit_hash
    tip2 = hook_make_commit(repository, branch="main", message="second")
    resp = test_client.post(
        "/api/v1/git-internal/post-receive",
        json=_payload(repository.path, "refs/heads/main", tip, tip2),
        headers=_headers(SECRET),
    )
    assert resp.status_code == 200

    db.commit()
    row = (
        db.execute(
            select(Branch).where(
                Branch.repository_id == repository.id, Branch.name == "main"
            )
        )
    ).scalar_one()
    assert row.commit_hash == tip2


# ==================== 默认分支自愈（DB 与物理不一致时的迁移） ====================


@pytest.mark.asyncio
async def test_default_branch_adopts_physical_branch(async_db, caplog):
    """DB 默认分支物理不存在：迁移到物理分支，补建 Branch 行且不产生自愈失败告警"""
    user = User(
        username="adoptuser",
        email="adopt@example.com",
        password="hashed_password_string",
        full_name="Adopt User",
        is_active=True,
        is_admin=False,
    )
    async_db.add(user)
    await async_db.commit()
    await async_db.refresh(user)

    repo = Repository(
        name="adopt-repo",
        path="adoptuser/adopt-repo",
        description="default branch adoption test",
        is_public=True,
        owner_id=user.id,
        default_branch="main",
    )
    async_db.add(repo)
    await async_db.commit()
    await async_db.refresh(repo)

    # 物理仓只有 master：模拟用户以非 DB 默认分支首推
    tip = _make_bare_with_commit(repo, branch="master")

    with caplog.at_level(logging.INFO, logger="app.services.repository_service"):
        await sync_repository_default_branch(repo, async_db)
    await async_db.commit()

    assert repo.default_branch == "master"
    # 迁移日志引用未定义变量会被 try 吞成「自愈失败」告警、真 INFO 永远丢失
    assert not any(
        "Failed to sync default branch" in r.getMessage() for r in caplog.records
    )
    assert "default branch migrated" in caplog.text
    assert "'main' -> 'master'" in caplog.text

    rows = (
        await async_db.execute(select(Branch).where(Branch.repository_id == repo.id))
    ).scalars().all()
    assert {b.name for b in rows} == {"master"}
    default_rows = [b for b in rows if b.is_default]
    assert len(default_rows) == 1 and default_rows[0].name == "master"
    assert rows[0].commit_hash == tip


@pytest.mark.asyncio
async def test_default_branch_consistent_still_syncs_rows(async_db, caplog):
    """DB 默认分支物理存在：仅同步 Branch 行，不做迁移"""
    user = User(
        username="consistentuser",
        email="consistent@example.com",
        password="hashed_password_string",
        full_name="Consistent User",
        is_active=True,
        is_admin=False,
    )
    async_db.add(user)
    await async_db.commit()
    await async_db.refresh(user)

    repo = Repository(
        name="consistent-repo",
        path="consistentuser/consistent-repo",
        description="default branch consistency test",
        is_public=True,
        owner_id=user.id,
        default_branch="main",
    )
    async_db.add(repo)
    await async_db.commit()
    await async_db.refresh(repo)

    tip = _make_bare_with_commit(repo, branch="main")

    with caplog.at_level(logging.INFO, logger="app.services.repository_service"):
        await sync_repository_default_branch(repo, async_db)
    await async_db.commit()

    assert repo.default_branch == "main"
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    rows = (
        await async_db.execute(select(Branch).where(Branch.repository_id == repo.id))
    ).scalars().all()
    assert {b.name for b in rows} == {"main"}
    assert rows[0].is_default and rows[0].commit_hash == tip
