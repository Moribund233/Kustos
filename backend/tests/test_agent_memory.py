"""会话记忆 + 作业 token 预算。

- 会话记忆为**确定性摘要**（由最近终态作业生成，无额外模型调用）；
- 作业级 token 预算耗尽时**优雅降级**（保留已得结论，非硬失败）。
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models.agent import AgentJob, AgentSession
from app.services.agent.providers import ModelReply, ToolCallRequest
from app.services.agent.runtime import AgentRuntime, RunStatus
from app.services.agent.tool_registry import ToolContext
from app.services.agent_service import AgentService


class _CapturingProvider:
    name = "capture"
    model = "test"

    def __init__(self, reply):
        self._reply = reply
        self.messages = []

    async def complete(self, messages, tools):
        self.messages = list(messages)
        return self._reply


class _ToolLoopProvider:
    """每轮回一个工具调用 + usage：驱动循环多轮，用于触发预算收尾。"""

    name = "loop"
    model = "test"

    def __init__(self, tokens=100):
        self._tokens = tokens
        self.calls = 0

    async def complete(self, messages, tools):
        self.calls += 1
        return ModelReply(
            content=f"中间结论 {self.calls}",
            tool_calls=[ToolCallRequest(id=str(self.calls), name="does_not_exist", arguments={})],
            usage={"total_tokens": self._tokens},
        )


def test_memory_config_defaults():
    from app.core.config import AgentSettings

    cfg = AgentSettings()
    assert cfg.max_summary_chars == 2000
    assert cfg.job_token_budget == 0  # 默认不限


@pytest.mark.asyncio
async def test_runtime_token_budget_degrades_with_partial_answer():
    provider = _ToolLoopProvider(tokens=100)
    out = await AgentRuntime(provider=provider).run(
        ToolContext(db=None, repository_id=None, user_id=None),
        "q", token_budget=50,
    )
    assert out.status == RunStatus.BUDGET_EXCEEDED
    assert "token 预算" in (out.answer or "")
    assert "中间结论 1" in (out.answer or "")  # 保留已得结论
    assert provider.calls == 1  # 达上限后不再调用模型


@pytest.mark.asyncio
async def test_runtime_session_context_merges_into_system_message():
    provider = _CapturingProvider(ModelReply(content="ok", tool_calls=[]))
    await AgentRuntime(provider=provider).run(
        ToolContext(db=None, repository_id=None, user_id=None),
        "新问题", session_context="会话历史摘要：上次结论 X",
    )
    system = [m for m in provider.messages if m.get("role") == "system"]
    assert system and "上次结论 X" in system[0]["content"]
    user = [m for m in provider.messages if m.get("role") == "user"]
    assert user and user[0]["content"] == "新问题"  # 用户提示未被污染


async def _add_terminal_job(db, session, user, repo, prompt, result, when):
    db.add(AgentJob(
        session_id=session.id, repository_id=repo.id, user_id=user.id,
        status="succeeded", prompt=prompt, result=result, finished_at=when,
    ))
    await db.commit()


@pytest.mark.asyncio
async def test_refresh_session_summary_deterministic(
    async_db, async_test_user, async_test_repo
):
    session = AgentSession(
        user_id=async_test_user.id, repository_id=async_test_repo.id, title="t"
    )
    async_db.add(session)
    await async_db.commit()
    await async_db.refresh(session)

    base = datetime.now(timezone.utc)
    await _add_terminal_job(async_db, session, async_test_user, async_test_repo,
                            "问题0", "结论一", base)
    await _add_terminal_job(async_db, session, async_test_user, async_test_repo,
                            "问题1", "结论二", base + timedelta(seconds=1))

    await AgentService()._refresh_session_summary(async_db, session.id)
    await async_db.refresh(session)
    assert session.summary and session.summary_updated_at is not None
    assert "问题0" in session.summary and "结论二" in session.summary
    # 时间正序：较早的问题在较近的问题之前
    assert session.summary.index("问题0") < session.summary.index("问题1")


@pytest.mark.asyncio
async def test_refresh_session_summary_respects_char_limit(
    async_db, async_test_user, async_test_repo, monkeypatch
):
    from app.core.config import get_config

    monkeypatch.setattr(get_config().agent, "max_summary_chars", 160, raising=False)

    session = AgentSession(
        user_id=async_test_user.id, repository_id=async_test_repo.id, title="t"
    )
    async_db.add(session)
    await async_db.commit()
    await async_db.refresh(session)

    base = datetime.now(timezone.utc)
    await _add_terminal_job(async_db, session, async_test_user, async_test_repo,
                            "很早的问题", "旧结论" * 50, base)
    await _add_terminal_job(async_db, session, async_test_user, async_test_repo,
                            "最近的问题", "最新结论", base + timedelta(seconds=1))

    await AgentService()._refresh_session_summary(async_db, session.id)
    await async_db.refresh(session)
    assert session.summary and len(session.summary) <= 160
    assert "最新结论" in session.summary  # 预算优先保留最近条目


@pytest.mark.asyncio
async def test_process_job_injects_session_summary(
    async_db, async_test_user, async_test_repo
):
    session = AgentSession(
        user_id=async_test_user.id, repository_id=async_test_repo.id, title="t",
        summary="会话历史摘要：上次审查结论 X",
    )
    async_db.add(session)
    await async_db.commit()
    await async_db.refresh(session)

    job = AgentJob(
        session_id=session.id, repository_id=async_test_repo.id,
        user_id=async_test_user.id, status="queued", prompt="接着上次",
        provider="fake", model="test",
    )
    async_db.add(job)
    await async_db.commit()
    await async_db.refresh(job)

    provider = _CapturingProvider(ModelReply(content="答案", tool_calls=[]))
    await AgentService().process_job(job.id, provider_override=provider)
    await async_db.refresh(job)

    assert job.status == "succeeded"
    system = [m for m in provider.messages if m.get("role") == "system"]
    assert system and "上次审查结论 X" in system[0]["content"]
