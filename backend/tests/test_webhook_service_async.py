"""
WebHook 服务层异步测试

测试 WebHook 的创建、管理、触发和投递功能
"""
import asyncio
import logging

import pytest
import uuid
import pytest_asyncio
import json
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.webhook import WebHook, WebHookDelivery, WEBHOOK_EVENTS
from app.services import webhook_service
from app.core.exception import NotFoundException, ValidationException, AuthorizationException


@pytest_asyncio.fixture
async def test_webhook(async_db: AsyncSession, async_test_repo):
    """创建测试 WebHook"""
    webhook = WebHook(
        repository_id=async_test_repo.id,
        url="https://example.com/webhook",
        events='["push", "pull_request.opened"]',
        secret="my-secret-key",
        content_type="application/json",
        is_active=True
    )
    async_db.add(webhook)
    await async_db.commit()
    await async_db.refresh(webhook)
    return webhook


# =============================================================================
# WebHook 管理测试
# =============================================================================

@pytest.mark.asyncio
async def test_create_webhook(async_db: AsyncSession, async_test_repo, async_test_user):
    """测试创建 WebHook"""
    webhook = await webhook_service.create_webhook(
        db=async_db,
        repository_id=async_test_repo.id,
        user_id=async_test_user.id,
        url="https://example.com/webhook",
        events=["push", "pull_request.opened"],
        secret="my-secret-key",
        content_type="application/json",
        is_active=True
    )

    assert webhook["url"] == "https://example.com/webhook"
    assert webhook["events"] == ["push", "pull_request.opened"]
    assert webhook["content_type"] == "application/json"
    assert webhook["is_active"] is True
    assert "secret" in webhook  # 应该返回部分隐藏的密钥


@pytest.mark.asyncio
async def test_create_webhook_invalid_url(async_db: AsyncSession, async_test_repo, async_test_user):
    """测试创建 WebHook 时验证 URL"""
    with pytest.raises(ValidationException) as exc_info:
        await webhook_service.create_webhook(
            db=async_db,
            repository_id=async_test_repo.id,
            user_id=async_test_user.id,
            url="invalid-url",
            events=["push"]
        )

    assert "Invalid URL" in str(exc_info.value)


@pytest.mark.asyncio
async def test_create_webhook_invalid_event(async_db: AsyncSession, async_test_repo, async_test_user):
    """测试创建 WebHook 时验证事件"""
    with pytest.raises(ValidationException) as exc_info:
        await webhook_service.create_webhook(
            db=async_db,
            repository_id=async_test_repo.id,
            user_id=async_test_user.id,
            url="https://example.com/webhook",
            events=["invalid_event"]
        )

    assert "Invalid event" in str(exc_info.value)


@pytest.mark.asyncio
async def test_create_webhook_empty_events(async_db: AsyncSession, async_test_repo, async_test_user):
    """测试创建 WebHook 时验证事件列表不能为空"""
    with pytest.raises(ValidationException) as exc_info:
        await webhook_service.create_webhook(
            db=async_db,
            repository_id=async_test_repo.id,
            user_id=async_test_user.id,
            url="https://example.com/webhook",
            events=[]
        )

    assert "At least one event" in str(exc_info.value)


@pytest.mark.asyncio
async def test_get_webhook(async_db: AsyncSession, async_test_repo, async_test_user, test_webhook):
    """测试获取 WebHook"""
    webhook = await webhook_service.get_webhook(
        db=async_db,
        repository_id=async_test_repo.id,
        webhook_id=test_webhook.id,
        user_id=async_test_user.id
    )

    assert webhook["id"] == test_webhook.id
    assert webhook["url"] == "https://example.com/webhook"


@pytest.mark.asyncio
async def test_get_webhook_not_found(async_db: AsyncSession, async_test_repo, async_test_user):
    """测试获取不存在的 WebHook"""
    with pytest.raises(NotFoundException) as exc_info:
        await webhook_service.get_webhook(
            db=async_db,
            repository_id=async_test_repo.id,
            webhook_id=uuid.uuid4(),
            user_id=async_test_user.id
        )

    assert "Webhook not found" in str(exc_info.value)


@pytest.mark.asyncio
async def test_list_webhooks(async_db: AsyncSession, async_test_repo, async_test_user):
    """测试获取 WebHook 列表"""
    # 创建多个 WebHook
    for i in range(3):
        await webhook_service.create_webhook(
            db=async_db,
            repository_id=async_test_repo.id,
            user_id=async_test_user.id,
            url=f"https://example.com/webhook{i}",
            events=["push"]
        )

    result = await webhook_service.list_webhooks(
        db=async_db,
        repository_id=async_test_repo.id,
        user_id=async_test_user.id
    )

    assert result["total"] == 3
    assert len(result["items"]) == 3


@pytest.mark.asyncio
async def test_update_webhook(async_db: AsyncSession, async_test_repo, async_test_user, test_webhook):
    """测试更新 WebHook"""
    updated = await webhook_service.update_webhook(
        db=async_db,
        repository_id=async_test_repo.id,
        webhook_id=test_webhook.id,
        user_id=async_test_user.id,
        url="https://new-url.com/webhook",
        events=["push", "release.created"],
        is_active=False
    )

    assert updated["url"] == "https://new-url.com/webhook"
    assert updated["events"] == ["push", "release.created"]
    assert updated["is_active"] is False


