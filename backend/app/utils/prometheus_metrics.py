"""
Prometheus 指标导出（单一记录点 + 跨 worker 聚合）

导出指标（名称/标签保持不变，告警规则与面板无需改动）：

- ``kustos_http_requests_total``（按 method/status 维度计数）
- ``kustos_http_request_duration_seconds``（延迟直方图）
- ``kustos_http_inflight_requests``（在途请求数）
- ``kustos_http_5xx_total`` / ``kustos_http_requests_total_total``（汇总）

历史问题（前）：
每个 worker 各持一份**进程内**计数，生产 ``uvicorn --workers 4`` 下
``/metrics`` 由随机 worker 应答——每次 scrape 拿到不同 worker 的快照，
计数器非单调（等价频繁 counter reset），``rate()`` 告警口径失真；且与
RequestStats（Redis 跨 worker 分钟桶）口径不一致，三套指标数字对不上时
无法判定谁对。

现在：
- **记录只发生一处**——观测层 ``middleware/observability`` 在
  ``RequestStats.record_request`` 的**同一条 Redis pipeline**（MULTI/EXEC
  原子）里追加累计计数器写入，统计与计数天然同源、可对账。
- 计数器按 worker pid 存 hash（``kustos:metrics:cnt:<pid>``），``/metrics``
  渲染时跨 pid 求和——任意 worker 应答都是**全局视图**，计数单调。
- ``/metrics`` 与 admin 时序（metrics_service）读同一批数据，数字天然一致；
  首行注释 ``# kustos_metrics_backend:`` 标明本次渲染的数据后端。
- Redis 不可用退回进程内计数（单 worker 视图），登记 ``utils.degraded``，
  恢复后由 ``drain_memory_counters`` 把降级期进程内增量**一次性回填**共享
  后端（否则恢复后的 /metrics 与 admin 时序会永久缺一块降级期数据）。

实现仅依赖标准库 + 既有 Redis 客户端，不引入额外包。
"""
import os
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

from fastapi import Request
from starlette.responses import PlainTextResponse

from app.utils.degraded import registry as degraded
from app.utils.redis_client import get_redis, key as redis_key

# 直方图 bucket 边界（秒）
DEFAULT_BUCKETS: Tuple[float, ...] = (
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    float("inf"),
)

_DEGRADED_COMPONENT = "metrics_export"

#: 累计计数器键的最小 TTL（秒）。累计计数器必须比任何聚合/告警窗口长寿：
#: 若 TTL 随过小的 ``metrics.history_minutes`` 收缩，某个活跃但空闲的 worker
#: 的 per-pid 键会先过期，跨 pid 求和后的 ``kustos_http_requests_total`` 骤降，
#: Prometheus 的 ``rate()`` 据此误判为 counter reset，稀释错误率告警
#: （``history_minutes`` 下限 5 分钟时，TTL 只有 360s）。
#: 取 7 天硬下限，与常见指标保留期对齐。
_COUNTER_TTL_FLOOR = 7 * 24 * 3600


def _counter_ttl() -> int:
    """累计计数器键 TTL（秒）。

    随 ``metrics.history_minutes`` 放大，但**不低于** ``_COUNTER_TTL_FLOOR``——
    避免短历史窗口下 per-pid 键部分过期造成的跨 worker 累计值假 reset。
    """
    configured = 1440 * 60 + 60
    try:
        from app.core.config import get_config

        configured = (
            int(getattr(get_config().metrics, "history_minutes", 1440) or 1440) * 60 + 60
        )
    except Exception:  # noqa: BLE001 — 配置未就绪时用默认值
        pass
    return max(configured, _COUNTER_TTL_FLOOR)


def _counter_key(pid: Optional[int] = None) -> str:
    """per-worker 累计计数器键：``kustos:metrics:cnt:<pid>``"""
    return redis_key("metrics", "cnt", str(pid if pid is not None else os.getpid()))


def _counter_key_pattern() -> str:
    return redis_key("metrics", "cnt", "*")


