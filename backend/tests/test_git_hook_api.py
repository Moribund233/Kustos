"""
Git hook 内部回调 API 测试（push 事件接入）

覆盖：
- 密钥鉴权三态：未配置（503）/ 错误（403）/ 正确（进入业务）；
- pre-receive 保护分支裁决：禁删、禁强推、快进放行、无保护放行、未知仓库 404；
- post-receive：分支全量对账（含自愈幽灵分支）、提交入库与幂等、
  push / tag_push webhook 触发（激活 utils/webhook_trigger 既有死代码）。
"""
import os
from unittest.mock import AsyncMock, patch

import pygit2
import pytest
from sqlalchemy import select

from app.models import Branch, Commit, Repository
from app.utils.git_utils import get_repository_storage_path

SECRET = "test-git-hook-secret"
ZERO = "0" * 40
OLD_SHA = "a" * 40
NEW_SHA = "b" * 40


@pytest.fixture(autouse=True)
def _hook_secret(monkeypatch):
    monkeypatch.setenv("KUSTOS_GIT_HOOK_SECRET", SECRET)


def _headers(secret: str = SECRET) -> dict:
    return {"X-Git-Hook-Secret": secret}


def _payload(repo_path: str, ref: str, old: str, new: str, is_force: bool = False) -> dict:
    return {
        "repo_path": repo_path,
        "updates": [{"ref": ref, "old": old, "new": new, "is_force": is_force}],
    }


def _make_repo_row(db, test_user, name: str = "hook-user", repo: str = "hook-repo") -> Repository:
    repository = Repository(
        name=repo,
        path=f"{name}/{repo}",
        description="git hook test repo",
        is_public=True,
        owner_id=test_user.id,
        default_branch="main",
    )
    db.add(repository)
    db.commit()
    db.refresh(repository)
    return repository


def _make_bare_with_commit(repository: Repository, branch: str = "main", message: str = "first") -> str:
    """在裸仓中创建分支与一个提交，返回 commit hash。"""
    path = get_repository_storage_path(repository.path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bare = pygit2.init_repository(path, bare=True)
    blob = bare.create_blob("hello kustos\n")
    builder = bare.TreeBuilder()
    builder.insert("README.md", blob, pygit2.GIT_FILEMODE_BLOB)
    tree = builder.write()
    sig = pygit2.Signature("Hook Tester", "hook@example.com")
    parents = []
    try:
        parents = [bare.branches.local[branch].target]
    except KeyError:
        pass
    commit_id = bare.create_commit(
        f"refs/heads/{branch}", sig, sig, message, tree, parents
    )
    return str(commit_id)


# ============================== 鉴权 ==============================

def test_missing_secret_env_returns_503(test_client, monkeypatch):
    monkeypatch.delenv("KUSTOS_GIT_HOOK_SECRET", raising=False)
    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload("u/r", "refs/heads/main", OLD_SHA, NEW_SHA),
        headers=_headers(),
    )
    assert resp.status_code == 503


def test_wrong_secret_returns_403(test_client):
    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload("u/r", "refs/heads/main", OLD_SHA, NEW_SHA),
        headers=_headers(secret="wrong-secret"),
    )
    assert resp.status_code == 403


def test_missing_header_returns_403(test_client):
    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload("u/r", "refs/heads/main", OLD_SHA, NEW_SHA),
    )
    assert resp.status_code == 403


# ============================== pre-receive ==============================

def test_pre_receive_protected_delete_rejected(test_client, db, test_user):
    repository = _make_repo_row(db, test_user)
    db.add(Branch(repository_id=repository.id, name="main", is_protected=True))
    db.commit()

    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload(repository.path, "refs/heads/main", OLD_SHA, ZERO),
        headers=_headers(),
    )
    assert resp.status_code == 403
    assert "cannot be deleted" in resp.json()["detail"]


def test_pre_receive_protected_force_rejected(test_client, db, test_user):
    repository = _make_repo_row(db, test_user, repo="force-repo")
    db.add(Branch(repository_id=repository.id, name="main", is_protected=True))
    db.commit()

    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload(repository.path, "refs/heads/main", OLD_SHA, NEW_SHA, is_force=True),
        headers=_headers(),
    )
    assert resp.status_code == 403
    assert "force push" in resp.json()["detail"]


def test_pre_receive_protected_fastforward_allowed(test_client, db, test_user):
    repository = _make_repo_row(db, test_user, repo="ff-repo")
    db.add(Branch(repository_id=repository.id, name="main", is_protected=True))
    db.commit()

    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload(repository.path, "refs/heads/main", OLD_SHA, NEW_SHA, is_force=False),
        headers=_headers(),
    )
    assert resp.status_code == 200


def test_pre_receive_review_required_direct_push_rejected(test_client, db, test_user):
    """require_code_review 分支禁止一切客户端直推（必须走 PR）"""
    repository = _make_repo_row(db, test_user, repo="review-required-repo")
    db.add(Branch(
        repository_id=repository.id, name="main", is_protected=True,
        require_code_review=True,
    ))
    db.commit()

    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload(repository.path, "refs/heads/main", OLD_SHA, NEW_SHA, is_force=False),
        headers=_headers(),
    )
    assert resp.status_code == 403
    assert "pull request" in resp.json()["detail"]


