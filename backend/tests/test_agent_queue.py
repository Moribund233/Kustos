"""作业队列连接池：失败按冷却窗口重试 + 降级登记（不再一次性永久退化内联）"""
import sys
import types

import pytest

from app.core.config import get_config
from app.services.agent import queue
from app.utils.degraded import registry


@pytest.fixture(autouse=True)
def _isolate():
    registry.reset()
    queue.reset_queue_state()
    yield
    registry.reset()
    queue.reset_queue_state()


def _fake_arq(monkeypatch, *, fail_times: int, calls: list):
    """注入伪 arq 模块：前 fail_times 次创建失败，之后成功返回伪池"""
    mod = types.ModuleType("arq")
    conn = types.ModuleType("arq.connections")

    class _RedisSettings:
        @staticmethod
        def from_dsn(dsn):
            return dsn

    async def _create_pool(settings):
        calls.append(settings)
        if len(calls) <= fail_times:
            raise RuntimeError("redis down")
        return object()

    mod.create_pool = _create_pool
    conn.RedisSettings = _RedisSettings
    monkeypatch.setitem(sys.modules, "arq", mod)
    monkeypatch.setitem(sys.modules, "arq.connections", conn)


def _cfg(monkeypatch, *, url: str, cooldown: float):
    redis_cfg = get_config().redis
    monkeypatch.setattr(redis_cfg, "url", url, raising=False)
    monkeypatch.setattr(redis_cfg, "reconnect_cooldown", cooldown, raising=False)


@pytest.mark.asyncio
async def test_failed_pool_is_retried_after_cooldown(monkeypatch):
    calls = []
    _fake_arq(monkeypatch, fail_times=1, calls=calls)
    _cfg(monkeypatch, url="redis://localhost:6379/0", cooldown=0.0)

    first = await queue._get_arq_pool()
    assert first is None
    assert registry.degraded and any(
        item["component"] == "agent_queue" for item in registry.snapshot()
    )

    # 冷却为 0 → 立即重试并自愈
    second = await queue._get_arq_pool()
    assert second is not None
    assert not registry.degraded
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_cooldown_window_skips_repeated_attempts(monkeypatch):
    calls = []
    _fake_arq(monkeypatch, fail_times=99, calls=calls)
    _cfg(monkeypatch, url="redis://localhost:6379/0", cooldown=9999.0)

    assert await queue._get_arq_pool() is None
    assert await queue._get_arq_pool() is None
    assert await queue._get_arq_pool() is None
    # 冷却窗口内只尝试一次，失败不再反复撞连接
    assert len(calls) == 1
    assert registry.degraded


@pytest.mark.asyncio
async def test_unconfigured_redis_returns_none_without_degradation(monkeypatch):
    calls = []
    _fake_arq(monkeypatch, fail_times=0, calls=calls)
    _cfg(monkeypatch, url="", cooldown=0.0)

    assert await queue._get_arq_pool() is None
    # 未配置 Redis 是既定形态（测试/单机），不算降级
    assert not registry.degraded
    assert calls == []


@pytest.mark.asyncio
async def test_get_job_queue_falls_back_to_inline(monkeypatch):
    from app.services.agent.queue import InlineJobQueue

    calls = []
    _fake_arq(monkeypatch, fail_times=1, calls=calls)
    _cfg(monkeypatch, url="redis://localhost:6379/0", cooldown=0.0)

    assert isinstance(await queue.get_job_queue(), InlineJobQueue)
    # 第二次：池已自愈 → 走 arq 队列
    assert not isinstance(await queue.get_job_queue(), InlineJobQueue)
