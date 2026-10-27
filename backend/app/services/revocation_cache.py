"""
撤销黑名单读缓存

**· 后仅剩 ``collab_invite`` 一类使用**：认证 token 的撤销已迁至
``services/token_state.py``（Redis 位图单层 + 内存兜底，不再查 DB）。
协作邀请撤销仍以 DB 表为真相源，本模块把「invite jti 是否已撤销」这一
高频读从 DB 前移到 Redis：

- **正缓存**：已撤销 → ``SET key "1" EX <positive_ttl>``（撤销时写入，覆盖负缓存）
- **负缓存**：未撤销 → ``SET key "0" EX <negative_ttl> NX``（``NX`` 保证撤销写入的正键
  不会被并发的 DB 查询结果覆盖，避免「已撤销被读回未撤销」的复活竞态）

Redis 不可用/异常时 ``get`` 返回 None、``set`` 空操作，调用方回退 DB（现状）。
DB 始终是事实来源：正缓存 TTL 短于 token 寿命也正确（到期回退 DB 仍为已撤销）。
"""
import logging
from typing import Optional

from app.utils.redis_client import get_redis, key as redis_key
from app.core.config import get_config_value

logger = logging.getLogger(__name__)

# 已撤销：缓存 1h（固定上限，避免把 token exp 透传进缓存层）
# 默认值 = 既有模块常量；运行期读 [security] revocation_positive_ttl / revocation_negative_ttl
POSITIVE_TTL = 3600
# 未撤销：短负缓存，降低高频认证的 DB 读
NEGATIVE_TTL = 60


def _key(kind: str, jti: str) -> str:
    return redis_key("revoked", kind, jti)


async def get(kind: str, jti: Optional[str]) -> Optional[bool]:
    """返回缓存值；未命中/不可用返回 None（调用方查 DB）"""
    if not jti:
        return None
    client = await get_redis()
    if client is None:
        return None
    try:
        raw = await client.get(_key(kind, jti))
    except Exception as exc:  # noqa: BLE001 — 缓存失败即回退 DB
        logger.warning("撤销缓存读取失败 kind=%s: %s", kind, exc)
        return None
    if raw is None:
        return None
    return str(raw) == "1"


async def set(kind: str, jti: Optional[str], revoked: bool) -> None:  # noqa: A001
    """写入缓存：已撤销写正键（覆盖），未撤销写负键（NX，不覆盖正键）"""
    if not jti:
        return
    client = await get_redis()
    if client is None:
        return
    try:
        if revoked:
            ttl = int(get_config_value("security", "revocation_positive_ttl", POSITIVE_TTL))
            await client.set(_key(kind, jti), "1", ex=ttl)
        else:
            ttl = int(get_config_value("security", "revocation_negative_ttl", NEGATIVE_TTL))
            await client.set(_key(kind, jti), "0", ex=ttl, nx=True)
    except Exception as exc:  # noqa: BLE001 — 缓存失败不影响主流程
        logger.warning("撤销缓存写入失败 kind=%s: %s", kind, exc)
