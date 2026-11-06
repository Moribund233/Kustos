"""协作感知: 活跃文档聚合服务

桌面端需要"进入协作之前"就知道哪些文件正有人编辑（文件树 live 圆点、
进入前预览），而连接计数只存在于协作网关的进程内存里（``connectionsByDoc``），
app 无法直接读取。因此由网关暴露只读内部端点，app 逐副本聚合后对外提供。

拓扑::

    app ──GET {gateway}/internal/active?repository_id=...──▶ collab 副本 1..N
    app ◀── {documents: [{docKey, connections}]} ────────────

多副本部署时同一文档可能落在不同副本上，故**计数按 docKey 求和**而不是取其一；
这是唯一正确的合并方式：用户可以同时连在不同副本上编辑同一文件。

降级原则: 协作感知是仓库浏览的锦上添花，**绝不阻塞**主流程。网关未配置、
不可达、超时、响应异常一律回退为空清单，并由调用方以 ``degraded`` 标记
显式告知前端——否则 UI 无法区分"真的没人编辑"与"感知能力不可用"。

安全: 只回连接数与 ``docKey``，**不含任何身份信息**（身份仍从 awareness 取）。
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, List

import httpx

from app.core.config import get_config_value

logger = logging.getLogger(__name__)

#: 网关内部地址（逗号分隔，多副本时逐个聚合）
ENDPOINTS_ENV = "KUSTOS_COLLAB_ACTIVE_ENDPOINTS"
#: 内部共享密钥，与 collab_internal_controller 同源
SECRET_ENV = "KUSTOS_COLLAB_INTERNAL_SECRET"
#: 内部端点路径（网关侧 activeDocuments.mjs）
ACTIVE_PATH = "/internal/active"
#: 单副本查询超时（秒）；感知数据快过期不如快失败，不拖累仓库浏览。
#: 运行期读 [collab] active_query_timeout_seconds，本常量仅作降级默认。
DEFAULT_REQUEST_TIMEOUT_SECONDS = 2.0


def _endpoints() -> List[str]:
    """解析网关内部地址清单；未配置返回空列表（视为协作感知未部署）。"""
    raw = (os.environ.get(ENDPOINTS_ENV) or "").strip()
    if not raw:
        return []
    return [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]


def _configured() -> bool:
    """是否配置了网关地址且持有密钥（两者缺一即不可用）。"""
    return bool(_endpoints()) and bool((os.environ.get(SECRET_ENV) or "").strip())


def _timeout_seconds() -> float:
    """单副本查询超时；配置不可用时回退模块默认。"""
    return float(
        get_config_value(
            "collab", "active_query_timeout_seconds", DEFAULT_REQUEST_TIMEOUT_SECONDS
        )
    )


async def _fetch_replica(
    base_url: str, secret: str, repository_id: str
) -> List[Dict[str, Any]]:
    """查询单个副本的活跃文档；任何失败都归一为空清单（不向上抛）。"""
    url = f"{base_url}{ACTIVE_PATH}"
    try:
        async with httpx.AsyncClient(timeout=_timeout_seconds()) as client:
            resp = await client.get(
                url,
                params={"repository_id": repository_id},
                headers={"X-Collab-Internal-Secret": secret},
            )
    except Exception as exc:  # noqa: BLE001 — 副本不可达是预期内降级路径
        logger.debug("collab active 查询失败 %s: %s", base_url, exc)
        return []

    if resp.status_code != 200:
        logger.debug("collab active %s 返回 %s", base_url, resp.status_code)
        return []

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001 — 非 JSON 响应视为无效副本
        logger.debug("collab active %s 响应非 JSON", base_url)
        return []

    documents = payload.get("documents") if isinstance(payload, dict) else None
    return documents if isinstance(documents, list) else []


async def collect_active_documents(repository_id: str) -> List[Dict[str, Any]]:
    """聚合各副本的活跃文档清单。

    Args:
        repository_id: 仓库 ID；只保留属于该仓库的 docKey。

    Returns:
        按 ``docKey`` 升序的 ``[{"docKey": str, "connections": int}]``；
        同一 docKey 跨副本计数**求和**。未配置或全部失败时返回空清单。
    """
    endpoints = _endpoints()
    secret = (os.environ.get(SECRET_ENV) or "").strip()
    if not endpoints or not secret:
        return []

    # 并发查询各副本：串行会让最慢的副本决定整体延迟
    per_replica = await asyncio.gather(
        *(_fetch_replica(url, secret, str(repository_id)) for url in endpoints),
        return_exceptions=True,
    )

    prefix = f"{str(repository_id).lower()}:"
    totals: Dict[str, int] = {}
    for result in per_replica:
        if not isinstance(result, list):
            continue
        for item in result:
            if not isinstance(item, dict):
                continue
            doc_key = item.get("docKey")
            connections = item.get("connections")
            if not isinstance(doc_key, str) or not doc_key.lower().startswith(prefix):
                continue
            try:
                count = int(connections)
            except (TypeError, ValueError):
                continue
            if count <= 0:
                continue
            totals[doc_key] = totals.get(doc_key, 0) + count

    return [
        {"docKey": doc_key, "connections": count}
        for doc_key, count in sorted(totals.items())
    ]


def is_degraded() -> bool:
    """协作感知当前是否不可用（未配置网关地址或缺密钥）。"""
    return not _configured()
