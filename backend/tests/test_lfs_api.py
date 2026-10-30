"""LFS API 端点测试（ACL + 短时效 transfer token）

授权约定（本文件 + test_lfs_acl.py 共同固化）：

- **batch**：唯一接受用户凭证的入口（``Bearer <access>`` 或 ``Basic 用户名:密码``），
  按矩阵裁决 ``lfs:read`` / ``lfs:write``，通过后签发短时效 token 放进 action.header；
- **传输端点**（upload/download/verify/delete）：只认 LFS transfer token，
  长时效 access token 一律 401。

oid 约定：LFS 线格式为裸 64 位小写 sha256 摘要（``hash_algo: sha256``），
受白名单 ``^[0-9a-f]{64}$`` 约束；对象内容必须与其 oid 一致。
"""
import base64
import hashlib

import pytest
from fastapi.testclient import TestClient

from app.models.repository import Repository
from app.models.user import User
from app.utils.git_utils import get_repository_storage_path, init_bare_repo
from app.utils.password_utils import get_password_hash
from tests.test_helpers import create_test_repo as _create_test_repo
from tests.test_helpers import create_test_user, lfs_batch


def _oid(content: bytes) -> str:
    """内容 sha256 → LFS oid（64 位小写 hex；线格式不带 ``sha256:`` 前缀）"""
    return hashlib.sha256(content).hexdigest()


def _headers(user: User) -> dict:
    from app.services.auth.token_service import create_access_token

    return {"Authorization": "Bearer " + create_access_token({
        "sub": str(user.id), "username": user.username,
        "is_admin": user.is_admin})}


def create_test_repo(db, name: str = "lfs-test-repo", owner_id=None,
                     is_public=True, path=None) -> Repository:
    """创建测试仓库（含物理 Git 仓库初始化）"""
    repo = _create_test_repo(db, name=name, owner_id=owner_id,
                             is_public=is_public, path=path)
    physical_path = get_repository_storage_path(repo.path)
    init_bare_repo(physical_path)
    return repo


def _object_url(repo_id, oid: str = "") -> str:
    base = f"/api/v1/repositories/{repo_id}/lfs/objects"
    return f"{base}/{oid}" if oid else base


