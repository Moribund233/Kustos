"""幂等键的 HTTP 行为测试

覆盖端点级语义：重放、冲突、无键放行、跨用户隔离，以及"重放不产生第二次
副作用"这条最关键的保证——它正是离线 outbox 敢自动补发的前提。
"""
import pytest

from app.services.auth.token_service import create_access_token
from tests.test_helpers import create_test_repo


def _bearer(user):
    token = create_access_token({
        "sub": str(user.id),
        "username": user.username,
        "is_admin": user.is_admin,
    })
    return {"Authorization": f"Bearer {token}"}


def _idem(key):
    return {"Idempotency-Key": key}


class TestDiscussionIdempotency:
    """行内评论创建：最典型的"补发会重复"场景"""

    def _post(self, client, user, repo, key=None, content="一条评论"):
        headers = {**_bearer(user)}
        if key:
            headers.update(_idem(key))
        return client.post(
            f"/api/v1/repositories/{repo.id}/discussions",
            json={"content": content, "file_path": "src/a.py", "line_number": 3},
            headers=headers,
        )

    def test_same_key_returns_same_comment_without_duplicate(self, test_client, db, test_user):
        repo = create_test_repo(db, name="idem-disc-dup", owner_id=test_user.id)

        first = self._post(test_client, test_user, repo, key="disc-1")
        assert first.status_code == 201
        first_id = first.json()["id"]

        second = self._post(test_client, test_user, repo, key="disc-1")
        assert second.status_code == 201
        # 同一个评论：补发不能创建第二条
        assert second.json()["id"] == first_id
        # 响应头显式标记这是重放，便于客户端区分
        assert second.headers.get("Idempotent-Replayed") == "true"

        listing = test_client.get(
            f"/api/v1/repositories/{repo.id}/discussions",
            headers=_bearer(test_user),
        )
        assert listing.status_code == 200
        assert len(listing.json()) == 1

    def test_same_key_different_body_conflicts(self, test_client, db, test_user):
        repo = create_test_repo(db, name="idem-disc-conflict", owner_id=test_user.id)

        assert self._post(test_client, test_user, repo, key="disc-2", content="原文").status_code == 201
        conflict = self._post(test_client, test_user, repo, key="disc-2", content="换了内容")
        assert conflict.status_code == 409

        listing = test_client.get(
            f"/api/v1/repositories/{repo.id}/discussions",
            headers=_bearer(test_user),
        )
        assert len(listing.json()) == 1

    def test_without_key_creates_separate_rows(self, test_client, db, test_user):
        """未带键 → 既有行为不变，两次提交产生两条"""
        repo = create_test_repo(db, name="idem-disc-nokey", owner_id=test_user.id)

        a = self._post(test_client, test_user, repo)
        b = self._post(test_client, test_user, repo)
        assert a.status_code == 201
        assert b.status_code == 201
        assert a.json()["id"] != b.json()["id"]

    def test_different_keys_create_separate_rows(self, test_client, db, test_user):
        repo = create_test_repo(db, name="idem-disc-keys", owner_id=test_user.id)
        a = self._post(test_client, test_user, repo, key="k-a")
        b = self._post(test_client, test_user, repo, key="k-b")
        assert a.json()["id"] != b.json()["id"]

    def test_key_is_scoped_per_user(self, test_client, db, test_user):
        """不同用户复用同一个键互不影响"""
        from app.models.user import User

        other = User(
            username="idem-http-other",
            email="idem-http-other@example.com",
            password="hashed_other_password",
            is_active=True,
            is_admin=False,
        )
        db.add(other)
        db.commit()
        db.refresh(other)

        repo = create_test_repo(db, name="idem-disc-user", owner_id=test_user.id)
        from app.models.repository_member import RepositoryMember

        db.add(RepositoryMember(
            repository_id=repo.id, user_id=other.id, role="developer", is_active=True
        ))
        db.commit()

        a = self._post(test_client, test_user, repo, key="shared-key")
        b = self._post(test_client, other, repo, key="shared-key")
        assert a.status_code == 201
        assert b.status_code == 201
        assert a.json()["id"] != b.json()["id"]


class TestIssueIdempotency:
    """Issue 与 Issue 评论：离线补发的另两个高危写路径"""

    def test_issue_creation_is_idempotent(self, test_client, db, test_user):
        repo = create_test_repo(db, name="idem-issue", owner_id=test_user.id)
        headers = {**_bearer(test_user), **_idem("issue-1")}
        payload = {"title": "补发测试", "description": "内容"}

        first = test_client.post(f"/api/v1/repositories/{repo.id}/issues", json=payload, headers=headers)
        assert first.status_code == 200
        second = test_client.post(f"/api/v1/repositories/{repo.id}/issues", json=payload, headers=headers)
        assert second.status_code == 200
        assert second.json()["id"] == first.json()["id"]

        listing = test_client.get(
            f"/api/v1/repositories/{repo.id}/issues", headers=_bearer(test_user)
        )
        assert listing.status_code == 200
        body = listing.json()
        items = body["items"] if isinstance(body, dict) and "items" in body else body
        assert len(items) == 1

    def test_issue_comment_is_idempotent(self, test_client, db, test_user):
        repo = create_test_repo(db, name="idem-issue-comment", owner_id=test_user.id)
        created = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues",
            json={"title": "带评论", "description": "x"},
            headers=_bearer(test_user),
        ).json()
        number = created["issue_number"]
        headers = {**_bearer(test_user), **_idem("issue-c-1")}

        first = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues/{number}/comments",
            json={"content": "一条评论"},
            headers=headers,
        )
        assert first.status_code == 200
        second = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues/{number}/comments",
            json={"content": "一条评论"},
            headers=headers,
        )
        assert second.status_code == 200
        assert second.json()["id"] == first.json()["id"]

        comments = test_client.get(
            f"/api/v1/repositories/{repo.id}/issues/{number}/comments",
            headers=_bearer(test_user),
        )
        assert len(comments.json()) == 1


class TestIdempotencyKeyValidation:
    def test_oversized_key_rejected(self, test_client, db, test_user):
        repo = create_test_repo(db, name="idem-disc-long", owner_id=test_user.id)
        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/discussions",
            json={"content": "x", "file_path": "a.py"},
            headers={**_bearer(test_user), **_idem("k" * 300)},
        )
        assert resp.status_code == 400

    def test_blank_key_treated_as_absent(self, test_client, db, test_user):
        """空白键视为未提供，不写入记录也不重放"""
        repo = create_test_repo(db, name="idem-disc-blank", owner_id=test_user.id)
        a = test_client.post(
            f"/api/v1/repositories/{repo.id}/discussions",
            json={"content": "x", "file_path": "a.py"},
            headers={**_bearer(test_user), **_idem("   ")},
        )
        b = test_client.post(
            f"/api/v1/repositories/{repo.id}/discussions",
            json={"content": "x", "file_path": "a.py"},
            headers={**_bearer(test_user), **_idem("   ")},
        )
        assert a.status_code == 201
        assert b.status_code == 201
        assert a.json()["id"] != b.json()["id"]
