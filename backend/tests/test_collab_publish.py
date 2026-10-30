"""协作草稿发布：POST /{repo_id}/collab/publish

把草稿分支 `collab/draft-{branch}` 上的 N 个保存提交 squash 成工作分支上的
一次发布提交，消除"每保存一次一个提交"对正式历史的洪泛。

契约:
  - 草稿侧全部变更 (含新增/删除) 压成目标分支顶端的一次提交;
  - 目标分支在分叉后被并行改过的路径与草稿冲突 → 整体拒绝 (400), 两边不动;
  - 发布成功后草稿分支重置到发布提交; 无待发布变更时 commit_id 为 None;
  - 发布落正式分支 → 需要仓库写权限, 受保护分支禁直推同样生效。
"""
import pytest
import pygit2
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.exception import NotFoundException, ValidationException
from app.models.branch import Branch
from app.models.repository_member import RepositoryMember
from app.services.auth.token_service import create_access_token
from app.services.collaboration.doc_key import draft_branch_name
from app.utils.git_utils import commit_file_changes, init_bare_repo, publish_draft_changes
from tests.test_helpers import create_test_repo
from tests.test_repo_browser_controller import create_commit_in_repo, create_repo_with_content


def _auth_headers(user) -> dict:
    token = create_access_token({
        "sub": str(user.id),
        "username": user.username,
        "is_admin": user.is_admin,
    })
    return {"Authorization": f"Bearer {token}"}


def _head(path: str, ref: str) -> str:
    repo = pygit2.Repository(path)
    return str(repo.revparse_single(ref).peel(pygit2.Commit).id)


def _walk_count(path: str, ref: str) -> int:
    repo = pygit2.Repository(path)
    return sum(1 for _ in repo.walk(repo.revparse_single(ref).peel(pygit2.Commit).id))


def _file_at(path: str, ref: str, filename: str) -> str:
    repo = pygit2.Repository(path)
    commit = repo.revparse_single(ref).peel(pygit2.Commit)
    return repo[commit.tree[filename].id].data.decode()


# ==================== git_utils 层 (真实 bare 仓库) ====================


class TestPublishDraftChanges:
    """publish_draft_changes: squash 语义 / 冲突裁决 / 草稿重置"""

    def _seed(self, path: str) -> None:
        init_bare_repo(path)
        commit_file_changes(path, "master", "a.txt", "base a", "seed", "seed@example.com", "init")
        commit_file_changes(path, "master", "b.txt", "base b", "seed", "seed@example.com", "init b")

    def test_publish_squashes_draft_into_single_commit(self, tmp_path):
        """草稿的多次保存 → 目标分支只多一次提交, 内容取草稿, 草稿重置"""
        path = str(tmp_path / "repo.git")
        self._seed(path)
        draft = draft_branch_name("master")
        commit_file_changes(path, draft, "a.txt", "draft a v2", "u", "u@example.com", "save 1")
        commit_file_changes(path, draft, "docs/new.txt", "new file", "u", "u@example.com", "save 2")

        result = publish_draft_changes(path, "master", draft, "pub", "pub@example.com", "publish")
        assert result["commit_id"]
        assert result["branch"] == "master"
        assert result["paths"] == ["a.txt", "docs/new.txt"]

        # master 只多了 1 次提交 (init + init b + publish)
        assert _walk_count(path, "master") == 3
        assert _file_at(path, "master", "a.txt") == "draft a v2"
        assert _file_at(path, "master", "docs/new.txt") == "new file"
        assert _file_at(path, "master", "b.txt") == "base b"
        # 草稿分支重置到发布提交, 下一会话从已发布状态开始
        assert _head(path, draft) == _head(path, "master")

    def test_publish_keeps_parallel_unrelated_changes(self, tmp_path):
        """他人在目标分支改了别的文件 → 不冲突, 两边都保留"""
        path = str(tmp_path / "repo.git")
        self._seed(path)
        draft = draft_branch_name("master")
        commit_file_changes(path, draft, "a.txt", "draft a", "u", "u@example.com", "save")
        # 分叉后 master 上的并行提交 (改的是另一个文件)
        commit_file_changes(path, "master", "c.txt", "parallel c", "v", "v@example.com", "parallel")

        result = publish_draft_changes(path, "master", draft, "pub", "pub@example.com", "publish")
        assert result["commit_id"]
        assert _file_at(path, "master", "a.txt") == "draft a"
        assert _file_at(path, "master", "c.txt") == "parallel c"

    def test_publish_conflict_when_file_changed_on_both_sides(self, tmp_path):
        """同一路径两边都改 → 整体拒绝, 两边都不动"""
        path = str(tmp_path / "repo.git")
        self._seed(path)
        draft = draft_branch_name("master")
        commit_file_changes(path, draft, "a.txt", "draft a", "u", "u@example.com", "save")
        commit_file_changes(path, "master", "a.txt", "parallel a", "v", "v@example.com", "parallel")

        with pytest.raises(ValidationException) as exc:
            publish_draft_changes(path, "master", draft, "pub", "pub@example.com", "publish")
        assert exc.value.error_code == "collab_publish_conflict"
        assert _file_at(path, "master", "a.txt") == "parallel a"
        assert _file_at(path, draft, "a.txt") == "draft a"
        assert _walk_count(path, "master") == 3

    def test_publish_without_draft_is_noop(self, tmp_path):
        """草稿分支不存在 → 无待发布变更, 不报错"""
        path = str(tmp_path / "repo.git")
        self._seed(path)
        result = publish_draft_changes(
            path, "master", draft_branch_name("master"), "pub", "pub@example.com", "publish"
        )
        assert result["commit_id"] is None
        assert result["paths"] == []

    def test_publish_twice_second_is_noop(self, tmp_path):
        """发布后草稿已重置 → 再次发布无待发布变更"""
        path = str(tmp_path / "repo.git")
        self._seed(path)
        draft = draft_branch_name("master")
        commit_file_changes(path, draft, "a.txt", "draft a", "u", "u@example.com", "save")

        first = publish_draft_changes(path, "master", draft, "pub", "pub@example.com", "publish")
        assert first["commit_id"]
        second = publish_draft_changes(path, "master", draft, "pub", "pub@example.com", "publish again")
        assert second["commit_id"] is None
        assert second["paths"] == []
        assert _walk_count(path, "master") == 3

    def test_publish_missing_target_branch_404(self, tmp_path):
        path = str(tmp_path / "repo.git")
        self._seed(path)
        with pytest.raises(NotFoundException):
            publish_draft_changes(
                path, "no-such-branch", draft_branch_name("no-such-branch"), "pub", "pub@example.com", "publish"
            )


