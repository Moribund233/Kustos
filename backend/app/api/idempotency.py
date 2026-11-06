"""幂等键的 HTTP 接入。

把 :mod:`app.services.idempotency_service` 的存储语义接到 FastAPI 上：读取
``Idempotency-Key`` 请求头、命中则重放首次响应、冲突则 409、未带键则原样放行。

**为什么用显式 helper 而不是中间件**：中间件要读取并重放请求体，在
``BaseHTTPMiddleware`` 下很容易把 body 流消耗掉导致下游拿不到 JSON；而且
中间件会隐式作用于所有端点，无法一眼看出哪些写接口支持幂等。这里让每个
目标端点显式调用两步，支持范围一目了然，也不会波及未接入的端点。

用法（在创建类端点里）::

    cached = await replay_if_idempotent(
        db, request, current_user, resource="issues", body=data.model_dump()
    )
    if cached is not None:
        return cached.resource_body

    created = await do_create(...)
    await remember_replay(db, request, current_user, resource="issues",
                          body=data.model_dump(), status_code=201,
                          response_body=created, resource_id=str(created["id"]))
    await db.commit()
    return created

两步之间必须**同一次事务提交**：若先提交业务再单独写幂等记录，中间崩溃会
导致"业务已成功但补发不被识别"，重发就产生重复数据。
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import uuid as _uuid
from typing import Any, Dict, Optional

from fastapi import HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.services.idempotency_service import (
    IDEMPOTENCY_HEADER,
    MAX_KEY_LENGTH,
    IdempotencyConflict,
    compute_fingerprint,
    lookup,
    remember_key,
)

logger = logging.getLogger(__name__)


class IdempotentReplay(Response):
    """命中幂等键时返回的响应：状态码与响应体取自首次执行。

    继承 ``Response`` 而非 ``JSONResponse`` 是为了让端点能 ``return`` 它，
    由 FastAPI 原样发出——不能再走一次响应模型校验，否则重放的响应会被
    当前请求的 schema 重新序列化，丢掉首次响应里可能已经变化的字段。
    """

    def __init__(self, status_code: int, body: Any) -> None:
        super().__init__(
            content=json.dumps(body, ensure_ascii=False, default=str),
            status_code=status_code,
            media_type="application/json",
            headers={"Idempotent-Replayed": "true"},
        )
        self.resource_body = body


def _header_key(request: Request) -> Optional[str]:
    """读取并校验幂等键；超长直接 400，避免把任意长度串塞进唯一索引。"""
    raw = request.headers.get(IDEMPOTENCY_HEADER)
    if raw is None:
        return None
    key = raw.strip()
    if not key:
        return None
    if len(key) > MAX_KEY_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Idempotency-Key 超过 {MAX_KEY_LENGTH} 字符",
        )
    return key


def _scope(request: Request, resource: str) -> str:
    """幂等作用域：``METHOD path``，不含查询串（避免分页参数污染幂等身份）。"""
    return f"{request.method.upper()} {request.url.path}#{resource}"


async def replay_if_idempotent(
    db: AsyncSession,
    request: Request,
    current_user: User,
    *,
    resource: str,
    body: Any,
) -> Optional[IdempotentReplay]:
    """命中既有幂等记录则返回可直接返回的重放响应，否则返回 None。

    Raises:
        HTTPException: 409 —— 同一键被用于不同请求体。
    """
    key = _header_key(request)
    if key is None:
        return None

    fingerprint = compute_fingerprint(request.method, request.url.path, body)
    try:
        record = await lookup(
            db,
            key=key,
            user_id=current_user.id,
            scope=_scope(request, resource),
            fingerprint=fingerprint,
        )
    except IdempotencyConflict:
        # 不能重放旧结果：用户会以为第二个请求也成功了，而实际上它没被执行。
        raise HTTPException(
            status_code=409,
            detail="该 Idempotency-Key 已用于不同的请求内容",
        )

    if record is None:
        return None
    logger.info(
        "幂等重放 key=%s resource=%s status=%s", key, resource, record.status_code
    )
    return IdempotentReplay(record.status_code, record.response_body)


def _jsonable(value: Any) -> Any:
    """把响应体转成可安全写入 JSON 列的结构。

    端点返回的通常是 dict，但里面混着 UUID / datetime（如 ``id``、``created_at``）。
    JSON 列由数据库驱动直接序列化，没有 FastAPI 的编码器兜底，不转换会抛
    ``TypeError: Object of type UUID is not JSON serializable``。
    重放时前端收到的是字符串，与首次响应经 FastAPI 编码后的形态一致。
    """
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (_uuid.UUID,)):
        return str(value)
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
        return value.isoformat()
    return value


async def remember_replay(
    db: AsyncSession,
    request: Request,
    current_user: User,
    *,
    resource: str,
    body: Any,
    status_code: int,
    response_body: Any,
    resource_id: Optional[str] = None,
) -> None:
    """登记本次执行结果（不提交，由调用方与业务写入同事务提交）。

    未携带幂等键时为 no-op，不改变既有调用方行为。
    """
    key = _header_key(request)
    if key is None:
        return

    fingerprint = compute_fingerprint(request.method, request.url.path, body)
    if isinstance(response_body, dict):
        payload: Dict[str, Any] = _jsonable(response_body)
    else:
        payload = {"data": _jsonable(response_body)}

    remember_key(
        db,
        key=key,
        user_id=current_user.id,
        scope=_scope(request, resource),
        fingerprint=fingerprint,
        status_code=status_code,
        response_body=payload,
        resource_id=resource_id,
    )
