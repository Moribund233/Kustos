"""
Prometheus 指标导出测试（监控集成 + 观测层重写）

覆盖：
- ``PrometheusMetrics`` 进程内存储（计数 / 直方图 / 在途 / 汇总）
- ``add_counter_ops``：累计计数器并入 RequestStats **同一条 pipeline**（单一记录点）
- ``_accumulate_redis``：跨 worker（per-pid hash）求和 → 全局视图
- ``/metrics`` 端点：async 渲染 + backend 注释行 + 记录范围自排除
- 记录范围由 ``middleware.scope`` 统一裁决（与 admin 统计同口径）

变更：
- 原 ``PrometheusMetricsMiddleware`` 已删除（并入 ``ObservabilityMiddleware``），
  中间件 dispatch 行为改由 ``tests/test_observability.py`` 覆盖；
- ``/health`` 不再计入指标（此前 Prometheus 与 RequestStats 对 /health 口径不一致）；
- ``/metrics`` 首行新增 ``# kustos_metrics_backend:`` 标注本次渲染的数据后端。
"""
import os

import pytest

from app.utils.prometheus_metrics import (
    DEFAULT_BUCKETS,
    PrometheusMetrics,
    _COUNTER_TTL_FLOOR,
    _accumulate_redis,
    _bucket_index,
    _counter_key,
    _counter_ttl,
    _status_label,
    add_counter_ops,
    get_prometheus_metrics,
    metrics_response,
    render_metrics,
    reset_prometheus_metrics,
)
from app.utils.degraded import registry as degraded


# ---------------------------------------------------------------------------
# 内存存储
# ---------------------------------------------------------------------------


class TestPrometheusMetricsStore:
    @pytest.fixture(autouse=True)
    def _fresh(self):
        reset_prometheus_metrics()
        yield
        reset_prometheus_metrics()

    def test_record_and_counts(self):
        m = get_prometheus_metrics()
        m.record("get", 200, 0.05)
        m.record("GET", 200, 0.01)
        m.record("GET", 404, 0.02)
        m.record("GET", 500, 0.03)
        text = m.render()
        assert 'kustos_http_requests_total{method="GET",status="2xx"} 2' in text
        assert 'kustos_http_requests_total{method="GET",status="4xx"} 1' in text
        assert 'kustos_http_requests_total{method="GET",status="5xx"} 1' in text
        assert "kustos_http_5xx_total 1" in text
        assert "kustos_http_requests_total_total 4" in text

    def test_latency_histogram_monotonic(self):
        m = get_prometheus_metrics()
        m.record("GET", 200, 0.003)
        m.record("GET", 200, 0.02)
        m.record("GET", 200, 1.5)
        text = m.render()
        counts = []
        for bucket in ("0.005", "0.01", "0.025", "0.05", "0.1",
                       "0.25", "0.5", "1", "2.5", "5", "10", "+Inf"):
            marker = f'kustos_http_request_duration_seconds_bucket{{method="GET",le="{bucket}"}} '
            value = int([l.split()[-1] for l in text.splitlines()
                         if l.startswith(marker)][0])
            counts.append(value)
        assert counts == sorted(counts)
        assert counts[-1] == 3
        assert '_sum' in text and '_count' in text
        assert 'kustos_http_request_duration_seconds_count{method="GET"} 3' in text

    def test_inflight_gauge(self):
        m = get_prometheus_metrics()
        m.enter()
        m.enter()
        assert "kustos_http_inflight_requests 2" in m.render()
        m.leave()
        assert "kustos_http_inflight_requests 1" in m.render()
        m.leave()
        m.leave()  # 不出现负值
        assert "kustos_http_inflight_requests 0" in m.render()

    def test_status_label_classification(self):
        assert _status_label(99) == "1xx"
        assert _status_label(200) == "2xx"
        assert _status_label(304) == "3xx"
        assert _status_label(422) == "4xx"
        assert _status_label(503) == "5xx"
        assert PrometheusMetrics._status_label(503) == "5xx"

    def test_render_includes_help_type_headers(self):
        m = get_prometheus_metrics()
        text = m.render()
        assert "# TYPE kustos_http_requests_total counter" in text
        assert "# TYPE kustos_http_request_duration_seconds histogram" in text
        assert "# TYPE kustos_http_inflight_requests gauge" in text
        assert "# TYPE kustos_http_5xx_total counter" in text
        assert "# TYPE kustos_http_requests_total_total counter" in text

    def test_bucket_index_boundaries(self):
        assert _bucket_index(0.0) == 0
        assert _bucket_index(0.005) == 0
        assert _bucket_index(0.006) == 1
        assert _bucket_index(0.02) == 2  # <= 0.025
        assert _bucket_index(999.0) == len(DEFAULT_BUCKETS) - 1  # +Inf 桶


