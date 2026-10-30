"""搜索域 · 重建并发锁

同一仓库同时只允许一个 worker 重建索引（防惊群）。
跨 worker 用 Redis SET NX；Redis 不可用时退回进程内锁。
"""
import logging
from typing import Dict
import asyncio

from app.models.uuid7 import generate_uuid7
from app.services.search.config import _rebuild_lock_ttl
from app.utils.redis_client import get_redis, key as redis_key

logger = logging.getLogger(__name__)


_local_rebuild_locks: Dict[str, asyncio.Lock] = {}


_local_rebuild_locks_guard = asyncio.Lock()


async def _local_rebuild_lock(repository_id) -> asyncio.Lock:
    async with _local_rebuild_locks_guard:
        return _local_rebuild_locks.setdefault(str(repository_id), asyncio.Lock())


async def _acquire_rebuild_lock(repository_id):
    """跨 worker 重建锁（Redis ``SET NX``）；Redis 不可用时返回 None 表示只用进程内锁。

    Returns:
        None  -> 无 Redis，调用方使用进程内锁
        False -> 锁被其他 worker 持有，调用方应放弃本次重建
        tuple -> ``(client, key, token)``，调用方负责 ``_release_rebuild_lock``
    """
    client = await get_redis()
    if client is None:
        return None
    name = redis_key("search", "index", "rebuild", str(repository_id))
    token = str(generate_uuid7())
    try:
        if await client.set(name, token, nx=True, ex=_rebuild_lock_ttl()):
            return (client, name, token)
    except Exception as exc:  # noqa: BLE001 - Redis 抖动不阻塞索引
        logger.warning("获取索引重建锁失败，退化为进程内互斥: %s", exc)
        return None
    return False


async def _release_rebuild_lock(handle) -> None:
    if not handle:
        return
    client, name, token = handle
    try:
        if await client.get(name) == token:
            await client.delete(name)
    except Exception:  # noqa: BLE001
        pass

