"""Agent 配额/成本控制 + worker 广播总线测试"""
import pytest

from app.core.config import get_config
from app.core.exception import RateLimitException
from app.models.agent import AgentJob, AgentSession
from app.services.agent_service import AgentService


async def _add_job(db, user, repo, *, status="queued", tokens=0):
    session = AgentSession(user_id=user.id, repository_id=repo.id, title="t")
    db.add(session)
    await db.commit()
    await db.refresh(session)
    job = AgentJob(
        session_id=session.id, repository_id=repo.id, user_id=user.id,
        status=status, prompt="q", provider="fake", model="test", tokens_used=tokens,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


def _noop_queue(monkeypatch):
    class _Q:
        async def enqueue(self, job_id, provider=None):
            return None

    async def _get():
        return _Q()

    monkeypatch.setattr("app.services.agent.queue.get_job_queue", _get)


def _set_limits(monkeypatch, *, user=0, glob=0, daily=0, tokens=0):
    cfg = get_config().agent
    monkeypatch.setattr(cfg, "max_active_jobs_per_user", user, raising=False)
    monkeypatch.setattr(cfg, "max_active_jobs_global", glob, raising=False)
    monkeypatch.setattr(cfg, "daily_job_limit_per_user", daily, raising=False)
    monkeypatch.setattr(cfg, "daily_token_budget_per_user", tokens, raising=False)
    return cfg


@pytest.mark.asyncio
async def test_user_concurrency_cap(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    _set_limits(monkeypatch, user=1)
    await _add_job(async_db, async_test_user, async_test_repo, status="running")

    with pytest.raises(RateLimitException) as exc:
        await AgentService().create_job(
            async_db, async_test_user, async_test_repo.id, "hello"
        )
    assert exc.value.error_code == "agent_user_concurrency_exceeded"
    assert exc.value.status_code == 429


@pytest.mark.asyncio
async def test_global_concurrency_cap(
    async_db, async_test_user, async_test_user2, async_test_repo, monkeypatch, agent_enabled
):
    _set_limits(monkeypatch, glob=1)
    # 另一个用户占用了全局唯一的在跑名额
    await _add_job(async_db, async_test_user2, async_test_repo, status="queued")

    with pytest.raises(RateLimitException) as exc:
        await AgentService().create_job(
            async_db, async_test_user, async_test_repo.id, "hello"
        )
    assert exc.value.error_code == "agent_global_concurrency_exceeded"


@pytest.mark.asyncio
async def test_daily_job_limit_counts_terminal_jobs(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    _set_limits(monkeypatch, daily=1)
    # 终态作业不占用并发，但仍计入「今日作业数」
    await _add_job(async_db, async_test_user, async_test_repo, status="succeeded")

    with pytest.raises(RateLimitException) as exc:
        await AgentService().create_job(
            async_db, async_test_user, async_test_repo.id, "hello"
        )
    assert exc.value.error_code == "agent_daily_job_limit_exceeded"


@pytest.mark.asyncio
async def test_daily_token_budget(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    _set_limits(monkeypatch, tokens=100)
    await _add_job(async_db, async_test_user, async_test_repo, tokens=100)

    with pytest.raises(RateLimitException) as exc:
        await AgentService().create_job(
            async_db, async_test_user, async_test_repo.id, "hello"
        )
    assert exc.value.error_code == "agent_token_budget_exceeded"


@pytest.mark.asyncio
async def test_under_limits_allows_creation(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    _set_limits(monkeypatch, user=5, glob=10, daily=10, tokens=1000)
    _noop_queue(monkeypatch)
    job = await AgentService().create_job(
        async_db, async_test_user, async_test_repo.id, "hello"
    )
    assert job.status == "queued"


@pytest.mark.asyncio
async def test_worker_startup_binds_and_starts_bus(monkeypatch):
    """arq worker 启动时注入并启动广播总线"""
    from app.services.agent import worker
    from app.utils.realtime_bus import bus

    calls = {}

    monkeypatch.setattr("app.models.async_db.get_async_engine", lambda: None)
    monkeypatch.setattr(bus, "bind", lambda mgr: calls.setdefault("bound", mgr))

    async def _start():
        calls["started"] = True
        return True

    monkeypatch.setattr(bus, "start", _start)

    from app.api.ws.manager import manager

    await worker.on_startup(None)
    assert calls.get("bound") is manager
    assert calls.get("started") is True


@pytest.mark.asyncio
async def test_worker_shutdown_stops_bus(monkeypatch):
    from app.services.agent import worker
    from app.utils.realtime_bus import bus

    calls = {}

    async def _stop():
        calls["stopped"] = True

    monkeypatch.setattr(bus, "stop", _stop)
    await worker.on_shutdown(None)
    assert calls.get("stopped") is True
