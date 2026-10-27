"""硬化回归锚点：修复 + 决策落地 + 关键安全项

覆盖范围：

1. build 域写权限：触发/更新构建需 REPO_WRITE（原任意登录用户可
   伪造 CI 状态），CI 签名回调路径不受影响；
2. 配置写回深合并：只提交脏节不再把其它节抹掉；
3. 配置读取脱敏：security.secret_key / database.url 凭据段；
4. 写回校验与加载校验同源：越界值（gunicorn.timeout=5）被拒，
   消除「能写入但重启即 crash loop」的落差；
5. 公开仓参与：公开仓登录即可建 issue/评论，私仓非成员 403、
   匿名 401；矩阵以 ISSUE_CREATE/PR_CREATE/COMMENT_CREATE 显式登记；
6. 仓库列表可见性：他人私仓不出现在列表与 /user/{id}；
7. family 吊销作用于 access：登出后同 family 的兄弟 access 立即 401；
8. 审计端点 admin-only：debug 模式对非管理员仍 403；
9. revoked_tokens 过期行自动清理（只删过期行）；
10. 网关/dev nginx 封禁 git-internal 公网透传（静态配置断言）。
"""
import re
import uuid as uuid_mod
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app.api.v1.app_controller as app_ctl
from app.services.config_store import update_sections
from app.core.exception import ValidationException
from app.services.config_service import get_config_service
from app.services.retention_service import get_retention_service
from app.services.token_service import create_access_token, create_token_pair, verify_token
from tests.test_helpers import create_test_repo

#: 仓库根（测试容器 cwd=/app，但显式定位更稳）
_REPO_ROOT = Path(__file__).resolve().parents[1]


# ============ 共用辅助 ============

def _headers(user) -> dict:
    token = create_access_token({
        "sub": str(user.id),
        "username": user.username,
        "is_admin": user.is_admin,
    })
    return {"Authorization": f"Bearer {token}"}


def _make_user(db, prefix: str):
    from app.models.user import User
    suffix = uuid_mod.uuid4().hex[:8]
    user = User(
        username=f"{prefix}_{suffix}",
        email=f"{prefix}_{suffix}@example.com",
        password="x",
        is_active=True,
        is_admin=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _debug_on(monkeypatch):
    """让 app_controller 的权限判定看到 debug=true（同测试口径）"""
    monkeypatch.setattr(
        app_ctl, "get_config",
        lambda: SimpleNamespace(app=SimpleNamespace(debug=True)),
    )


# ========================================================================
# build 域写权限
# ========================================================================

class TestBuildWritePermission:
    def _build_payload(self) -> dict:
        return {"branch": "master", "commit_sha": "a" * 40}

    def test_outsider_cannot_trigger_build_on_public_repo(
        self, test_client: TestClient, db, test_user
    ):
        """公开仓非成员触发构建 → 403（原 201 = 任意账号伪造构建记录）"""
        owner = _make_user(db, "b11_owner")
        repo = create_test_repo(db, name="b11-build-pub", owner_id=owner.id, is_public=True)
        outsider = _make_user(db, "b11_out")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/builds",
            json=self._build_payload(),
            headers=_headers(outsider),
        )
        assert r.status_code == 403, f"非成员可触发构建: {r.status_code} {r.text[:200]}"

    def test_anonymous_cannot_trigger_build(self, test_client: TestClient, db, test_user):
        owner = _make_user(db, "b11_owner")
        repo = create_test_repo(db, name="b11-build-anon", owner_id=owner.id, is_public=True)
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/builds", json=self._build_payload()
        )
        assert r.status_code == 401

    def test_owner_can_trigger_build(self, test_client: TestClient, db, test_user):
        repo = create_test_repo(db, name="b11-build-own", owner_id=test_user.id, is_public=True)
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/builds",
            json=self._build_payload(),
            headers=_headers(test_user),
        )
        assert r.status_code == 201, f"owner 触发构建被拒: {r.status_code} {r.text[:200]}"

    def test_outsider_cannot_update_build_without_signature(
        self, test_client: TestClient, db, test_user
    ):
        """无签名头回落路径 → 也需 REPO_WRITE（原仅认证即可覆写 status/logs）"""
        repo = create_test_repo(db, name="b11-build-patch", owner_id=test_user.id, is_public=True)
        created = test_client.post(
            f"/api/v1/repositories/{repo.id}/builds",
            json=self._build_payload(),
            headers=_headers(test_user),
        )
        assert created.status_code == 201
        build_id = created.json()["id"]

        outsider = _make_user(db, "b11_out")
        r = test_client.patch(
            f"/api/v1/repositories/{repo.id}/builds/{build_id}",
            json={"status": "success"},
            headers=_headers(outsider),
        )
        assert r.status_code == 403, f"非成员可覆写构建状态: {r.status_code} {r.text[:200]}"

    def test_owner_can_update_build_without_signature(
        self, test_client: TestClient, db, test_user
    ):
        repo = create_test_repo(db, name="b11-build-patch-own", owner_id=test_user.id, is_public=True)
        created = test_client.post(
            f"/api/v1/repositories/{repo.id}/builds",
            json=self._build_payload(),
            headers=_headers(test_user),
        )
        build_id = created.json()["id"]
        r = test_client.patch(
            f"/api/v1/repositories/{repo.id}/builds/{build_id}",
            json={"status": "running"},
            headers=_headers(test_user),
        )
        assert r.status_code == 200, f"owner 更新构建被拒: {r.status_code} {r.text[:200]}"