def test_pre_receive_status_check_required_direct_push_rejected(test_client, db, test_user):
    """require_status_checks 分支同样禁止直推"""
    repository = _make_repo_row(db, test_user, repo="status-required-repo")
    db.add(Branch(
        repository_id=repository.id, name="main", is_protected=True,
        require_status_checks=True,
    ))
    db.commit()

    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload(repository.path, "refs/heads/main", OLD_SHA, NEW_SHA, is_force=False),
        headers=_headers(),
    )
    assert resp.status_code == 403
    assert "pull request" in resp.json()["detail"]


def test_pre_receive_review_required_new_branch_allowed(test_client, db, test_user):
    """同名保护配置下新建 ref（old=0）不受禁直推限制"""
    repository = _make_repo_row(db, test_user, repo="review-new-ref-repo")
    db.add(Branch(
        repository_id=repository.id, name="release", is_protected=True,
        require_code_review=True,
    ))
    db.commit()

    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload(repository.path, "refs/heads/release", ZERO, NEW_SHA),
        headers=_headers(),
    )
    assert resp.status_code == 200


def test_pre_receive_unprotected_or_new_branch_allowed(test_client, db, test_user):
    repository = _make_repo_row(db, test_user, repo="open-repo")
    # 未保护分支 + DB 无记录的新分支（服务端 NotFound → 放行）
    db.add(Branch(repository_id=repository.id, name="develop", is_protected=False))
    db.commit()

    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload(repository.path, "refs/heads/develop", OLD_SHA, NEW_SHA, is_force=True),
        headers=_headers(),
    )
    assert resp.status_code == 200

    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload(repository.path, "refs/heads/brand-new", ZERO, NEW_SHA),
        headers=_headers(),
    )
    assert resp.status_code == 200


def test_pre_receive_tag_only_allowed(test_client, db, test_user):
    """纯 tag 更新不参与保护裁决（hook 实际不会发送，此处验证端点语义）。"""
    repository = _make_repo_row(db, test_user, repo="tag-repo")
    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload(repository.path, "refs/tags/v1.0.0", ZERO, NEW_SHA),
        headers=_headers(),
    )
    assert resp.status_code == 200


def test_pre_receive_unknown_repo_404(test_client):
    resp = test_client.post(
        "/api/v1/git-internal/pre-receive",
        json=_payload("nobody/no-repo", "refs/heads/main", OLD_SHA, NEW_SHA),
        headers=_headers(),
    )
    assert resp.status_code == 404


# ============================== post-receive ==============================

def test_post_receive_reconciles_branches_commits_and_fires_webhook(
    test_client, db, test_user
):
    repository = _make_repo_row(db, test_user, repo="sync-repo")
    sha = _make_bare_with_commit(repository, branch="main")

    # 幽灵分支：DB 有、磁盘无 → 对账应删除（含其提交行的 FK 前置清理）
    db.add(Branch(repository_id=repository.id, name="ghost"))
    db.commit()

    with patch(
        "app.services.integration.webhook_trigger.webhook_service.trigger_webhooks",
        new_callable=AsyncMock,
    ) as mock_trigger:
        resp = test_client.post(
            "/api/v1/git-internal/post-receive",
            json=_payload(repository.path, "refs/heads/main", ZERO, sha),
            headers=_headers(),
        )

    assert resp.status_code == 200
    stats = resp.json()
    assert stats["ok"] is True
    assert stats["branches_upserted"] == 1
    assert stats["branches_removed"] == 1
    assert stats["commits_added"] == 1
    assert stats["webhook_events"] == 1

    # 断言前结束 fixture 事务以获取新快照（跨连接可见性）
    db.commit()
    branches = {
        b.name
        for b in db.execute(
            select(Branch).where(Branch.repository_id == repository.id)
        ).scalars()
    }
    assert branches == {"main"}

    commit_row = db.execute(
        select(Commit).where(Commit.hash == sha)
    ).scalar_one()
    assert commit_row.repository_id == repository.id
    assert commit_row.commit_message == "first"

    # push webhook 已触发（激活 trigger_push_event 生产调用）
    mock_trigger.assert_awaited()
    call = mock_trigger.call_args
    assert call.args[1] == repository.id
    assert call.args[2] == "push"


def test_post_receive_commit_sync_is_idempotent(test_client, db, test_user):
    repository = _make_repo_row(db, test_user, repo="idem-repo")
    sha = _make_bare_with_commit(repository, branch="main")

    with patch(
        "app.services.integration.webhook_trigger.webhook_service.trigger_webhooks",
        new_callable=AsyncMock,
    ):
        first = test_client.post(
            "/api/v1/git-internal/post-receive",
            json=_payload(repository.path, "refs/heads/main", ZERO, sha),
            headers=_headers(),
        ).json()
        second = test_client.post(
            "/api/v1/git-internal/post-receive",
            json=_payload(repository.path, "refs/heads/main", OLD_SHA, sha),
            headers=_headers(),
        ).json()

    assert first["commits_added"] == 1
    assert second["commits_added"] == 0
    assert second["commits_skipped"] >= 1


