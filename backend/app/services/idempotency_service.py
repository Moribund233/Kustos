"""幂等键服务

让"重复提交"变成"重放首次结果"，是离线 outbox 自动补发的前提。设计文档
明确：没有幂等键就只能存草稿（``docs/prototype/desktop/desktop-app-design.md``
§15），补发会导致评论/Issue 重复。

三条硬规则：

1. **同键同体 → 重放**：返回首次的 status/body，不重复执行副作用。
2. **同键异体 → 409**：说明客户端把同一个键复用给了不同请求。此时重放旧
   结果是危险的——用户会以为第二个请求成功了。必须显式冲突。
3. **无键 → 放行**：不改变既有调用方行为。

存储用数据库而非 Redis：幂等记录必须与业务写入**同一次事务**提交，否则
"记录已写但业务回滚"会让后续补发被错误地当成已完成而吞掉真实写入。
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.idempotency_record import IdempotencyRecord

logger = logging.getLogger(__name__)

#: 请求头名（大小写不敏感，FastAPI/Starlette 的 headers 已是小写键）
IDEMPOTENCY_HEADER = "idempotency-key"

#: 键的最大长度；超长直接拒绝，避免把任意长度串塞进唯一索引
MAX_KEY_LENGTH = 255


class IdempotencyConflict(Exception):
    """同一幂等键被用于不同的请求体。

    单独定义而非复用 HTTP 异常：服务层不感知 HTTP 语义，由接入方翻译成
    409 响应。这样服务层可以被 worker/脚本复用。
    """

    def __init__(self, key: str) -> None:
        super().__init__(f"幂等键已被用于不同的请求体: {key}")
        self.key = key


def compute_fingerprint(method: str, path: str, body: Any) -> str:
    """请求指纹：方法 + 路径 + 规范化 JSON 体。

    键序必须无关（``sort_keys``）——客户端两次序列化同一对象可能得到不同
    键序，若按原文摘要会把合法的重试误判成冲突。

    Args:
        method: HTTP 方法。
        path: 请求路径（不含查询串，避免分页参数污染幂等身份）。
        body: 请求体，任意可 JSON 序列化对象。

    Returns:
        sha256 十六进制摘要。
    """
    try:
        payload = json.dumps(body, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        payload = repr(body)
    raw = f"{method.upper()}\n{path}\n{payload}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def lookup(
    db: AsyncSession,
    *,
    key: str,
    user_id,
    scope: str,
    fingerprint: str,
) -> Optional[IdempotencyRecord]:
    """查询既有幂等记录。

    Returns:
        命中且指纹一致 → 既有记录（调用方应重放其响应）；
        未命中 → ``None``（调用方应正常执行）。

    Raises:
        IdempotencyConflict: 键命中但指纹不同。
    """
    result = await db.execute(
        select(IdempotencyRecord).filter(
            IdempotencyRecord.user_id == user_id,
            IdempotencyRecord.scope == scope,
            IdempotencyRecord.key == key,
        )
    )
    record = result.scalar_one_or_none()
    if record is None:
        return None
    if record.fingerprint != fingerprint:
        raise IdempotencyConflict(key)
    return record


def remember_key(
    db: AsyncSession,
    *,
    key: str,
    user_id,
    scope: str,
    fingerprint: str,
    status_code: int,
    response_body: Optional[Dict[str, Any]] = None,
    resource_id: Optional[str] = None,
) -> IdempotencyRecord:
    """登记一次成功执行的幂等结果（不提交，由调用方与新资源同事务提交）。

    Args:
        db: 异步会话；记录随业务写入一起 commit。
        key: 客户端幂等键。
        user_id: 键归属用户。
        scope: ``METHOD path``。
        fingerprint: 请求指纹。
        status_code: 首次执行的状态码。
        response_body: 首次执行的响应体，重放时原样返回。
        resource_id: 新建资源 ID（诊断用）。

    Returns:
        新增的记录对象。
    """
    record = IdempotencyRecord(
        user_id=user_id,
        scope=scope,
        key=key,
        fingerprint=fingerprint,
        status_code=status_code,
        response_body=response_body,
        resource_id=resource_id,
    )
    db.add(record)
    return record


async def commit_guarded(db: AsyncSession) -> bool:
    """提交并处理唯一约束竞争。

    两个并发请求携带同一键时，可能都通过了 ``lookup`` 而同时尝试插入；
    数据库唯一约束会让其中一个失败。此时不应把错误抛给用户——正确的语义是
    "另一个请求已经用这个键完成了"，让调用方回退到重放路径。

    Returns:
        True 提交成功；False 因幂等键唯一约束冲突而回滚（调用方应重放）。
    """
    try:
        await db.commit()
        return True
    except IntegrityError as exc:
        await db.rollback()
        # 仅当冲突来自幂等表的唯一约束时才返回 False；其他完整性错误必须上抛，
        # 否则会吞掉真实的数据问题。
        if "uq_idempotency_user_scope_key" in str(getattr(exc, "orig", exc)):
            logger.info("幂等键并发竞争：另一请求已完成，回退到重放路径")
            return False
        raise
