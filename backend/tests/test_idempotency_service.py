"""幂等键（Idempotency-Key）测试

离线 outbox 要能"自动补发"而非只能存草稿，前提是服务端对重复提交去重。
设计文档要求：没有幂等键就只能做草稿（``§15``），有了才能做自动补发。

语义（对齐 RFC 9110 / Stripe 的实践）:
- 同 key + 同请求体 + 未过期 → 返回**首次**的响应，不重复执行副作用；
- 同 key + 不同请求体 → **409 conflict**（不能静默返回旧结果，否则掩盖客户端 bug）；
- 不同 key → 各自独立执行；
- 未带 key → 保持原行为（不改变既有调用方）。
"""
import uuid

import pytest
from sqlalchemy import select

from app.models.idempotency_record import IdempotencyRecord
from app.services.idempotency_service import (
    IdempotencyConflict,
    compute_fingerprint,
    lookup,
    remember_key,
)


class TestFingerprint:
    def test_same_body_and_target_same_fingerprint(self):
        fp1 = compute_fingerprint("POST", "/api/v1/repositories/x/issues", {"title": "a"})
        fp2 = compute_fingerprint("POST", "/api/v1/repositories/x/issues", {"title": "a"})
        assert fp1 == fp2

    def test_different_body_differs(self):
        fp1 = compute_fingerprint("POST", "/p", {"title": "a"})
        fp2 = compute_fingerprint("POST", "/p", {"title": "b"})
        assert fp1 != fp2

    def test_key_order_does_not_matter(self):
        """JSON 对象键序不应影响指纹——否则同一请求会因序列化顺序被判为冲突"""
        fp1 = compute_fingerprint("POST", "/p", {"a": 1, "b": 2})
        fp2 = compute_fingerprint("POST", "/p", {"b": 2, "a": 1})
        assert fp1 == fp2

    def test_different_method_or_path_differs(self):
        base = {"x": 1}
        assert compute_fingerprint("POST", "/a", base) != compute_fingerprint("PUT", "/a", base)
        assert compute_fingerprint("POST", "/a", base) != compute_fingerprint("POST", "/b", base)


class TestRememberAndLookup:
    @pytest.mark.asyncio
    async def test_remember_then_lookup_returns_record(self, async_db, async_test_user):
        remember_key(
            async_db,
            key="k-1",
            user_id=async_test_user.id,
            scope="POST /api/v1/x",
            fingerprint="fp-1",
            status_code=201,
            response_body={"id": "abc"},
        )
        await async_db.commit()

        found = await lookup(
            async_db,
            key="k-1",
            user_id=async_test_user.id,
            scope="POST /api/v1/x",
            fingerprint="fp-1",
        )
        assert found is not None
        assert found.status_code == 201
        assert found.response_body == {"id": "abc"}

    @pytest.mark.asyncio
    async def test_different_fingerprint_raises_conflict(self, async_db, async_test_user):
        """同 key 不同请求体必须是冲突，不能返回旧响应"""
        remember_key(
            async_db,
            key="k-2",
            user_id=async_test_user.id,
            scope="POST /api/v1/x",
            fingerprint="fp-1",
            status_code=201,
            response_body={"id": "abc"},
        )
        await async_db.commit()

        with pytest.raises(IdempotencyConflict):
            await lookup(
                async_db,
                key="k-2",
                user_id=async_test_user.id,
                scope="POST /api/v1/x",
                fingerprint="fp-2",
            )

    @pytest.mark.asyncio
    async def test_missing_key_returns_none(self, async_db, async_test_user):
        found = await lookup(
            async_db,
            key="never",
            user_id=async_test_user.id,
            scope="s",
            fingerprint="fp",
        )
        assert found is None

    @pytest.mark.asyncio
    async def test_keys_are_scoped_per_user(self, async_db, async_test_user):
        """不同用户用同一个 key 互不影响——key 是客户端自选的，不能跨用户串"""
        from app.models.user import User

        other = User(
            username="idem-other",
            email="idem-other@example.com",
            password="hashed_other_password",
            is_active=True,
            is_admin=False,
        )
        async_db.add(other)
        await async_db.commit()
        await async_db.refresh(other)

        remember_key(
            async_db,
            key="shared",
            user_id=async_test_user.id,
            scope="POST /api/v1/x",
            fingerprint="fp-a",
            status_code=201,
            response_body={"id": "mine"},
        )
        await async_db.commit()

        found = await lookup(
            async_db,
            key="shared",
            user_id=other.id,
            scope="POST /api/v1/x",
            fingerprint="fp-a",
        )
        assert found is None


class TestModelIsolation:
    @pytest.mark.asyncio
    async def test_records_are_distinct_rows(self, async_db, async_test_user):
        for i in range(2):
            remember_key(
                async_db,
                key=f"multi-{i}",
                user_id=async_test_user.id,
                scope="s",
                fingerprint=f"fp-{i}",
                status_code=201,
                response_body={"i": i},
            )
        await async_db.commit()

        result = await async_db.execute(
            select(IdempotencyRecord).filter(IdempotencyRecord.user_id == async_test_user.id)
        )
        assert len(result.scalars().all()) == 2