@pytest.mark.asyncio
async def test_delete_webhook(async_db: AsyncSession, async_test_repo, async_test_user, test_webhook):
    """测试删除 WebHook"""
    await webhook_service.delete_webhook(
        db=async_db,
        repository_id=async_test_repo.id,
        webhook_id=test_webhook.id,
        user_id=async_test_user.id
    )

    # 确认已删除
    with pytest.raises(NotFoundException):
        await webhook_service.get_webhook(
            db=async_db,
            repository_id=async_test_repo.id,
            webhook_id=test_webhook.id,
            user_id=async_test_user.id
        )


# =============================================================================
# WebHook 事件订阅测试
# =============================================================================

@pytest.mark.asyncio
async def test_webhook_is_subscribed_to(async_db: AsyncSession, async_test_repo):
    """测试 WebHook 事件订阅匹配"""
    webhook = WebHook(
        repository_id=async_test_repo.id,
        url="https://example.com/webhook",
        events='["push", "pull_request.*"]',
        is_active=True
    )

    assert webhook.is_subscribed_to("push") is True
    assert webhook.is_subscribed_to("pull_request.opened") is True
    assert webhook.is_subscribed_to("pull_request.merged") is True
    assert webhook.is_subscribed_to("release.created") is False


@pytest.mark.asyncio
async def test_webhook_events_list(async_db: AsyncSession, async_test_repo):
    """测试 WebHook 事件列表的读写"""
    webhook = WebHook(
        repository_id=async_test_repo.id,
        url="https://example.com/webhook",
        is_active=True
    )

    # 设置事件列表
    webhook.set_events_list(["push", "pull_request.opened"])

    # 获取事件列表
    events = webhook.get_events_list()
    assert events == ["push", "pull_request.opened"]


# =============================================================================
# WebHook 签名生成测试
# =============================================================================

def test_generate_signature():
    """测试 HMAC-SHA256 签名生成"""
    payload = '{"event": "push", "ref": "main"}'
    secret = "my-secret"

    signature = webhook_service.generate_signature(payload, secret)

    # 验证签名格式
    assert signature.startswith("sha256=")
    assert len(signature) == 71  # "sha256=" + 64 位十六进制


# =============================================================================
# 事件验证测试
# =============================================================================

def test_is_valid_event():
    """测试事件名称验证"""
    # 有效事件
    assert webhook_service._is_valid_event("push") is True
    assert webhook_service._is_valid_event("pull_request.opened") is True
    assert webhook_service._is_valid_event("release.*") is True

    # 无效事件
    assert webhook_service._is_valid_event("invalid_event") is False
    assert webhook_service._is_valid_event("") is False


# =============================================================================
# 响应构建测试
# =============================================================================

def test_build_webhook_response(async_db: AsyncSession, async_test_repo):
    """测试 WebHook 响应构建"""
    webhook = WebHook(
        id=1,
        repository_id=async_test_repo.id,
        url="https://example.com/webhook",
        events='["push"]',
        secret="my-secret-key",
        is_active=True,
        content_type="application/json"
    )

    # 不包含密钥
    response = webhook_service.build_webhook_response(webhook, include_secret=False)
    assert "secret" not in response

    # 包含密钥（部分隐藏）
    response = webhook_service.build_webhook_response(webhook, include_secret=True)
    assert "secret" in response
    assert response["secret"].startswith("my-s")
    assert "*" in response["secret"]


def test_build_delivery_response():
    """测试投递记录响应构建"""
    delivery = WebHookDelivery(
        id=1,
        webhook_id=uuid.uuid4(),
        event="push",
        payload='{"ref": "main"}',
        is_success=True,
        response_status=200,
        duration_ms=150
    )

    # 不包含详细信息
    response = webhook_service.build_delivery_response(delivery, include_details=False)
    assert "payload" not in response
    assert response["is_success"] is True
    assert response["response_status"] == 200

    # 包含详细信息
    response = webhook_service.build_delivery_response(delivery, include_details=True)
    assert "payload" in response


# =============================================================================
# WebHook 投递重试测试
# =============================================================================

@pytest.mark.asyncio
async def test_webhook_delivery_retries_on_failure(async_db: AsyncSession, test_webhook, respx_mock):
    """
    测试 WebHook 投递失败时执行重试

    验证点：
    1. 目标 URL 前两次返回 500，第三次返回 200
    2. 最终投递记录 is_success 为 True
    3. 目标 URL 被请求 3 次
    """
    import respx
    from httpx import Response

    route = respx_mock.post("https://example.com/webhook").mock(
        side_effect=[Response(500), Response(500), Response(200)]
    )

    delivery = await webhook_service._deliver_webhook(
        webhook=test_webhook,
        event="push",
        payload={"ref": "main"},
        db=async_db,
    )

    assert delivery.is_success is True
    assert delivery.response_status == 200
    assert route.call_count == 3


