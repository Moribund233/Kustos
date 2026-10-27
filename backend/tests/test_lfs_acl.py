"""LFS 仓库级 ACL 与 transfer token 校验

覆盖「任意登录用户持 oid 即可跨仓取对象」的原始漏洞面：

- 私仓非成员 → batch 直接 403（连 token 都拿不到）；
- 只读成员 → 可下载不可上传；写成员 → 可上传；
- 公开仓 → 读放行（对齐 fork/star 口径），写仍需成员；
- token 绑定 repo：拿 A 仓 token 访问 B 仓 → 403；
- token 绑定 scope：只读 token 上传/校验/删除 → 403；
- 过期 / 篡改 / 签发所用 access token 被撤销 / 主体被停用 → 401。

oid 约定：线格式为裸 64 位小写 sha256 摘要，内容须与 oid 一致。
"""
import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from jose import jwt

from app.core.config import get_config
from app.models.repository_member import RepositoryMember
from app.models.user import User
from tests.test_helpers import create_test_repo, create_test_user, lfs_batch


def _oid(content: bytes) -> str:
    """内容 sha256 → LFS oid（64 位小写 hex；线格式不带 ``sha256:`` 前缀）"""
    return hashlib.sha256(content).hexdigest()


def _headers(user: User) -> dict:
    from app.services.token_service import create_access_token

    return {"Authorization": "Bearer " + create_access_token({
        "sub": str(user.id),
        "username": user.username,
        "is_admin": user.is_admin,
    })}


def _add_member(db, repo_id, user_id, role: str) -> None:
    db.add(RepositoryMember(
        repository_id=repo_id, user_id=user_id, role=role, is_active=True,
    ))
    db.commit()


def _object_url(repo_id, oid: str = _oid(b"obj")) -> str:
    return f"/api/v1/repositories/{repo_id}/lfs/objects/{oid}"


