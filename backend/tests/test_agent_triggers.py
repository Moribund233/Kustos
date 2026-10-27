"""Agent 触发器：事件派发 / 去重节流 / 自主只读。

触发器把平台事件映射为**只读**Agent 作业（``origin="trigger"``），结论回帖目标
频道；执行者为内置 bot 用户。派发为 best-effort。
"""
import pytest
from sqlalchemy import select

from app.models.agent import AgentJob, AgentSession
from app.models.agent_trigger import AgentTrigger, AgentTriggerRun
from app.services.agent.triggers import AgentTriggerService


def _enable_triggers(monkeypatch):
    from app.core.config import get_config

    monkeypatch.setattr(get_config().agent, "triggers_enabled", True, raising=False)


def _stub_queue(monkeypatch):
    recorded = []

    class _Q:
        async def enqueue(self, job_id, provider=None):
            recorded.append(job_id)

    async def _get():
        return _Q()

    monkeypatch.setattr("app.services.agent.queue.get_job_queue", _get)
    return recorded


@pytest.mark.asyncio
async def test_create_trigger_rejects_unknown_event(async_db, async_test_repo):
    with pytest.raises(ValueError):
        await AgentTriggerService().create_trigger(
            async_db, async_test_repo.id, event_type="nope", prompt_template="x"
        )


