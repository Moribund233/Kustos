"""LLM provider 适配器。

默认实现走 OpenAI 兼容的 ``POST {base_url}/chat/completions``（function calling），
用项目既有的 ``httpx``，不额外引入 SDK。

安全：``api_key`` 只作为实例属性存在于内存，``__repr__`` 与日志一律脱敏，
不写入数据库或配置文件；也可由单次请求在内存中携带。
未配置时返回 ``NotConfiguredProvider``，作业以明确错误失败而非静默。
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Protocol

import httpx

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "你是 Kustos 内置的代码仓库助手。可以调用提供的只读工具检索代码、符号、"
    "PR 与 Issue。回答要基于证据并标注 `file:line`；只读，不得臆造未检索到的内容。"
    "若信息不足，明确说明并给出下一步检索建议。"
)

#: 未配置 provider 的统一文案（作业失败与聊天桥预检共用）
NOT_CONFIGURED_MSG = (
    "未配置 LLM provider：设置 KUSTOS_AGENT_ENABLED=1 并让 api_key_env "
    "指向存放 API key 的环境变量，或在请求中于内存携带 api_key"
)


@dataclass
class ToolCallRequest:
    """模型请求的一次工具调用"""
    id: str
    name: str
    arguments: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ModelReply:
    """模型一次回复（可能含文本与/或工具调用）"""
    content: Optional[str]
    tool_calls: List[ToolCallRequest] = field(default_factory=list)
    usage: Optional[Dict[str, Any]] = None


class ModelProvider(Protocol):
    name: str
    model: str

    async def complete(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        *,
        on_delta: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> ModelReply:
        ...


class ProviderNotConfigured(RuntimeError):
    """未配置任何 LLM provider"""


def _parse_tool_args(raw: Any) -> Dict[str, Any]:
    """工具入参归一为 dict（JSON 字符串解析；坏数据保底为 ``_raw`` 不丢内容）"""
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except ValueError:
        return {"_raw": raw}
    return parsed if isinstance(parsed, dict) else {"_raw": parsed}


class NotConfiguredProvider:
    """占位 provider：任何调用都显式失败（不静默）"""
    name = "none"
    model = ""

    async def complete(
        self, messages, tools, *, on_delta=None
    ) -> ModelReply:  # noqa: ANN001
        raise ProviderNotConfigured(NOT_CONFIGURED_MSG)


class OpenAICompatProvider:
    """OpenAI 兼容 chat/completions provider（function calling）"""

    name = "openai"

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.openai.com/v1",
        model: str = "gpt-4o-mini",
        max_tokens: int = 1024,
        temperature: float = 0.2,
        timeout: float = 60.0,
    ):
        self._api_key = api_key
        self.base_url = (base_url or "").rstrip("/")
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.timeout = timeout

    def __repr__(self) -> str:  # 防密钥泄漏
        return (
            f"OpenAICompatProvider(base_url={self.base_url!r}, "
            f"model={self.model!r}, api_key=***)"
        )

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    def _payload(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        *,
        stream: bool = False,
        include_usage: bool = True,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if stream:
            payload["stream"] = True
            # 末尾 chunk 携带 usage（OpenAI 及多数兼容网关支持；
            # 不支持的网关通常 400 → 上层回退非流式，不会静默丢计量）
            if include_usage:
                payload["stream_options"] = {"include_usage": True}
        return payload

    @staticmethod
    def _parse_reply(data: Dict[str, Any]) -> ModelReply:
        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError("LLM 返回空 choices")
        message = choices[0].get("message") or {}
        tool_calls: List[ToolCallRequest] = []
        for tc in message.get("tool_calls") or []:
            fn = tc.get("function") or {}
            tool_calls.append(
                ToolCallRequest(
                    id=tc.get("id") or "",
                    name=fn.get("name") or "",
                    arguments=_parse_tool_args(fn.get("arguments")),
                )
            )
        return ModelReply(
            content=message.get("content"), tool_calls=tool_calls, usage=data.get("usage")
        )

    async def _post_json(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions", headers=self._headers(), json=payload
            )
            resp.raise_for_status()
            return resp.json()

    async def _post_sse(
        self,
        payload: Dict[str, Any],
        on_delta: Callable[[str], Awaitable[None]],
    ) -> ModelReply:
        """SSE 流式请求：逐 delta 回调，结束归并为 ModelReply。

        兼容三种形态：标准 SSE；服务器忽略 ``stream`` 直接回整体 JSON
        （不发 ``data:`` 行时按 JSON 解析）；4xx/5xx 先读错误体再抛出。
        """
        content_parts: List[str] = []
        tool_acc: Dict[Any, Dict[str, Any]] = {}
        usage: Optional[Dict[str, Any]] = None
        saw_sse = False
        raw_lines: List[str] = []

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream(
                "POST", f"{self.base_url}/chat/completions",
                headers=self._headers(), json=payload,
            ) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread())[:300]
                    raise RuntimeError(
                        f"SSE 请求失败 status={resp.status_code}: {body!r}"
                    )
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    if not line.startswith("data:"):
                        raw_lines.append(line)
                        continue
                    saw_sse = True
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    if isinstance(chunk.get("usage"), dict):
                        usage = chunk["usage"]
                    for ch in chunk.get("choices") or []:
                        delta = ch.get("delta") or {}
                        text = delta.get("content")
                        if text:
                            content_parts.append(text)
                            await on_delta(text)
                        for tc in delta.get("tool_calls") or []:
                            idx = tc.get("index", 0)
                            acc = tool_acc.setdefault(
                                idx, {"id": "", "name": "", "args": []}
                            )
                            if tc.get("id"):
                                acc["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                acc["name"] = fn["name"]
                            if fn.get("arguments"):
                                acc["args"].append(fn["arguments"])

        if not saw_sse:
            # 网关忽略 stream:true 直接回整体 JSON
            return self._parse_reply(json.loads("\n".join(raw_lines)))

        tool_calls = [
            ToolCallRequest(
                id=str(acc["id"]),
                name=str(acc["name"]),
                arguments=_parse_tool_args("".join(acc["args"]) or None),
            )
            for _, acc in sorted(tool_acc.items(), key=lambda kv: str(kv[0]))
        ]
        return ModelReply(
            content="".join(content_parts) or None,
            tool_calls=tool_calls,
            usage=usage,
        )

    async def complete(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        *,
        on_delta: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> ModelReply:
        """请求模型。``on_delta`` 给定时走 SSE 流式并逐段回调。

        流式任何阶段失败都回退非流式（已流出的增量由上层气泡容忍——
        终态回帖会整体替换）；已发过增量则不再重试第二遍流式，避免重复文本。
        """
        if on_delta is None:
            return self._parse_reply(await self._post_json(self._payload(messages, tools)))

        emitted = {"n": 0}

        async def wrapped(delta: str) -> None:
            emitted["n"] += 1
            await on_delta(delta)

        for include_usage in (True, False):
            try:
                return await self._post_sse(
                    self._payload(
                        messages, tools, stream=True, include_usage=include_usage
                    ),
                    wrapped,
                )
            except Exception as exc:  # noqa: BLE001 — 一律降级，最终由非流式定成败
                if emitted["n"]:
                    break  # 已流出部分内容：跳过流式重试，直接非流式兜底
                logger.warning(
                    "SSE 流式失败(include_usage=%s)，回退: %s", include_usage, exc
                )
        return self._parse_reply(await self._post_json(self._payload(messages, tools)))


_provider_override: Optional[ModelProvider] = None


def set_provider(provider: Optional[ModelProvider]) -> None:
    """注入 provider（测试/自定义用）"""
    global _provider_override
    _provider_override = provider


def reset_provider() -> None:
    global _provider_override
    _provider_override = None


def resolve_env_key(provider_id: Optional[str] = None) -> tuple[str, str]:
    """按候选顺序解析 env key → ``(env_name, key)``；全空 → ``("", "")``。

    候选顺序：provider 目录条目专属环境变量名在前（如 ``KUSTOS_DEEPSEEK_API_KEY``），
    通用 ``agent.api_key_env`` 兜底——既有部署只注入 ``KUSTOS_AGENT_API_KEY`` 也照常工作。
    与管理面 ``AgentAdminService.resolve_api_key`` 同一口径（key 只进内存）。
    """
    from app.core.config import get_config
    from app.services.agent.provider_catalog import get_entry

    cfg = get_config().agent
    names: list[str] = []
    entry = get_entry(provider_id)
    if entry:
        names.extend(entry.key_envs)
    if cfg.api_key_env:
        names.append(cfg.api_key_env)
    for name in dict.fromkeys(n for n in names if n):
        value = (os.environ.get(name) or "").strip()
        if value:
            return name, value
    return "", ""


def get_provider(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
) -> ModelProvider:
    """按优先级取 provider：测试注入 > 请求内存 key > 环境变量（目录候选顺序）。

    仅当拿到非空 key 时构造真实 provider；否则返回 NotConfiguredProvider。
    """
    if _provider_override is not None:
        return _provider_override
    from app.core.config import get_config
    from app.services.agent.provider_catalog import get_entry

    cfg = get_config().agent
    # 密钥源链：请求内存 key > env 候选（部署硬约束）> DB 密文（admin 后台录入）。
    # 解密失败抛 ConfigSecretError（Exception 系）：作业路径由 process_job 的
    # except Exception 捕获落 job.error——不抛 BaseException 系的 HTTP 异常，
    # 否则逃逸后作业僵死到超时回收；HTTP 管理面在服务层转 config_secret_decrypt_failed。
    key = (api_key or "").strip() or resolve_env_key(cfg.provider)[1]
    if not key:
        from app.core.config_store import get_secret

        key = get_secret("agent", "api_key") or ""
    if not key:
        return NotConfiguredProvider()
    if get_entry(cfg.provider) is None:
        # 目录外的 provider id：无专属元数据，按 OpenAI 兼容实现处理（base_url 已显式配置）
        logger.warning("未知 Agent provider=%s，按 OpenAI 兼容实现处理", cfg.provider)
    return OpenAICompatProvider(
        api_key=key,
        base_url=base_url or cfg.base_url,
        model=model or cfg.model,
        max_tokens=cfg.max_tokens,
        temperature=cfg.temperature,
        timeout=cfg.request_timeout,
    )
