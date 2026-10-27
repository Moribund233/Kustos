"""内置 Agent 子包：provider 适配器、工具注册表、执行循环、队列与 worker。

安全：本包不持久化 LLM API key；密钥仅存在于内存或进程环境变量。
"""
from app.services.agent.tool_registry import (
    SCOPE_READ,
    SCOPE_WRITE,
    ToolContext,
    ToolSpec,
    get_tool,
    list_tools,
    openai_tools,
    visible_tools,
)
from app.services.agent.tools_server import load_server_tools

__all__ = [
    "SCOPE_READ",
    "SCOPE_WRITE",
    "ToolContext",
    "ToolSpec",
    "get_tool",
    "list_tools",
    "openai_tools",
    "visible_tools",
    "load_server_tools",
]
