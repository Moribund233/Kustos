"""出站 URL 白名单校验（防 SSRF）

**信任边界**：本模块只校验**请求级（不可信）**传入的 URL —— 典型场景是
`POST /repositories/{id}/agent/jobs` 请求体里的 ``base_url``。任何能对某仓库
发起读请求的用户都能控制该字段，若原样交给 ``httpx`` 发出，服务端即可被当作
跳板访问内网（云 metadata / Redis / 自身 API）。

**为何用白名单而非"拒绝私有 IP"**：
``base_url`` 的主用途是接入**自托管** OpenAI 兼容服务（vLLM / Ollama / one-api），
它们本就部署在私网/回环地址。因此正确做法是把"是否允许访问私网"这一决定权交给
管理员（配置白名单），而不是在代码里一刀切——代码层的黑名单也挡不住 DNS rebinding。

**配置级 URL 不走白名单**：配置里的 ``agent.base_url``（DB/env 层）/
``search.embedding_base_url`` 由管理员掌控，属于可信输入，不做限制；
管理端点（``/api/app/agent/*``）里管理员传入的 ``base_url`` 走
``validate_config_url``——只做形态校验（http/https、拒 userinfo），
不拦私网/回环（自托管服务合法部署在回环）。

匹配规则：按 ``(scheme, host, port)`` 三元组比较，**忽略 path**。因此白名单项
``https://api.openai.com/v1`` 允许该主机下的任意路径，而
``http://127.0.0.1:11434`` 只放行 11434 端口。白名单为空 = 拒绝一切请求级 URL。
"""
from __future__ import annotations

from typing import List, Optional, Tuple
from urllib.parse import urlsplit

ALLOWED_SCHEMES = ("http", "https")

DEFAULT_PORTS = {"http": 80, "https": 443}


class UrlNotAllowed(ValueError):
    """URL 不在白名单内 / 形态非法"""


def _origin(url: str) -> Optional[Tuple[str, str, int]]:
    """把 URL 归一为 ``(scheme, host, port)``；形态非法返回 None。

    拒绝含 userinfo（``https://user:pass@host``）的 URL —— 凭据走私无正当用途。
    """
    if not url or not url.strip():
        return None
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    scheme = (parts.scheme or "").lower()
    if scheme not in ALLOWED_SCHEMES:
        return None
    if parts.username or parts.password or "@" in (parts.netloc or ""):
        return None
    try:
        host = parts.hostname
    except ValueError:
        return None
    if not host:
        return None
    try:
        port = parts.port
    except ValueError:
        return None
    return (scheme, host.lower(), port if port is not None else DEFAULT_PORTS[scheme])


def validate_config_url(url: Optional[str]) -> str:
    """校验**配置级** URL 的形态（非白名单）；通过则返回去空白原值，否则抛 :class:`UrlNotAllowed`。

    信任边界：配置级 URL（如 ``GET/POST /api/app/agent/*`` 里管理员传入的
    ``base_url``）由管理员掌控，与请求级 ``validate_outbound_url`` 不同——
    **不做白名单、不拦私网/回环**：自托管 vLLM / Ollama 本就部署在回环地址
    （见 ``services/agent/provider_catalog.py``）。但形态仍须检查：
    非 http/https、含 userinfo（凭据走私）、无 host 一律拒绝。

    Args:
        url: 待校验 URL（空值直接拒绝——管理端点缺省值应由服务端填配置，而非空串）

    Raises:
        UrlNotAllowed: 形态非法
    """
    if url is None or not str(url).strip():
        raise UrlNotAllowed("base_url 不能为空")
    candidate = str(url).strip()
    if _origin(candidate) is None:
        raise UrlNotAllowed("base_url 非法：仅支持不带凭据的 http/https 绝对 URL")
    return candidate


def parse_allowlist(raw: Optional[str]) -> List[str]:
    """把逗号/空白分隔的白名单配置解析为 URL 列表（忽略空项与非法项）"""
    if not raw:
        return []
    items = []
    for piece in raw.replace(";", ",").replace("\n", ",").split(","):
        candidate = piece.strip()
        if candidate and _origin(candidate) is not None:
            items.append(candidate)
    return items


def validate_outbound_url(url: Optional[str], allowlist: List[str]) -> str:
    """校验请求级出站 URL；通过则返回去除首尾空白的原值，否则抛 :class:`UrlNotAllowed`。

    Args:
        url: 请求携带的 URL（``None``/空表示不覆盖，走配置默认值，无需校验）
        allowlist: 管理员配置的白名单（``(scheme, host, port)`` 精确匹配）

    Raises:
        UrlNotAllowed: ``url`` 非空但不在白名单内，或形态非法。
    """
    if url is None or not str(url).strip():
        return ""
    candidate = str(url).strip()
    origin = _origin(candidate)
    if origin is None:
        raise UrlNotAllowed("base_url 非法：仅支持不带凭据的 http/https 绝对 URL")
    if not allowlist:
        raise UrlNotAllowed(
            "未配置允许的 base_url 白名单，拒绝请求级覆盖（如需自托管模型请设置 "
            "KUSTOS_AGENT_ALLOWED_BASE_URLS）"
        )
    for entry in allowlist:
        allowed = _origin(entry)
        if allowed is not None and allowed == origin:
            return candidate
    raise UrlNotAllowed("base_url 不在白名单内")
