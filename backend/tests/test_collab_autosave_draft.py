"""自动落盘草稿分支：会话空闲 N 分钟自动 collab_save 到 `collab/draft-...`。

契约 (本测试只断言 API 契约):
  - `POST /api/v1/collab/save` 带 `draft: true` 时, 将 docKey 的 branch 替换为
    `collab/draft-{branch}` 写入 (存量 commit_file 分支不存在即创建);
  - 响应返回 draft 分支名 (非触碰用户工作分支)。
"""
from unittest.mock import AsyncMock

import pytest

from app.api.v1.collab_internal_controller import (
    INTERNAL_SECRET_ENV,
    INTERNAL_SECRET_HEADER,
    make_doc_key,
)
from app.services.token_service import create_access_token
from tests.test_helpers import create_test_repo

SECRET = "test-internal-secret"


def _headers(secret=SECRET):
    return {INTERNAL_SECRET_HEADER: secret}


def _token_for(user):
    return create_access_token(
        {
            "sub": str(user.id),
            "username": user.username,
            "is_admin": user.is_admin,
        }
    )


@pytest.fixture
def internal_env(monkeypatch):
    monkeypatch.setenv(INTERNAL_SECRET_ENV, SECRET)


class TestCollabAutosaveDraft:
    """自动落盘草稿分支 — 会话空闲自动保存到 collab/draft-*。"""

    def test_autosave_to_draft_branch(
        self, test_client, db, test_user, internal_env, monkeypatch
    ):
        """draft=True 时将 branch 替换为 collab/draft-{branch} 写入。"""
        repo = create_test_repo(db, name="draft-repo", owner_id=test_user.id)
        mock = AsyncMock(
            return_value={
                "commit_id": "draft000",
                "branch": "collab/draft-main",
                "path": "src/app.py",
            }
        )
        monkeypatch.setattr("app.services.repository_browser_service.commit_file", mock)

        resp = test_client.post(
            "/api/v1/collab/save",
            json={
                "token": _token_for(test_user),
                "docKey": make_doc_key(str(repo.id), "main", "src/app.py"),
                "content": "draft content",
                "message": "autosave to draft",
                "draft": True,
            },
            headers=_headers(),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["commit_id"] == "draft000"
        assert data["branch"].startswith("collab/draft-")
        assert data["branch"] == "collab/draft-main"
        # 工作分支未被触碰: commit_file 收到的 branch 必须重写为草稿分支
        args, _ = mock.call_args
        assert args[1] == "collab/draft-main"