# ==================== HTTP 端点 ====================


class TestPublishEndpoint:
    """POST /{repo_id}/collab/publish — 权限与分支保护"""

    def _add_member(self, db, repo, user, role):
        db.add(RepositoryMember(repository_id=repo.id, user_id=user.id, role=role, is_active=True))
        db.commit()

    def _other_user(self, db):
        from app.models.user import User

        user = User(
            username="draftowner",
            email="draftowner@example.com",
            password="hashed_password",
            full_name="Draft Owner",
            is_active=True,
            is_admin=False,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    def test_owner_publishes_draft(self, test_client: TestClient, db, test_user):
        """owner 发布: 草稿 squash 落默认分支, 返回提交与路径"""
        repo, physical_path = create_repo_with_content(db, "publish-basic", owner_id=test_user.id)
        create_commit_in_repo(physical_path, "a.txt", b"base a")
        draft = draft_branch_name("master")
        commit_file_changes(physical_path, draft, "a.txt", "draft content", "u", "u@example.com", "save")

        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/collab/publish",
            json={"message": "publish draft"},
            headers=_auth_headers(test_user),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["branch"] == "master"
        assert data["paths"] == ["a.txt"]
        assert data["commit_id"]
        assert _file_at(physical_path, "master", "a.txt") == "draft content"

    def test_publish_without_draft_returns_noop(self, test_client: TestClient, db, test_user):
        """无草稿分支 → 200 且 commit_id 为 None (前端提示无待发布变更)"""
        repo, physical_path = create_repo_with_content(db, "publish-noop", owner_id=test_user.id)
        create_commit_in_repo(physical_path, "a.txt", b"base a")
        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/collab/publish",
            json={},
            headers=_auth_headers(test_user),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["commit_id"] is None
        assert data["paths"] == []

    def test_viewer_publish_403(self, test_client: TestClient, db, test_user):
        """viewer 只能存草稿, 不能发布到工作分支"""
        repo = create_test_repo(db, name="publish-viewer", owner_id=self._other_user(db).id)
        self._add_member(db, repo, test_user, "viewer")
        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/collab/publish",
            json={},
            headers=_auth_headers(test_user),
        )
        assert resp.status_code == 403

    def test_non_member_publish_403(self, test_client: TestClient, db, test_user):
        repo = create_test_repo(db, name="publish-stranger", owner_id=self._other_user(db).id)
        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/collab/publish",
            json={},
            headers=_auth_headers(test_user),
        )
        assert resp.status_code == 403

    def test_protected_branch_publish_403(self, test_client: TestClient, db, test_user):
        """受保护分支 (require_code_review 禁直推) → 发布被拒, 与 pre-receive 同一裁决"""
        repo, physical_path = create_repo_with_content(db, "publish-protected", owner_id=test_user.id)
        draft = draft_branch_name("master")
        commit_file_changes(physical_path, draft, "a.txt", "draft", "u", "u@example.com", "save")

        row = db.execute(
            select(Branch).filter(Branch.repository_id == repo.id, Branch.name == "master")
        ).scalar_one_or_none()
        if row is None:
            row = Branch(repository_id=repo.id, name="master")
            db.add(row)
        row.is_protected = True
        row.require_code_review = True
        db.commit()

        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/collab/publish",
            json={},
            headers=_auth_headers(test_user),
        )
        assert resp.status_code == 403
        assert resp.json()["error"]["error_code"] == "branch_direct_write_forbidden"
