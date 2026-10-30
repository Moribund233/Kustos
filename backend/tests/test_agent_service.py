"""AgentService：作业落库、执行、密钥不落库；审批挂起/批准/取消"""
import json

import pytest

from app.models.agent import AgentJob, AgentSession
from app.services.agent.providers import ModelReply
from app.services.agent.runtime import APPROVAL_APPROVED, APPROVAL_REJECTED
from app.services.agent.agent_service import AgentService


class _FakeProvider:
    name = "fake"
    model = "test"

    async def complete(self, messages, tools):
        return ModelReply(content="答案", tool_calls=[])


class _Scripted:
    """按脚本回放回复（工具调用 / 文本）"""

    name = "scripted"
    model = "test"

    def __init__(self, replies):
        self._replies = list(replies)

    async def complete(self, messages, tools) -> ModelReply:
        return self._replies.pop(0)


@pytest.mark.asyncio
async def test_create_job_persists_and_enqueues(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    recorded = []

    class _RecQueue:
        async def enqueue(self, job_id, provider=None):
            recorded.append((job_id, provider))

    async def _fake_get_queue():
        return _RecQueue()

    monkeypatch.setattr("app.services.agent.queue.get_job_queue", _fake_get_queue)

    job = await AgentService().create_job(async_db, async_test_user, async_test_repo.id, "列出函数")
    assert job.status == "queued"
    assert job.user_id == async_test_user.id
    assert recorded and recorded[0][0] == job.id
    # 会话自动创建
    session = (
        await async_db.execute(
            AgentSession.__table__.select().where(AgentSession.id == job.session_id)
        )
    ).first()
    assert session is not None


@pytest.mark.asyncio
async def test_api_key_not_persisted_and_forces_inline(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    async def _noop(self, job_id, provider=None):
        return None

    monkeypatch.setattr("app.services.agent.queue.InlineJobQueue.enqueue", _noop)
    monkeypatch.setattr("app.services.agent.agent_service.get_provider", lambda **kw: _FakeProvider())

    job = await AgentService().create_job(
        async_db, async_test_user, async_test_repo.id, "用我的 key 查代码", api_key="sk-super-secret"
    )
    assert job.provider == "openai"
    assert "sk-super-secret" not in (job.prompt or "")
    assert "sk-super-secret" not in str(job.__dict__)


@pytest.mark.asyncio
async def test_process_job_checkpoints_steps(async_db, async_test_user, async_test_repo):
    session = AgentSession(user_id=async_test_user.id, repository_id=async_test_repo.id, title="t")
    async_db.add(session)
    await async_db.commit()
    await async_db.refresh(session)

    job = AgentJob(
        session_id=session.id, repository_id=async_test_repo.id, user_id=async_test_user.id,
        status="queued", prompt="问题", provider="fake", model="test",
    )
    async_db.add(job)
    await async_db.commit()
    await async_db.refresh(job)

    await AgentService().process_job(job.id, provider_override=_FakeProvider())
    await async_db.refresh(job)
    assert job.status == "succeeded"
    assert job.result == "答案"
    assert job.step_count == 2

    steps = await AgentService().get_steps(async_db, async_test_user, job.id)
    assert [s.type for s in steps] == ["user", "assistant"]


@pytest.mark.asyncio
async def test_process_job_fails_without_provider(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    from app.services.agent import providers

    providers.reset_provider()
    monkeypatch.delenv("KUSTOS_AGENT_API_KEY", raising=False)

    session = AgentSession(user_id=async_test_user.id, repository_id=async_test_repo.id, title="t")
    async_db.add(session)
    await async_db.commit()
    await async_db.refresh(session)
    job = AgentJob(
        session_id=session.id, repository_id=async_test_repo.id, user_id=async_test_user.id,
        status="queued", prompt="q",
    )
    async_db.add(job)
    await async_db.commit()
    await async_db.refresh(job)

    await AgentService().process_job(job.id)
    await async_db.refresh(job)
    assert job.status == "failed"
    assert "provider" in (job.error or "").lower()


@pytest.mark.asyncio
async def test_ensure_bot_user_idempotent(async_db):
    svc = AgentService()
    a = await svc.ensure_bot_user(async_db)
    b = await svc.ensure_bot_user(async_db)
    assert a.id == b.id and a.is_bot is True


@pytest.mark.asyncio
async def test_approval_flow_persists_then_resumes(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    """端到端：写工具调用 → awaiting_approval（带 pending + runtime_state）
    → approve → 重新入队 → 凭历史续跑并成功。"""
    from app.services.agent.providers import ToolCallRequest
    from app.services.agent.tools_server import load_server_tools

    load_server_tools()
    opened = ModelReply(
        content=None, tool_calls=[ToolCallRequest(id="a1", name="create_issue", arguments={"title": "t"})]
    )
    answered = ModelReply(content="创建完成", tool_calls=[])

    holder = {"provider": _Scripted([opened])}
    monkeypatch.setattr("app.services.agent.agent_service.get_provider", lambda: holder["provider"])

    recorded = []

    class _RecQueue:
        async def enqueue(self, job_id, provider=None):
            recorded.append(job_id)

    async def _fake_get_queue():
        return _RecQueue()

    monkeypatch.setattr("app.services.agent.queue.get_job_queue", _fake_get_queue)

    job = await AgentService().create_job(
        async_db, async_test_user, async_test_repo.id, "帮我建个 issue"
    )
    assert job.status == "queued"

    # 第一轮执行 → 挂起
    await AgentService().process_job(job.id)
    await async_db.refresh(job)
    assert job.status == "awaiting_approval"
    assert json.loads(job.pending_approval)["tool"] == "create_issue"
    assert json.loads(job.runtime_state)[0]["role"] == "system"

    # 批准 → 重新入队 → 第二轮续跑成功
    holder["provider"] = _Scripted([answered])
    resumed = await AgentService().resolve_approval(
        async_db, async_test_user, job.id, APPROVAL_APPROVED, "同意"
    )
    assert resumed.status == "queued"
    assert resumed.approval_decision == APPROVAL_APPROVED
    assert recorded and recorded[-1] == job.id

    await AgentService().process_job(job.id)
    await async_db.refresh(job)
    assert job.status == "succeeded"
    assert job.result == "创建完成"
    assert job.pending_approval is None and job.runtime_state is None


@pytest.mark.asyncio
async def test_approval_reject_no_write_side_effect(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    """拒绝路径：不产生写副作用，作业续跑收尾。"""
    from app.services.agent.providers import ToolCallRequest
    from app.services.agent.tools_server import load_server_tools

    load_server_tools()
    opened = ModelReply(
        content=None, tool_calls=[ToolCallRequest(id="r1", name="create_issue", arguments={"title": "r"})]
    )
    holder = {"provider": _Scripted([opened])}
    monkeypatch.setattr("app.services.agent.agent_service.get_provider", lambda: holder["provider"])

    async def _noop_queue():
        class _Q:
            async def enqueue(self, job_id, provider=None):
                return None
        return _Q()

    monkeypatch.setattr("app.services.agent.queue.get_job_queue", _noop_queue)

    job = await AgentService().create_job(
        async_db, async_test_user, async_test_repo.id, "拒绝的场景"
    )
    await AgentService().process_job(job.id)
    await async_db.refresh(job)
    assert job.status == "awaiting_approval"

    holder["provider"] = _Scripted([ModelReply(content="好的，不执行", tool_calls=[])])
    await AgentService().resolve_approval(
        async_db, async_test_user, job.id, APPROVAL_REJECTED, "不批准"
    )
    await AgentService().process_job(job.id)
    await async_db.refresh(job)
    assert job.status == "succeeded"

    from app.models.issue import Issue
    from sqlalchemy import func, select

    n = (await async_db.execute(
        select(func.count()).select_from(Issue).where(Issue.repository_id == async_test_repo.id)
    )).scalar_one()
    assert n == 0  # 拒绝后绝无写副作用


@pytest.mark.asyncio
async def test_resolve_approval_conflicts_when_not_pending(
    async_db, async_test_user, async_test_repo
):
    from app.core.exception import ConflictException

    session = AgentSession(user_id=async_test_user.id, repository_id=async_test_repo.id, title="t")
    async_db.add(session)
    await async_db.commit()
    await async_db.refresh(session)
    job = AgentJob(
        session_id=session.id, repository_id=async_test_repo.id, user_id=async_test_user.id,
        status="succeeded", prompt="done", provider="fake", model="test",
    )
    async_db.add(job)
    await async_db.commit()
    await async_db.refresh(job)

    with pytest.raises(ConflictException):
        await AgentService().resolve_approval(
            async_db, async_test_user, job.id, APPROVAL_APPROVED
        )


@pytest.mark.asyncio
async def test_cancel_while_awaiting_approval_is_final(
    async_db, async_test_user, async_test_repo, monkeypatch, agent_enabled
):
    """催批期间取消：取消是终态，后续 approve 不再生效。"""
    from app.services.agent.providers import ToolCallRequest
    from app.services.agent.tools_server import load_server_tools

    load_server_tools()
    opened = ModelReply(
        content=None, tool_calls=[ToolCallRequest(id="x1", name="create_issue", arguments={"title": "x"})]
    )
    holder = {"provider": _Scripted([opened])}
    monkeypatch.setattr("app.services.agent.agent_service.get_provider", lambda: holder["provider"])

    async def _noop_queue():
        class _Q:
            async def enqueue(self, job_id, provider=None):
                return None
        return _Q()

    monkeypatch.setattr("app.services.agent.queue.get_job_queue", _noop_queue)

    job = await AgentService().create_job(
        async_db, async_test_user, async_test_repo.id, "建一个 issue"
    )
    await AgentService().process_job(job.id)
    await async_db.refresh(job)
    assert job.status == "awaiting_approval"

    cancelled = await AgentService().cancel_job(async_db, async_test_user, job.id)
    assert cancelled.status == "cancelled"
    assert cancelled.runtime_state is None  # 终态清空恢复上下文

    from app.core.exception import ConflictException

    with pytest.raises(ConflictException):
        await AgentService().resolve_approval(
            async_db, async_test_user, job.id, APPROVAL_APPROVED
        )
    await async_db.refresh(job)
    assert job.status == "cancelled"  # 取消不可被撤销
