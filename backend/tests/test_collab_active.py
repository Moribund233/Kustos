"""协作感知端点测试 (GET /repositories/{id}/collab/active)

桌面端要在"进入协作之前"知道哪些文件正有人编辑, 用于文件树 live 圆点与
进入前预警。数据源是协作网关的实时连接计数, 由 app 聚合多副本后对外提供。

本文件覆盖:
- 权限: 仓库读权限裁决 (无权限 403, 私仓匿名 401/403, 缺仓 404);
- 聚合: 多副本计数求和, docKey 排序稳定;
- 降级: 网关不可达时返回空清单而非报错 (协作感知是锦上添花, 不能挡住仓库浏览)。
"""

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from app.core.permissions import Action
from app.services.collaboration.doc_key import make_doc_key
from app.services.auth.token_service import create_access_token
from tests.test_helpers import create_test_repo

REPO = uuid.uuid4()
GATEWAY_SECRET = "test-internal-secret"
GATEWAY_SECRET_ENV = "KUSTOS_COLLAB_INTERNAL_SECRET"


def _bearer(user):
    token = create_access_token(
        {
            "sub": str(user.id),
            "username": user.username,
            "is_admin": user.is_admin,
        }
    )
    return {"Authorization": f"Bearer {token}"}


class TestCollabActiveEndpoint:
    """GET /api/v1/repositories/{repo_id}/collab/active"""

    def _url(self, repo_id):
        return f"/api/v1/repositories/{repo_id}/collab/active"

    def test_requires_auth(self, test_client, db):
        """匿名访问私仓 → 401/403 (不泄露仓库内容)"""
        owner = _owner(db, "ca-anon-owner")
        repo = create_test_repo(db, name="ca-anon", owner_id=owner.id, is_public=False)
        resp = test_client.get(self._url(repo.id))
        assert resp.status_code in (401, 403)

    def test_outsider_denied(self, test_client, db, test_user):
        """非成员访问私仓 → 403"""
        owner = _owner(db, "ca-outsider-owner")
        repo = create_test_repo(
            db, name="ca-outsider", owner_id=owner.id, is_public=False
        )
        resp = test_client.get(self._url(repo.id), headers=_bearer(test_user))
        assert resp.status_code == 403

    def test_missing_repo_404(self, test_client, db, test_user):
        """仓库不存在 → 404"""
        resp = test_client.get(self._url(uuid.uuid4()), headers=_bearer(test_user))
        assert resp.status_code == 404

    def test_owner_gets_aggregated_documents(self, test_client, db, test_user):
        """owner 可读; 多副本计数求和后返回"""
        repo = create_test_repo(db, name="ca-owner", owner_id=test_user.id)
        key_a = make_doc_key(str(repo.id), "main", "src/a.py")
        key_b = make_doc_key(str(repo.id), "main", "src/b.py")

        # collect_active_documents 的契约就是"已完成聚合的扁平清单";
        # 多副本求和逻辑由 TestCollectActiveDocuments 单独覆盖。
        aggregated = [
            {"docKey": key_a, "connections": 3},
            {"docKey": key_b, "connections": 4},
        ]

        async def fake_collect(_repository_id):
            return aggregated

        with patch(
            "app.api.v1.collab_active_controller.collect_active_documents",
            side_effect=fake_collect,
        ):
            resp = test_client.get(self._url(repo.id), headers=_bearer(test_user))

        assert resp.status_code == 200
        documents = resp.json()["documents"]
        assert documents == [
            {"docKey": key_a, "connections": 3},
            {"docKey": key_b, "connections": 4},
        ]

    def test_no_active_documents_is_empty_list(self, test_client, db, test_user):
        """无人编辑时返回空清单 (不是 404, 也不是 null)"""
        repo = create_test_repo(db, name="ca-empty", owner_id=test_user.id)

        async def fake_collect(_repository_id):
            return []

        with patch(
            "app.api.v1.collab_active_controller.collect_active_documents",
            side_effect=fake_collect,
        ):
            resp = test_client.get(self._url(repo.id), headers=_bearer(test_user))

        assert resp.status_code == 200
        assert resp.json()["documents"] == []

    def test_gateway_unreachable_degrades_to_empty(self, test_client, db, test_user):
        """网关未配置/不可达 → 空清单 + degraded 标记, 不 500"""
        repo = create_test_repo(db, name="ca-down", owner_id=test_user.id)

        async def fake_collect(_repository_id):
            return []

        with (
            patch(
                "app.api.v1.collab_active_controller.collect_active_documents",
                side_effect=fake_collect,
            ),
            patch(
                "app.api.v1.collab_active_controller.is_degraded",
                return_value=True,
            ),
        ):
            resp = test_client.get(self._url(repo.id), headers=_bearer(test_user))

        assert resp.status_code == 200
        body = resp.json()
        assert body["documents"] == []
        # 网关状态必须显式告知前端, 否则 UI 无法区分"没人编辑"与"感知不可用"
        assert body["degraded"] is True

    def test_gateway_configured_reports_not_degraded(
        self, test_client, db, test_user, monkeypatch
    ):
        """网关已配置且可达 → degraded 为 false, 空清单可信"""
        repo = create_test_repo(db, name="ca-ok", owner_id=test_user.id)
        monkeypatch.setenv("KUSTOS_COLLAB_ACTIVE_ENDPOINTS", "http://collab:4446")
        monkeypatch.setenv("KUSTOS_COLLAB_INTERNAL_SECRET", GATEWAY_SECRET)

        async def fake_collect(_repository_id):
            return []

        with patch(
            "app.api.v1.collab_active_controller.collect_active_documents",
            side_effect=fake_collect,
        ):
            resp = test_client.get(self._url(repo.id), headers=_bearer(test_user))

        assert resp.status_code == 200
        assert resp.json() == {"documents": [], "degraded": False}


