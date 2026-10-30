"""Agent 执行循环（人工审批门禁 / 取消感知）。

设计要点：

* **两阶段循环**。每轮先看 ``messages`` 末尾是否有"已产生但尚未回填结果的
  assistant 工具调用"：有则执行工具，无则请求模型。这样"审批后恢复执行"与
  "正常继续"共用同一条代码路径 —— 恢复时只需把持久化的 ``messages`` 原样喂回来，
  无需从 ``agent_steps`` 反推对话（见 :class:`RunOutcome`）。
* **审批门禁**（``ToolSpec.requires_approval``）。写工具在执行前必须拿到用户显式
  决定；未拿到则**挂起**作业（返回 :data:`RunStatus.AWAITING_APPROVAL`）并把
  ``messages`` 一并交还，由 ``agent_service`` 落库等待 approve/reject 端点唤醒。
  绝不在无确认的情况下产生写副作用。
* **取消感知**。每轮前回调 ``is_cancelled``；命中即返回
  :data:`RunStatus.CANCELLED`，由上层做带状态前置条件的终态写入，避免"取消后又被
  覆盖成成功"。
* **短步长**：每步经 ``on_step`` 回调落 checkpoint 并流式推送，天然可恢复、可观测。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

from app.core.config import get_config
from app.services.agent import tools_server
from app.services.agent.providers import SYSTEM_PROMPT, ModelProvider, get_provider
from app.services.agent.tool_registry import ToolContext, get_tool, openai_tools

logger = logging.getLogger(__name__)

# ---- 步骤类型（落 agent_steps.type，供 UI 分流与审计）----
STEP_USER = "user"
STEP_ASSISTANT = "assistant"
STEP_TOOL_CALL = "tool_call"
STEP_TOOL_RESULT = "tool_result"
STEP_ERROR = "error"
STEP_APPROVAL_REQUIRED = "approval_required"

StepCallback = Callable[
    [str, Optional[str], Optional[str], Optional[Dict[str, Any]]], Awaitable[None]
]
#: 模型输出增量回调（打字机流式；provider 支持时逐 delta 调用）
DeltaCallback = Callable[[str], Awaitable[None]]
CancelCheck = Callable[[], Awaitable[bool]]

# ---- 审批决定 ----
APPROVAL_APPROVED = "approved"
APPROVAL_REJECTED = "rejected"


class RunStatus:
    """循环终态"""

    ANSWERED = "answered"
    AWAITING_APPROVAL = "awaiting_approval"
    CANCELLED = "cancelled"
    #: 达作业 token 预算上限而主动收尾（优雅降级，非失败）
    BUDGET_EXCEEDED = "budget_exceeded"


class MaxStepsExceeded(RuntimeError):
    """超过最大模型调用步数"""


@dataclass
class RunOutcome:
    """一次 :meth:`AgentRuntime.run` 的结果

    Attributes:
        status: :class:`RunStatus` 之一
        answer: 最终回答（仅 ``ANSWERED``）
        pending: 待审批的工具调用（仅 ``AWAITING_APPROVAL``）
        messages: 完整对话消息列表 —— 挂起时**必须**由上层持久化，否则无法恢复
        tokens_used: 本轮消耗的 token（来自 provider ``usage`` 累计，供预算结算）
        prompt_tokens / completion_tokens / cached_tokens: usage 拆分（成本审计；
            provider 未回传对应字段时为 0）
    """

    status: str
    answer: Optional[str] = None
    pending: Optional[Dict[str, Any]] = None
    messages: List[Dict[str, Any]] = field(default_factory=list)
    tokens_used: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0


def _usage_tokens(usage: Optional[Dict[str, Any]]) -> int:
    """从 provider 的 ``usage`` 归一提取 token 总数（缺失字段宽容处理）"""
    if not isinstance(usage, dict):
        return 0
    total = usage.get("total_tokens")
    if isinstance(total, (int, float)):
        return int(total)
    prompt = usage.get("prompt_tokens") or 0
    completion = usage.get("completion_tokens") or 0
    try:
        return int(prompt) + int(completion)
    except (TypeError, ValueError):
        return 0


def _usage_breakdown(usage: Optional[Dict[str, Any]]) -> tuple:
    """拆出 ``(prompt, completion, cached)``（宽容提取，坏值按 0 计）。

    cached 取 OpenAI 形态 ``prompt_tokens_details.cached_tokens``，
    兼容部分网关的顶层 ``cached_tokens``。
    """
    if not isinstance(usage, dict):
        return 0, 0, 0

    def _int(v) -> int:
        try:
            return int(v) if isinstance(v, (int, float)) else 0
        except (TypeError, ValueError):
            return 0

    prompt = _int(usage.get("prompt_tokens"))
    completion = _int(usage.get("completion_tokens"))
    details = usage.get("prompt_tokens_details")
    cached = _int(details.get("cached_tokens")) if isinstance(details, dict) else 0
    if not cached:
        cached = _int(usage.get("cached_tokens"))
    return prompt, completion, cached


def _supports_on_delta(provider: ModelProvider) -> bool:
    """provider 是否接受 ``on_delta`` 关键字（自定义/测试 provider 可能是旧签名）"""
    import inspect

    try:
        return "on_delta" in inspect.signature(provider.complete).parameters
    except (TypeError, ValueError):
        return False


def _flatten_tool_call(call: Dict[str, Any]) -> Dict[str, Any]:
    """把工具调用归一为扁平的 ``{id, name, arguments}``。

    持久化的 assistant 消息里 tool_calls 是 OpenAI 公开模型的
    ``{"id", "type", "function": {"name", "arguments"}}`` 嵌套形态，且 ``arguments``
    为 JSON 字符串；挂起恢复时必须先扁平化回 ``{id, name, arguments(dict)}``。
    同一轮实时产生的 pending 已是扁平形态，本函数对两种形态都兼容。
    """
    fn = call.get("function") or {}
    raw_args = call.get("arguments") or fn.get("arguments") or {}
    if isinstance(raw_args, str):
        try:
            raw_args = json.loads(raw_args)
        except (TypeError, ValueError):
            raw_args = {}
    return {
        "id": str(call.get("id") or ""),
        "name": str(call.get("name") or fn.get("name") or ""),
        "arguments": raw_args if isinstance(raw_args, dict) else {},
    }


def _unanswered_tool_calls(
    messages: List[Dict[str, Any]], answered: set
) -> List[Dict[str, Any]]:
    """收集所有尚无 tool 结果回填的工具调用（扁平化形态）。

    扫描**全部**消息（而非只看末尾 assistant）：同一轮模型可发出多个工具调用，
    在挂起/恢复跨多次 run() 的情况下，已批准执行填入结果，其余仍待执行。
    """
    opened: List[Dict[str, Any]] = []
    for msg in messages:
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            for call in msg["tool_calls"]:
                opened.append(call)
        elif msg.get("role") == "tool" and msg.get("tool_call_id"):
            answered.add(msg["tool_call_id"])
    return [
        _flatten_tool_call(c) for c in opened if c.get("id") not in answered
    ]


def _tool_result_content(result: Dict[str, Any], limit: int) -> str:
    """序列化工具结果并施加 runtime 兜底上限（结构化截断，不裸切 JSON）。

    每个工具应按 ``[agent]`` 的产出上限自夹取并置 ``truncated``，使本兜底**不被
    触发**；一旦触发即说明某工具未夹取——除截断外追加 ``_truncated`` 标记并告警，
    让操作者能从日志定位到具体工具，而非只能翻代码找阈值。
    """
    text = json.dumps(result, ensure_ascii=False, default=str)
    if limit <= 0 or len(text) <= limit:
        return text
    logger.warning(
        "Agent 工具结果 %d 字符超过 runtime 兜底 %d，已截断（该工具应自夹取并置 truncated）",
        len(text), limit,
    )
    marker = json.dumps(
        {
            "_truncated": True,
            "_note": f"结果超过 {limit} 字符上限已截断；请用更精确的参数缩小范围",
        },
        ensure_ascii=False,
    )
    keep = max(0, limit - len(marker) - 2)
    return text[:keep] + "\n" + marker


def _budget_answer(last_answer: Optional[str]) -> str:
    """token 预算耗尽时的降级回答：保留已得结论 + 明确的收尾提示。"""
    notice = (
        "⚠️ 已达到本次作业的 token 预算上限，已停止继续调用工具/模型。"
        "如需完整结论，请人工跟进或拆分为更小的任务。"
    )
    if last_answer:
        return f"{last_answer}\n\n{notice}"
    return notice



class AgentRuntime:
    """tool-calling 循环执行器（provider 可注入，便于本地/测试）"""

    def __init__(
        self,
        provider: Optional[ModelProvider] = None,
        max_steps: Optional[int] = None,
        max_tool_result_chars: Optional[int] = None,
    ):
        tools_server.load_server_tools()
        cfg = get_config().agent
        self.provider = provider or get_provider()
        self.max_steps = max_steps or cfg.max_steps
        self.max_tool_result_chars = max_tool_result_chars or cfg.max_tool_result_chars

    async def run(
        self,
        ctx: ToolContext,
        prompt: str,
        on_step: Optional[StepCallback] = None,
        *,
        history: Optional[List[Dict[str, Any]]] = None,
        approvals: Optional[Dict[str, str]] = None,
        is_cancelled: Optional[CancelCheck] = None,
        on_delta: Optional[DeltaCallback] = None,
        session_context: Optional[str] = None,
        token_budget: Optional[int] = None,
    ) -> RunOutcome:
        """执行一轮 tool-calling 循环。

        Args:
            ctx: 工具执行上下文（``ctx.allow_write`` 决定是否暴露写工具）
            prompt: 用户输入（仅在无 ``history`` 的首轮使用）
            on_step: 每步回调（落 checkpoint + 流式推送）
            history: 恢复执行时的完整消息列表（原样前置，省去反推）
            approvals: ``{tool_call_id: "approved"|"rejected"}``，来自审批端点
            is_cancelled: 取消感知回调
            on_delta: 模型输出增量回调（provider 支持流式时逐段调用，
                供频道打字机效果；不支持则静默忽略）
            session_context: 会话记忆摘要，仅首轮（无 ``history``）并入 system 消息
            token_budget: 本轮允许消耗的 token 上限（None=不限）；达上限返回
                :data:`RunStatus.BUDGET_EXCEEDED` 并附已得结论，而非继续调用
        """
        allow_write = ctx.allow_write
        messages: List[Dict[str, Any]] = list(history or [])
        resumed = bool(history)
        if resumed:
            # history 是挂起时 RunOutcome.messages 的原样快照（已含 system），
            # 直接续跑；防御性地兜底首条非 system 的异常数据。
            if not messages or messages[0].get("role") != "system":
                messages.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
        else:
            system_content = SYSTEM_PROMPT
            if session_context:
                system_content = f"{SYSTEM_PROMPT}\n\n{session_context}"
            messages.append({"role": "system", "content": system_content})
            messages.append({"role": "user", "content": prompt})
            await _notify(on_step, STEP_USER, None, prompt, None)

        decisions = dict(approvals or {})
        answered = {
            m.get("tool_call_id") for m in messages if m.get("role") == "tool"
        }
        pending = _unanswered_tool_calls(messages, answered)
        model_calls = 0
        tokens_used = 0
        prompt_total = 0
        completion_total = 0
        cached_total = 0
        last_answer: Optional[str] = None
        can_stream = on_delta is not None and _supports_on_delta(self.provider)

        while True:
            if is_cancelled is not None and await is_cancelled():
                return RunOutcome(
                    RunStatus.CANCELLED, messages=messages, tokens_used=tokens_used,
                    prompt_tokens=prompt_total,
                    completion_tokens=completion_total,
                    cached_tokens=cached_total,
                )

            if token_budget is not None and tokens_used >= token_budget:
                return RunOutcome(
                    RunStatus.BUDGET_EXCEEDED,
                    answer=_budget_answer(last_answer),
                    messages=messages,
                    tokens_used=tokens_used,
                    prompt_tokens=prompt_total,
                    completion_tokens=completion_total,
                    cached_tokens=cached_total,
                )

            if pending:
                for call in pending:
                    if call.get("id") in answered:
                        continue
                    if is_cancelled is not None and await is_cancelled():
                        return RunOutcome(
                            RunStatus.CANCELLED, messages=messages,
                            tokens_used=tokens_used,
                            prompt_tokens=prompt_total,
                            completion_tokens=completion_total,
                            cached_tokens=cached_total,
                        )
                    spec = get_tool(call.get("name") or "")
                    # 写工具仅在"当前作业允许写"时才进入审批门禁；BYO-key 作业
                    # 不暴露写工具，若模型仍发出写调用则直接放行到 _execute 被拒，
                    # 避免展示"永远无法被批准"的确认卡片。
                    gated = spec is not None and spec.requires_approval and allow_write
                    decision = decisions.pop(call.get("id"), None) if gated else None
                    if gated and decision is None:
                        await _notify(
                            on_step, STEP_APPROVAL_REQUIRED, call.get("name"), None,
                            {
                                "tool_call_id": call.get("id"),
                                "tool": call.get("name"),
                                "arguments": call.get("arguments") or {},
                            },
                        )
                        return RunOutcome(
                            RunStatus.AWAITING_APPROVAL,
                            pending={
                                "tool_call_id": call.get("id"),
                                "tool": call.get("name"),
                                "arguments": call.get("arguments") or {},
                            },
                            messages=messages,
                            tokens_used=tokens_used,
                            prompt_tokens=prompt_total,
                            completion_tokens=completion_total,
                            cached_tokens=cached_total,
                        )
                    if decision == APPROVAL_REJECTED:
                        result: Dict[str, Any] = {
                            "error": "用户拒绝了该操作，未执行"
                        }
                    else:
                        await _notify(
                            on_step, STEP_TOOL_CALL, call.get("name"), None,
                            call.get("arguments") or {},
                        )
                        result = await self._execute(
                            ctx, call.get("name") or "", call.get("arguments") or {},
                            allow_write=allow_write,
                        )
                    answered.add(call.get("id"))
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.get("id"),
                            "content": _tool_result_content(
                                result, self.max_tool_result_chars
                            ),
                        }
                    )
                    await _notify(on_step, STEP_TOOL_RESULT, call.get("name"), None, result)
                # 一轮模型可能同时请求多个调用：逐条处理后重扫，仍有余量则继续
                pending = _unanswered_tool_calls(messages, answered)
                if pending:
                    continue

            if model_calls >= self.max_steps:
                raise MaxStepsExceeded(f"Agent 超过最大步数 {self.max_steps}")
            model_calls += 1
            tools_spec = openai_tools(allow_write=allow_write)
            if can_stream:
                reply = await self.provider.complete(
                    messages, tools_spec, on_delta=on_delta
                )
            else:
                reply = await self.provider.complete(messages, tools_spec)
            tokens_used += _usage_tokens(reply.usage)
            p, c, ca = _usage_breakdown(reply.usage)
            prompt_total += p
            completion_total += c
            cached_total += ca
            if reply.content:
                # 记录最近一次模型正文：预算降级时作为「已有结论」返回
                last_answer = reply.content
            if not reply.tool_calls:
                answer = reply.content or ""
                await _notify(on_step, STEP_ASSISTANT, None, answer, None)
                return RunOutcome(
                    RunStatus.ANSWERED, answer=answer, messages=messages,
                    tokens_used=tokens_used,
                    prompt_tokens=prompt_total,
                    completion_tokens=completion_total,
                    cached_tokens=cached_total,
                )

            messages.append(
                {
                    "role": "assistant",
                    "content": reply.content or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(
                                    tc.arguments, ensure_ascii=False
                                ),
                            },
                        }
                        for tc in reply.tool_calls
                    ],
                }
            )
            await _notify(
                on_step, STEP_ASSISTANT, None, reply.content or "",
                {
                    "tool_calls": [
                        {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                        for tc in reply.tool_calls
                    ]
                },
            )
            pending = [
                {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                for tc in reply.tool_calls
            ]

    async def _execute(
        self,
        ctx: ToolContext,
        name: str,
        args: Dict[str, Any],
        *,
        allow_write: bool = True,
    ) -> Dict[str, Any]:
        spec = get_tool(name)
        if spec is None:
            return {"error": f"未知工具: {name}"}
        if spec.is_write and not allow_write:
            return {"error": f"当前作业不允许写操作，拒绝执行 {name}"}
        if spec.is_write and not await self._can_write(ctx):
            return {"error": f"当前用户无仓库写权限，拒绝执行 {name}"}
        try:
            result = await spec.handler(ctx, args or {})
            result = result if isinstance(result, dict) else {"result": result}
            if spec.is_write and "error" not in result:
                # 审计：写工具**成功执行**才落 Activity（被拒/出错无副作用不记）
                await self._record_write_activity(ctx, name, args)
            return result
        except Exception as exc:  # noqa: BLE001 — 工具异常回灌模型，不中断循环
            logger.warning("Agent 工具 %s 执行失败: %s", name, exc)
            return {"error": f"{type(exc).__name__}: {exc}"}

    @staticmethod
    async def _record_write_activity(
        ctx: ToolContext, name: str, args: Dict[str, Any]
    ) -> None:
        """写工具成功执行 → Activity 审计（步骤级明细已有 agent_steps，
        此处只记**决策性动作**：创建/审批/取消/写工具，防活动流洪泛）。"""
        if (
            ctx.db is None
            or ctx.repository_id is None
            or ctx.user_id is None
            or ctx.job_id is None
        ):
            return
        from app.services.repository.activity_service import try_record_activity

        # details 取人类可读的首要参数（标题/路径/编号/分支），兜底截断 JSON
        detail = ""
        for key in ("title", "path", "issue_number", "pr_number", "message"):
            if args.get(key) not in (None, ""):
                detail = f"{key}: {args[key]}"
                break
        if not detail:
            detail = json.dumps(args, ensure_ascii=False, default=str)
        await try_record_activity(
            repository_id=ctx.repository_id,
            actor_id=ctx.user_id,
            entity_type="agent_tool",
            entity_id=ctx.job_id,
            action=name,
            details=detail[:200],
            db=ctx.db,
        )

    async def _can_write(self, ctx: ToolContext) -> bool:
        """写工具门禁：校验调用者具备仓库写角色（owner/admin/developer）"""
        if ctx.db is None or ctx.repository_id is None or ctx.user_id is None:
            return False
        from app.core.permissions import Action, has_repo_action

        return await has_repo_action(ctx.db, ctx.user_id, ctx.repository_id, Action.AGENT_WRITE)


async def _notify(
    on_step: Optional[StepCallback],
    step_type: str,
    name: Optional[str],
    content: Optional[str],
    data: Optional[Dict[str, Any]],
) -> None:
    if on_step is not None:
        await on_step(step_type, name, content, data)
