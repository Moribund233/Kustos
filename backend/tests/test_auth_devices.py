"""
登录设备（已登录会话）登记与定向吊销

覆盖：登录登记（同设备覆盖）、刷新回填存活证据、列出设备、按设备吊销
refresh 家族并使其 access token 立即失效。
"""
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exception import AuthenticationException, NotFoundException
from app.models.user import User
from app.models.user_device import UserDevice
from app.services.auth import device_service, token_service
from app.services.auth.user_service import login_user
from app.utils.password_utils import get_password_hash


@pytest_asyncio.fixture
async def device_user(async_db: AsyncSession):
    """创建设备测试用的用户"""
    user = User(
        username="deviceuser",
        email="device@example.com",
        password=get_password_hash("testpassword"),
        is_active=True,
    )
    async_db.add(user)
    await async_db.commit()
    await async_db.refresh(user)
    return user


async def _login(db: AsyncSession, user: User, device_id: str = "dev-1",
                 device_name: str = "Kustos Desktop (macOS)"):
    """走真实登录路径，返回登录结果"""
    return await login_user(
        {
            "username": user.username,
            "password": "testpassword",
            "device_id": device_id,
            "device_name": device_name,
            "platform": "desktop",
        },
        db,
        ip="10.0.0.8",
    )


async def _device_row(db: AsyncSession, user_id) -> UserDevice:
    return (
        await db.execute(select(UserDevice).filter(UserDevice.user_id == user_id))
    ).scalars().first()


@pytest.mark.asyncio
async def test_login_registers_device(async_db: AsyncSession, device_user):
    """登录上报设备标识时登记一条设备记录，并记录来源 IP"""
    result = await _login(async_db, device_user)

    devices = await device_service.list_devices(async_db, device_user.id)
    assert len(devices) == 1
    assert devices[0]["device_name"] == "Kustos Desktop (macOS)"
    assert devices[0]["platform"] == "desktop"
    assert devices[0]["last_ip"] == "10.0.0.8"
    assert devices[0]["revoked"] is False
    # 内部吊销标识不外泄
    assert "family_id" not in devices[0]

    refresh_data = token_service.verify_token(result["refresh_token"], token_type="refresh")
    assert refresh_data.device_id == "dev-1"


@pytest.mark.asyncio
async def test_login_without_device_id_registers_nothing(async_db: AsyncSession, device_user):
    """Web 端不传设备标识：登录照常成功，不留设备记录"""
    result = await login_user(
        {"username": device_user.username, "password": "testpassword"}, async_db
    )
    assert result["refresh_token"]
    assert await device_service.list_devices(async_db, device_user.id) == []


@pytest.mark.asyncio
async def test_relogin_same_device_overwrites(async_db: AsyncSession, device_user):
    """同设备再次登录覆盖既有记录，不堆叠，并换掉 family"""
    first = await _login(async_db, device_user)
    second = await _login(async_db, device_user, device_name="Kustos Desktop (renamed)")

    devices = await device_service.list_devices(async_db, device_user.id)
    assert len(devices) == 1
    assert devices[0]["device_name"] == "Kustos Desktop (renamed)"
    assert first["refresh_token"] != second["refresh_token"]


@pytest.mark.asyncio
async def test_refresh_touches_device_last_seen(async_db: AsyncSession, device_user):
    """刷新沿家族回填最近活跃时间，且新令牌沿用设备标识"""
    await _login(async_db, device_user)
    row = await _device_row(async_db, device_user.id)
    before = row.last_seen_at

    pair = token_service.create_token_pair(
        device_user, extra_claims={"family_id": row.family_id, "device_id": "dev-1"}
    )
    refreshed = await token_service.refresh_access_token(
        pair["refresh_token"], async_db, ip="10.0.0.9"
    )
    assert token_service.verify_token(
        refreshed["refresh_token"], token_type="refresh"
    ).device_id == "dev-1"

    await async_db.refresh(row)
    assert row.last_seen_at > before
    assert row.last_ip == "10.0.0.9"


@pytest.mark.asyncio
async def test_revoke_device_kills_its_family(async_db: AsyncSession, device_user):
    """吊销设备返回其 family 供吊销位图，并让 refresh 家族立即失效"""
    await _login(async_db, device_user)
    device = (await device_service.list_devices(async_db, device_user.id))[0]
    row = await _device_row(async_db, device_user.id)

    pair = token_service.create_token_pair(
        device_user, extra_claims={"family_id": row.family_id, "device_id": "dev-1"}
    )

    info = await device_service.revoke_device(async_db, device_user.id, uuid.UUID(device["id"]))
    await token_service.revoke_family(async_db, info["family_id"], revoked_by=device_user.id)
    await async_db.commit()

    devices = await device_service.list_devices(async_db, device_user.id)
    assert devices[0]["revoked"] is True

    with pytest.raises(AuthenticationException):
        await token_service.refresh_access_token(pair["refresh_token"], async_db)


@pytest.mark.asyncio
async def test_revoke_other_users_device_is_404(async_db: AsyncSession, device_user):
    """不能吊销他人设备，且不泄露其存在性"""
    await _login(async_db, device_user)
    device = (await device_service.list_devices(async_db, device_user.id))[0]

    with pytest.raises(NotFoundException):
        await device_service.revoke_device(async_db, uuid.uuid4(), uuid.UUID(device["id"]))


@pytest.mark.asyncio
async def test_revoke_is_idempotent(async_db: AsyncSession, device_user):
    """重复吊销不报错，family 保持不变"""
    await _login(async_db, device_user)
    device = (await device_service.list_devices(async_db, device_user.id))[0]
    pk = uuid.UUID(device["id"])

    first = await device_service.revoke_device(async_db, device_user.id, pk)
    second = await device_service.revoke_device(async_db, device_user.id, pk)
    assert first["family_id"] == second["family_id"]
