"""中断作业回收：running/queued 超时自愈，以及创建作业时的配额前置复核"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import update

from app.core.config import get_config
from app.core.exception import RateLimitException
from app.models.agent import AgentJob, AgentSession
from app.services.agent_service import AgentService, reclaim_stale_jobs
from app.services.retention_service import RetentionService


async def _add_job(
    db, user, repo, *, status, age_minutes=30, runtime_state=None
) -> AgentJob:
    """建作业并把 ``updated_at`` 拨到 ``age_minutes`` 之前。

    ``age_minutes=None`` 表示不动时间戳（保持刚写入的新鲜状态）。
    时间戳用显式 ``update()`` 写入：列级 ``onupdate`` 只对未显式赋值的列生效。
    """
    session = AgentSession(user_id=user.id, repository_id=repo.id, title="t")
    db.add(session)
    await db.commit()
    await db.refresh(session)
    job = AgentJob(
        session_id=session.id, repository_id=repo.id, user_id=user.id,
        status=status, prompt="q", provider="fake", model="test",
        runtime_state=runtime_state,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    if age_minutes is not None:
        await db.execute(
            update(AgentJob)
            .where(AgentJob.id == job.id)
            .values(
                updated_at=datetime.now(timezone.utc) - timedelta(minutes=age_minutes)
            )
        )
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


@pytest.mark.asyncio
async def test_reclaims_stale_running_and_queued(async_db, async_test_user, async_test_repo):
    stale_running = await _add_job(
        async_db, async_test_user, async_test_repo,
        status="running", runtime_state='[{"role": "system"}]',
    )
    stale_queued = await _add_job(
        async_db, async_test_user, async_test_repo, status="queued"
    )
    fresh_running = await _add_job(
        async_db, async_test_user, async_test_repo, status="running", age_minutes=1
    )
    awaiting = await _add_job(
        async_db, async_test_user, async_test_repo, status="awaiting_approval"
    )

    assert await reclaim_stale_jobs(async_db) == 2

    await async_db.refresh(stale_running)
    assert stale_running.status == "failed"
    assert stale_running.finished_at is not None
    assert "执行中断" in (stale_running.error or "")
    assert stale_running.runtime_state is None  # 终态清空恢复上下文

    await async_db.refresh(stale_queued)
    assert stale_queued.status == "failed"
    assert "未被执行" in (stale_queued.error or "")

    await async_db.refresh(fresh_running)
    assert fresh_running.status == "running"

    await async_db.refresh(awaiting)
    assert awaiting.status == "awaiting_approval"  # 等人审批，不回收

    # 失败原因同步写进步骤时间线，用户能看出为什么结束
    steps = await AgentService().get_steps(async_db, async_test_user, stale_running.id)
    assert [s.type for s in steps] == ["error"]
    assert steps[0].content == stale_running.error
    assert stale_running.step_count == 1

    # 二次执行幂等：已回收的不再命中
    assert await reclaim_stale_jobs(async_db) == 0


@pytest.mark.asyncio
async def test_reclaim_disabled_when_threshold_zero(
    async_db, async_test_user, async_test_repo, monkeypatch
):
    job = await _add_job(async_db, async_test_user, async_test_repo, status="running")
    monkeypatch.setattr(
        get_config().agent, "stale_job_timeout_minutes", 0, raising=False
    )

    assert await reclaim_stale_jobs(async_db) == 0
    await async_db.refresh(job)
    assert job.status == "running"


@pytest.mark.asyncio
async def test_create_job_reclaims_stale_before_rejecting(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    """并发闸门被僵尸作业占满时：先回收再复核，用户立即拿到新名额"""
    monkeypatch.setattr(
        get_config().agent, "max_active_jobs_per_user", 1, raising=False
    )
    stale = await _add_job(async_db, async_test_user, async_test_repo, status="running")
    _noop_queue(monkeypatch)

    job = await AgentService().create_job(
        async_db, async_test_user, async_test_repo.id, "hello"
    )
    assert job.status == "queued"
    await async_db.refresh(stale)
    assert stale.status == "failed"


@pytest.mark.asyncio
async def test_create_job_still_rejects_when_nothing_to_reclaim(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    """确属真实配额超限时仍应 429，且回收不得误伤在跑作业"""
    monkeypatch.setattr(
        get_config().agent, "max_active_jobs_per_user", 1, raising=False
    )
    running = await _add_job(
        async_db, async_test_user, async_test_repo, status="running", age_minutes=1
    )
    _noop_queue(monkeypatch)

    with pytest.raises(RateLimitException) as exc:
        await AgentService().create_job(
            async_db, async_test_user, async_test_repo.id, "hello"
        )
    assert exc.value.error_code == "agent_user_concurrency_exceeded"
    await async_db.refresh(running)
    assert running.status == "running"


@pytest.mark.asyncio
async def test_retention_run_once_reclaims_interrupted_jobs(
    async_db, async_test_user, async_test_repo, monkeypatch
):
    """保留任务是回收器的周期挂载点：一轮执行顺带回收中断作业"""
    logging_cfg = get_config().logging
    monkeypatch.setattr(logging_cfg, "log_keep_days", 0, raising=False)
    monkeypatch.setattr(logging_cfg, "activity_keep_days", 0, raising=False)
    job = await _add_job(async_db, async_test_user, async_test_repo, status="running")

    result = await RetentionService().run_once()

    assert result["stale_jobs_reclaimed"] == 1
    await async_db.refresh(job)
    assert job.status == "failed"
