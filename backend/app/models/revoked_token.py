"""
JWT 撤销记录（访问/刷新 token 审计行 + refresh family 吊销）

热路径**不查此表**：撤销生效走 `services/token_state.py` 的
Redis 位图单层（TTL = token 剩余寿命）。本表保留为：

- **审计**：谁在何时撤销了哪个 jti / family（token_type='family' 行按
  family_id 记入 jti 列）；
- **启动回填源**：`token_service.backfill_revocations` 把未过期行写回位图，
  补偿 Redis 重启（`--appendonly no`）与 `volatile-lru` 淘汰造成的丢失。
"""
from sqlalchemy import DateTime, ForeignKey, Index, String, Uuid as SAUuid
from sqlalchemy.orm import mapped_column

from app.models.base import BaseModel


class RevokedToken(BaseModel):
    """被撤销的 JWT（按 jti 唯一）。"""

    __tablename__ = "revoked_tokens"

    jti = mapped_column(String(64), nullable=False, index=True)
    """token 的唯一标识 (JWT jti)"""

    user_id = mapped_column(
        SAUuid(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    """token 所属用户ID (供审计/按用户清理)"""

    token_type = mapped_column(String(16), nullable=False, default="access")
    """token 类型: access / refresh"""

    expires_at = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    """该 token 的原始过期时刻（过期行由 retention_service 自动清理，
    ``backfill_revocations`` 按 ``expires_at > now`` 扫描需此索引避免全表扫）"""

    __table_args__ = (
        Index("uq_revoked_tokens_jti", "jti", unique=True),
    )

    def __repr__(self) -> str:
        return f"<RevokedToken(jti={self.jti}, type={self.token_type})>"