# ========================================================================
# 配置写入深合并
# ========================================================================

class TestConfigWriteMerge:
    @staticmethod
    def _seed_db(url):
        """在独立空库（conftest.isolated_db_url）上建表并灌入三个节"""
        from sqlalchemy import create_engine

        from app.models.app_config import AppConfig

        engine = create_engine(url)
        try:
            table = AppConfig.__table__
            table.create(engine, checkfirst=True)
            with engine.begin() as conn:
                conn.execute(table.insert().values(
                    section="server", payload={"host": "0.0.0.0", "port": 8000}, version=1
                ))
                conn.execute(table.insert().values(
                    section="app", payload={"title": "kustos"}, version=1
                ))
                conn.execute(table.insert().values(
                    section="logging", payload={"log_keep_days": 42}, version=1
                ))
        finally:
            engine.dispose()
        return url

    @staticmethod
    def _payloads(url):
        from sqlalchemy import create_engine

        from app.models.app_config import AppConfig

        engine = create_engine(url)
        try:
            with engine.connect() as conn:
                return {
                    r.section: r.payload
                    for r in conn.execute(AppConfig.__table__.select())
                }
        finally:
            engine.dispose()

    def test_partial_write_preserves_other_sections(self, isolated_db_url):
        """只提交 [server] 不得抹掉其它节（原整文件覆盖 = 下次重启回默认）"""
        url = self._seed_db(isolated_db_url)

        update_sections({"server": {"port": 9999}}, db_url=url)

        data = self._payloads(url)
        assert data["server"]["port"] == 9999
        assert data["server"]["host"] == "0.0.0.0"
        assert data["app"]["title"] == "kustos", "其它节被抹掉"
        assert data["logging"]["log_keep_days"] == 42, "其它节被抹掉"

    def test_merge_updates_existing_key_only(self, isolated_db_url):
        url = self._seed_db(isolated_db_url)

        update_sections({"server": {"log_level": "warning"}}, db_url=url)

        data = self._payloads(url)
        assert data["server"]["log_level"] == "warning"
        assert data["server"]["port"] == 8000, "同节未提交键被抹掉"


# ========================================================================
# 配置读取脱敏
# ========================================================================

class TestConfigReadMasking:
    def test_secret_key_masked(self):
        from app.core.config import get_config
        real = get_config().security.secret_key
        data = get_config_service().get_config()
        if real:
            assert data["security"]["secret_key"] == "***", "secret_key 未脱敏"
            assert real not in str(data), "真实密钥出现在配置读取响应中"

    def test_secret_key_masked_in_section_query(self):
        from app.core.config import get_config
        real = get_config().security.secret_key
        section = get_config_service().get_config("security")
        if real:
            assert section.get("secret_key") == "***"

    def test_database_url_credentials_masked(self):
        from app.core.config import get_config
        real = get_config().database.url or ""
        masked = get_config_service().get_config().get("database", {}).get("url") or ""
        first_segment = real.split("://", 1)[1].split("/", 1)[0] if "://" in real else ""
        if "@" in first_segment:
            real_creds = real.split("://", 1)[1].rsplit("@", 1)[0]
            assert real_creds not in masked, "database.url 凭据未脱敏"
            assert "***@" in masked, f"database.url 凭据段未掩码: {masked}"
            # 主机/库名保留供运维辨识
            assert masked.rsplit("@", 1)[1] == real.rsplit("@", 1)[1]

    def test_editable_sections_untouched(self):
        """可编辑节（server/gunicorn/proxy/cors/database 字段名）不落入脱敏键"""
        data = get_config_service().get_config()
        for section in ("server", "gunicorn", "cors"):
            for key, value in (data.get(section) or {}).items():
                assert value != "***" or key.lower() in get_config_service.SENSITIVE_CONFIG_KEYS, (
                    f"{section}.{key} 被误脱敏"
                )


