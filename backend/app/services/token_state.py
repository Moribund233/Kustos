"""Token 生命周期状态存储：撤销位图 + refresh 轮换标记（单层撤销）

方向定稿（2026-10-03）：**保留回源 + Redis 位图单层撤销 + refresh 轮换**。
本模块是"位图单层"的实现——替代原「RevokedToken DB 查询 + revocation_cache
60s 正/负缓存」两层：

- **Redis 主后端**：``SET kustos:revoked:{kind}:{key} <value> EX <ttl>``。
  TTL = token 剩余寿命（轮换标记同理），**过期自失效、免清理任务**；
  撤销检查 = 一次 ``EXISTS/GET``，热路径不再回源 DB。
- **进程内内存兜底**：写时总是镜像（带同样 TTL），读时 Redis 不可用/未命中
  回退内存——同 worker 撤销始终生效（口径：**降级显式登记 + 内存兜底**，
  而非裸 fail-open；跨 worker 在 Redis 故障期间确实失效，靠 degraded 横幅暴露）。
- **degraded 登记**：Redis 不可用时 ``degraded.set("token_revocation", "memory", …)``,
  恢复后 ``clear``——与 request_stats/presence/realtime_bus 同一登记点。

三类状态（kind）：

=========== ==========================================================
``token``   access/refresh 撤销位图（key=jti，value="1"）。``revoke_token``
            仍写 ``RevokedToken`` 表（审计 + 启动回填源：
            留表、热路径不查）。
``family``  refresh 家族吊销（key=family_id）。refresh 轮换**重用检测**
            触发：旧 refresh 超宽限期被再次使用 → 整个登录链失效。
``rotated`` refresh 轮换标记（key=旧 jti，value=首次轮换 epoch 秒）。
            ``SET NX``——宽限期内重放不重置首次时间戳，防止连续重放
            永久停留在宽限窗口。
=========== ==========================================================

已知边界（记录在案）：

- Redis 非持久化（``--appendonly no``）且撤销键带 TTL 会被 ``volatile-lru``
  优先淘汰——Redis 丢失期间同 worker 靠内存兜底，**worker 重启后由 lifespan
  回填 ``RevokedToken`` 未过期行补偿**；轮换标记与 family 吊销不落表，
  Redis 整体丢失时重用检测窗口失效（上限 = refresh 剩余寿命），接受。
"""
import logging
import time
from typing import Dict, Optional, Tuple

from app.utils.degraded import registry as degraded
from app.utils.redis_client import get_redis, key as redis_key

logger = logging.getLogger(__name__)

#: 降级登记组件名（Admin「Redis → 降级」面板可见）
COMPONENT = "token_revocation"

#: 内存兜底: full_key -> (value, 过期 epoch 秒)
_mem: Dict[str, Tuple[str, float]] = {}


def _key(kind: str, key: str) -> str:
    return redis_key("revoked", kind, key)


def _mem_set(full_key: str, value: str, ttl: int, nx: bool = False) -> None:
    """写内存镜像；顺带清理已过期条目，防止长期运行膨胀。

    ``nx=True`` 时已存在的未过期键不覆盖（与 Redis SET NX 对齐——
    轮换标记的首次时间戳为准，宽限期内重放不重置计时）。
    """
    now = time.time()
    expired = [k for k, (_, exp) in _mem.items() if exp <= now]
    for k in expired:
        _mem.pop(k, None)
    if nx and full_key in _mem:
        return
    _mem[full_key] = (value, now + max(ttl, 1))


def _mem_get(full_key: str) -> Optional[str]:
    item = _mem.get(full_key)
    if item is None:
        return None
    value, exp = item
    if exp <= time.time():
        _mem.pop(full_key, None)
        return None
    return value


def _mark_degraded(detail: str) -> None:
    degraded.set(COMPONENT, "memory", detail)


async def _set(full_key: str, value: str, ttl: int, nx: bool = False) -> None:
    """写 Redis（尽力）+ 总是写内存镜像。

    Redis 成功即 clear 降级登记（恢复自愈，同 request_stats 模式）。
    """
    _mem_set(full_key, value, ttl, nx=nx)
    client = await get_redis()
    if client is None:
        _mark_degraded("Redis 不可用：撤销/轮换状态仅本 worker 可见（内存兜底）")
        return
    try:
        if nx:
            await client.set(full_key, value, ex=ttl, nx=True)
        else:
            await client.set(full_key, value, ex=ttl)
        degraded.clear(COMPONENT)
    except Exception as exc:  # noqa: BLE001 — 状态写入失败不打断主流程
        _mark_degraded(f"Redis 写入失败：撤销/轮换状态仅本 worker 可见（{type(exc).__name__}）")
        logger.warning("token 状态写入失败（内存兜底） key=%s: %s", full_key, exc)


async def _get(full_key: str) -> Optional[str]:
    """读状态：Redis 可用则 Redis 优先、miss 再查内存；不可用只查内存。"""
    client = await get_redis()
    if client is None:
        _mark_degraded("Redis 不可用：撤销/轮换状态仅本 worker 可见（内存兜底）")
        return _mem_get(full_key)
    try:
        raw = await client.get(full_key)
        degraded.clear(COMPONENT)
    except Exception as exc:  # noqa: BLE001 — 读失败回退内存
        _mark_degraded(f"Redis 读取失败：撤销/轮换状态仅本 worker 可见（{type(exc).__name__}）")
        logger.warning("token 状态读取失败（内存兜底） key=%s: %s", full_key, exc)
        return _mem_get(full_key)
    if raw is not None:
        return str(raw)
    # Redis miss 不代表没有——Redis 故障窗口内的写可能只在内存
    return _mem_get(full_key)


# ========================================================================
# 撤销位图（kind="token" / "family"）
# ========================================================================

async def is_revoked(kind: str, key: str) -> bool:
    """该 key 是否已撤销/吊销（单层位图直查，不回源 DB）"""
    if not key:
        return False
    return await _get(_key(kind, key)) is not None


async def revoke(kind: str, key: str, ttl: int) -> None:
    """撤销（幂等覆盖写；TTL=token 剩余寿命，过期自动失效）"""
    if not key or ttl <= 0:
        return
    await _set(_key(kind, key), "1", ttl)


# ========================================================================
# refresh 轮换标记（kind="rotated"）
# ========================================================================

async def mark_rotated(jti: str, ttl: int) -> None:
    """标记 refresh jti 已轮换。``SET NX``——首次轮换时间戳为准，
    宽限期内重放不重置计时（防连续重放永久驻留宽限窗口）。"""
    if not jti or ttl <= 0:
        return
    await _set(_key("rotated", jti), str(time.time()), ttl, nx=True)


async def get_rotated(jti: str) -> Optional[float]:
    """取首次轮换时间（epoch 秒）；未轮换返回 None"""
    if not jti:
        return None
    raw = await _get(_key("rotated", jti))
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def reset_memory() -> None:
    """清空内存兜底（测试隔离用）"""
    _mem.clear()