# ---------------------------------------------------------------------------
# 单一记录点：计数器并入 RequestStats 的 pipeline
# ---------------------------------------------------------------------------


class _FakePipe:
    """记录 pipeline 调用序列的替身（不真连 Redis）"""

    def __init__(self):
        self.ops = []

    def hincrby(self, key, field, amount):
        self.ops.append(("hincrby", key, field, amount))

    def hincrbyfloat(self, key, field, amount):
        self.ops.append(("hincrbyfloat", key, field, amount))

    def expire(self, key, ttl):
        self.ops.append(("expire", key, ttl))

    def fields(self):
        return [op[2] for op in self.ops if op[0] in ("hincrby", "hincrbyfloat")]


class TestCounterPipelineOps:
    def test_add_counter_ops_appends_four_counters_and_ttl(self):
        pipe = _FakePipe()
        add_counter_ops(pipe, "get", 200, 0.02)
        fields = pipe.fields()
        assert "c:GET|2xx" in fields
        assert any(f.startswith("h:GET|") for f in fields)
        assert "hs:GET" in fields
        assert "hn:GET" in fields
        # 计数器键需带 TTL，否则累计值永不过期
        assert any(op[0] == "expire" for op in pipe.ops)
        # 键落在 metrics 分域下（含 pid，跨 worker 各写各的）
        keys = {op[1] for op in pipe.ops}
        assert all("metrics" in k and "cnt" in k for k in keys)
        assert str(os.getpid()) in _counter_key()

    def test_add_counter_ops_status_class(self):
        pipe = _FakePipe()
        add_counter_ops(pipe, "POST", 503, 1.5)
        assert "c:POST|5xx" in pipe.fields()
        # 1.5s → 落入 2.5 桶（下标 8）
        assert f"h:POST|{_bucket_index(1.5)}" in pipe.fields()
        assert _bucket_index(1.5) == DEFAULT_BUCKETS.index(2.5)

    def test_counter_ttl_never_shrinks_below_floor(self, monkeypatch):
        """累计计数器 TTL 有 7 天硬下限——``history_minutes`` 下限 5 分钟时旧口径仅 360s，
        会使活跃但空闲 worker 的 per-pid 键先过期，跨 pid 求和假 reset（review #11）。"""
        import app.utils.prometheus_metrics as pm

        class _Metrics:
            def __init__(self, minutes):
                self.history_minutes = minutes

        class _Cfg:
            def __init__(self, minutes):
                self.metrics = _Metrics(minutes)

        monkeypatch.setattr("app.core.config.get_config", lambda: _Cfg(5))
        assert pm._counter_ttl() == pm._COUNTER_TTL_FLOOR
        assert pm._COUNTER_TTL_FLOOR >= 24 * 3600

        # 大窗口按配置放大，且仍不低于下限
        monkeypatch.setattr("app.core.config.get_config", lambda: _Cfg(10080))
        assert pm._counter_ttl() > pm._COUNTER_TTL_FLOOR

    def test_alerts_cover_target_down_and_absent(self):
        """alerts.yml 必须含 ``up==0`` 与 ``absent()`` 兜底规则（review #11：序列消失无告警）"""
        import pathlib

        path = (
            pathlib.Path(__file__).resolve().parents[1]
            / "docker" / "prometheus" / "alerts.yml"
        )
        text = path.read_text(encoding="utf-8")
        assert "KustosTargetDown" in text
        assert 'up{job="kustos"} == 0' in text
        assert "KustosMetricsAbsent" in text
        assert "absent(kustos_http_requests_total)" in text


class TestCrossWorkerAccumulation:
    def test_two_worker_hashes_sum_into_global_view(self):
        """两个 per-pid hash 聚合后 = 全局计数（任一 worker 应答都是全局视图）"""
        agg = PrometheusMetrics()
        _accumulate_redis(agg, {"c:GET|2xx": "2", "h:GET|1": "3",
                                "hs:GET": "0.05", "hn:GET": "3"})
        _accumulate_redis(agg, {"c:GET|2xx": "5", "h:GET|1": "4",
                                "hs:GET": "0.07", "hn:GET": "4"})
        text = agg.render()
        assert 'kustos_http_requests_total{method="GET",status="2xx"} 7' in text
        assert "kustos_http_requests_total_total 7" in text
        assert 'kustos_http_request_duration_seconds_count{method="GET"} 7' in text
        # 精确桶 idx=1（0.01）→ 累积桶：le >= 0.01 全部计入
        assert ('kustos_http_request_duration_seconds_bucket'
                '{method="GET",le="0.01"} 7' in text)
        assert ('kustos_http_request_duration_seconds_bucket'
                '{method="GET",le="0.005"} 0' in text)

    def test_dirty_fields_skipped_not_raise(self):
        agg = PrometheusMetrics()
        _accumulate_redis(agg, {"c:GET|2xx": "not-a-number",
                                "h:GET|999": "1",   # 越界桶下标
                                "hs:GET": None,
                                "unknown": "x"})
        # 脏字段被跳过，渲染不炸
        assert "kustos_http_requests_total_total 0" in agg.render()


