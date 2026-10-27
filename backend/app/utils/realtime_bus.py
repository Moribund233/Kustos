"""
实时广播总线（跨 worker WebSocket 投递）

采用 **Hybrid** 策略：发送方先在本地 manager 直投，再经 Redis
``publish`` 广播；各 worker 的订阅循环收到后跳过 ``origin``（本进程）回声，
只投递给本进程持有的连接。因此每条消息对每个连接恰好投递一次。

Redis 不可用时 ``start()`` 返回 False，``publish()`` 先按冷却窗惰性重连
（Redis 恢复后无需重启进程即自动重建订阅），仍不可达则空操作——行为退化为
纯进程内广播（与旧版一致），不影响业务。
"""
import asyncio
import json
import logging
import time
import uuid
from typing import Any, Dict, Optional

from app.utils.degraded import registry as degraded
from app.utils import redis_client

logger = logging.getLogger(__name__)

# 进程唯一标识：订阅端据此跳过本进程发布的消息，避免重复投递
WORKER_ID = uuid.uuid4().hex

#: 总线启动失败时的降级说明（三处失败路径共用；``publish`` 会按冷却窗惰性重连）
_START_DEGRADED_DETAIL = (
    "跨 worker WS 消息丢失（仅本进程连接可收）；Redis 恢复后下一次发布自动重连"
)


def _decode_target(scope: str, raw: Optional[str]):
    """通道里 target 统一以字符串传输；能解析为 UUID 时还原（匹配索引键类型）"""
    if raw is None or scope == "broadcast":
        return None
    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return raw


