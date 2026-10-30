"""探针：本地写/读入口的权限与保护裁决现状（先证后修）。

验证四项怀疑：
1. 匿名/非成员读私仓内容（browser 读端点无认证 + 无 REPO_READ 裁决）
2. 非成员写私仓文件（browser 写端点仅认证，无 REPO_WRITE 裁决）
3. 非成员删/取消保护分支（branch 写端点无裁决）
4. 本地写绕过保护分支「禁直推」裁决（核心机制）

全部通过 HTTP 端点探测（避免同步测试里跑 async service 的事件循环问题）。
"""
import uuid as uuid_mod

from fastapi.testclient import TestClient

from app.services.auth.token_service import create_access_token
from tests.test_repo_browser_controller import create_repo_with_content, create_commit_in_repo


def _headers(user) -> dict:
    token = create_access_token({
        "sub": str(user.id),
        "username": user.username,
        "is_admin": user.is_admin,
    })
    return {"Authorization": f"Bearer {token}"}


def _make_user(db, prefix: str):
    from app.models.user import User
    u = User(
        username=f"{prefix}_{uuid_mod.uuid4().hex[:8]}",
        email=f"{prefix}_{uuid_mod.uuid4().hex[:8]}@example.com",
        password="x",
        is_active=True,
        is_admin=False,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _victim_private_repo(db):
    repo, physical_path = create_repo_with_content(db, "probe-private")
    repo.is_public = False
    db.commit()
    db.refresh(repo)
    create_commit_in_repo(physical_path, "secret.txt", b"top secret")
    _ensure_branch_row(db, repo, "master")
    # 前置自检：读侧探针只有在「确实私仓」时才有效
    from sqlalchemy import select
    from app.models.repository import Repository
    fresh = (
        db.execute(select(Repository).filter(Repository.id == repo.id))
    ).scalar_one()
    assert fresh.is_public is False, "夹具未生效：仓库仍为公开，读探针无意义"
    return repo, physical_path


def _ensure_branch_row(db, repo, name: str, **flags):
    """browser 测试夹具不建 Branch 行；探测需要 DB 分支记录（保护/删除语义前提）"""
    from app.models.branch import Branch
    from sqlalchemy import select
    row = (
        db.execute(select(Branch).filter(
            Branch.repository_id == repo.id, Branch.name == name
        ))
    ).scalar_one_or_none()
    if row is None:
        row = Branch(repository_id=repo.id, name=name, **flags)
        db.add(row)
    else:
        for k, v in flags.items():
            setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


class TestProbeReadLeak:
    def test_anonymous_blob_private_repo(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        r = test_client.get(
            f"/api/v1/repositories/{repo.id}/blob",
            params={"path": "secret.txt", "ref": "master"},
        )
        assert r.status_code in (401, 403), (
            f"私仓内容匿名可读: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_blob_private_repo(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_attacker")
        r = test_client.get(
            f"/api/v1/repositories/{repo.id}/blob",
            params={"path": "secret.txt", "ref": "master"},
            headers=_headers(attacker),
        )
        assert r.status_code in (401, 403), (
            f"非成员可读私仓: {r.status_code} {r.text[:200]}"
        )

    def test_anonymous_tree_private_repo(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        r = test_client.get(
            f"/api/v1/repositories/{repo.id}/tree",
            params={"ref": "master"},
        )
        assert r.status_code in (401, 403), (
            f"私仓文件树匿名可读: {r.status_code} {r.text[:200]}"
        )

    def test_anonymous_issue_list_private_repo(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        r = test_client.get(f"/api/v1/repositories/{repo.id}/issues")
        assert r.status_code in (401, 403), (
            f"私仓 issue 列表匿名可读: {r.status_code} {r.text[:200]}"
        )

    def test_anonymous_pr_list_private_repo(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        r = test_client.get(f"/api/v1/repositories/{repo.id}/pull-requests")
        assert r.status_code in (401, 403), (
            f"私仓 PR 列表匿名可读: {r.status_code} {r.text[:200]}"
        )

    def test_anonymous_branch_list_private_repo(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        r = test_client.get(f"/api/v1/repositories/{repo.id}/branches")
        assert r.status_code in (401, 403), (
            f"私仓分支列表匿名可读: {r.status_code} {r.text[:200]}"
        )

    def test_anonymous_commit_history_private_repo(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        r = test_client.get(f"/api/v1/repositories/{repo.id}/commits/history")
        assert r.status_code in (401, 403), (
            f"私仓提交历史匿名可读: {r.status_code} {r.text[:200]}"
        )


class TestProbeWriteBypass:
    def test_outsider_put_contents(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_writer")
        r = test_client.put(
            f"/api/v1/repositories/{repo.id}/contents/pwned.txt",
            json={"content": "pwned", "branch": "master"},
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员写入私仓: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_move_contents(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_mover")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/contents/move",
            json={"from_path": "secret.txt", "to_path": "leaked.txt", "branch": "master"},
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员移动私仓文件: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_delete_branch(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        owner_headers = _headers(repo_owner(db, repo))
        # owner 先建分支（探测前置条件）
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/branches",
            json={"name": "probe-branch"},
            headers=owner_headers,
        )
        assert r.status_code in (200, 201), f"建分支失败: {r.status_code} {r.text[:200]}"

        attacker = _make_user(db, "probe_deleter")
        r = test_client.delete(
            f"/api/v1/repositories/{repo.id}/branches/probe-branch",
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员删除仓库分支: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_unprotect_branch(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        owner_headers = _headers(repo_owner(db, repo))
        r = test_client.put(
            f"/api/v1/repositories/{repo.id}/branches/master/protect",
            json={"require_code_review": True, "require_status_checks": True},
            headers=owner_headers,
        )
        assert r.status_code in (200, 404), f"保护分支失败: {r.status_code} {r.text[:200]}"

        attacker = _make_user(db, "probe_unprotector")
        r = test_client.put(
            f"/api/v1/repositories/{repo.id}/branches/master/unprotect",
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员取消分支保护: {r.status_code} {r.text[:200]}"
        )


def repo_owner(db, repo):
    from app.models.user import User
    from sqlalchemy import select
    return (
        db.execute(select(User).filter(User.id == repo.owner_id))
    ).scalar_one()


class TestProbeLocalWriteProtection:
    """本地写保护裁决本体：受保护（require_code_review/status_checks）分支上的
    本地 pygit2 写应被拒——与 pre-receive「禁直推」同一裁决。"""

    def test_editor_write_to_protected_branch(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        owner_headers = _headers(repo_owner(db, repo))

        # owner 保护 master（要求 review + status checks）
        r = test_client.put(
            f"/api/v1/repositories/{repo.id}/branches/master/protect",
            json={"require_code_review": True, "require_status_checks": True},
            headers=owner_headers,
        )
        assert r.status_code in (200, 404), f"保护分支失败: {r.status_code} {r.text[:200]}"

        # owner 自己（有写权限）经 web editor 直写保护分支 → 应被保护裁决拒绝
        r = test_client.put(
            f"/api/v1/repositories/{repo.id}/contents/hacked.txt",
            json={"content": "bypass", "branch": "master"},
            headers=owner_headers,
        )
        assert r.status_code in (403, 409), (
            f"本地写绕过保护分支直推禁令: {r.status_code} {r.text[:200]}"
        )

    def test_owner_delete_protected_branch_forbidden(self, test_client: TestClient, db):
        """owner 删受保护分支 → 403 branch_delete_protected_forbidden
        （API 删保护分支接线）"""
        repo, _ = _victim_private_repo(db)
        owner_headers = _headers(repo_owner(db, repo))
        _ensure_branch_row(db, repo, "master", is_protected=True, is_default=False)

        r = test_client.delete(
            f"/api/v1/repositories/{repo.id}/branches/master",
            headers=owner_headers,
        )
        assert r.status_code == 403
        assert r.json()["error"]["error_code"] == "branch_delete_protected_forbidden"


class TestProbeOtherWriteDomains:
    """扫描发现的同类怀疑（controller+service 双层无校验的写端点）——
    非成员对私仓的越权写。证实则并入，否则记录后开新批。"""

    def test_outsider_create_issue(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_issue")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues",
            json={"title": "outsider issue"},
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员在私仓建 issue: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_create_pr(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_pr")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/pull-requests",
            json={"title": "outsider pr", "source_branch": "a", "target_branch": "master"},
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员在私仓开 PR: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_create_tag(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_tag")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/tags",
            json={"name": "v9.9.9", "commit_hash": "a" * 40},
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员在私仓建 tag: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_create_release(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_release")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/releases",
            json={"tag_name": "v9.9.8", "name": "x"},
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员在私仓建 release: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_create_commit_via_api(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_commit")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/commits",
            json={
                "hash": "b" * 40,
                "repository_id": str(repo.id),
                "branch_id": "00000000-0000-0000-0000-000000000001",
                "author_name": "x", "author_email": "x@x",
                "commit_message": "x",
            },
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员在私仓登记 commit: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_create_label(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_label")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/labels",
            json={"name": "pwned", "color": "ff0000"},
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员在私仓建 label: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_create_webhook(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_webhook")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/webhooks",
            json={"url": "http://example.com/hook", "events": ["push"]},
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员在私仓建 webhook: {r.status_code} {r.text[:200]}"
        )

    def test_outsider_add_member(self, test_client: TestClient, db):
        repo, _ = _victim_private_repo(db)
        attacker = _make_user(db, "probe_member")
        victim = _make_user(db, "probe_victim")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/members",
            json={"user_id": str(victim.id), "role": "developer"},
            headers=_headers(attacker),
        )
        assert r.status_code == 403, (
            f"非成员往私仓加成员: {r.status_code} {r.text[:200]}"
        )
