"""
请求统计（middleware/request_stats）与 Redis 客户端（utils/redis_client）测试。

Redis 未配置/不可达时统计走进程内回退，本文件覆盖该路径的统一口径：
success/failed/avg/rpm 基于「完整分钟」滑动窗口，当前未走完的分钟不参与。
"""

from app.utils.request_stats import (
    RequestStats,
    _key as _rs_key,
    _redis_minute,
    _fresh_bucket,
)
from app.utils import redis_client


async def test_current_minute_not_counted():
    """当前未走完的分钟不进入窗口统计（成功/失败/速率均为 0）"""
    stats = RequestStats(window_minutes=5)
    for _ in range(5):
        await stats.record_request(10.0, True)
    await stats.record_request(50.0, False)

    result = await stats.get_stats()
    assert result["total"] == 6
    assert result["success"] == 0
    assert result["failed"] == 0
    assert result["requests_per_minute"] == 0.0
    assert result["avg_response_time_ms"] == 0.0
    assert result["window_minutes"] == 5


def _filled_bucket(minute: int, count=0, ok=0, fail=0, lat_sum=0.0):
    b = _fresh_bucket(minute)
    b.update(count=count, ok=ok, fail=fail, lat_sum=lat_sum)
    return b


async def test_completed_minute_counts():
    """归档完成的分钟进入窗口统计，rpm 按实际观测分钟数取均值"""
    stats = RequestStats(window_minutes=5)
    stats._minutes.append(
        _filled_bucket(_redis_minute() - 2, count=2, ok=2, lat_sum=20)
    )
    stats._minutes.append(
        _filled_bucket(_redis_minute() - 1, count=4, ok=3, fail=1, lat_sum=40)
    )

    result = await stats.get_stats()
    assert result["total"] == 0  # total 为累计值，此处未发生实时请求
    assert result["success"] == 5
    assert result["failed"] == 1
    assert result["requests_per_minute"] == 3.0  # (2+4)/2 个完整分钟
    assert result["avg_response_time_ms"] == 10.0  # (20+40)/(2+4)


async def test_reset_clears():
    """reset 清空累计与窗口"""
    stats = RequestStats(window_minutes=5)
    await stats.record_request(10.0, True)
    await stats.reset()

    result = await stats.get_stats()
    assert result["total"] == 0
    assert result["success"] == 0
    assert result["failed"] == 0
    assert result["requests_per_minute"] == 0.0


async def test_redis_path_parses_float_latency(monkeypatch):
    """Redis 路径：count/ok/fail 整数字面量、lat 浮点字符串，均能正确解析"""
    class FakeBackend:
        async def get(self, key):
            return "42"

        async def mget(self, *keys):
            # 每分钟一组 count,ok,fail,lat；前两分钟有数据，其余分钟键不存在
            minutes = [
                ("4", "3", "1", "16.25"),
                ("2", "2", "0", "20.0"),
                (None, None, None, None),
                (None, None, None, None),
                (None, None, None, None),
            ]
            return [v for group in minutes for v in group]

    stats = RequestStats(window_minutes=5)

    async def _fake_get_redis():
        return FakeBackend()

    # _backend() 不再缓存一次性探测结果，改为按 get_redis 冷却重试
    monkeypatch.setattr("app.utils.request_stats.get_redis", _fake_get_redis)

    result = await stats.get_stats()
    assert result["total"] == 42
    assert result["success"] == 5
    assert result["failed"] == 1
    assert result["requests_per_minute"] == 3.0  # 6 次 / 2 个完整分钟
    assert result["avg_response_time_ms"] == 6.04  # 36.25 / 6


async def test_redis_client_disabled_when_no_url(monkeypatch):
    """未配置 Redis URL 时 get_redis 返回 None，调用方回退"""
    for dirty in ("", "  "):
        await redis_client.reset_redis()
        monkeypatch.setattr(redis_client, "_redis_url", lambda: dirty)
        assert await redis_client.get_redis() is None
    await redis_client.reset_redis()


async def test_redis_client_lazy_connect_success(monkeypatch):
    """配置 URL 且连接成功时返回客户端；reset 后重新探测"""

    class FakeRedis:
        def __init__(self):
            self.closed = False

        async def ping(self):
            return True

        async def aclose(self):
            self.closed = True

        @classmethod
        def from_url(cls, url, *args, **kwargs):
            return cls()

    await redis_client.reset_redis()
    monkeypatch.setattr(redis_client, "_redis_url", lambda: "redis://x:6379/0")
    monkeypatch.setattr("redis.asyncio", FakeRedis)
    first = await redis_client.get_redis()
    second = await redis_client.get_redis()
    assert first is not None and second is first
    await redis_client.reset_redis()
    third = await redis_client.get_redis()
    assert third is not None and third is not first
    await redis_client.reset_redis()
    # 备注: Redis 回退路径验证改由具体键操作单测覆盖（见 e2e）,
    # 此处仅确认请求统计能解析到同一后端实例。
    stats = RequestStats(window_minutes=5)
    assert await stats._backend() is not None
    await redis_client.reset_redis()


# ===========================================================================
# 降级期计数回填（内存回退计数分裂 / 降级期计数不回填不合并）
# ===========================================================================