# ========================================================================
# 写回校验与加载校验同源
# ========================================================================

class TestConfigWriteValidation:
    def test_rejects_out_of_range_gunicorn_timeout(self):
        """timeout=5 过手写校验（>=0）但违反模型 ge=10 → 必须在写入前拒绝"""
        with pytest.raises(ValidationException):
            get_config_service().update_config({"gunicorn": {"timeout": 5}}, is_admin=True)

    def test_rejects_out_of_range_pool_size(self):
        with pytest.raises(ValidationException):
            get_config_service().update_config({"database": {"pool_size": 0}}, is_admin=True)

    def test_rejects_unknown_server_key(self):
        """模型 extra=forbid：写入后会被静默丢弃的键应直接拒绝"""
        with pytest.raises(ValidationException):
            get_config_service().update_config({"server": {"workers": 3}}, is_admin=True)

    def test_rejects_out_of_range_workers(self):
        with pytest.raises(ValidationException):
            get_config_service().update_config({"gunicorn": {"workers": 100}}, is_admin=True)


# ========================================================================
# 决策：GitHub 式参与（issue/PR/评论）
# ========================================================================

class TestParticipateActions:
    def test_public_repo_outsider_can_create_issue(
        self, test_client: TestClient, db, test_user
    ):
        """决策锁定：公开仓 + 已认证（非成员）可建 issue"""
        owner = _make_user(db, "b11_iowner")
        repo = create_test_repo(db, name="b11-issue-pub", owner_id=owner.id, is_public=True)
        outsider = _make_user(db, "b11_iout")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues",
            json={"title": "outsider issue"},
            headers=_headers(outsider),
        )
        assert r.status_code in (200, 201), f"公开仓拒绝登录用户建 issue: {r.status_code} {r.text[:200]}"

    def test_private_repo_outsider_cannot_create_issue(
        self, test_client: TestClient, db, test_user
    ):
        owner = _make_user(db, "b11_iowner")
        repo = create_test_repo(db, name="b11-issue-priv", owner_id=owner.id, is_public=False)
        outsider = _make_user(db, "b11_iout")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues",
            json={"title": "intrusion"},
            headers=_headers(outsider),
        )
        assert r.status_code in (401, 403), f"私仓非成员可建 issue: {r.status_code} {r.text[:200]}"

    def test_anonymous_cannot_create_issue_on_public_repo(
        self, test_client: TestClient, db, test_user
    ):
        owner = _make_user(db, "b11_iowner")
        repo = create_test_repo(db, name="b11-issue-anon", owner_id=owner.id, is_public=True)
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues", json={"title": "anon"}
        )
        assert r.status_code == 401

    def test_public_repo_outsider_can_comment(self, test_client: TestClient, db, test_user):
        owner = _make_user(db, "b11_cowner")
        repo = create_test_repo(db, name="b11-comment-pub", owner_id=owner.id, is_public=True)
        created = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues",
            json={"title": "for comments"},
            headers=_headers(owner),
        )
        assert created.status_code in (200, 201)
        number = created.json()["issue_number"]

        outsider = _make_user(db, "b11_cout")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues/{number}/comments",
            json={"content": "hello from outsider"},
            headers=_headers(outsider),
        )
        assert r.status_code in (200, 201), f"公开仓拒绝登录用户评论: {r.status_code} {r.text[:200]}"
    def test_private_repo_outsider_cannot_comment(self, test_client: TestClient, db, test_user):
        owner = _make_user(db, "b11_cowner")
        repo = create_test_repo(db, name="b11-comment-priv", owner_id=owner.id, is_public=False)
        created = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues",
            json={"title": "private issue"},
            headers=_headers(owner),
        )
        assert created.status_code in (200, 201)
        number = created.json()["issue_number"]

        outsider = _make_user(db, "b11_cout")
        r = test_client.post(
            f"/api/v1/repositories/{repo.id}/issues/{number}/comments",
            json={"content": "intrusion"},
            headers=_headers(outsider),
        )
        assert r.status_code in (401, 403), f"私仓非成员可评论: {r.status_code} {r.text[:200]}"

    def test_matrix_registers_participate_actions(self):
        """结构断言：参与型操作必须显式进矩阵（防回潮为隐式放行）"""
        from app.core.permissions import Action, ACTION_MATRIX, PUBLIC_PARTICIPATE_ACTIONS
        for action in (Action.ISSUE_CREATE, Action.PR_CREATE, Action.COMMENT_CREATE):
            assert action in ACTION_MATRIX, f"{action} 未登记进 ACTION_MATRIX"
            assert action in PUBLIC_PARTICIPATE_ACTIONS