class TestLFSRepositoryACL:
    def test_private_repo_non_member_denied(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lfsowner")
        outsider = create_test_user(db, username="lfsoutsider")
        repo = create_test_repo(db, name="lfs-private", owner_id=owner.id,
                                is_public=False)
        headers = _headers(outsider)

        download = test_client.post(
            f"/api/v1/repositories/{repo.id}/lfs/objects/batch",
            json={"operation": "download", "objects": [{"oid": _oid(b"x")}]},
            headers=headers,
        )
        assert download.status_code == 403

        upload = test_client.post(
            f"/api/v1/repositories/{repo.id}/lfs/objects/batch",
            json={"operation": "upload", "objects": [{"oid": _oid(b"x")}]},
            headers=headers,
        )
        assert upload.status_code == 403

    def test_private_repo_owner_full_access(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lfsowner2")
        repo = create_test_repo(db, name="lfs-owner", owner_id=owner.id,
                                is_public=False)
        headers = _headers(owner)
        payload = b"abc"
        oid = _oid(payload)

        _, write = lfs_batch(test_client, repo.id, "upload",
                             [{"oid": oid, "size": len(payload)}], headers)
        assert write is not None
        assert test_client.put(_object_url(repo.id, oid), content=payload,
                               headers=write).status_code == 201

        _, read = lfs_batch(test_client, repo.id, "download",
                            [{"oid": oid}], headers)
        assert test_client.get(_object_url(repo.id, oid),
                               headers=read).status_code == 200

    def test_readonly_member_can_download_not_upload(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lfsowner3")
        reader = create_test_user(db, username="lfsreader")
        repo = create_test_repo(db, name="lfs-readonly", owner_id=owner.id,
                                is_public=False)
        _add_member(db, repo.id, reader.id, "readonly")
        headers = _headers(reader)

        upload = test_client.post(
            f"/api/v1/repositories/{repo.id}/lfs/objects/batch",
            json={"operation": "upload", "objects": [{"oid": _oid(b"x")}]},
            headers=headers,
        )
        assert upload.status_code == 403

        # owner 上传后 readonly 成员可下载
        payload = b"hi"
        oid = _oid(payload)
        _, owner_write = lfs_batch(test_client, repo.id, "upload",
                                   [{"oid": oid, "size": len(payload)}], _headers(owner))
        test_client.put(_object_url(repo.id, oid), content=payload,
                        headers=owner_write)

        _, read = lfs_batch(test_client, repo.id, "download",
                            [{"oid": oid}], headers)
        assert read is not None
        assert test_client.get(_object_url(repo.id, oid),
                               headers=read).content == payload

    def test_developer_member_can_upload(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lfsowner4")
        dev = create_test_user(db, username="lfsdev")
        repo = create_test_repo(db, name="lfs-dev", owner_id=owner.id,
                                is_public=False)
        _add_member(db, repo.id, dev.id, "developer")

        payload = b"dev"
        oid = _oid(payload)
        _, write = lfs_batch(test_client, repo.id, "upload",
                             [{"oid": oid, "size": len(payload)}], _headers(dev))
        assert write is not None
        assert test_client.put(_object_url(repo.id, oid), content=payload,
                               headers=write).status_code == 201

    def test_deactivated_member_denied(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lfsowner5")
        member = create_test_user(db, username="lfsinactive")
        repo = create_test_repo(db, name="lfs-inactive", owner_id=owner.id,
                                is_public=False)
        _add_member(db, repo.id, member.id, "developer")
        db.query(RepositoryMember).filter(
            RepositoryMember.user_id == member.id
        ).update({"is_active": False})
        db.commit()

        response = test_client.post(
            f"/api/v1/repositories/{repo.id}/lfs/objects/batch",
            json={"operation": "download", "objects": [{"oid": _oid(b"x")}]},
            headers=_headers(member),
        )
        assert response.status_code == 403

    def test_public_repo_read_allowed_write_denied(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lfsowner6")
        outsider = create_test_user(db, username="lfsoutsider6")
        repo = create_test_repo(db, name="lfs-public", owner_id=owner.id,
                                is_public=True)
        headers = _headers(outsider)
        oid = _oid(b"pub")

        # 公开仓读：非成员放行（对齐 fork/star 口径）——对象尚不存在，
        # 因此没有 action，但授权已通过（返回 404 条目而非 403）
        _, read = lfs_batch(test_client, repo.id, "download",
                            [{"oid": oid}], headers)
        assert read is None

        response = test_client.post(
            f"/api/v1/repositories/{repo.id}/lfs/objects/batch",
            json={"operation": "upload", "objects": [{"oid": oid}]},
            headers=headers,
        )
        assert response.status_code == 403

    def test_public_repo_outsider_can_fetch_object(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lfsowner7")
        outsider = create_test_user(db, username="lfsoutsider7")
        repo = create_test_repo(db, name="lfs-public2", owner_id=owner.id,
                                is_public=True)
        payload = b"open"
        oid = _oid(payload)

        _, owner_write = lfs_batch(test_client, repo.id, "upload",
                                   [{"oid": oid, "size": len(payload)}],
                                   _headers(owner))
        test_client.put(_object_url(repo.id, oid), content=payload,
                        headers=owner_write)

        _, read = lfs_batch(test_client, repo.id, "download",
                            [{"oid": oid}], _headers(outsider))
        assert test_client.get(_object_url(repo.id, oid),
                               headers=read).content == payload

    def test_unknown_repository_404(self, test_client: TestClient, db):
        user = create_test_user(db, username="lfsuser404")
        response = test_client.post(
            f"/api/v1/repositories/{uuid.uuid4()}/lfs/objects/batch",
            json={"operation": "download", "objects": []},
            headers=_headers(user),
        )
        assert response.status_code == 404


class TestLFSTransferToken:
    def test_token_bound_to_repository(self, test_client: TestClient, db):
        """A 仓签发的 token 不可用于 B 仓（防「持 oid 跨仓取对象」）"""
        owner = create_test_user(db, username="lstokenowner")
        repo_a = create_test_repo(db, name="lfs-token-a", owner_id=owner.id,
                                  is_public=False)
        repo_b = create_test_repo(db, name="lfs-token-b", owner_id=owner.id,
                                  is_public=False)
        headers = _headers(owner)
        payload = b"hello"
        oid = _oid(payload)

        # A 仓先有对象，download batch 才会下发读 token
        _, write_a = lfs_batch(test_client, repo_a.id, "upload",
                               [{"oid": oid, "size": len(payload)}], headers)
        test_client.put(_object_url(repo_a.id, oid), content=payload,
                        headers=write_a)
        _, token_a = lfs_batch(test_client, repo_a.id, "download",
                               [{"oid": oid}], headers)
        assert token_a is not None

        response = test_client.get(_object_url(repo_b.id, oid), headers=token_a)
        assert response.status_code == 403

        # 同仓同 token 正常
        ok = test_client.get(_object_url(repo_a.id, oid), headers=token_a)
        assert ok.status_code == 200
        assert ok.content == payload

    def test_read_token_cannot_write(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lsscopeowner")
        repo = create_test_repo(db, name="lfs-scope", owner_id=owner.id,
                                is_public=False)
        headers = _headers(owner)
        payload = b"data"
        oid = _oid(payload)

        # 先落对象，才能换到只读 token
        _, write = lfs_batch(test_client, repo.id, "upload",
                             [{"oid": oid, "size": len(payload)}], headers)
        test_client.put(_object_url(repo.id, oid), content=payload,
                        headers=write)

        _, read = lfs_batch(test_client, repo.id, "download",
                            [{"oid": oid}], headers)
        assert read is not None

        assert test_client.put(_object_url(repo.id, oid),
                               content=payload, headers=read).status_code == 403
        assert test_client.post(_object_url(repo.id, oid) + "/verify",
                                json={"oid": oid, "size": len(payload)},
                                headers=read).status_code == 403
        assert test_client.delete(_object_url(repo.id, oid),
                                  headers=read).status_code == 403

    def test_write_token_can_read(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lswriteowner")
        repo = create_test_repo(db, name="lfs-write-read", owner_id=owner.id,
                                is_public=False)
        payload = b"abc"
        oid = _oid(payload)
        _, write = lfs_batch(test_client, repo.id, "upload",
                             [{"oid": oid, "size": len(payload)}], _headers(owner))
        assert test_client.put(_object_url(repo.id, oid), content=payload,
                               headers=write).status_code == 201
        assert test_client.get(_object_url(repo.id, oid),
                               headers=write).status_code == 200

    def test_expired_token_rejected(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lsexpowner")
        repo = create_test_repo(db, name="lfs-expired", owner_id=owner.id,
                                is_public=False)
        security = get_config().security
        now = datetime.now(timezone.utc)
        expired = jwt.encode({
            "sub": str(owner.id),
            "repo_id": str(repo.id),
            "scope": "read",
            "type": "lfs",
            "jti": "expired-jti",
            "iat": now - timedelta(minutes=10),
            "exp": now - timedelta(minutes=1),
        }, security.secret_key, algorithm=security.algorithm)

        response = test_client.get(
            _object_url(repo.id, _oid(b"exp")),
            headers={"Authorization": f"Bearer {expired}"},
        )
        assert response.status_code == 401

    def test_tampered_token_rejected(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lstampowner")
        repo = create_test_repo(db, name="lfs-tamper", owner_id=owner.id,
                                is_public=False)
        headers = _headers(owner)
        payload = b"abc"
        oid = _oid(payload)

        _, write = lfs_batch(test_client, repo.id, "upload",
                             [{"oid": oid, "size": len(payload)}], headers)
        test_client.put(_object_url(repo.id, oid), content=payload, headers=write)

        _, token = lfs_batch(test_client, repo.id, "download",
                             [{"oid": oid}], headers)
        header_value = token["Authorization"]
        tampered = header_value[:-4] + ("aaa" if not header_value.endswith("aaa")
                                        else "bbb")
        response = test_client.get(
            _object_url(repo.id, oid),
            headers={"Authorization": tampered},
        )
        assert response.status_code == 401

    def test_access_token_revocation_kills_transfer_token(
        self, test_client: TestClient, db
    ):
        """登出（撤销 access token）后，已签发的 LFS token 立即失效"""
        owner = create_test_user(db, username="lsrevowner")
        repo = create_test_repo(db, name="lfs-revoke", owner_id=owner.id,
                                is_public=False)
        headers = _headers(owner)

        payload = b"abc"
        oid = _oid(payload)
        _, write = lfs_batch(test_client, repo.id, "upload",
                             [{"oid": oid, "size": len(payload)}], headers)
        assert test_client.put(_object_url(repo.id, oid), content=payload,
                               headers=write).status_code == 201

        logout = test_client.post("/api/v1/auth/logout", headers=headers, json={})
        assert logout.status_code == 200
        assert logout.json().get("access_revoked") is True

        # 撤销后：签发时绑定该 access token 的 LFS token 立即失效
        response = test_client.get(_object_url(repo.id, oid), headers=write)
        assert response.status_code == 401

    def test_deactivated_user_transfer_rejected(self, test_client: TestClient, db):
        owner = create_test_user(db, username="lsdisowner")
        repo = create_test_repo(db, name="lfs-disable", owner_id=owner.id,
                                is_public=False)
        payload = b"abc"
        oid = _oid(payload)
        _, write = lfs_batch(test_client, repo.id, "upload",
                             [{"oid": oid, "size": len(payload)}], _headers(owner))
        assert write is not None

        db.query(User).filter(User.id == owner.id).update({"is_active": False})
        db.commit()

        response = test_client.put(_object_url(repo.id, oid),
                                   content=payload, headers=write)
        assert response.status_code == 401
