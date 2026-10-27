"""统一工具注册表。

每个工具是现有 service 的薄适配器，携带：
- ``parameters``：JSON Schema，供模型 function calling；
- ``plane``：执行面 ``server`` | ``local``（local 为 desktop 反向 RPC）；
- ``scope``：权限范围（复用仓库角色判定）；
- ``requires_approval``：危险工具是否需用户显式授权（本地执行用）。
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

PLANE_SERVER = "server"
PLANE_LOCAL = "local"


@dataclass
class ToolContext:
    """工具执行上下文（server-plane：主库会话 + 仓库 + 用户）"""
    db: Any
    repository_id: Optional[uuid.UUID]
    user_id: Optional[uuid.UUID]
    repo_path: Optional[str] = None
    # 作业锚点（Activity 审计的实体 id；非作业上下文保持 None → 不落审计）
    job_id: Optional[uuid.UUID] = None
    # 是否允许暴露/执行写工具。请求自带 API key 的作业强制为 False —— 这类作业
    # 密钥只在创建请求的进程内存中，一旦因审批而暂停，worker 无从取得密钥，
    # 写工具将永远无法被批准执行（见 runtime 的审批门禁）。
    allow_write: bool = True


ToolHandler = Callable[[ToolContext, Dict[str, Any]], Awaitable[Any]]


SCOPE_READ = "repo:read"
SCOPE_WRITE = "repo:write"


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: Dict[str, Any]
    handler: ToolHandler
    plane: str = PLANE_SERVER
    scope: str = SCOPE_READ
    requires_approval: bool = False

    @property
    def is_write(self) -> bool:
        return self.scope == SCOPE_WRITE

    def to_openai(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


_REGISTRY: Dict[str, ToolSpec] = {}


def register_tool(spec: ToolSpec) -> ToolSpec:
    _REGISTRY[spec.name] = spec
    return spec


def get_tool(name: str) -> Optional[ToolSpec]:
    return _REGISTRY.get(name)


def list_tools(plane: Optional[str] = None) -> List[ToolSpec]:
    return [s for s in _REGISTRY.values() if plane is None or s.plane == plane]


def visible_tools(plane: str = PLANE_SERVER, allow_write: bool = True) -> List[ToolSpec]:
    """按作业能力过滤工具面：``allow_write=False`` 时不暴露任何写工具。"""
    return [s for s in list_tools(plane) if allow_write or not s.is_write]


def openai_tools(plane: str = PLANE_SERVER, allow_write: bool = True) -> List[Dict[str, Any]]:
    return [s.to_openai() for s in visible_tools(plane, allow_write)]


def clear_registry() -> None:
    """测试隔离用"""
    _REGISTRY.clear()