@pytest.mark.asyncio
async def test_dispatch_creates_readonly_job_and_dedups(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    _enable_triggers(monkeypatch)
    recorded = _stub_queue(monkeypatch)

    await AgentTriggerService().create_trigger(
        async_db, async_test_repo.id, event_type="push",
        prompt_template="审查 {branch} 的推送 {sha}",
        created_by=async_test_user.id,
    )
    ids = await AgentTriggerService().dispatch_event(
        async_db, async_test_repo.id, "push", dedup_key="refs/heads/main:abc",
        context={"branch": "main", "sha": "abc"},
    )
    assert len(ids) == 1
    job = (
        await async_db.execute(select(AgentJob).where(AgentJob.id == ids[0]))
    ).scalar_one()
    assert job.origin == "trigger"
    assert "main" in job.prompt and "abc" in job.prompt  # 模板已渲染
    assert recorded == [ids[0]]  # 已入队

    runs = (await async_db.execute(select(AgentTriggerRun))).scalars().all()
    assert len(runs) == 1 and runs[0].dedup_key == "refs/heads/main:abc"

    # 同 dedup_key 再次派发 → 去重，不再建作业
    ids2 = await AgentTriggerService().dispatch_event(
        async_db, async_test_repo.id, "push", dedup_key="refs/heads/main:abc",
        context={"branch": "main", "sha": "abc"},
    )
    assert ids2 == []


@pytest.mark.asyncio
async def test_dispatch_throttles_within_interval(
    async_db, async_test_repo, monkeypatch, agent_enabled
):
    _enable_triggers(monkeypatch)
    _stub_queue(monkeypatch)
    await AgentTriggerService().create_trigger(
        async_db, async_test_repo.id, event_type="push",
        prompt_template="review", min_interval_seconds=3600,
    )
    first = await AgentTriggerService().dispatch_event(
        async_db, async_test_repo.id, "push", dedup_key="k1", context={}
    )
    assert len(first) == 1
    # 不同 dedup_key 但仍在节流窗口内 → 跳过
    second = await AgentTriggerService().dispatch_event(
        async_db, async_test_repo.id, "push", dedup_key="k2", context={}
    )
    assert second == []


@pytest.mark.asyncio
async def test_dispatch_disabled_when_kill_switch_off(
    async_db, async_test_repo, monkeypatch, agent_enabled
):
    _stub_queue(monkeypatch)
    await AgentTriggerService().create_trigger(
        async_db, async_test_repo.id, event_type="push", prompt_template="x"
    )
    # triggers_enabled 默认 False → 不派发
    ids = await AgentTriggerService().dispatch_event(
        async_db, async_test_repo.id, "push", dedup_key="k", context={}
    )
    assert ids == []


@pytest.mark.asyncio
async def test_dispatch_build_failed_event(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    _enable_triggers(monkeypatch)
    _stub_queue(monkeypatch)
    await AgentTriggerService().create_trigger(
        async_db, async_test_repo.id, event_type="build_failed",
        prompt_template="CI 失败于 {branch}：{failure_summary}",
        created_by=async_test_user.id,
    )
    ids = await AgentTriggerService().dispatch_event(
        async_db, async_test_repo.id, "build_failed", dedup_key="build-1",
        context={"branch": "main", "failure_summary": "exit code 1"},
    )
    assert len(ids) == 1
    job = (
        await async_db.execute(select(AgentJob).where(AgentJob.id == ids[0]))
    ).scalar_one()
    assert job.origin == "trigger" and "exit code 1" in job.prompt


@pytest.mark.asyncio
async def test_dispatch_scheduled_creates_and_dedups(
    async_db, async_test_repo, monkeypatch, agent_enabled
):
    _enable_triggers(monkeypatch)
    _stub_queue(monkeypatch)
    await AgentTriggerService().create_trigger(
        async_db, async_test_repo.id, event_type="schedule",
        prompt_template="每日站会 {date}", min_interval_seconds=86400,
    )
    first = await AgentTriggerService().dispatch_scheduled(async_db)
    assert len(first) == 1
    # 同一时间片（同一天）再次扫描 → 去重，不再触发
    second = await AgentTriggerService().dispatch_scheduled(async_db)
    assert second == []

    job = (
        await async_db.execute(select(AgentJob).where(AgentJob.id == first[0]))
    ).scalar_one()
    assert job.origin == "trigger" and job.prompt.startswith("每日站会")


def test_worker_settings_exposes_cron_jobs():
    """arq 定时巡航：WorkerSettings 必须有类体求值的 cron_jobs（property 会崩 worker）"""
    from app.services.agent.worker import WorkerSettings

    cron_jobs = WorkerSettings.__dict__.get("cron_jobs")
    assert isinstance(cron_jobs, list) and cron_jobs


class _ToolsCapturingProvider:
    name = "cap"
    model = "test"

    def __init__(self):
        self.tools = None

    async def complete(self, messages, tools):
        from app.services.agent.providers import ModelReply

        self.tools = tools
        return ModelReply(content="done", tool_calls=[])


@pytest.mark.asyncio
async def test_process_job_trigger_origin_is_readonly(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    _stub_queue(monkeypatch)
    provider = _ToolsCapturingProvider()
    monkeypatch.setattr("app.services.agent_service.get_provider", lambda **kw: provider)

    session = AgentSession(user_id=async_test_user.id, repository_id=async_test_repo.id)
    async_db.add(session)
    await async_db.commit()
    await async_db.refresh(session)

    trig_job = AgentJob(
        session_id=session.id, repository_id=async_test_repo.id,
        user_id=async_test_user.id, status="queued", prompt="p", origin="trigger",
    )
    user_job = AgentJob(
        session_id=session.id, repository_id=async_test_repo.id,
        user_id=async_test_user.id, status="queued", prompt="p", origin="user",
    )
    async_db.add_all([trig_job, user_job])
    await async_db.commit()
    await async_db.refresh(trig_job)
    await async_db.refresh(user_job)

    from app.services.agent_service import AgentService

    await AgentService().process_job(trig_job.id)
    trig_names = {t["function"]["name"] for t in provider.tools}
    assert "create_issue" not in trig_names and "commit_file" not in trig_names
    assert "search_code" in trig_names  # 读工具仍在

    await AgentService().process_job(user_job.id)
    user_names = {t["function"]["name"] for t in provider.tools}
    assert "create_issue" in user_names  # 用户作业仍暴露写工具