def _bucket_index(duration_s: float) -> int:
    """请求耗时落入的精确桶下标（首个 >= duration 的边界；超界取 +Inf）"""
    for i, b in enumerate(DEFAULT_BUCKETS):
        if duration_s <= b:
            return i
    return len(DEFAULT_BUCKETS) - 1


def _status_label(status_code: int) -> str:
    if status_code < 200:
        return "1xx"
    if status_code < 300:
        return "2xx"
    if status_code < 400:
        return "3xx"
    if status_code < 500:
        return "4xx"
    return "5xx"


class PrometheusMetrics:
    """进程内指标存储——双重职责：

    1. **在途请求数**：永远进程内（gauge 语义，无跨 worker 聚合需求，
       避免每请求额外 Redis 往返；渲染时即「应答本次 scrape 的 worker」）。
    2. **计数/直方图回退**：仅当 Redis 不可用时作为记录与渲染的后端
       （单 worker 视图，登记 degraded）。
    """

    def __init__(self, buckets: Tuple[float, ...] = DEFAULT_BUCKETS) -> None:
        self._buckets: Tuple[float, ...] = buckets
        # key -> ("method", "status") 组合
        self._counters: Dict[str, int] = defaultdict(int)
        # key -> 直方图累计值: {"cum": {bucket: cnt}, "sum": ..., "count": ...}
        self._latency: Dict[str, Dict[str, Any]] = {}
        self._inflight: int = 0

    def record(self, method: str, status_code: int, duration_s: float) -> None:
        """记录一次请求的指标（内存回退路径使用）"""
        method = (method or "UNKNOWN").upper()
        status = _status_label(status_code)
        self._counters[f"{method}|{status}"] += 1

        bucket_key = method
        entry = self._latency.setdefault(
            bucket_key, {"cum": defaultdict(int), "sum": 0.0, "count": 0}
        )
        entry["sum"] += duration_s
        entry["count"] += 1
        for bucket in self._buckets:
            if duration_s <= bucket:
                entry["cum"][bucket] += 1

    def enter(self) -> None:
        """请求进入时调用"""
        self._inflight += 1

    def leave(self) -> None:
        """请求结束时调用"""
        if self._inflight > 0:
            self._inflight -= 1

    def render(self) -> str:
        """渲染 Prometheus 文本格式指标"""
        lines: List[str] = []
        lines.append("# HELP kustos_http_requests_total Total HTTP requests by method and status.")
        lines.append("# TYPE kustos_http_requests_total counter")
        for key, count in sorted(self._counters.items()):
            method, status = key.split("|")
            lines.append(
                f'kustos_http_requests_total{{method="{method}",status="{status}"}} {count}'
            )

        lines.append("# HELP kustos_http_request_duration_seconds HTTP request latency.")
        lines.append("# TYPE kustos_http_request_duration_seconds histogram")
        for method, entry in sorted(self._latency.items()):
            cumulative = 0
            for bucket in self._buckets:
                cumulative = entry["cum"].get(bucket, 0)
                b_label = "+Inf" if bucket == float("inf") else f"{bucket:g}"
                lines.append(
                    f'kustos_http_request_duration_seconds_bucket{{method="{method}",le="{b_label}"}} '
                    f"{cumulative}"
                )
            lines.append(
                f'kustos_http_request_duration_seconds_sum{{method="{method}"}} '
                f"{entry['sum']:.9f}"
            )
            lines.append(
                f'kustos_http_request_duration_seconds_count{{method="{method}"}} '
                f"{entry['count']}"
            )

        lines.append(
            "# HELP kustos_http_inflight_requests Current inflight requests "
            "(per-worker gauge; counters above are aggregated across workers)."
        )
        lines.append("# TYPE kustos_http_inflight_requests gauge")
        lines.append(f"kustos_http_inflight_requests {self._inflight}")

        lines.append("# HELP kustos_http_5xx_total Total 5xx responses.")
        lines.append("# TYPE kustos_http_5xx_total counter")
        five_xx = sum(
            count for key, count in self._counters.items() if key.split("|")[1] == "5xx"
        )
        lines.append(f"kustos_http_5xx_total {five_xx}")

        lines.append("# HELP kustos_http_requests_total_total All HTTP requests counter.")
        lines.append("# TYPE kustos_http_requests_total_total counter")
        lines.append(f"kustos_http_requests_total_total {sum(self._counters.values())}")

        return "\n".join(lines) + "\n"

    @staticmethod
    def _status_label(status_code: int) -> str:
        return _status_label(status_code)


