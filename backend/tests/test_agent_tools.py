"""工具注册表 + tool-calling 运行时测试"""
import pytest

from app.services.agent import tool_registry as tr
from app.services.agent.providers import ModelReply, ToolCallRequest
from app.services.agent.runtime import AgentRuntime
from app.services.agent.tool_registry import ToolContext, ToolSpec
from app.services.agent.tools_server import load_server_tools


class _FakeProvider:
    name = "fake"
    model = "test"

    def __init__(self, replies):
        self._replies = list(replies)
        self.calls = []

    async def complete(self, messages, tools):
        self.calls.append(list(messages))
        return self._replies.pop(0)


def test_server_tools_registered():
    load_server_tools()
    names = {t.name for t in tr.list_tools()}
    assert {
        "search_code", "find_definition", "find_usages", "read_file", "list_tree",
        "list_pull_requests", "get_pull_request", "list_issues", "get_issue",
        "list_commits", "get_commit", "get_diff", "blame_file", "compare_refs",
        "get_build_status", "get_build_logs", "review_recent_changes", "who_changed",
        "list_members", "responsible_for",
        "list_channel_messages", "search_chat_decisions",
    } <= names
    schema = tr.openai_tools()
    assert schema and all(
        s["type"] == "function" and s["function"]["parameters"]["type"] == "object"
        for s in schema
    )


@pytest.mark.asyncio
async def test_runtime_executes_tool_then_answers():
    calls = []

    async def handler(ctx, args):
        calls.append(args)
        return {"ok": True, "echo": args}

    load_server_tools()
    tr.register_tool(ToolSpec(name="_echo_test", description="d", parameters={"type": "object"}, handler=handler))
    try:
        provider = _FakeProvider([
            ModelReply(content=None, tool_calls=[ToolCallRequest(id="1", name="_echo_test", arguments={"x": 1})]),
            ModelReply(content="final", tool_calls=[]),
        ])
        steps = []

        async def on_step(t, n, c, d):
            steps.append((t, n))

        out = await AgentRuntime(provider=provider).run(
            ToolContext(db=None, repository_id=None, user_id=None), "hi", on_step
        )
        assert out.answer == "final"
        assert calls == [{"x": 1}]
        assert ("user", None) in steps
        assert ("tool_call", "_echo_test") in steps
        assert ("tool_result", "_echo_test") in steps
        assert ("assistant", None) in steps
    finally:
        tr._REGISTRY.pop("_echo_test", None)


@pytest.mark.asyncio
async def test_runtime_unknown_tool_returns_error_and_continues():
    provider = _FakeProvider([
        ModelReply(content=None, tool_calls=[ToolCallRequest(id="1", name="does_not_exist", arguments={})]),
        ModelReply(content="done", tool_calls=[]),
    ])
    outcomes = []

    async def on_step(t, n, c, d):
        if t == "tool_result":
            outcomes.append(d)

    out = await AgentRuntime(provider=provider).run(
        ToolContext(db=None, repository_id=None, user_id=None), "q", on_step
    )
    assert out.answer == "done"
    assert outcomes and "error" in outcomes[0]


@pytest.mark.asyncio
async def test_runtime_exceeds_max_steps():
    provider = _FakeProvider([
        ModelReply(content=None, tool_calls=[ToolCallRequest(id=str(i), name="does_not_exist", arguments={})])
        for i in range(5)
    ])
    with pytest.raises(RuntimeError):
        await AgentRuntime(provider=provider, max_steps=3).run(
            ToolContext(db=None, repository_id=None, user_id=None), "q"
        )


@pytest.mark.asyncio
async def test_runtime_cancel_stops_before_model_call():
    provider = _FakeProvider([
        ModelReply(content=None, tool_calls=[ToolCallRequest(id="1", name="does_not_exist", arguments={})]),
    ])
    steps = []

    async def on_step(t, n, c, d):
        steps.append((t, n))

    async def cancelled():
        return True

    out = await AgentRuntime(provider=provider).run(
        ToolContext(db=None, repository_id=None, user_id=None), "q", on_step,
        is_cancelled=cancelled,
    )
    assert out.status == "cancelled"
    assert out.answer is None
    assert not provider.calls  # 未触发任何模型调用 / 工具副作用


@pytest.mark.asyncio
async def test_runtime_cancel_stops_mid_batch():
    """取消在工具批之间生效——已执行读工具不撤销，未放行的调用不会执行"""
    provider = _FakeProvider([
        ModelReply(content=None, tool_calls=[
            ToolCallRequest(id="1", name="does_not_exist", arguments={}),
            ToolCallRequest(id="2", name="does_not_exist", arguments={}),
        ]),
    ])
    flag = {"value": False}
    visits = {"n": 0}

    async def cancelled():
        visits["n"] += 1
        if visits["n"] >= 3:
            flag["value"] = True
        return flag["value"]

    out = await AgentRuntime(provider=provider).run(
        ToolContext(db=None, repository_id=None, user_id=None), "q", is_cancelled=cancelled
    )
    assert out.status == "cancelled"
    assert flag["value"] is True  # 循环感知到取消后主动收尾即可，不保证执行到底


@pytest.mark.asyncio
async def test_search_code_tool_carries_provenance(async_db, async_test_repo):
    """search_code 工具把结果溯源（source / semantic_used）带进模型上下文"""
    import shutil

    from app.services.search_service import SearchService
    from tests.test_search_service import _make_bare_repo

    load_server_tools()
    handler = tr.get_tool("search_code").handler
    tmp, bare, _ = _make_bare_repo({"a.py": "def alpha():\n    pass\n"})
    try:
        await SearchService().rebuild_index(async_db, async_test_repo.id, bare)
        ctx = ToolContext(
            db=async_db, repository_id=async_test_repo.id, user_id=None, repo_path=bare
        )

        out = await handler(ctx, {"query": "alpha"})

        assert out["source"] == "index"
        assert out["semantic_used"] is False  # 未配 embedding provider
        assert out["results"] and out["results"][0]["symbol"] == "alpha"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
