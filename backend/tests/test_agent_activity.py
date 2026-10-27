"""审计测试：Agent 作业生命周期与写工具落 Activity（决策性动作，防洪泛）。

覆盖：
- 创建作业 → activity(agent_job/created)
- 批准 / 拒绝 → activity(approved/rejected)（CAS 认领侧记录，不重复）
- 取消 → activity(cancelled)
- 写工具成功执行 → activity(agent_tool/<tool>)；被拒（返回 error）不落
- 只记决策性动作：read 工具不落（步骤级明细已由 agent_steps 承担）
"""
import json
import uuid

import pytest
from sqlalchemy import select

from app.models.agent import AgentJob, AgentSession
from app.models.activity import Activity
from app.services.agent_service import (
    APPROVAL_APPROVED,
    APPROVAL_REJECTED,
    AgentService,
)


@pytest.fixture(autouse=True)
def _no_inline_queue(monkeypatch):
    """入队空转：避免 inline 后台任务与 teardown 清理竞态（FK 交错删除）。"""

    class _NoopQueue:
        async def enqueue(self, job_id, provider=None):  # noqa: ARG002
            return None

    import app.services.agent.queue as queue_mod

    async def _fake_get_queue():
        return _NoopQueue()

    monkeypatch.setattr(queue_mod, "get_job_queue", _fake_get_queue)


async def _make_job(async_db, user, repo, status="queued", prompt="审计测试作业"):
    session = AgentSession(user_id=user.id, repository_id=repo.id, title="audit")
    async_db.add(session)
    await async_db.commit()
    await async_db.refresh(session)
    job = AgentJob(
        session_id=session.id,
        repository_id=repo.id,
        user_id=user.id,
        status=status,
        prompt=prompt,
    )
    async_db.add(job)
    await async_db.commit()
    await async_db.refresh(job)
    return job


async def _activities(async_db, entity_id):
    return list(
        (
            await async_db.execute(
                select(Activity).where(Activity.entity_id == entity_id)
            )
        ).scalars().all()
    )


class TestJobLifecycleAudit:
    @pytest.mark.asyncio
    async def test_create_job_records_activity(
        self, async_db, async_test_user, async_test_repo, agent_enabled
    ):
        job = await AgentService().create_job(
            async_db, async_test_user, async_test_repo.id, "帮我看看搜索逻辑"
        )
        acts = await _activities(async_db, job.id)
        assert len(acts) == 1
        a = acts[0]
        assert a.entity_type == "agent_job"
        assert a.action == "created"
        assert a.actor_id == async_test_user.id
        assert a.repository_id == async_test_repo.id
        assert "搜索逻辑" in a.details

    @pytest.mark.asyncio
    async def test_approve_and_reject_record_activity(
        self, async_db, async_test_user, async_test_repo
    ):
        svc = AgentService()
        job = await _make_job(async_db, async_test_user, async_test_repo,
                              status="awaiting_approval")
        await svc.resolve_approval(
            async_db, async_test_user, job.id, APPROVAL_APPROVED, "看起来安全"
        )
        acts = await _activities(async_db, job.id)
        assert [(a.action, a.actor_id) for a in acts] == [
            ("approved", async_test_user.id)
        ]
        assert acts[0].details == "看起来安全"

        job2 = await _make_job(async_db, async_test_user, async_test_repo,
                               status="awaiting_approval")
        await svc.resolve_approval(
            async_db, async_test_user, job2.id, APPROVAL_REJECTED, None
        )
        acts2 = await _activities(async_db, job2.id)
        assert [a.action for a in acts2] == ["rejected"]

    @pytest.mark.asyncio
    async def test_cancel_records_activity(
        self, async_db, async_test_user, async_test_repo
    ):
        job = await _make_job(async_db, async_test_user, async_test_repo, status="queued")
        await AgentService().cancel_job(async_db, async_test_user, job.id)
        acts = await _activities(async_db, job.id)
        assert [a.action for a in acts] == ["cancelled"]
        assert acts[0].actor_id == async_test_user.id


class TestWriteToolAudit:
    @pytest.mark.asyncio
    async def test_write_tool_records_activity(
        self, async_db, async_test_user, async_test_repo
    ):
        from app.services.agent.runtime import AgentRuntime
        from app.services.agent.tool_registry import ToolContext

        job = await _make_job(async_db, async_test_user, async_test_repo)
        ctx = ToolContext(
            db=async_db,
            repository_id=async_test_repo.id,
            user_id=async_test_user.id,
            repo_path=None,
            job_id=job.id,
        )
        # repo_path=None → commit_file 走不到；用 create_issue（纯 DB 写）
        runtime = AgentRuntime(provider=None)
        result = await runtime._execute(
            ctx, "create_issue", {"title": "审计测试 Issue", "body": "body"}
        )
        assert "error" not in result, result

        acts = await _activities(async_db, job.id)
        assert len(acts) == 1
        a = acts[0]
        assert a.entity_type == "agent_tool"
        assert a.action == "create_issue"
        assert a.actor_id == async_test_user.id
        assert "title" in (a.details or "")

    @pytest.mark.asyncio
    async def test_rejected_write_tool_records_nothing(
        self, async_db, async_test_user, async_test_repo
    ):
        from app.services.agent.runtime import AgentRuntime
        from app.services.agent.tool_registry import ToolContext

        job = await _make_job(async_db, async_test_user, async_test_repo)
        ctx = ToolContext(
            db=async_db,
            repository_id=async_test_repo.id,
            user_id=async_test_user.id,
            repo_path=None,  # commit_file 会以 error 返回（仓库路径不可用）
            job_id=job.id,
        )
        runtime = AgentRuntime(provider=None)
        result = await runtime._execute(
            ctx,
            "commit_file",
            {"path": "x.txt", "content": "x", "branch": "no-such-branch"},
        )
        assert "error" in result  # 被拒/失败 → 无副作用 → 不落审计
        assert await _activities(async_db, job.id) == []