class TestLFSBatch:
    def test_batch_upload_request(self, test_client: TestClient, auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-test-repo")
        oid = _oid(b"batch-upload-payload")

        response = test_client.post(
            _object_url(repo.id) + "/batch",
            json={
                "operation": "upload",
                "transfers": ["basic"],
                "ref": {"name": "main"},
                "objects": [{"oid": oid, "size": 1024}],
            },
            headers=auth_headers,
        )
        assert response.status_code == 200
        data = response.json()
        assert data["transfer"] == "basic"
        assert data["hash_algo"] == "sha256"
        assert len(data["objects"]) == 1

        actions = data["objects"][0]["actions"]
        assert "upload" in actions and "verify" in actions
        # 绝对 href（旧版返回相对 /lfs/objects/xxx，git-lfs 无法解析）
        assert actions["upload"]["href"].endswith(_object_url(repo.id, oid))
        assert actions["upload"]["href"].startswith("http://")
        # 短时效 token 走 header，不落 href query（避免进访问日志）
        assert actions["upload"]["header"]["Authorization"].startswith("Bearer ")
        assert actions["upload"]["expires_at"].endswith("Z")

    def test_batch_download_request(self, test_client: TestClient, auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-download-repo")
        payload = b"12345678"
        oid = _oid(payload)

        # 先上传，否则 download 会拿到 404 条目
        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": oid, "size": len(payload)}], auth_headers)
        assert test_client.put(_object_url(repo.id, oid), content=payload,
                               headers=write_headers).status_code == 201

        data, read_headers = lfs_batch(test_client, repo.id, "download",
                                       [{"oid": oid}], auth_headers)
        assert read_headers is not None
        assert data["objects"][0]["actions"]["download"]["href"].endswith(
            _object_url(repo.id, oid))

        # 读令牌可以下载
        response = test_client.get(_object_url(repo.id, oid), headers=read_headers)
        assert response.status_code == 200
        assert response.content == payload

    def test_batch_download_missing_object(self, test_client: TestClient,
                                           auth_headers: dict, db):
        """对象不存在 → 显式 404 条目，而不是下发一个注定失败的 action"""
        repo = create_test_repo(db, name="lfs-missing-obj")
        data, headers = lfs_batch(test_client, repo.id, "download",
                                  [{"oid": _oid(b"notthere")}], auth_headers)
        assert headers is None
        assert data["objects"][0]["error"]["code"] == 404

    def test_batch_upload_skips_existing_object(self, test_client: TestClient,
                                                auth_headers: dict, db):
        """对象已在服务端 → 不下发上传动作（客户端跳过传输）"""
        repo = create_test_repo(db, name="lfs-exists")
        payload = b"data"
        oid = _oid(payload)
        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": oid, "size": len(payload)}], auth_headers)
        assert test_client.put(_object_url(repo.id, oid), content=payload,
                               headers=write_headers).status_code == 201

        data, headers = lfs_batch(test_client, repo.id, "upload",
                                  [{"oid": oid, "size": len(payload)}], auth_headers)
        assert headers is None
        assert "actions" not in data["objects"][0]

    def test_batch_unknown_operation_rejected(self, test_client: TestClient,
                                              auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-bad-op")
        response = test_client.post(
            _object_url(repo.id) + "/batch",
            json={"operation": "teleport", "objects": []},
            headers=auth_headers,
        )
        assert response.status_code == 400

    def test_batch_requires_auth(self, test_client: TestClient, db):
        repo = create_test_repo(db, name="lfs-noauth-batch")
        response = test_client.post(
            _object_url(repo.id) + "/batch",
            json={"operation": "download", "objects": []},
        )
        assert response.status_code == 401

    def test_batch_accepts_basic_auth(self, test_client: TestClient, db):
        """git-lfs 默认用 Basic 凭证调 batch（与 git-auth 同口径）"""
        user = User(
            username="lfspusher",
            email="lfspusher@example.com",
            password=get_password_hash("s3cret-pass"),
            is_active=True,
        )
        db.add(user)
        db.commit()

        repo = create_test_repo(db, name="lfs-basic-repo", owner_id=user.id)
        basic = base64.b64encode(b"lfspusher:s3cret-pass").decode()

        data, headers = lfs_batch(
            test_client, repo.id, "upload", [{"oid": _oid(b"basic"), "size": 1}],
            {"Authorization": f"Basic {basic}"},
        )
        assert headers is not None
        assert "upload" in data["objects"][0]["actions"]

    def test_batch_rejects_bad_basic_password(self, test_client: TestClient, db):
        user = User(
            username="lfswrong",
            email="lfswrong@example.com",
            password=get_password_hash("right-pass"),
            is_active=True,
        )
        db.add(user)
        db.commit()
        repo = create_test_repo(db, name="lfs-bad-pass", owner_id=user.id)
        basic = base64.b64encode(b"lfswrong:wrong-pass").decode()

        response = test_client.post(
            _object_url(repo.id) + "/batch",
            json={"operation": "download", "objects": []},
            headers={"Authorization": f"Basic {basic}"},
        )
        assert response.status_code == 401

    def test_batch_unknown_user_rejected(self, test_client: TestClient, db):
        repo = create_test_repo(db, name="lfs-unknown-user")
        basic = base64.b64encode(b"ghost:whatever").decode()
        response = test_client.post(
            _object_url(repo.id) + "/batch",
            json={"operation": "download", "objects": []},
            headers={"Authorization": f"Basic {basic}"},
        )
        assert response.status_code == 401


class TestLFSBatchByPath:
    """git-lfs 入口：网关把 `/{owner}/{repo}.git/info/lfs/batch` 重写到
    `/api/v1/lfs/{owner}/{repo}/batch`（本模块校验应用侧那一半）。"""

    @pytest.fixture
    def path_repo(self, db, test_user):
        return create_test_repo(
            db, name="lfs-path-repo", owner_id=test_user.id,
            path=f"{test_user.username}/lfs-path-repo", is_public=False,
        )

    def test_batch_by_owner_repo_path(self, test_client: TestClient,
                                      auth_headers: dict, path_repo):
        oid = _oid(b"path1")
        response = test_client.post(
            f"/api/v1/lfs/{path_repo.path}/batch",
            json={"operation": "upload", "objects": [{"oid": oid, "size": 3}]},
            headers=auth_headers,
        )
        assert response.status_code == 200
        data = response.json()
        actions = data["objects"][0]["actions"]
        # href 仍按 repo_id 寻址（传输端点不依赖路径映射）
        assert actions["upload"]["href"].endswith(
            f"/api/v1/repositories/{path_repo.id}/lfs/objects/{oid}")
        assert actions["upload"]["header"]["Authorization"].startswith("Bearer ")

    def test_batch_by_path_unknown_repo_404(self, test_client: TestClient,
                                            auth_headers: dict):
        response = test_client.post(
            "/api/v1/lfs/nobody/no-such-repo/batch",
            json={"operation": "download", "objects": []},
            headers=auth_headers,
        )
        assert response.status_code == 404

    def test_batch_by_path_denied_for_outsider(self, test_client: TestClient, db,
                                               path_repo):
        outsider = create_test_user(db, username="lfs-path-outsider")
        response = test_client.post(
            f"/api/v1/lfs/{path_repo.path}/batch",
            json={"operation": "download", "objects": []},
            headers=_headers(outsider),
        )
        assert response.status_code == 403


class TestLFSTransfer:
    def test_upload_object(self, test_client: TestClient, auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-upload-repo")
        payload = b"Hello, LFS!"
        oid = _oid(payload)

        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": oid, "size": len(payload)}], auth_headers)
        response = test_client.put(
            _object_url(repo.id, oid),
            content=payload,
            headers={**write_headers, "Content-Type": "application/octet-stream"},
        )
        assert response.status_code == 201
        assert response.json()["oid"] == oid

    def test_download_object(self, test_client: TestClient, auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-dl-repo")
        payload = b"Download me"
        oid = _oid(payload)

        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": oid, "size": len(payload)}], auth_headers)
        test_client.put(_object_url(repo.id, oid), content=payload,
                        headers=write_headers)

        _, read_headers = lfs_batch(test_client, repo.id, "download",
                                    [{"oid": oid}], auth_headers)
        response = test_client.get(_object_url(repo.id, oid), headers=read_headers)
        assert response.status_code == 200
        assert response.content == payload

    def test_verify_object(self, test_client: TestClient, auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-verify-repo")
        payload = b"1234567"
        oid = _oid(payload)
        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": oid, "size": len(payload)}], auth_headers)
        test_client.put(_object_url(repo.id, oid), content=payload,
                        headers=write_headers)

        ok = test_client.post(_object_url(repo.id, oid) + "/verify",
                              json={"oid": oid, "size": len(payload)},
                              headers=write_headers)
        assert ok.status_code == 200

        mismatch = test_client.post(_object_url(repo.id, oid) + "/verify",
                                    json={"oid": oid, "size": 99}, headers=write_headers)
        assert mismatch.status_code == 400

        absent_oid = _oid(b"absent")
        absent = test_client.post(_object_url(repo.id, absent_oid) + "/verify",
                                  json={"oid": absent_oid, "size": 1},
                                  headers=write_headers)
        assert absent.status_code == 404

    def test_delete_object(self, test_client: TestClient, auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-delete-repo")
        payload = b"Delete me"
        oid = _oid(payload)
        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": oid, "size": len(payload)}], auth_headers)
        test_client.put(_object_url(repo.id, oid), content=payload,
                        headers=write_headers)

        response = test_client.delete(_object_url(repo.id, oid), headers=write_headers)
        assert response.status_code == 204

        # 已删除 → 下一次 download batch 只拿到 404 条目
        data, read_headers = lfs_batch(test_client, repo.id, "download",
                                       [{"oid": oid}], auth_headers)
        assert read_headers is None
        assert data["objects"][0].get("error", {}).get("code") == 404

    def test_transfer_requires_token(self, test_client: TestClient, db):
        repo = create_test_repo(db, name="lfs-noauth-xfer")
        response = test_client.put(_object_url(repo.id, _oid(b"data")),
                                   content=b"data")
        assert response.status_code == 401

    def test_transfer_rejects_access_token(self, test_client: TestClient,
                                           auth_headers: dict, db):
        """长时效 access token 不得直接用于传输端点（只在 batch 入口有效）"""
        repo = create_test_repo(db, name="lfs-xfer-access")
        oid = _oid(b"data")
        put = test_client.put(_object_url(repo.id, oid), content=b"data",
                              headers=auth_headers)
        assert put.status_code == 401

        get = test_client.get(_object_url(repo.id, oid), headers=auth_headers)
        assert get.status_code == 401

        delete = test_client.delete(_object_url(repo.id, oid),
                                    headers=auth_headers)
        assert delete.status_code == 401


class TestLFSOidGuard:
    """oid 白名单 + 上传内容 sha256 校验

    oid 会拼进存储路径参与存在性判断与文件读写；未校验即可探测/穿越路径，
    且 oid 即内容 sha256，不校验则可覆盖破坏同仓既有对象。
    """

    def test_batch_malformed_oid_rejected(self, test_client: TestClient,
                                          auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-oid-batch")
        response = test_client.post(
            _object_url(repo.id) + "/batch",
            json={"operation": "download", "objects": [{"oid": "not-a-sha256"}]},
            headers=auth_headers,
        )
        assert response.status_code == 400
        assert response.json()["error"]["error_code"] == "lfs_oid_invalid"

    def test_batch_prefixed_oid_rejected(self, test_client: TestClient,
                                         auth_headers: dict, db):
        """``sha256:`` 前缀只存在于指针文件；线格式必须是裸摘要"""
        repo = create_test_repo(db, name="lfs-oid-prefixed")
        response = test_client.post(
            _object_url(repo.id) + "/batch",
            json={"operation": "download",
                  "objects": [{"oid": "sha256:" + "a" * 64}]},
            headers=auth_headers,
        )
        assert response.status_code == 400
        assert response.json()["error"]["error_code"] == "lfs_oid_invalid"

    def test_upload_oid_must_be_valid(self, test_client: TestClient,
                                      auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-oid-upload")
        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": _oid(b"seed"), "size": 4}],
                                     auth_headers)
        response = test_client.put(_object_url(repo.id, "bad-oid"),
                                   content=b"seed", headers=write_headers)
        assert response.status_code == 400
        assert response.json()["error"]["error_code"] == "lfs_oid_invalid"

    def test_upload_content_hash_must_match_oid(self, test_client: TestClient,
                                                auth_headers: dict, db):
        """oid 与内容不符 → 400（否则可覆盖同仓既有对象）"""
        repo = create_test_repo(db, name="lfs-hash-mismatch")
        declared_oid = _oid(b"expected-content")
        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": declared_oid, "size": 8}],
                                     auth_headers)
        response = test_client.put(_object_url(repo.id, declared_oid),
                                   content=b"tampered", headers=write_headers)
        assert response.status_code == 400
        assert response.json()["error"]["error_code"] == "lfs_hash_mismatch"

    def test_download_malformed_oid_rejected(self, test_client: TestClient,
                                             auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-oid-download")
        # batch 仅对已存在对象下发 download action，先落一个对象换只读 token
        seed_payload = b"seed"
        seed_oid = _oid(seed_payload)
        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": seed_oid, "size": len(seed_payload)}],
                                     auth_headers)
        test_client.put(_object_url(repo.id, seed_oid), content=seed_payload,
                        headers=write_headers)
        _, read_headers = lfs_batch(test_client, repo.id, "download",
                                    [{"oid": seed_oid}], auth_headers)
        assert read_headers is not None
        response = test_client.get(_object_url(repo.id, "bad-oid"),
                                   headers=read_headers)
        assert response.status_code == 400
        assert response.json()["error"]["error_code"] == "lfs_oid_invalid"

    def test_verify_malformed_oid_rejected(self, test_client: TestClient,
                                           auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-oid-verify")
        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": _oid(b"seed"), "size": 4}],
                                     auth_headers)
        response = test_client.post(_object_url(repo.id, "bad-oid") + "/verify",
                                    json={"oid": "bad-oid", "size": 1},
                                    headers=write_headers)
        assert response.status_code == 400
        assert response.json()["error"]["error_code"] == "lfs_oid_invalid"

    def test_delete_malformed_oid_rejected(self, test_client: TestClient,
                                           auth_headers: dict, db):
        repo = create_test_repo(db, name="lfs-oid-delete")
        _, write_headers = lfs_batch(test_client, repo.id, "upload",
                                     [{"oid": _oid(b"seed"), "size": 4}],
                                     auth_headers)
        response = test_client.delete(_object_url(repo.id, "bad-oid"),
                                      headers=write_headers)
        assert response.status_code == 400
        assert response.json()["error"]["error_code"] == "lfs_oid_invalid"