# ========================================================================
# 仓库列表可见性
# ========================================================================

class TestRepositoryListVisibility:
    def _ids(self, payload) -> set:
        return {item["id"] for item in payload.get("items", [])}

    def test_private_repo_hidden_from_outsider_list(
        self, test_client: TestClient, db, test_user
    ):
        owner = _make_user(db, "b11_vowner")
        priv = create_test_repo(db, name="b11-priv-list", owner_id=owner.id, is_public=False)
        pub = create_test_repo(db, name="b11-pub-list", owner_id=owner.id, is_public=True)

        r = test_client.get("/api/v1/repositories", headers=_headers(test_user))
        assert r.status_code == 200
        ids = self._ids(r.json())
        assert str(priv.id) not in ids, "他人私仓出现在仓库列表（跨租户元数据枚举）"
        assert str(pub.id) in ids

    def test_private_repo_visible_to_owner_and_admin(
        self, test_client: TestClient, db, test_user, admin_headers
    ):
        priv = create_test_repo(db, name="b11-priv-own", owner_id=test_user.id, is_public=False)

        r = test_client.get("/api/v1/repositories", headers=_headers(test_user))
        assert str(priv.id) in self._ids(r.json()), "owner 看不到自己的私仓"

        r = test_client.get("/api/v1/repositories", headers=admin_headers)
        assert str(priv.id) in self._ids(r.json()), "admin 看不到私仓"

    def test_by_user_returns_only_public_for_others(
        self, test_client: TestClient, db, test_user
    ):
        owner = _make_user(db, "b11_bvowner")
        priv = create_test_repo(db, name="b11-bv-priv", owner_id=owner.id, is_public=False)
        pub = create_test_repo(db, name="b11-bv-pub", owner_id=owner.id, is_public=True)

        r = test_client.get(
            f"/api/v1/repositories/user/{owner.id}", headers=_headers(test_user)
        )
        assert r.status_code == 200
        ids = {item["id"] for item in r.json()}
        assert str(priv.id) not in ids, "他人私仓清单泄露（含成员关系）"
        assert str(pub.id) in ids

    def test_by_user_returns_all_for_self(self, test_client: TestClient, db, test_user):
        priv = create_test_repo(db, name="b11-bv-self", owner_id=test_user.id, is_public=False)
        r = test_client.get(
            f"/api/v1/repositories/user/{test_user.id}", headers=_headers(test_user)
        )
        assert r.status_code == 200
        assert str(priv.id) in {item["id"] for item in r.json()}


# ========================================================================
# family 吊销作用于 access
# ========================================================================

