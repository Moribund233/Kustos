"""撤销黑名单读缓存（services/revocation_cache）——仅剩 collab_invite 使用"""
from unittest.mock import AsyncMock

import pytest

from app.services.auth import revocation_cache


class _FakeRedis:
    def __init__(self):
        self.store = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None, nx=False):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True


@pytest.fixture
def no_redis(monkeypatch):
    async def _none():
        return None

    monkeypatch.setattr(revocation_cache, "get_redis", _none)


@pytest.fixture
def fake_redis(monkeypatch):
    fake = _FakeRedis()

    async def _fake():
        return fake

    monkeypatch.setattr(revocation_cache, "get_redis", _fake)
    return fake


async def test_get_returns_none_without_redis(no_redis):
    assert await revocation_cache.get("token", "abc") is None


async def test_get_none_for_empty_jti(fake_redis):
    assert await revocation_cache.get("token", None) is None


async def test_positive_then_get_true(fake_redis):
    await revocation_cache.set("token", "j1", True)
    assert await revocation_cache.get("token", "j1") is True


async def test_negative_then_get_false(fake_redis):
    await revocation_cache.set("token", "j1", False)
    assert await revocation_cache.get("token", "j1") is False


async def test_negative_nx_does_not_override_positive(fake_redis):
    await revocation_cache.set("token", "j1", True)
    # 并发 DB 查询回写负缓存时不得覆盖已撤销的正键（避免复活）
    await revocation_cache.set("token", "j1", False)
    assert await revocation_cache.get("token", "j1") is True


async def test_set_noop_without_redis(no_redis):
    await revocation_cache.set("token", "j1", True)  # 不抛错


# ---------------- token 撤销已迁出 ----------------
# token 路径不再走 revocation_cache/DB 回源，改为 services/token_state.py
# 位图单层——新语义测试见 tests/test_token_state.py。


# ---------------- collab invite 接线 ----------------

async def test_invite_revoked_false_caches_negative(monkeypatch, async_db):
    from app.services.collaboration import collab_invite_service as svc

    monkeypatch.setattr(revocation_cache, "get", AsyncMock(return_value=None))
    set_mock = AsyncMock()
    monkeypatch.setattr(revocation_cache, "set", set_mock)

    assert await svc.is_invite_token_revoked(async_db, "inv-jti") is False
    set_mock.assert_awaited_once_with("collab_invite", "inv-jti", False)