class TestCollectActiveDocuments:
    """聚合服务: 多副本收集与失败降级"""

    @pytest.mark.asyncio
    async def test_aggregates_replica_counts(self, monkeypatch):
        """多副本同文档计数相加, 并去重排序"""
        from app.services.collaboration import collab_active_service as svc

        replicas = [
            [
                {"docKey": "r:main:b.py", "connections": 1},
                {"docKey": "r:main:a.py", "connections": 2},
            ],
            [{"docKey": "r:main:a.py", "connections": 3}],
        ]

        async def fake_fetch(_url, _secret, _repository_id):
            return replicas.pop(0)

        monkeypatch.setattr(
            svc, "_endpoints", lambda: ["http://collab-a:4446", "http://collab-b:4446"]
        )
        monkeypatch.setenv(GATEWAY_SECRET_ENV, GATEWAY_SECRET)
        monkeypatch.setattr(svc, "_fetch_replica", fake_fetch)

        result = await svc.collect_active_documents("r")
        assert result == [
            {"docKey": "r:main:a.py", "connections": 5},
            {"docKey": "r:main:b.py", "connections": 1},
        ]

    @pytest.mark.asyncio
    async def test_filters_foreign_repository(self, monkeypatch):
        """跨仓库的 docKey 一律剔除, 防止串数据"""
        from app.services.collaboration import collab_active_service as svc

        async def fake_fetch(_url, _secret, _repository_id):
            return [
                {"docKey": "repo-a:main:a.py", "connections": 1},
                {"docKey": "repo-b:main:b.py", "connections": 9},
            ]

        monkeypatch.setattr(svc, "_endpoints", lambda: ["http://collab:4446"])
        monkeypatch.setenv(GATEWAY_SECRET_ENV, GATEWAY_SECRET)
        monkeypatch.setattr(svc, "_fetch_replica", fake_fetch)

        assert await svc.collect_active_documents("repo-a") == [
            {"docKey": "repo-a:main:a.py", "connections": 1}
        ]

    @pytest.mark.asyncio
    async def test_ignores_non_positive_and_malformed_counts(self, monkeypatch):
        """异常计数忽略, 不污染结果"""
        from app.services.collaboration import collab_active_service as svc

        async def fake_fetch(_url, _secret, _repository_id):
            return [
                {"docKey": "r:main:a.py", "connections": 0},
                {"docKey": "r:main:b.py", "connections": "x"},
                {"docKey": "r:main:c.py", "connections": 2},
                {"docKey": None, "connections": 5},
                "not-a-dict",
            ]

        monkeypatch.setattr(svc, "_endpoints", lambda: ["http://collab:4446"])
        monkeypatch.setenv(GATEWAY_SECRET_ENV, GATEWAY_SECRET)
        monkeypatch.setattr(svc, "_fetch_replica", fake_fetch)

        assert await svc.collect_active_documents("r") == [
            {"docKey": "r:main:c.py", "connections": 2}
        ]

    @pytest.mark.asyncio
    async def test_replica_failure_does_not_break_others(self, monkeypatch):
        """单个副本抛错时其余副本仍能聚合"""
        from app.services.collaboration import collab_active_service as svc

        async def fake_fetch(url, _secret, _repository_id):
            if url.endswith(":9999"):
                raise RuntimeError("replica down")
            return [{"docKey": "r:main:a.py", "connections": 4}]

        monkeypatch.setattr(
            svc, "_endpoints", lambda: ["http://collab:9999", "http://collab:4446"]
        )
        monkeypatch.setenv(GATEWAY_SECRET_ENV, GATEWAY_SECRET)
        monkeypatch.setattr(svc, "_fetch_replica", fake_fetch)

        assert await svc.collect_active_documents("r") == [
            {"docKey": "r:main:a.py", "connections": 4}
        ]

    @pytest.mark.asyncio
    async def test_unconfigured_returns_empty(self, monkeypatch):
        """未配置网关地址 → 空清单 (协作感知未部署), 且 is_degraded 为真"""
        from app.services.collaboration import collab_active_service as svc

        monkeypatch.setattr(svc, "_endpoints", lambda: [])
        assert await svc.collect_active_documents("r") == []
        assert svc.is_degraded() is True

    @pytest.mark.asyncio
    async def test_missing_secret_is_degraded(self, monkeypatch):
        """有地址但缺密钥 → 视为不可用 (安全默认, 与网关侧 503 对称)"""
        from app.services.collaboration import collab_active_service as svc

        monkeypatch.setattr(svc, "_endpoints", lambda: ["http://collab:4446"])
        monkeypatch.delenv(GATEWAY_SECRET_ENV, raising=False)
        assert await svc.collect_active_documents("r") == []
        assert svc.is_degraded() is True


def _owner(db, username):
    """独立 owner 用户 (避免 test_user 恒为 owner)"""
    from app.models.user import User

    user = User(
        username=username,
        email=f"{username}@example.com",
        password="hashed_owner_password",
        full_name=f"Owner {username}",
        is_active=True,
        is_admin=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user
