"""语义检索的 embedding 适配器。

- ``EmbeddingProvider`` 协议；``OpenAICompatEmbeddingProvider`` 走 OpenAI 兼容
  ``POST {base_url}/embeddings``（项目既有 httpx）；
- 未配置时返回 ``NotConfiguredEmbeddingProvider``，语义检索**自动退化为关键词**；
- 向量直接存 pgvector 的 ``vector`` 列，近邻检索在库内完成（PostgreSQL-only）。

安全：API key 只从环境变量/请求内存取，不落库/不入配置；``__repr__`` 脱敏。
"""
from __future__ import annotations

import logging
import os
from typing import List, Optional, Protocol

import httpx

logger = logging.getLogger(__name__)


class EmbeddingProvider(Protocol):
    name: str
    model: str
    dim: int

    async def embed(self, texts: List[str]) -> List[List[float]]:
        ...


class EmbeddingNotConfigured(RuntimeError):
    """未配置 embedding provider"""


class NotConfiguredEmbeddingProvider:
    name = "none"
    model = ""
    dim = 0

    async def embed(self, texts: List[str]) -> List[List[float]]:  # noqa: ARG002
        raise EmbeddingNotConfigured(
            "未配置 embedding provider：设置 search.embedding_enabled 并让 "
            "embedding_api_key_env 指向存放 API key 的环境变量"
        )


class OpenAICompatEmbeddingProvider:
    """OpenAI 兼容 embeddings provider"""

    name = "openai"

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.openai.com/v1",
        model: str = "text-embedding-3-small",
        dim: int = 1536,
        timeout: float = 60.0,
    ):
        self._api_key = api_key
        self.base_url = (base_url or "").rstrip("/")
        self.model = model
        self.dim = dim
        self.timeout = timeout

    def __repr__(self) -> str:  # 防密钥泄漏
        return (
            f"OpenAICompatEmbeddingProvider(base_url={self.base_url!r}, "
            f"model={self.model!r}, api_key=***)"
        )

    async def embed(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        payload = {"model": self.model, "input": texts}
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                f"{self.base_url}/embeddings", headers=headers, json=payload
            )
            resp.raise_for_status()
            data = resp.json()
        items = sorted(data.get("data") or [], key=lambda d: d.get("index", 0))
        return [item.get("embedding") or [] for item in items]


_override: Optional[EmbeddingProvider] = None


def set_embedding_provider(provider: Optional[EmbeddingProvider]) -> None:
    global _override
    _override = provider


def reset_embedding_provider() -> None:
    global _override
    _override = None


def get_embedding_provider(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    dim: Optional[int] = None,
    timeout: Optional[float] = None,
) -> EmbeddingProvider:
    if _override is not None:
        return _override
    from app.core.config import get_config

    cfg = get_config().search
    # 密钥源链：显式入参 > env（部署硬约束）> DB 密文（admin 后台录入，
    # 与 LLM 链路的 agent.api_key 分表分键存储——两条链路配置独立）。
    # 解密失败抛 ConfigSecretError（Exception 系）：索引/查询侧既有的
    # except Exception 边界按设计降级为关键词检索并留 warning 日志。
    key = (api_key or os.environ.get(cfg.embedding_api_key_env, "") or "").strip()
    if not key:
        from app.services.config_store import get_secret

        key = get_secret("search", "embedding_api_key") or ""
    if not key:
        return NotConfiguredEmbeddingProvider()
    return OpenAICompatEmbeddingProvider(
        api_key=key,
        base_url=base_url or cfg.embedding_base_url,
        model=model or cfg.embedding_model,
        dim=dim or cfg.embedding_dim,
        timeout=timeout or cfg.embedding_timeout,
    )


def is_configured(provider: EmbeddingProvider) -> bool:
    return not isinstance(provider, NotConfiguredEmbeddingProvider)