# ---------------------------------------------------------------------------
# /metrics 端点（经 app 全链路）
# ---------------------------------------------------------------------------

class TestMetricsEndpoint:
    @pytest.fixture(autouse=True)
    def _fresh(self):
        reset_prometheus_metrics()
        yield
        reset_prometheus_metrics()
        degraded.clear("metrics_export")

    def test_metrics_endpoint_via_app_records_recorded_paths(self, test_client):
        # 记录范围内的路径（未命中任何排除集）→ 计入
        test_client.get("/definitely-not-a-route")
        r = test_client.get("/metrics")
        assert r.status_code == 200
        assert "text/plain" in r.headers.get("content-type", "")
        text = r.text
        # 首行标注数据后端（测试容器无 REDIS_URL → memory 回退）
        assert text.splitlines()[0].startswith("# kustos_metrics_backend: ")
        assert text.splitlines()[0].strip().endswith(("memory", "redis"))
        # 仅 /definitely-not-a-route（4xx）被记录，/metrics 自排除
        assert "kustos_http_requests_total_total 1" in text
        assert 'kustos_http_requests_total{method="GET",status="4xx"} 1' in text

    def test_health_docs_metrics_not_counted(self, test_client):
        """/health /docs /openapi.json /metrics 均不计入（scope 统一裁决）"""
        for _ in range(3):
            test_client.get("/health")
        test_client.get("/openapi.json")
        test_client.get("/metrics")
        r = test_client.get("/metrics")
        assert r.status_code == 200
        assert "kustos_http_requests_total_total 0" in r.text
        assert 'method="GET"' not in r.text

    def test_metrics_self_excluded(self, test_client):
        """仅请求 /metrics 时自身不出现计数（防递归膨胀）"""
        r = test_client.get("/metrics")
        assert r.status_code == 200
        assert "kustos_http_requests_total_total 0" in r.text

    def test_inflight_gauge_visible_on_endpoint(self, test_client):
        r = test_client.get("/metrics")
        assert "kustos_http_inflight_requests 0" in r.text

    async def test_metrics_response_is_async(self):
        r = await metrics_response(None)
        assert r.status_code == 200
        body = r.body.decode()
        assert body.splitlines()[0].startswith("# kustos_metrics_backend: ")
        assert "kustos_http_requests_total" in body

    async def test_render_metrics_falls_back_to_memory_without_redis(self, monkeypatch):
        import app.utils.prometheus_metrics as pm

        async def _no_redis():
            return None

        monkeypatch.setattr(pm, "get_redis", _no_redis)
        text, backend = await render_metrics()
        assert backend == "memory"
        assert "kustos_http_requests_total" in text
        assert "metrics_export" in [c["component"] for c in degraded.snapshot()]

    async def test_render_metrics_uses_redis_when_available(self, monkeypatch):
        """Redis 可用 → 后端标记 redis，且渲染跨 pid 聚合结果"""
        import app.utils.prometheus_metrics as pm

        class _Client:
            def __init__(self):
                self._hashes = {
                    "kustos:metrics:cnt:111": {"c:GET|2xx": "3", "hn:GET": "3"},
                    "kustos:metrics:cnt:222": {"c:GET|2xx": "4", "hn:GET": "4"},
                }
                self._pending = []

            async def scan_iter(self, match=None):
                for k in self._hashes:
                    yield k

            def pipeline(self):
                return self

            def hgetall(self, key):
                self._pending.append(key)

            async def execute(self):
                out = [self._hashes.get(k, {}) for k in self._pending]
                self._pending = []
                return out

        async def _client():
            return _Client()

        monkeypatch.setattr(pm, "get_redis", _client)
        # 在途数取应答 scrape 的这个 worker 自身的进程内 gauge
        get_prometheus_metrics().enter()
        try:
            text, backend = await render_metrics()
            assert "kustos_http_inflight_requests 1" in text
        finally:
            get_prometheus_metrics().leave()
        assert backend == "redis"
        assert 'kustos_http_requests_total{method="GET",status="2xx"} 7' in text
        assert "metrics_export" not in [c["component"] for c in degraded.snapshot()]