class RealtimeBus:
    """基于 Redis pub/sub 的跨 worker 广播总线"""

    def __init__(self, manager=None):
        self._manager = manager
        self._client = None
        self._pubsub_client = None
        self._pubsub = None
        self._task: Optional[asyncio.Task] = None
        self._running = False
        # 启动互斥 + 惰性重连冷却（publish 自愈用）
        self._start_lock = asyncio.Lock()
        self._last_start_attempt = 0.0
        # 运维观测计数
        self.published = 0
        self.publish_failures = 0
        self.received = 0
        self.dispatch_failures = 0
        self.last_error: Optional[str] = None

    def stats(self) -> Dict[str, Any]:
        return {
            "running": self._running,
            "published": self.published,
            "publish_failures": self.publish_failures,
            "received": self.received,
            "dispatch_failures": self.dispatch_failures,
            "last_error": self.last_error,
        }

    def bind(self, manager) -> None:
        """绑定连接管理器并注入总线引用"""
        self._manager = manager
        manager.set_bus(self)

    @property
    def is_running(self) -> bool:
        return self._running

    async def start(self) -> bool:
        """启动订阅循环；Redis 不可用时返回 False（退化为进程内）并登记降级

        幂等：已在运行时直接返回 True。启动过程加互斥锁，避免并发
        ``start()``（lifespan 与惰性自愈可能同时触发）重复建 subscribed 连接。
        """
        if self._running:
            degraded.clear("realtime_bus")
            return True
        async with self._start_lock:
            if self._running:
                degraded.clear("realtime_bus")
                return True
            return await self._start_locked()

    async def _start_locked(self) -> bool:
        client = await redis_client.get_redis()
        if client is None:
            logger.warning("RealtimeBus: Redis 不可用，跨 worker 广播退化为进程内")
            degraded.set("realtime_bus", "in-process", _START_DEGRADED_DETAIL)
            return False
        pubsub_client = await redis_client.create_pubsub_client()
        if pubsub_client is None:
            logger.warning("RealtimeBus: pub/sub 连接创建失败，退化为进程内")
            degraded.set("realtime_bus", "in-process", _START_DEGRADED_DETAIL)
            return False

        self._client = client
        self._pubsub_client = pubsub_client
        self._pubsub = pubsub_client.pubsub()
        try:
            await self._pubsub.psubscribe(redis_client.ws_pattern())
        except Exception as exc:  # noqa: BLE001 — 订阅失败即退化
            logger.warning("RealtimeBus: 订阅失败，退化为进程内: %s", exc)
            await self._teardown_pubsub()
            degraded.set("realtime_bus", "in-process", _START_DEGRADED_DETAIL)
            return False

        self._running = True
        self._task = asyncio.create_task(self._listen())
        degraded.clear("realtime_bus")
        logger.info("RealtimeBus 已启动，订阅 %s", redis_client.ws_pattern())
        return True

    async def _ensure_started(self) -> None:
        """惰性自愈：未运行且已过冷却窗时重试 ``start()``。

        复用 ``utils.redis_client`` 的重连冷却节奏——Redis 启动时不可达、
        之后恢复的场景下，下一次 ``publish`` 即重建订阅，无需重启进程；
        冷却窗内不重复尝试，避免 Redis 持续不可达时每个请求都建连。
        """
        if self._running:
            return
        now = time.monotonic()
        if now - self._last_start_attempt < redis_client.reconnect_cooldown():
            return
        self._last_start_attempt = now
        try:
            await self.start()
        except Exception as exc:  # noqa: BLE001 — 自愈失败不影响本地直投
            logger.warning("RealtimeBus 惰性重连失败: %s", exc)

    async def stop(self) -> None:
        """停止订阅循环并释放 pub/sub 连接"""
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
        await self._teardown_pubsub()
        self._client = None

    async def _teardown_pubsub(self) -> None:
        if self._pubsub is not None:
            try:
                await self._pubsub.punsubscribe()
                await self._pubsub.close()
            except Exception:  # noqa: BLE001
                pass
            self._pubsub = None
        if self._pubsub_client is not None:
            try:
                await self._pubsub_client.aclose()
            except Exception:  # noqa: BLE001
                pass
            self._pubsub_client = None

    async def publish(self, scope: str, target_id, message: Dict[str, Any],
                      exclude_user_id=None) -> None:
        """发布消息到其他 worker（本地直投由 manager 负责）"""
        if self._client is None:
            # 启动失败后 Redis 恢复：按冷却窗惰性重连，避免永久退化为进程内
            await self._ensure_started()
            if self._client is None:
                return
        payload = {
            "origin": WORKER_ID,
            "scope": scope,
            "target": None if target_id is None else str(target_id),
            "exclude_user_id": None if exclude_user_id is None else str(exclude_user_id),
            "message": message,
        }
        try:
            await self._client.publish(
                redis_client.ws_channel(scope, target_id),
                json.dumps(payload, ensure_ascii=False, default=str),
            )
            self.published += 1
        except Exception as exc:  # noqa: BLE001 — 发布失败不影响本地投递
            self.publish_failures += 1
            self.last_error = str(exc)
            logger.warning("RealtimeBus 发布失败 scope=%s: %s", scope, exc)

    async def _listen(self) -> None:
        while self._running:
            try:
                msg = await self._pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if msg is None or msg.get("type") != "pmessage":
                    continue
                await self._dispatch_raw(msg.get("data"))
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001 — 循环自愈
                logger.warning("RealtimeBus 订阅循环异常，1s 后重试: %s", exc)
                await asyncio.sleep(1.0)

    async def _dispatch_raw(self, raw) -> None:
        try:
            payload = json.loads(raw)
        except (ValueError, TypeError):
            return
        if not isinstance(payload, dict):
            return
        if payload.get("origin") == WORKER_ID:
            return  # 本进程已直投，跳过回声
        scope = payload.get("scope")
        message = payload.get("message")
        if not scope or message is None:
            return
        target = _decode_target(scope, payload.get("target"))
        exclude_raw = payload.get("exclude_user_id")
        exclude = _decode_target("user", exclude_raw) if exclude_raw else None
        try:
            await self.deliver(scope, target, message, exclude)
            self.received += 1
        except Exception as exc:  # noqa: BLE001 — 单条投递失败不影响订阅循环
            self.dispatch_failures += 1
            self.last_error = str(exc)
            logger.warning("RealtimeBus 投递失败 scope=%s: %s", scope, exc)

    async def deliver(self, scope: str, target_id, message: Dict[str, Any],
                      exclude_user_id=None) -> int:
        """投递到本进程连接（订阅循环调用；不再次 publish）"""
        if self._manager is None:
            return 0
        if scope == "user":
            return await self._manager._deliver_user(target_id, message)
        if scope == "room":
            return await self._manager._deliver_room(target_id, message, exclude_user_id)
        if scope == "repository":
            return await self._manager._deliver_repository(target_id, message, exclude_user_id)
        if scope == "broadcast":
            return await self._manager._deliver_broadcast(message)
        logger.warning("RealtimeBus 未知 scope: %s", scope)
        return 0


# 全局单例（由 lifespan 绑定 manager 并启停）
bus = RealtimeBus()
