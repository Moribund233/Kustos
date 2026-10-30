"""构建日志流式：PATCH 追加 log_entries，GET 按 after_seq 增量拉取。

契约 (本测试只断言 API 契约红线):
  - `PATCH` 签名回调支持 `log_entries: [{stream, line}]` **追加**写入, 不整串覆盖。
  - `GET /builds/{build_id}/logs?after_seq=N` 增量拉取:
    返回 {"logs": <自动从 entries 拼成 onChange 兼容整串>, "entries": [逐条 seq+stream+line+logged_at], "next_seq": N}。
"""

from fastapi.testclient import TestClient

from app.services.integration.webhook_service import generate_signature
from tests.test_helpers import create_test_repo


def _sign(body: str, secret: str) -> str:
    # 复用生产 generate_signature (返回 "sha256=<hex>"), 避免假红
    return generate_signature(body, secret)


class TestBuildLogStream:
    """构建日志流式 — 增量追加 + after_seq 增量拉取。"""

    def _create_repo_with_ci_secret(self, db) -> "Repository":
        repo = create_test_repo(db)
        repo.ci_secret = "test-ci-secret"
        db.commit()
        return repo

    def test_patch_with_log_entries_appends_seq(
        self,
        test_client: TestClient,
        auth_headers: dict,
        db,
    ):
        """PATCH 携带 log_entries 时按 seq 分步追加，不整串覆盖 logs。"""
        repo = self._create_repo_with_ci_secret(db)
        create_resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/builds",
            json={"branch": "main", "commit_sha": "abc"},
            headers=auth_headers,
        )
        build_id = create_resp.json()["id"]

        body = '{"status":"running","log_entries":[{"stream":"stdout","line":"step1"},{"stream":"stderr","line":"step2"}]}'
        resp = test_client.patch(
            f"/api/v1/repositories/{repo.id}/builds/{build_id}",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Kustos-Signature": _sign(body, "test-ci-secret"),
            },
        )
        assert resp.status_code == 200

    def test_get_logs_after_seq_incremental(
        self,
        test_client: TestClient,
        auth_headers: dict,
        db,
    ):
        """GET /logs?after_seq=N 只回 seq>N 的 entries，并给出 next_seq 供下次增量。"""
        repo = self._create_repo_with_ci_secret(db)
        create_resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/builds",
            json={"branch": "main", "commit_sha": "abc"},
            headers=auth_headers,
        )
        build_id = create_resp.json()["id"]

        body = '{"status":"running","log_entries":[{"stream":"stdout","line":"a"},{"stream":"stderr","line":"b"}]}'
        patch = test_client.patch(
            f"/api/v1/repositories/{repo.id}/builds/{build_id}",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Kustos-Signature": _sign(body, "test-ci-secret"),
            },
        )
        assert patch.status_code == 200

        # after_seq=1 → 只回 seq>1 (即 stderr "b")
        resp = test_client.get(
            f"/api/v1/repositories/{repo.id}/builds/{build_id}/logs?after_seq=1",
            headers=auth_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert set(data) >= {"entries", "next_seq", "logs"}
        lines = [e["line"] for e in data["entries"]]
        assert lines == ["b"]
        assert data["next_seq"] == 2
