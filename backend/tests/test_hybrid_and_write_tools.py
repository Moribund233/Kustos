"""混合检索（向量召回 + RRF）+ 写工具/权限测试"""
import shutil

import pytest

from app.services.indexing import embeddings
from app.services.search.search_service import SearchResult, SearchService, _rrf_fuse


class _FakeEmbedProvider:
    name = "fake"
    model = "fake-embed"
    # PG 向量列固定 vector(1536)，故假向量也必须是 1536 维（前两维承载语义方向）
    dim = 1536

    async def embed(self, texts):
        out = []
        for t in texts:
            low = t.lower()
            if any(k in low for k in ("auth", "login", "credential")):
                out.append([1.0, 0.0] + [0.0] * 1534)
            elif any(k in low for k in ("add", "number", "math", "sum")):
                out.append([0.0, 1.0] + [0.0] * 1534)
            else:
                out.append([0.5, 0.5] + [0.0] * 1534)
        return out


def _item(file, chunk_index, line=1, symbol=None):
    from app.services.search.search_service import ChunkRef

    return SearchResult(
        file=file, line=line, content="x",
        chunk=ChunkRef(chunk_index=chunk_index, symbol=symbol, kind="function",
                       start_line=line, end_line=line),
    )


def test_rrf_fuse_prefers_agreement():
    a = [_item("f.py", 0), _item("f.py", 1)]
    b = [_item("f.py", 1), _item("f.py", 2)]
    fused = _rrf_fuse([a, b], max_results=10, k=60)
    # chunk 1 同时出现在两路且靠前 → 居首
    assert (fused[0].file, fused[0].chunk.chunk_index) == ("f.py", 1)


@pytest.mark.asyncio
async def test_semantic_recall_without_keyword_match(async_db, async_test_repo, monkeypatch):
    from tests.test_search_service import _make_bare_repo

    files = {
        "auth.py": "def authenticate_user():\n    return check_credentials()\n",
        "math.py": "def add_numbers(a, b):\n    return a + b\n",
    }
    tmp, bare, _ = _make_bare_repo(files)
    embeddings.set_embedding_provider(_FakeEmbedProvider())
    try:
        service = SearchService()
        await service.rebuild_index(async_db, async_test_repo.id, bare)

        # 关键词无字面命中
        kw = await service.search_code(async_db, async_test_repo.id, bare, "login flow")
        assert kw.total_count == 0

        # 语义命中：query 与 auth 块向量一致（关键词仍无命中 → 纯语义胜出）
        res = await service.search_code(
            async_db, async_test_repo.id, bare, "login flow", semantic=True
        )
        assert res.results, "语义检索应召回 auth 块"
        assert res.results[0].file == "auth.py"
        assert res.results[0].chunk.symbol == "authenticate_user"
        assert "auth" not in "login flow"  # 确认非字面匹配
    finally:
        embeddings.reset_embedding_provider()
        shutil.rmtree(tmp, ignore_errors=True)


class _ScriptedProvider:
    name = "scripted"
    model = "test"

    def __init__(self, replies):
        self._replies = list(replies)

    async def complete(self, messages, tools):
        return self._replies.pop(0)


@pytest.mark.asyncio
async def test_write_tools_gated_by_permission(async_db, async_test_user, async_another_user, async_test_repo):
    from sqlalchemy import func, select

    from app.models.issue import Issue
    from app.services.agent.providers import ModelReply, ToolCallRequest
    from app.services.agent.runtime import APPROVAL_APPROVED, AgentRuntime, RunStatus
    from app.services.agent.tool_registry import ToolContext
    from app.services.agent.tools_server import load_server_tools

    load_server_tools()

    def run_with(ctx, *replies, history=None, approvals=None):
        provider = _ScriptedProvider([ModelReply(**r) for r in replies])
        return AgentRuntime(provider=provider).run(
            ctx, "open an issue", history=history, approvals=approvals
        )

    async def issue_count():
        return (await async_db.execute(
            select(func.count()).select_from(Issue).where(Issue.repository_id == async_test_repo.id)
        )).scalar_one()

    open_call = {"content": None, "tool_calls": [ToolCallRequest(id="c1", name="create_issue", arguments={"title": "t"})]}

    # 仓库 owner：挂起等待审批，绝不产生写副作用
    ctx_owner = ToolContext(db=async_db, repository_id=async_test_repo.id, user_id=async_test_user.id, allow_write=True)
    first = await run_with(ctx_owner, open_call)
    assert first.status == RunStatus.AWAITING_APPROVAL
    assert first.pending["tool"] == "create_issue"
    assert await issue_count() == 0

    # 批准 → 执行工具 → 模型应答 → 落一条记录
    ok_steps = []

    async def ok_on_step(t, n, c, d):
        ok_steps.append((t, n, d))

    ok = await AgentRuntime(provider=_ScriptedProvider([ModelReply(content="done", tool_calls=[])])).run(
        ctx_owner, "open an issue", ok_on_step,
        history=first.messages, approvals={first.pending["tool_call_id"]: APPROVAL_APPROVED},
    )
    assert ok.status == RunStatus.ANSWERED and ok.answer == "done"
    assert await issue_count() == 1, ok_steps

    # 无写权限（非成员）→ 审批后执行期被拒，且不新建
    results = []

    async def on_step(t, n, c, d):
        if t == "tool_result":
            results.append(d)

    ctx_other = ToolContext(db=async_db, repository_id=async_test_repo.id, user_id=async_another_user.id, allow_write=True)
    pending_other = await run_with(ctx_other, open_call)
    assert pending_other.status == RunStatus.AWAITING_APPROVAL
    denied = await AgentRuntime(provider=_ScriptedProvider([
        ModelReply(content="ok", tool_calls=[]),
    ])).run(
        ctx_other, "open an issue", on_step,
        history=pending_other.messages,
        approvals={pending_other.pending["tool_call_id"]: APPROVAL_APPROVED},
    )
    assert denied.status == RunStatus.ANSWERED
    assert results and "写权限" in results[0].get("error", "")
    assert await issue_count() == 1  # 与上一步合并断言仍只 1 条

    # BYO-key 作业（allow_write=False）纵深防御：不暴露写工具，模型若强行发出写调用则执行期拒绝
    ctx_bare = ToolContext(db=async_db, repository_id=async_test_repo.id, user_id=async_test_user.id, allow_write=False)
    barrier = []

    async def record_steps(t, n, c, d):
        if t == "tool_result":
            barrier.append((t, d))

    blocked = await AgentRuntime(provider=_ScriptedProvider([
        ModelReply(content=None, tool_calls=[ToolCallRequest(id="c2", name="create_issue", arguments={"title": "x"})]),
        ModelReply(content="ok", tool_calls=[]),
    ])).run(ctx_bare, "create an issue", record_steps)
    assert blocked.status == RunStatus.ANSWERED
    assert any("不允许写" in d.get("error", "") for _, d in barrier)
    assert await issue_count() == 1  # 仍只有 owner 批准的那一条


def test_server_tools_include_write_scope():
    from app.services.agent.tool_registry import get_tool, list_tools
    from app.services.agent.tools_server import load_server_tools

    load_server_tools()
    write_names = {t.name for t in list_tools() if t.scope == "repo:write"}
    assert {"create_issue", "comment_on_issue", "comment_on_pull_request",
            "create_pull_request", "commit_file", "retry_build",
            "apply_label", "set_priority"} <= write_names
    assert get_tool("search_code").scope == "repo:read"