def test_post_receive_tag_push_fires_tag_webhook(test_client, db, test_user):
    repository = _make_repo_row(db, test_user, repo="tagpush-repo")
    sha = _make_bare_with_commit(repository, branch="main")
    path = get_repository_storage_path(repository.path)
    bare = pygit2.Repository(path)
    bare.create_reference("refs/tags/v1.0.0", bare.revparse_single(sha).id)

    with patch(
        "app.services.integration.webhook_trigger.webhook_service.trigger_webhooks",
        new_callable=AsyncMock,
    ) as mock_trigger:
        resp = test_client.post(
            "/api/v1/git-internal/post-receive",
            json=_payload(repository.path, "refs/tags/v1.0.0", ZERO, sha),
            headers=_headers(),
        )

    assert resp.status_code == 200
    assert resp.json()["webhook_events"] == 1
    mock_trigger.assert_awaited()
    assert mock_trigger.call_args.args[2] == "tag_push"


# ===================== 分支对账并发窗口（快照→删除） =====================


def test_reconcile_adopts_ref_created_after_snapshot(test_client, db, test_user):
    """删前复核：快照之后建出的引用不能删——否则行连带丢保护位。"""
    repository = _make_repo_row(db, test_user, repo="toc-adopt")
    sha_main = _make_bare_with_commit(repository, branch="main")
    sha_late = _make_bare_with_commit(repository, branch="late")

    db.add(Branch(
        repository_id=repository.id, name="late",
        commit_hash=sha_late, is_protected=True,
    ))
    db.commit()

    from app.services.integration import git_event_service
    real_list = git_event_service._list_local_branches
    calls = []

    def _stale_first_then_real(repo_fs: str):
        # 首次调用 = 磁盘快照：扣掉 late 模拟「快照落在并发建支之前」
        branches = real_list(repo_fs)
        calls.append(repo_fs)
        if len(calls) == 1:
            branches.pop("late", None)
        return branches

    with patch(
        "app.services.integration.webhook_trigger.webhook_service.trigger_webhooks",
        new_callable=AsyncMock,
    ), patch(
        "app.services.integration.git_event_service._list_local_branches",
        side_effect=_stale_first_then_real,
    ):
        resp = test_client.post(
            "/api/v1/git-internal/post-receive",
            json=_payload(repository.path, "refs/heads/main", ZERO, sha_main),
            headers=_headers(),
        )

    assert resp.status_code == 200
    stats = resp.json()
    assert stats["branches_removed"] == 0, "快照后建出的引用被误删（丢保护位）"

    # 断言前结束 fixture 事务以获取新快照（跨连接可见性）
    db.commit()
    rows = {
        b.name: b
        for b in db.execute(
            select(Branch).where(Branch.repository_id == repository.id)
        ).scalars()
    }
    assert "late" in rows, "并发建支行被删除"
    assert rows["late"].is_protected is True
    assert rows["late"].commit_hash == sha_late, "收养时未同步 tip"


def test_reconcile_defers_rows_written_after_snapshot(test_client, db, test_user):
    """快照之后才落库的行本轮不删（时间戳回落后下轮正常清理）。"""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import update as sa_update

    repository = _make_repo_row(db, test_user, repo="toc-defer")
    sha = _make_bare_with_commit(repository, branch="main")

    future = datetime.now(timezone.utc) + timedelta(hours=1)
    db.add(Branch(
        repository_id=repository.id, name="fresh", is_protected=True,
        created_at=future, updated_at=future,
    ))
    db.commit()

    def _post():
        return test_client.post(
            "/api/v1/git-internal/post-receive",
            json=_payload(repository.path, "refs/heads/main", ZERO, sha),
            headers=_headers(),
        )

    with patch(
        "app.services.integration.webhook_trigger.webhook_service.trigger_webhooks",
        new_callable=AsyncMock,
    ):
        resp = _post()

    assert resp.status_code == 200
    assert resp.json()["branches_removed"] == 0, "快照后新建的行被误删"

    db.commit()
    row = db.execute(
        select(Branch).where(
            Branch.repository_id == repository.id, Branch.name == "fresh"
        )
    ).scalar_one_or_none()
    assert row is not None and row.is_protected is True

    # 时间戳回到过去（引用仍不在磁盘）→ 下轮对账正常删除（自愈）
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    db.execute(sa_update(Branch).where(Branch.id == row.id)
               .values(created_at=past, updated_at=past))
    db.commit()

    with patch(
        "app.services.integration.webhook_trigger.webhook_service.trigger_webhooks",
        new_callable=AsyncMock,
    ):
        resp2 = _post()

    assert resp2.status_code == 200
    assert resp2.json()["branches_removed"] == 1