@pytest.mark.asyncio
async def test_webhook_delivery_records_final_failure(async_db: AsyncSession, test_webhook, respx_mock):
    """
    测试 WebHook 投递最终失败时记录最后一次错误

    验证点：
    1. 目标 URL 始终返回 500
    2. 最终投递记录 is_success 为 False
    3. 目标 URL 被请求 3 次（含初始投递）
    """
    import respx
    from httpx import Response

    route = respx_mock.post("https://example.com/webhook").mock(return_value=Response(500))

    delivery = await webhook_service._deliver_webhook(
        webhook=test_webhook,
        event="push",
        payload={"ref": "main"},
        db=async_db,
    )

    assert delivery.is_success is False
    assert delivery.response_status == 500
    assert route.call_count == 3


# =============================================================================
# 投递任务治理（强引用 / 信号量 / drain）
# =============================================================================

@pytest.mark.asyncio
async def test_track_holds_strong_reference_and_self_cleans():
    """_track 强引用登记任务（防 GC），完成后 done 回调自动清理。"""
    webhook_service._dispatch_tasks.clear()
    started = asyncio.Event()
    release = asyncio.Event()

    async def _work():
        started.set()
        await release.wait()

    task = webhook_service._track(asyncio.create_task(_work()))
    assert task in webhook_service._dispatch_tasks  # 强引用登记
    await started.wait()
    release.set()
    await task
    await asyncio.sleep(0)  # 让 done 回调执行
    assert task not in webhook_service._dispatch_tasks


@pytest.mark.asyncio
async def test_track_logs_uncaught_exception_and_cleans(caplog):
    """任务内未捕获异常被 done 回调记录，且任务仍被清理。"""
    webhook_service._dispatch_tasks.clear()

    async def _boom():
        raise RuntimeError("boom")

    with caplog.at_level(logging.ERROR):
        task = webhook_service._track(asyncio.create_task(_boom()))
        with pytest.raises(RuntimeError):
            await task
        await asyncio.sleep(0)

    assert task not in webhook_service._dispatch_tasks
    assert any("投递批次异常" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_track_ignores_cancelled_task():
    """被取消的任务不视为异常，但同样从强引用集合移除。"""
    webhook_service._dispatch_tasks.clear()

    async def _slow():
        await asyncio.sleep(10)

    task = webhook_service._track(asyncio.create_task(_slow()))
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0)
    assert task not in webhook_service._dispatch_tasks


@pytest.mark.asyncio
async def test_delivery_semaphore_caps_concurrency(monkeypatch):
    """信号量把「单次投递」并发限制在 max_concurrent_deliveries。"""
    # 上限读配置：改配置源而非模块常量（常量仅是降级默认）
    from app.core.config import get_config

    monkeypatch.setattr(get_config().webhook, "max_concurrent_deliveries", 2, raising=False)
    webhook_service._delivery_semaphore = None
    webhook_service._delivery_semaphore_loop = None
    sem = webhook_service._get_delivery_semaphore()

    state = {"cur": 0, "peak": 0}
    release = asyncio.Event()

    async def _job():
        async with sem:
            state["cur"] += 1
            state["peak"] = max(state["peak"], state["cur"])
            await release.wait()
            state["cur"] -= 1

    tasks = [asyncio.create_task(_job()) for _ in range(5)]
    await asyncio.sleep(0.02)
    assert state["peak"] == 2  # 恰好 2 个同时进入，其余排队
    release.set()
    await asyncio.gather(*tasks)
    assert state["peak"] == 2


@pytest.mark.asyncio
async def test_delivery_semaphore_cached_per_loop():
    """同一事件循环内复用同一信号量（避免每请求重建）。"""
    webhook_service._delivery_semaphore = None
    webhook_service._delivery_semaphore_loop = None
    assert (
        webhook_service._get_delivery_semaphore()
        is webhook_service._get_delivery_semaphore()
    )


@pytest.mark.asyncio
async def test_wait_for_pending_deliveries_no_pending():
    webhook_service._dispatch_tasks.clear()
    assert await webhook_service.wait_for_pending_deliveries(timeout=0.1) == 0


@pytest.mark.asyncio
async def test_wait_for_pending_deliveries_times_out_and_counts():
    """关闭时有界等待：超时仍未完成的任务被计数返回。"""
    webhook_service._dispatch_tasks.clear()
    release = asyncio.Event()

    async def _slow():
        await release.wait()

    task = webhook_service._track(asyncio.create_task(_slow()))
    pending = await webhook_service.wait_for_pending_deliveries(timeout=0.05)
    assert pending == 1
    release.set()
    await task


@pytest.mark.asyncio
async def test_wait_for_pending_deliveries_waits_to_completion():
    """任务在超时前完成 → 返回 0（drain 生效）。"""
    webhook_service._dispatch_tasks.clear()

    async def _quick():
        await asyncio.sleep(0.01)

    task = webhook_service._track(asyncio.create_task(_quick()))
    pending = await webhook_service.wait_for_pending_deliveries(timeout=1.0)
    assert pending == 0
    assert task.done()
