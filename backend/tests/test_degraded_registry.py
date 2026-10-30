"""Redis 静默降级 → 显式 degraded 登记与面板暴露

原缺陷：Redis 缺失时三处子系统静默回退，把「单 worker 视图 / 进程内广播」
当正常数据返回——运维无法区分「指标就是低」与「指标缺了一半」。
"""
import asyncio

import pytest

from app.utils.degraded import registry as degraded


@pytest.fixture(autouse=True)
def _clean_registry():
    degraded.reset()
    yield
    degraded.reset()


class TestDegradedRegistry:
    def test_set_then_clear(self):
        degraded.set("bus", "in-process", "跨 worker 消息丢失")
        assert degraded.degraded is True

        items = degraded.snapshot()
        assert len(items) == 1
        assert items[0]["component"] == "bus"
        assert items[0]["mode"] == "in-process"
        assert items[0]["detail"] == "跨 worker 消息丢失"
        assert items[0]["since"]

        degraded.clear("bus")
        assert degraded.degraded is False
        assert degraded.snapshot() == []

    def test_set_is_idempotent(self):
        """重复登记同一状态不产生重复条目（避免每请求刷日志/刷面板）"""
        for _ in range(5):
            degraded.set("presence", "in-process", "单 worker 视图")
        assert len(degraded.snapshot()) == 1

    def test_snapshot_sorted_and_covers_multiple(self):
        degraded.set("request_stats", "memory", "单 worker 视图")
        degraded.set("presence", "in-process", "本 worker 视图")
        degraded.set("realtime_bus", "in-process", "跨 worker 丢失")

        names = [c["component"] for c in degraded.snapshot()]
        assert names == sorted(names)
        assert set(names) == {"presence", "realtime_bus", "request_stats"}

    def test_clear_unknown_is_noop(self):
        degraded.clear("never-set")
        assert degraded.degraded is False


class TestRequestStatsRegistration:
    @pytest.mark.asyncio
    async def test_no_redis_marks_degraded(self, monkeypatch):
        import app.utils.request_stats as rs

        async def _none():
            return None

        monkeypatch.setattr(rs, "get_redis", _none)
        stats = rs.RequestStats(window_minutes=5)

        for _ in range(3):  # 多次调用仍是单条
            assert await stats._backend() is None

        components = [c["component"] for c in degraded.snapshot()]
        assert components == ["request_stats"]
        detail = degraded.snapshot()[0]["detail"]
        assert "单 worker" in detail

    @pytest.mark.asyncio
    async def test_recovers_when_redis_returns(self, monkeypatch):
        """原实现「探测一次永久回退」→ 恢复自愈（改为按 get_redis 冷却重试）"""
        import app.utils.request_stats as rs

        calls = {"up": False}
        fake_client = object()

        async def _client():
            return fake_client if calls["up"] else None

        monkeypatch.setattr(rs, "get_redis", _client)
        stats = rs.RequestStats(window_minutes=5)

        assert await stats._backend() is None
        assert degraded.degraded is True

        calls["up"] = True
        assert await stats._backend() is fake_client
        assert degraded.degraded is False


class TestRealtimeBusRegistration:
    @pytest.mark.asyncio
    async def test_start_failure_marks_degraded(self, monkeypatch):
        import app.utils.realtime_bus as rb

        async def _none():
            return None

        monkeypatch.setattr(rb.redis_client, "get_redis", _none)
        bus = rb.RealtimeBus()

        assert await bus.start() is False
        components = degraded.snapshot()
        assert [c["component"] for c in components] == ["realtime_bus"]
        assert "跨 worker" in components[0]["detail"]

    @pytest.mark.asyncio
    async def test_start_success_clears(self, monkeypatch):
        import app.utils.realtime_bus as rb

        degraded.set("realtime_bus", "in-process", "启动失败")

        class _FakePubsub:
            async def psubscribe(self, pattern):
                return None

            async def punsubscribe(self):
                return None

            async def close(self):
                return None

            async def get_message(self, **kwargs):
                await asyncio.sleep(0.01)
                return None

        class _FakePubsubClient:
            def pubsub(self):
                return _FakePubsub()

            async def aclose(self):
                return None

        async def _client():
            return object()

        async def _pubsub():
            return _FakePubsubClient()

        monkeypatch.setattr(rb.redis_client, "get_redis", _client)
        monkeypatch.setattr(rb.redis_client, "create_pubsub_client", _pubsub)

        bus = rb.RealtimeBus()
        try:
            assert await bus.start() is True
            assert degraded.degraded is False
        finally:
            await bus.stop()


class TestPresenceRegistration:
    @pytest.mark.asyncio
    async def test_no_redis_marks_degraded(self, monkeypatch):
        import app.services.realtime.presence_service as ps

        async def _none():
            return None

        monkeypatch.setattr(ps, "get_redis", _none)
        store = ps.PresenceStore()

        assert await store.enabled() is False
        assert await store.list_users("room-1") == []

        components = degraded.snapshot()
        assert [c["component"] for c in components] == ["presence"]
        assert "worker" in components[0]["detail"]

    @pytest.mark.asyncio
    async def test_recovers_when_redis_returns(self, monkeypatch):
        import app.services.realtime.presence_service as ps

        calls = {"up": False}

        async def _client():
            return object() if calls["up"] else None

        monkeypatch.setattr(ps, "get_redis", _client)
        store = ps.PresenceStore()

        assert await store.enabled() is False
        assert degraded.degraded is True

        calls["up"] = True
        assert await store.enabled() is True
        assert degraded.degraded is False


class TestAdminSurface:
    @pytest.mark.asyncio
    async def test_degradation_block_lists_components(self):
        """Admin「Redis → 降级」面板数据必须带显式清单（非静默）"""
        from app.services.redis_admin_service import RedisAdminService

        degraded.set("request_stats", "memory", "Admin 时序为单 worker 视图")

        status = await RedisAdminService().get_status()
        degradation = status["degradation"]

        assert degradation["degraded"] is True
        assert len(degradation["components"]) == 1
        entry = degradation["components"][0]
        assert entry["component"] == "request_stats"
        assert entry["mode"] == "memory"
        assert entry["detail"]
        assert entry["since"]

    @pytest.mark.asyncio
    async def test_degradation_block_clean_when_healthy(self):
        from app.services.redis_admin_service import RedisAdminService

        status = await RedisAdminService().get_status()
        degradation = status["degradation"]

        assert degradation["degraded"] is False
        assert degradation["components"] == []