class TestFamilyRevocationOnAccess:
    def test_logout_revokes_sibling_access_token(
        self, test_client: TestClient, db, test_user
    ):
        """登出（吊销 family）后，同 family 另一标签页的 access 立即 401"""
        first = create_token_pair(test_user)
        family_id = verify_token(first["access_token"], token_type="access").family_id
        assert family_id, "夹具：access 应携带 family_id"

        # 模拟第二标签页：同 family 的另一个 access
        second = create_token_pair(test_user, extra_claims={"family_id": family_id})
        sibling_headers = {"Authorization": f"Bearer {second['access_token']}"}

        # 同 family access 在登出前可用
        r = test_client.get("/api/v1/users/me", headers=sibling_headers)
        assert r.status_code == 200, "前置：同 family access 应可用"

        # 用第一个标签页登出 → family 吊销
        r = test_client.post(
            "/api/v1/auth/logout",
            json={"refresh_token": first["refresh_token"]},
            headers={"Authorization": f"Bearer {first['access_token']}"},
        )
        assert r.status_code == 200
        assert r.json().get("family_revoked") is True, "登出应吊销整个 family"

        # 兄弟 access 立即失效
        r = test_client.get("/api/v1/users/me", headers=sibling_headers)
        assert r.status_code == 401, (
            f"family 吊销后兄弟 access 仍有效: {r.status_code}"
        )


# ========================================================================
# 审计端点 admin-only
# ========================================================================

class TestAuditEndpointAdminOnly:
    def test_debug_mode_does_not_open_audit_to_non_admin(
        self, test_client: TestClient, auth_headers, monkeypatch
    ):
        """debug=true 时非管理员读审计 → 403（原 check_app_permission 放行）"""
        _debug_on(monkeypatch)
        r = test_client.get("/api/app/audit", headers=auth_headers)
        assert r.status_code == 403, f"debug 模式非管理员可读审计: {r.status_code}"

    def test_admin_can_read_audit_in_debug(
        self, test_client: TestClient, admin_headers, monkeypatch
    ):
        _debug_on(monkeypatch)
        r = test_client.get("/api/app/audit", headers=admin_headers)
        assert r.status_code == 200

    def test_admin_can_read_audit_debug_off(
        self, test_client: TestClient, admin_headers
    ):
        r = test_client.get("/api/app/audit", headers=admin_headers)
        assert r.status_code == 200


# ========================================================================
# revoked_tokens 过期清理
# ========================================================================

class TestRevokedTokenRetention:
    async def test_cleanup_deletes_only_expired_rows(self, async_db):
        from app.models.revoked_token import RevokedToken

        expired = RevokedToken(
            jti="b11_expired_jti",
            token_type="access",
            expires_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
        alive = RevokedToken(
            jti="b11_alive_jti",
            token_type="access",
            expires_at=datetime.now(timezone.utc) + timedelta(days=6),
        )
        no_expiry = RevokedToken(jti="b11_noexpiry_jti", token_type="access", expires_at=None)
        async_db.add_all([expired, alive, no_expiry])
        await async_db.commit()

        deleted = await get_retention_service().cleanup_revoked_tokens(async_db)
        assert deleted == 1, f"应只删过期行，实删 {deleted}"

        from sqlalchemy import select
        remaining = {
            row for row in (await async_db.execute(select(RevokedToken.jti))).scalars()
        }
        assert "b11_expired_jti" not in remaining
        assert "b11_alive_jti" in remaining, "未过期行被误删"
        assert "b11_noexpiry_jti" in remaining, "无过期时间行被误删"

    async def test_run_once_reports_revoked_cleanup(self, async_db):
        from app.models.revoked_token import RevokedToken

        async_db.add(RevokedToken(
            jti="b11_runonce_expired",
            token_type="refresh",
            expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
        ))
        await async_db.commit()

        result = await get_retention_service().run_once(async_db)
        assert "revoked_tokens_deleted" in result
        assert result["revoked_tokens_deleted"] >= 1


# ========================================================================
# 网关封禁 git-internal
# ========================================================================

class TestGatewayBlocksGitInternal:
    def test_production_gateway_blocks(self):
        conf = (_REPO_ROOT / "docker/gateway/nginx.conf").read_text(encoding="utf-8")
        assert re.search(
            r"location\s+\^~\s+/api/v1/git-internal/", conf
        ), "生产网关未封禁 /api/v1/git-internal/（内部回调对公网透传）"
        # 封禁块内必须是直接 404，不能 proxy_pass
        block = conf.split("location ^~ /api/v1/git-internal/", 1)[1].split("}", 1)[0]
        assert "return 404" in block
        assert "proxy_pass" not in block

    def test_dev_gateway_blocks(self):
        conf = (_REPO_ROOT / "docker/dev/nginx.dev.conf").read_text(encoding="utf-8")
        assert re.search(
            r"location\s+\^~\s+/api/v1/git-internal/", conf
        ), "开发网关未封禁 /api/v1/git-internal/"