# 进程内实例（在途 gauge + 内存回退计数）
_metrics: Optional[PrometheusMetrics] = None


def get_prometheus_metrics() -> PrometheusMetrics:
    """获取全局进程内指标实例"""
    global _metrics
    if _metrics is None:
        _metrics = PrometheusMetrics()
    return _metrics


def reset_prometheus_metrics() -> None:
    """重置全局实例（测试隔离用）"""
    global _metrics
    _metrics = None


# ---------------------------------------------------------------------------
# 记录：写入 RequestStats 的同一条 pipeline（单一记录点 · 原子同源）
# ---------------------------------------------------------------------------

def add_counter_ops(pipe: Any, method: str, status_code: int, duration_s: float) -> None:
    """向既有 Redis pipeline 追加累计计数器写入。

    由 ``RequestStats._record_redis`` 在写分钟桶的同一条 pipeline（MULTI）
    中调用——统计与计数要么一起落、要么一起丢，天然可对账。

    键结构（per-pid hash，TTL 随 metrics.history_minutes 续期）::

        c:<METHOD>|<status>   累计计数（按状态类）
        h:<METHOD>|<idx>      直方图精确桶计数（idx → DEFAULT_BUCKETS[idx]）
        hs:<METHOD>           延迟累计（秒，float）
        hn:<METHOD>           直方图样本数
    """
    method = (method or "UNKNOWN").upper()
    k = _counter_key()
    pipe.hincrby(k, f"c:{method}|{_status_label(int(status_code))}", 1)
    pipe.hincrby(k, f"h:{method}|{_bucket_index(duration_s)}", 1)
    pipe.hincrbyfloat(k, f"hs:{method}", f"{duration_s:.6f}")
    pipe.hincrby(k, f"hn:{method}", 1)
    pipe.expire(k, _counter_ttl())


def drain_memory_counters(pipe: Any) -> int:
    """把进程内（内存回退期）累计的计数增量并入 ``pipe``（**不清空**本地存储）。

    由 ``RequestStats`` 在 Redis 后端恢复后的首次记录时调用：降级期落在本进程
    内存里的累计计数/直方图一次性回填共享后端——否则 Redis 恢复后 ``/metrics``
    与 admin 时序会永久缺一块降级期数据（降级期计数不回填不合并）。

    本地 ``_counters`` / ``_latency`` 的语义正是「**尚未**回填的增量」，
    因此这里只做只读转换；调用方在 ``pipe.execute()`` **成功后**再调
    ``clear_memory_counters()`` 标记已同步——失败则保留，下次恢复时重试，
    避免「pipe 写失败却已清空」导致这段数据永久丢失。

    Returns:
        int: 本次拟回填的请求数（0 = 无待回填数据，``pipe`` 未被改动）。
    """
    agg = get_prometheus_metrics()
    if not agg._counters and not agg._latency:
        return 0

    k = _counter_key()
    total = 0
    for field, count in agg._counters.items():
        n = int(count)
        if n > 0:
            pipe.hincrby(k, f"c:{field}", n)
            total += n

    for method, entry in agg._latency.items():
        # 本地存**累积**桶语义，Redis 存精确桶——差分还原
        cumulative = entry.get("cum") or {}
        prev = 0
        for idx, bound in enumerate(agg._buckets):
            current = int(cumulative.get(bound, 0))
            if current > prev:
                pipe.hincrby(k, f"h:{method}|{idx}", current - prev)
            prev = current
        lat_sum = float(entry.get("sum", 0.0) or 0.0)
        if lat_sum:
            pipe.hincrbyfloat(k, f"hs:{method}", f"{lat_sum:.6f}")
        samples = int(entry.get("count", 0) or 0)
        if samples:
            pipe.hincrby(k, f"hn:{method}", samples)

    pipe.expire(k, _counter_ttl())
    return total