class _FakeMetricsStore:
    """够用的 Redis 替身：支持 pipeline 的 incr/incrby/hincrby/expire。"""

    def __init__(self):
        self.counters = {}
        self.hashes = {}
        self.ttls = {}

    def pipeline(self):
        return _FakeMetricsPipe(self)

    async def get(self, key):
        return None

    async def mget(self, *keys):
        return [None] * len(keys)

    async def delete(self, key):
        self.counters.pop(key, None)


class _FakeMetricsPipe:
    def __init__(self, store):
        self._store = store
        self._ops = []

    def incr(self, key):
        self._ops.append(("incrby", key, 1))
        return self

    def incrby(self, key, n):
        self._ops.append(("incrby", key, n))
        return self

    def incrbyfloat(self, key, n):
        self._ops.append(("incrbyfloat", key, n))
        return self

    def hincrby(self, key, field, n):
        self._ops.append(("hincrby", key, field, n))
        return self

    def hincrbyfloat(self, key, field, n):
        self._ops.append(("hincrbyfloat", key, field, n))
        return self

    def expire(self, key, ttl):
        self._ops.append(("expire", key, ttl))
        return self

    async def execute(self):
        store = self._store
        for op in self._ops:
            kind = op[0]
            if kind == "incrby":
                _, key, n = op
                store.counters[key] = store.counters.get(key, 0) + int(n)
            elif kind == "incrbyfloat":
                _, key, n = op
                store.counters[key] = store.counters.get(key, 0.0) + float(n)
            elif kind == "hincrby":
                _, key, field, n = op
                bucket = store.hashes.setdefault(key, {})
                bucket[field] = bucket.get(field, 0) + int(n)
            elif kind == "hincrbyfloat":
                _, key, field, n = op
                bucket = store.hashes.setdefault(key, {})
                bucket[field] = bucket.get(field, 0.0) + float(n)
            elif kind == "expire":
                _, key, ttl = op
                store.ttls[key] = ttl
        return [None] * len(self._ops)


def _sum_counters(store, suffix: str) -> int:
    """累加所有 ``kustos:req:m:<minute>:<suffix>`` 分钟键（跨分钟边界稳健）"""
    marker = f":m:"
    return sum(
        v for k, v in store.counters.items()
        if marker in k and k.endswith(f":{suffix}") and v
    )


async def test_memory_fallback_backfilled_on_redis_recovery(monkeypatch):
    """降级期计入内存的请求，Redis 恢复后一次性回填共享后端（不丢、不重）"""
    import app.utils.request_stats as rs
    from app.utils.prometheus_metrics import (
        _counter_key,
        get_prometheus_metrics,
        reset_prometheus_metrics,
    )

    reset_prometheus_metrics()
    stats = RequestStats(window_minutes=5)

    # --- 阶段 1：Redis 不可用 → 计数进内存，并登记未回填游标 ---
    async def _down():
        return None

    monkeypatch.setattr(rs, "get_redis", _down)
    await stats.record_request(12.0, True, 200, "GET")
    await stats.record_request(30.0, False, 500, "POST")

    assert stats._pending_total == 2
    assert stats._pending_minutes
    assert get_prometheus_metrics()._counters, "降级期计数应落在进程内"

    # --- 阶段 2：Redis 恢复 → 下一次记录触发回填 ---
    store = _FakeMetricsStore()

    async def _up():
        return store

    monkeypatch.setattr(rs, "get_redis", _up)
    await stats.record_request(10.0, True, 200, "GET")

    assert stats._pending_total == 0
    assert stats._pending_minutes == {}, "回填后未回填游标必须清零（防重复计数）"

    # 分钟桶：降级期 2 条 + 恢复后 1 条
    assert store.counters[_rs_key("total")] == 3
    assert _sum_counters(store, "count") == 3
    assert _sum_counters(store, "ok") == 2
    assert _sum_counters(store, "fail") == 1

    # Prometheus 累计计数器：降级期 2 条已回填，且本地增量被清空
    histogram = store.hashes[_counter_key()]
    assert histogram["c:GET|2xx"] == 2  # 1 条回填 + 恢复后 1 条
    assert histogram["c:POST|5xx"] == 1
    assert not get_prometheus_metrics()._counters
    assert not get_prometheus_metrics()._latency

    # --- 阶段 3：继续记录不再回填（游标已清零，不产生第二次补写） ---
    await stats.record_request(8.0, True, 200, "GET")
    assert stats._pending_total == 0
    assert store.counters[_rs_key("total")] == 4
    assert store.hashes[_counter_key()]["c:GET|2xx"] == 3
    assert _sum_counters(store, "count") == 4


async def test_reset_drops_pending_backfill(monkeypatch):
    """reset 后不得再把重置前的降级期数据回填回去"""
    import app.utils.request_stats as rs

    stats = RequestStats(window_minutes=5)

    async def _down():
        return None

    monkeypatch.setattr(rs, "get_redis", _down)
    await stats.record_request(12.0, True, 200, "GET")
    assert stats._pending_total == 1

    await stats.reset()
    assert stats._pending_total == 0
    assert stats._pending_minutes == {}