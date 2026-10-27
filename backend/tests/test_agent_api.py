"""Agent API 端点测试（含审批 / kill switch）"""
from fastapi.testclient import TestClient

from app.utils.git_utils import init_bare_repo, get_repository_storage_path
from tests.test_helpers import create_test_repo as _create_test_repo


def create_repo(db, name: str):
    repo = _create_test_repo(db, name=name)
    init_bare_repo(get_repository_storage_path(repo.path))
    return repo


class TestAgentAPI:
    def test_create_list_get_job(
        self, test_client: TestClient, auth_headers: dict, db, monkeypatch, agent_enabled
    ):
        # 端到端只测 API 编排：内联队列改为记录器，避免后台任务与 teardown 竞争
        recorded = []

        class _RecQueue:
            async def enqueue(self, job_id, provider=None):
                recorded.append(job_id)

        async def _fake_get_queue():
            return _RecQueue()

        monkeypatch.setattr("app.services.agent.queue.get_job_queue", _fake_get_queue)
        repo = create_repo(db, "agent-create-repo")
        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/agent/jobs",
            json={"prompt": "你好，介绍一下这个仓库"},
            headers=auth_headers,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] in ("queued", "running", "succeeded", "failed")
        assert data["prompt"] == "你好，介绍一下这个仓库"
        assert "api_key" not in data and "api_key" not in resp.text
        job_id = data["id"]

        one = test_client.get(
            f"/api/v1/repositories/{repo.id}/agent/jobs/{job_id}", headers=auth_headers
        )
        assert one.status_code == 200 and one.json()["id"] == job_id

        listing = test_client.get(
            f"/api/v1/repositories/{repo.id}/agent/jobs", headers=auth_headers
        )
        assert listing.status_code == 200 and any(j["id"] == job_id for j in listing.json()["jobs"])

        steps = test_client.get(
            f"/api/v1/repositories/{repo.id}/agent/jobs/{job_id}/steps", headers=auth_headers
        )
        assert steps.status_code == 200 and "steps" in steps.json()

    def test_api_key_not_echoed(
        self, test_client: TestClient, auth_headers: dict, db, monkeypatch, agent_enabled
    ):
        async def _noop(self, job_id, provider=None):
            return None

        monkeypatch.setattr("app.services.agent.queue.InlineJobQueue.enqueue", _noop)
        repo = create_repo(db, "agent-key-repo")
        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/agent/jobs",
            json={"prompt": "p", "api_key": "sk-very-secret"},
            headers=auth_headers,
        )
        assert resp.status_code == 200, resp.text
        assert "sk-very-secret" not in resp.text
        assert resp.json()["provider"] == "openai"

    def test_kill_switch_rejects_when_disabled(self, test_client: TestClient, auth_headers: dict, db):
        repo = create_repo(db, "agent-killswitch-repo")
        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/agent/jobs",
            json={"prompt": "p"},
            headers=auth_headers,
        )
        assert resp.status_code == 403
        assert "未启用" in resp.json()["detail"]

    def test_base_url_requires_api_key(
        self, test_client: TestClient, auth_headers: dict, db, monkeypatch, agent_enabled
    ):
        from app.core.config import get_config

        monkeypatch.setattr(get_config().agent, "allowed_base_urls", "https://notes.a.com", raising=False)
        repo = create_repo(db, "agent-url-repo")
        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/agent/jobs",
            json={"prompt": "p", "base_url": "https://notes.a.com/v1"},
            headers=auth_headers,
        )
        assert resp.status_code == 400
        assert "api_key" in resp.json()["detail"]

    def test_requires_auth(self, test_client: TestClient, db):
        repo = create_repo(db, "agent-auth-repo")
        resp = test_client.post(
            f"/api/v1/repositories/{repo.id}/agent/jobs", json={"prompt": "p"}
        )
        assert resp.status_code == 401