def clear_memory_counters() -> None:
    """清空进程内回退计数（``RequestStats._flush_pending`` 回填成功后调用）。

    ``_inflight`` gauge 不受影响——它始终是本进程视角，与回填无关。
    """
    agg = get_prometheus_metrics()
    agg._counters.clear()
    agg._latency.clear()


def _accumulate_redis(agg: PrometheusMetrics, data: Dict[str, Any]) -> None:
    """把一个 per-pid hash 的字段累加进聚合对象"""
    for field, value in data.items():
        try:
            if field.startswith("c:"):
                agg._counters[field[2:]] += int(value)
            elif field.startswith("h:"):
                method, _, idx_s = field[2:].rpartition("|")
                n = int(value)
                if n <= 0 or not method:
                    continue
                bound = DEFAULT_BUCKETS[int(idx_s)]
                entry = agg._latency.setdefault(
                    method, {"cum": defaultdict(int), "sum": 0.0, "count": 0}
                )
                # 精确桶 → 累积桶语义：耗时 <= le 的所有桶都计入
                for b in DEFAULT_BUCKETS:
                    if b >= bound:
                        entry["cum"][b] += n
            elif field.startswith("hs:"):
                entry = agg._latency.setdefault(
                    field[3:], {"cum": defaultdict(int), "sum": 0.0, "count": 0}
                )
                entry["sum"] += float(value)
            elif field.startswith("hn:"):
                entry = agg._latency.setdefault(
                    field[3:], {"cum": defaultdict(int), "sum": 0.0, "count": 0}
                )
                entry["count"] += int(value)
        except (TypeError, ValueError, IndexError):
            continue  # 脏字段跳过，不让一次渲染失败


async def _render_redis(client: Any) -> str:
    """跨全部 worker（per-pid hash）求和渲染"""
    agg = PrometheusMetrics()
    keys: List[str] = [k async for k in client.scan_iter(match=_counter_key_pattern())]
    if keys:
        pipe = client.pipeline()
        for k in keys:
            pipe.hgetall(k)
        for data in await pipe.execute():
            if data:
                _accumulate_redis(agg, data)
    # 在途数取本 worker 进程内 gauge（渲染方自身视角）
    agg._inflight = get_prometheus_metrics()._inflight
    return agg.render()


async def render_metrics() -> Tuple[str, str]:
    """渲染指标文本。

    Returns:
        ``(text, backend)``：backend ∈ ``redis``（跨 worker 全局）/ ``memory``
        （单 worker 回退，已登记 degraded）。
    """
    client = await get_redis()
    if client is not None:
        try:
            text = await _render_redis(client)
            degraded.clear(_DEGRADED_COMPONENT)
            return text, "redis"
        except Exception as exc:  # noqa: BLE001 — 渲染失败不阻断抓取
            from app.utils.logging import get_logger

            get_logger("metrics").warning(f"从 Redis 渲染指标失败，退回内存视图: {exc}")
    degraded.set(
        _DEGRADED_COMPONENT,
        "memory",
        "/metrics 为单 worker 内存视图（Redis 不可用），与 admin 时序不可对账",
    )
    return get_prometheus_metrics().render(), "memory"


async def metrics_response(request: Request) -> PlainTextResponse:
    """``GET /metrics`` 端点（读 Redis 跨 worker 聚合，故为 async）"""
    text, backend = await render_metrics()
    return PlainTextResponse(
        f"# kustos_metrics_backend: {backend}\n" + text,
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )