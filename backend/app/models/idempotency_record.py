"""幂等键记录模型

离线 outbox 要让"自动补发"安全可用，服务端必须能识别重复提交。客户端在
请求头携带 ``Idempotency-Key``，服务端首次执行后把响应存下来；同一键再次
到达直接重放首次响应，不再产生第二个副作用。

键的作用域是 ``(user_id, scope, key)``：

- ``user_id``：键由客户端自选，跨用户相同是常态，不能串数据；
- ``scope``：``METHOD path``，避免同一键被复用到别的端点；
- ``key``：客户端生成的唯一串。

``fingerprint`` 是请求体的规范化摘要：同键但请求体不同说明是客户端 bug
（把同一键复用给了两个不同请求），此时必须报冲突而不是重放旧结果——重放
会让用户以为第二个请求成功了。
"""

from sqlalchemy import ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import mapped_column
from sqlalchemy.types import JSON

from app.models.base import TimestampMixin


class IdempotencyRecord(TimestampMixin):
    """一次幂等请求的执行结果快照。"""

    __tablename__ = "idempotency_records"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "scope", "key", name="uq_idempotency_user_scope_key"
        ),
        Index("ix_idempotency_created_at", "created_at"),
    )

    user_id = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    """键的归属用户；键由客户端自选，必须按用户隔离"""

    scope = mapped_column(String(255), nullable=False)
    """作用域 ``METHOD path``（不含查询串），避免同一键跨端点复用"""

    key = mapped_column(String(255), nullable=False)
    """客户端提供的 Idempotency-Key"""

    fingerprint = mapped_column(String(64), nullable=False)
    """请求体规范化摘要（sha256）；同键不同指纹 → 409"""

    status_code = mapped_column(Integer, nullable=False)
    """首次执行的 HTTP 状态码，重放时原样返回"""

    response_body = mapped_column(JSON, nullable=True)
    """首次执行的响应体，重放时原样返回"""

    resource_id = mapped_column(Text, nullable=True)
    """首次创建的资源 ID（诊断用，便于排查"补发命中了哪条既有记录"）"""
