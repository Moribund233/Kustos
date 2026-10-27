"""第二批端点契约：Agent 用量聚合 + 仓库索引状态/手动重建 + admin 索引总览。"""
import uuid as uuid_lib
from datetime import datetime, timedelta, timezone

import pytest


def _err(resp) -> dict:
    body = resp.json()
    assert "error" in body, f"缺少 error 信封: {body}"
    return body["error"]


def _mk_repo(db, owner_id):
    from app.models.repository import Repository

    repo = Repository(
        name=f"idx-{uuid_lib.uuid4().hex[:8]}",
        path=f"usage/{uuid_lib.uuid4().hex[:12]}",
        owner_id=owner_id,
    )
    db.add(repo)
    db.commit()
    db.refresh(repo)
    return repo


class TestAgentUsage:
    """GET /api/app/agent/usage——admin 概览图表的数据面"""

    def test_requires_auth(self, test_client):
        assert test_client.get("/api/app/agent/usage").status_code == 401

    def test_non_admin_forbidden(self, test_client, auth_headers):
        resp = test_client.get("/api/app/agent/usage", headers=auth_headers)
        assert resp.status_code == 403

    def test_days_out_of_range_rejected(self, test_client, admin_headers):
        assert (
            test_client.get("/api/app/agent/usage?days=0", headers=admin_headers).status_code
            == 422
        )
        assert (
            test_client.get(
                "/api/app/agent/usage?days=999", headers=admin_headers
            ).status_code
            == 422
        )

    def test_usage_shape_and_aggregation(
        self, test_client, admin_headers, admin_user, db
    ):
        from app.models.agent import AgentJob, AgentSession, AgentStep

        repo = _mk_repo(db, admin_user.id)
        session = AgentSession(
            user_id=admin_user.id, repository_id=repo.id, title="usage"
        )
        db.add(session)
        db.commit()
        db.refresh(session)

        now = datetime.now(timezone.utc)
        job_ok = AgentJob(
            session_id=session.id,
            repository_id=repo.id,
            user_id=admin_user.id,
            status="succeeded",
            prompt="p1",
            tokens_used=1200,
            started_at=now - timedelta(seconds=40),
            finished_at=now,
        )
        job_bad = AgentJob(
            session_id=session.id,
            repository_id=repo.id,
            user_id=admin_user.id,
            status="failed",
            prompt="p2",
            tokens_used=300,
        )
        db.add_all([job_ok, job_bad])
        db.commit()
        db.refresh(job_ok)
        db.add_all(
            [
                AgentStep(job_id=job_ok.id, seq=1, type="user", content="hi"),
                AgentStep(
                    job_id=job_ok.id, seq=2, type="tool_call", name="search_code",
                    data="{}",
                ),
                AgentStep(
                    job_id=job_ok.id, seq=3, type="tool_call", name="search_code",
                    data="{}",
                ),
                AgentStep(
                    job_id=job_ok.id, seq=4, type="tool_call", name="read_file",
                    data="{}",
                ),
            ]
        )
        db.commit()

        resp = test_client.get("/api/app/agent/usage?days=7", headers=admin_headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # 空天补齐：恒为 days 个桶，最后一桶 = 今天（UTC）
        assert data["days"] == 7
        assert len(data["daily"]) == 7
        assert data["totals"] == {
            "jobs": 2,
            "succeeded": 1,
            "failed": 1,
            "tokens": 1500,
        }
        today = data["daily"][-1]
        assert today["jobs"] == 2 and today["tokens"] == 1500
        assert today["succeeded"] == 1 and today["failed"] == 1
        assert today["avg_duration_s"] is not None and today["avg_duration_s"] > 0
        # 空天的 avg 为 None（而非 0——区分「没有作业」与「瞬时完成」）
        assert all(
            b["avg_duration_s"] is None for b in data["daily"][:-1] if b["jobs"] == 0
        )
        assert data["tools"][0] == {"name": "search_code", "calls": 2}
        assert {"name": "read_file", "calls": 1} in data["tools"]

    def test_empty_range_returns_zero_shape(self, test_client, admin_headers):
        resp = test_client.get("/api/app/agent/usage?days=3", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["totals"]["jobs"] == 0
        assert len(data["daily"]) == 3 and data["tools"] == []


class TestRepoIndexStatus:
    """GET .../search/index-status + POST .../search/reindex（仓库级，非 admin）"""

    def test_status_requires_auth(self, test_client):
        rid = uuid_lib.uuid4()
        assert (
            test_client.get(
                f"/api/v1/repositories/{rid}/search/index-status"
            ).status_code
            in (401, 404)
        )

    def test_status_shape_when_never_indexed(
        self, test_client, auth_headers, test_user, db
    ):
        repo = _mk_repo(db, test_user.id)
        resp = test_client.get(
            f"/api/v1/repositories/{repo.id}/search/index-status",
            headers=auth_headers,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # 物理目录不存在（纯 DB 夹具）→ head 为空、未索引，字段形状完整
        assert data["head_commit"] is None
        assert data["indexed_commit"] is None
        assert data["in_sync"] is False
        assert data["chunks"] == 0 and data["refs"] == 0 and data["embeddings"] == 0
        assert data["current_generation"] >= 1
        assert isinstance(data["semantic_enabled"], bool)

    def test_reindex_returns_started(
        self, test_client, auth_headers, test_user, db
    ):
        repo = _mk_repo(db, test_user.id)
        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/search/reindex", headers=auth_headers
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["started"] is True

    def test_reindex_requires_auth(self, test_client, db, test_user):
        repo = _mk_repo(db, test_user.id)
        resp = test_client.post(f"/api/v1/repositories/{repo.id}/search/reindex")
        assert resp.status_code == 401

    def test_is_rebuilding_lock_flag(self):
        """is_rebuilding 反映 per-repo 锁（同进程重复触发的挡板）。

        用随机 key：不碰真实仓库的锁缓存，避免与后台重建任务跨事件循环串扰。
        """
        import asyncio

        from app.services.search_service import SearchService, _local_rebuild_lock

        key = uuid_lib.uuid4()

        async def _scenario():
            service = SearchService()
            assert await service.is_rebuilding(key) is False
            lock = await _local_rebuild_lock(key)
            async with lock:
                assert await service.is_rebuilding(key) is True
            assert await service.is_rebuilding(key) is False

        asyncio.run(_scenario())


class TestIndexOverview:
    """GET /api/app/search/index-overview——admin 索引页数据面"""

    def test_requires_auth(self, test_client):
        assert (
            test_client.get("/api/app/search/index-overview").status_code == 401
        )

    def test_non_admin_forbidden(self, test_client, auth_headers):
        resp = test_client.get("/api/app/search/index-overview", headers=auth_headers)
        assert resp.status_code == 403

    def test_overview_shape_and_counts(
        self, test_client, admin_headers, admin_user, db
    ):
        from app.models.repo_search import RepoSearchState

        repo1 = _mk_repo(db, admin_user.id)  # 无 state → never_indexed
        repo2 = _mk_repo(db, admin_user.id)  # 有 state 但 head 为空 → stale
        db.add(
            RepoSearchState(
                repository_id=repo2.id, indexed_commit="deadbeef", index_generation=1
            )
        )
        db.commit()

        resp = test_client.get(
            "/api/app/search/index-overview", headers=admin_headers
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["totals"]["repos"] >= 2
        assert data["totals"]["never_indexed"] >= 1
        assert data["totals"]["stale"] >= 1
        assert set(data["totals"]) == {
            "repos", "in_sync", "stale", "never_indexed",
            "chunks", "refs", "embeddings",
        }
        assert isinstance(data["semantic_enabled"], bool)
        by_id = {r["id"]: r for r in data["repos"]}
        r1 = by_id[str(repo1.id)]
        assert r1["indexed_commit"] is None and r1["in_sync"] is False
        r2 = by_id[str(repo2.id)]
        assert r2["indexed_commit"] == "deadbeef" and r2["in_sync"] is False
        assert r2["chunks"] == 0
