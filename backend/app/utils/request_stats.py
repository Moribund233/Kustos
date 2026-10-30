"""
请求统计类（异步安全，支持跨 worker 聚合）

Redis 可用时经 Redis 聚合多 worker 的请求指标，使 admin 概览的
请求速率与成功/失败数在任意副本间保持一致；Redis 未配置或不可达时
回退进程内实现（语义与 Redis 口径一致），并登记到 ``utils.degraded``
——Admin 面板据此显示显式 degraded，而不是把单 worker 视图当全局数据
。

指标口径（``window_minutes`` 分钟滑动窗）：
- ``total``: 累计总请求数（进程生命周期，跨 worker 求和）
- ``success`` / ``failed``: 最近 ``window_minutes`` 个「完整分钟」内的成功/失败数
- ``avg_response_time_ms``: 同一完整分钟窗口内的平均响应时间
- ``requests_per_minute``: 完整分钟窗口的平均每分钟请求速率
- ``window_minutes``: 本窗口长度（分钟）

当前未走完的分钟不参与任何统计，避免“从 1 爬升到 59 再归零”的锯齿。

（单一记录点）：Prometheus 累计计数器与上述分钟桶在
``_record_redis`` 的**同一条 pipeline** 中写入、内存回退路径同步写入进程内
计数——``/metrics`` 与本统计/时序同源，数字天然可对账。
降级期（Redis 不可用）落在本进程内存里的增量由 ``_flush_pending`` 在后端恢复后
**一次性回填**，恢复期数据不会从统计与 ``/metrics`` 里凭空消失。
记录入口在 ``middleware/observability``（合并的观测层），
记录范围由 ``middleware/scope.should_record`` 统一裁决。
"""
import asyncio
import time
from collections import deque
from typing import Any, Deque, Dict, Optional

from app.utils.degraded import registry as degraded
from app.utils.redis_client import get_redis, key as redis_key

# 内存回退：单个条目
_MinuteBucket = Dict[str, Any]


def _key(*parts: str) -> str:
    """统一命名空间：``kustos:req:*``"""
    return redis_key("req", *parts)


def _redis_minute() -> int:
    """当前分钟桶（Unix 秒 // 60）"""
    return int(time.time()) // 60


# 延迟直方图桶上界（毫秒）：时序接口据此估算 p95，避免存储全量样本。
LATENCY_BUCKETS_MS: tuple = (10, 25, 50, 100, 200, 500, 1000, 2500, 5000)
_INF_LABEL = "inf"
_BUCKET_LABELS: tuple = tuple(str(b) for b in LATENCY_BUCKETS_MS) + (_INF_LABEL,)

# 请求分钟桶的字符串字段（get_stats 仅用前 4 个，其余供时序接口使用）。
_BUCKET_SUFFIXES: tuple = ("count", "ok", "fail", "lat", "s2xx", "s3xx", "s4xx", "s5xx")


def _history_minutes() -> int:
    """指标历史保留分钟数（配置不可用时回退 1440）"""
    try:
        from app.core.config import get_config

        return int(getattr(get_config().metrics, "history_minutes", 1440) or 1440)
    except Exception:  # noqa: BLE001 — 配置未就绪时用默认值
        return 1440


def _bucket_label(latency_ms: float) -> str:
    """返回命中的直方图桶标签（首个 >= 延迟的上界，超出则 inf）"""
    for bound in LATENCY_BUCKETS_MS:
        if latency_ms <= bound:
            return str(bound)
    return _INF_LABEL


def _status_class_field(status_code: int) -> Optional[str]:
    """2xx/3xx/4xx/5xx → s2xx/...；其他状态码返回 None"""
    cls = int(status_code) // 100
    return f"s{cls}xx" if cls in (2, 3, 4, 5) else None


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def percentile_from_hist(hist: Dict[str, int], q: float = 0.95) -> float:
    """由直方图估算分位数（毫秒）；返回命中桶上界（inf 桶回退到上一上界）"""
    total = sum(hist.values())
    if total <= 0:
        return 0.0
    target = q * total
    cum = 0
    prev_bound = 0.0
    for label in _BUCKET_LABELS:
        cum += hist.get(label, 0)
        if cum >= target:
            if label == _INF_LABEL:
                return float(max(prev_bound, LATENCY_BUCKETS_MS[-1]))
            return float(label)
        if label != _INF_LABEL:
            prev_bound = float(label)
    return float(LATENCY_BUCKETS_MS[-1])


def merge_hist(target: Dict[str, int], source: Dict[str, int]) -> None:
    """把 ``source`` 直方图累加进 ``target``（原地）"""
    for label, count in source.items():
        target[label] = target.get(label, 0) + count


def _fresh_bucket(minute: int) -> _MinuteBucket:
    return {
        "minute": minute,
        "count": 0,
        "ok": 0,
        "fail": 0,
        "lat_sum": 0.0,
        "s2xx": 0,
        "s3xx": 0,
        "s4xx": 0,
        "s5xx": 0,
        "hist": {},
    }


class RequestStats:
    """请求统计类（异步安全）"""

    def __init__(self, window_minutes: int = 5):
        self.window_minutes = window_minutes
        self._lock = asyncio.Lock()
        # 内存回退状态
        self._total = 0
        self._ok = 0
        self._fail = 0
        self._minutes: Deque[_MinuteBucket] = deque(
            maxlen=max(window_minutes, _history_minutes())
        )
        self._current: _MinuteBucket = _fresh_bucket(_redis_minute())
        # 内存回退期**尚未回填** Redis 的增量（恢复后一次性补写）。
        # 与上面的 _minutes/_total 分开：后者是本进程回退视图，Redis 再次
        # 不可用时仍要保留；前者是「待同步游标」，回填后即清空防重复计数。
        self._pending_minutes: Dict[int, _MinuteBucket] = {}
        self._pending_total = 0

    async def _backend(self) -> Optional[Any]:
        """解析 Redis 后端（惰性 + 冷却重试，恢复自愈）。

        原实现「探测一次、失败后**永久**回退内存」——Redis 恢复后
        Admin 时序仍停在单 worker 视图。改为直接用 ``get_redis()``（自带连接
        缓存与重连冷却，已连接时零成本），并把降级/恢复登记到 ``utils.degraded``。
        """
        client = await get_redis()
        if client is None:
            degraded.set(
                "request_stats",
                "memory",
                "Admin QPS/时序为单 worker 视图（多 worker 下不完整）",
            )
        else:
            degraded.clear("request_stats")
        return client

    async def record_request(
        self,
        response_time_ms: float,
        success: bool,
        status_code: Optional[int] = None,
        method: Optional[str] = None,
    ):
        """记录一个请求（``status_code`` 可选，用于 2xx/3xx/4xx/5xx 分布）。

        ``method`` 供 Prometheus 累计计数器使用——Redis 路径下计数器
        与分钟桶写入**同一条 pipeline**（原子同源），内存路径下同步写入进程内
        计数存储，保证 ``/metrics`` 与 admin 统计/时序天然可对账。
        """
        backend = await self._backend()
        async with self._lock:
            if backend is not None:
                if self._pending_total or self._pending_minutes:
                    # Redis 从降级中恢复：先把降级期的增量补写回共享后端
                    await self._flush_pending(backend)
                await self._record_redis(backend, response_time_ms, success, status_code, method)
            else:
                self._record_memory(response_time_ms, success, status_code, method)

    async def _record_redis(
        self,
        backend: Any,
        response_time_ms: float,
        success: bool,
        status_code: Optional[int] = None,
        method: Optional[str] = None,
    ) -> None:
        minute = _redis_minute()
        pipe = backend.pipeline()
        pipe.incr(_key("total"))
        pipe.incr(_key("m", str(minute), "count"))
        pipe.incr(_key("m", str(minute), "ok") if success else _key("m", str(minute), "fail"))
        pipe.incrbyfloat(_key("m", str(minute), "lat"), response_time_ms)

        cls_field = _status_class_field(status_code) if status_code is not None else None
        if cls_field:
            pipe.incr(_key("m", str(minute), cls_field))

        hist_key = _key("m", str(minute), "hist")
        pipe.hincrby(hist_key, _bucket_label(response_time_ms), 1)

        ttl = max(self.window_minutes * 120 + 60, _history_minutes() * 60 + 60)
        for suffix in _BUCKET_SUFFIXES:
            pipe.expire(_key("m", str(minute), suffix), ttl)
        pipe.expire(hist_key, ttl)

        # Prometheus 累计计数器并入同一条 pipeline（单一记录点）
        if method is not None and status_code is not None:
            from app.utils.prometheus_metrics import add_counter_ops

            add_counter_ops(pipe, method, status_code, response_time_ms / 1000.0)

        await pipe.execute()

    def _record_memory(
        self,
        response_time_ms: float,
        success: bool,
        status_code: Optional[int] = None,
        method: Optional[str] = None,
    ) -> None:
        now = _redis_minute()
        if now > self._current["minute"]:
            self._minutes.append(self._current)
            self._current = _fresh_bucket(now)

        current = self._current
        current["count"] += 1
        current["lat_sum"] += response_time_ms
        if success:
            self._ok += 1
            current["ok"] += 1
        else:
            self._fail += 1
            current["fail"] += 1
        if status_code is not None:
            field = _status_class_field(status_code)
            if field:
                current[field] = current.get(field, 0) + 1
        label = _bucket_label(response_time_ms)
        current["hist"][label] = current["hist"].get(label, 0) + 1
        self._total += 1

        # 内存回退路径同步写进程内计数（metrics 与统计同源）
        if method is not None and status_code is not None:
            from app.utils.prometheus_metrics import get_prometheus_metrics

            get_prometheus_metrics().record(method, status_code, response_time_ms / 1000.0)

        # 同步登记「未回填」增量：Redis 恢复后由 _flush_pending 一次性补写，
        # 让降级期的请求不从 /metrics 与 admin 统计里凭空消失
        pend = self._pending_minutes.setdefault(now, _fresh_bucket(now))
        pend["count"] += 1
        pend["lat_sum"] += response_time_ms
        if success:
            pend["ok"] += 1
        else:
            pend["fail"] += 1
        if status_code is not None:
            field = _status_class_field(status_code)
            if field:
                pend[field] = pend.get(field, 0) + 1
        pend["hist"][label] = pend["hist"].get(label, 0) + 1
        self._pending_total += 1

    async def _flush_pending(self, backend: Any) -> None:
        """把内存回退期累积的增量一次性回填 Redis（调用方须持有 ``_lock``）。

        覆盖两处「分裂」：admin 分钟桶/总量，以及并入同一条 pipeline 的
        Prometheus 累计计数（``drain_memory_counters``）。本地 ``_minutes`` /
        进程内计数**不清空**——它们是 Redis 再次不可用时的回退视图；只清
        「未回填」游标，保证同一段数据不会被写两次。
        """
        from app.utils.prometheus_metrics import clear_memory_counters, drain_memory_counters

        ttl = max(self.window_minutes * 120 + 60, _history_minutes() * 60 + 60)
        pipe = backend.pipeline()

        for minute, bucket in self._pending_minutes.items():
            for suffix in ("count", "ok", "fail", "s2xx", "s3xx", "s4xx", "s5xx"):
                n = int(bucket.get(suffix, 0) or 0)
                if n:
                    pipe.incrby(_key("m", str(minute), suffix), n)
            lat = float(bucket.get("lat_sum", 0.0) or 0.0)
            if lat:
                pipe.incrbyfloat(_key("m", str(minute), "lat"), lat)
            hist_key = _key("m", str(minute), "hist")
            for bucket_label, n in (bucket.get("hist") or {}).items():
                if n:
                    pipe.hincrby(hist_key, bucket_label, int(n))
            for suffix in _BUCKET_SUFFIXES:
                pipe.expire(_key("m", str(minute), suffix), ttl)
            pipe.expire(hist_key, ttl)

        if self._pending_total:
            pipe.incrby(_key("total"), int(self._pending_total))

        drain_memory_counters(pipe)
        await pipe.execute()
        # 回填成功才清「未回填」标记；execute 失败则保留，下次恢复时重试
        clear_memory_counters()
        self._pending_minutes.clear()
        self._pending_total = 0

    async def get_stats(self) -> Dict[str, Any]:
        """获取统计信息"""
        backend = await self._backend()
        async with self._lock:
            if backend is not None:
                return await self._stats_redis(backend)
            return self._stats_memory()

    async def _stats_redis(self, backend: Any) -> Dict[str, Any]:
        total = int((await backend.get(_key("total"))) or 0)

        now_min = _redis_minute()
        complete = [now_min - i for i in range(1, self.window_minutes + 1)]
        parts = await backend.mget(
            *[
                _key("m", str(m), suffix)
                for m in complete
                for suffix in ("count", "ok", "fail", "lat")
            ]
        )

        counts = [int(parts[i] or 0) for i in range(0, len(parts), 4)]
        oks = [int(parts[i] or 0) for i in range(1, len(parts), 4)]
        fails = [int(parts[i] or 0) for i in range(2, len(parts), 4)]
        lats = [float(parts[i] or 0.0) for i in range(3, len(parts), 4)]

        count_sum = sum(counts)
        count_minutes = max(1, sum(1 for c in counts if c > 0))
        rpm = round(count_sum / count_minutes, 2) if count_sum else 0.0

        lat_sum = sum(lats)
        lat_n = count_sum
        avg = round(lat_sum / lat_n, 2) if lat_n else 0.0

        return {
            "total": total,
            "success": sum(oks),
            "failed": sum(fails),
            "avg_response_time_ms": avg,
            "requests_per_minute": rpm,
            "window_minutes": self.window_minutes,
        }

    def _stats_memory(self) -> Dict[str, Any]:
        # _minutes 的 maxlen 已扩大到历史保留量，实时统计只取最近 window 分钟
        buckets = list(self._minutes)[-self.window_minutes:]
        count = sum(b["count"] for b in buckets)
        success = sum(b["ok"] for b in buckets)
        failed = sum(b["fail"] for b in buckets)
        lat_sum = sum(b["lat_sum"] for b in buckets)

        n = max(1, len(buckets))
        rpm = round(count / n, 2) if count else 0.0
        avg = round(lat_sum / count, 2) if count else 0.0

        return {
            "total": self._total,
            "success": success,
            "failed": failed,
            "avg_response_time_ms": avg,
            "requests_per_minute": rpm,
            "window_minutes": self.window_minutes,
        }

    # ---------------- 时序历史（admin 概览趋势图） ----------------

    async def get_history(self, minutes: int) -> Dict[int, _MinuteBucket]:
        """
        读取最近 ``minutes`` 分钟的每分钟请求桶（含状态分布与延迟直方图）。

        不含当前未走完的分钟，与 ``get_stats`` 口径一致；缺失分钟不补零，
        由调用方按时间轴对齐。
        """
        backend = await self._backend()
        if backend is not None:
            return await self._history_redis(backend, minutes)
        return self._history_memory(minutes)

    def _history_memory(self, minutes: int) -> Dict[int, _MinuteBucket]:
        lo = _redis_minute() - minutes + 1
        return {b["minute"]: b for b in self._minutes if b["minute"] >= lo}

    async def _history_redis(self, backend: Any, minutes: int) -> Dict[int, _MinuteBucket]:
        now_min = _redis_minute()
        mins = list(range(now_min - minutes + 1, now_min))  # 排除当前未走完分钟
        if not mins:
            return {}

        pipe = backend.pipeline()
        for m in mins:
            pipe.mget(*[_key("m", str(m), suffix) for suffix in _BUCKET_SUFFIXES])
            pipe.hgetall(_key("m", str(m), "hist"))
        raw = await pipe.execute()

        out: Dict[int, _MinuteBucket] = {}
        for idx, m in enumerate(mins):
            vals = raw[idx * 2] or []
            hist = raw[idx * 2 + 1] or {}

            def _get(i: int):
                return vals[i] if len(vals) > i else None

            bucket = _fresh_bucket(m)
            bucket.update(
                count=_as_int(_get(0)),
                ok=_as_int(_get(1)),
                fail=_as_int(_get(2)),
                lat_sum=_as_float(_get(3)),
                s2xx=_as_int(_get(4)),
                s3xx=_as_int(_get(5)),
                s4xx=_as_int(_get(6)),
                s5xx=_as_int(_get(7)),
            )
            bucket["hist"] = {str(k): _as_int(v) for k, v in hist.items()}
            out[m] = bucket
        return out

    async def reset(self, backend: Optional[Any] = None):
        """重置统计（Redis 键一并清理）"""
        async with self._lock:
            self._total = 0
            self._ok = 0
            self._fail = 0
            self._minutes.clear()
            self._current = _fresh_bucket(_redis_minute())
            # 「未回填」游标与进程内 Prometheus 计数一并清零：否则后端恢复后
            # 会把重置前的降级期数据又补写回去（同一段数据被计两次）。
            self._pending_minutes.clear()
            self._pending_total = 0
            from app.utils.prometheus_metrics import get_prometheus_metrics

            agg = get_prometheus_metrics()
            agg._counters.clear()
            agg._latency.clear()
            client = backend if backend is not None else await self._backend()
            if client is not None:
                try:
                    await client.delete(_key("total"))
                except Exception:  # noqa: BLE001 — 清理为尽力而为
                    pass


# 全局统计实例
_request_stats: Optional[RequestStats] = None


def get_request_stats() -> RequestStats:
    """获取全局请求统计实例"""
    global _request_stats
    if _request_stats is None:
        _request_stats = RequestStats()
    return _request_stats


# RequestStatsMiddleware 已移除：记录职责并入观测层
# middleware.observability.ObservabilityMiddleware，消除多层叠套。