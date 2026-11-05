"""登录设备登记与定向吊销

``refresh`` 家族此前只能整体吊销：用户看到若干会话却无法辨认是哪台机器，
泄漏时只能"全部登出"。本模块把"一次登录 = 一台设备"落成记录，
并以 ``family_id`` 作为吊销单元——设备吊销即吊销其家族，与现有
``token_state`` 位图、``revoked_tokens`` 审计表同一套语义。
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exception import NotFoundException
from app.models.user_device import UserDevice

logger = logging.getLogger(__name__)

#: 未上报设备名时的兜底（各端均可缺省，不能让登录因此失败）
DEFAULT_DEVICE_NAME = "Unknown device"

#: 设备名与 device_id 的长度上限，与模型列宽绑定（不是可调运行参数）
MAX_DEVICE_NAME = 128  # config-allow: 与 user_devices.device_name 列宽绑定
MAX_DEVICE_ID = 64  # config-allow: 与 user_devices.device_id 列宽绑定


def normalize_device(device_id: Optional[str], device_name: Optional[str],
                     platform: Optional[str]) -> tuple[Optional[str], str, Optional[str]]:
    """规整客户端上报的设备信息

    全部字段可缺省：Web 端不传时退化为一条无名会话，不影响登录。

    Returns:
        (device_id, device_name, platform)：device_id 为空表示客户端不区分设备
    """
    device_id = (device_id or "").strip()[:MAX_DEVICE_ID] or None
    device_name = (device_name or "").strip()[:MAX_DEVICE_NAME] or DEFAULT_DEVICE_NAME
    platform = (platform or "").strip()[:32] or None
    return device_id, device_name, platform


async def register_login(
    db: AsyncSession,
    user_id: uuid.UUID,
    family_id: str,
    device_id: Optional[str],
    device_name: str,
    platform: Optional[str],
    ip: Optional[str],
) -> Optional[UserDevice]:
    """登记一次登录；同用户同设备覆盖既有记录

    Args:
        db: 异步数据库会话（调用方负责提交）
        user_id: 登录用户 ID
        family_id: 本次登录的 refresh 家族 ID（吊销单元）
        device_id: 客户端设备标识，缺省时不登记
        device_name: 用户可辨认的设备名
        platform: 客户端平台标识
        ip: 来源 IP

    Returns:
        UserDevice | None: 登记成功返回记录；``device_id`` 缺省返回 None
    """
    if not device_id:
        return None

    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(UserDevice).filter(
            UserDevice.user_id == user_id,
            UserDevice.device_id == device_id,
        )
    )
    device = result.scalar_one_or_none()
    if device is None:
        device = UserDevice(user_id=user_id, device_id=device_id)
        db.add(device)

    device.device_name = device_name
    device.platform = platform
    device.family_id = family_id
    device.last_ip = ip
    device.last_seen_at = now
    device.revoked_at = None
    await db.flush()
    return device


async def touch_family(db: AsyncSession, family_id: Optional[str], ip: Optional[str]) -> None:
    """刷新时回填会话存活证据；按 family 找回，找不到就跳过

    ``family_id`` 为空的存量 token 不会命中任何设备记录。
    """
    if not family_id:
        return
    result = await db.execute(
        select(UserDevice).filter(UserDevice.family_id == family_id)
    )
    device = result.scalars().first()
    if device is None:
        return
    device.last_seen_at = datetime.now(timezone.utc)
    if ip:
        device.last_ip = ip
    await db.flush()


def device_to_dict(device: UserDevice) -> dict:
    """设备记录序列化（不含 ``family_id``：那是吊销凭证的内部标识）"""
    return {
        "id": str(device.id),
        "device_name": device.device_name,
        "device_id": device.device_id,
        "platform": device.platform,
        "last_ip": device.last_ip,
        "last_seen_at": (
            device.last_seen_at.isoformat() if device.last_seen_at else None
        ),
        "created_at": device.created_at.isoformat() if device.created_at else None,
        "revoked": device.revoked_at is not None,
    }


async def list_devices(db: AsyncSession, user_id: uuid.UUID) -> list[dict]:
    """列出该用户的全部登录设备，最近活跃在前"""
    result = await db.execute(
        select(UserDevice)
        .filter(UserDevice.user_id == user_id)
        .order_by(UserDevice.last_seen_at.desc().nullslast(), UserDevice.created_at.desc())
    )
    return [device_to_dict(d) for d in result.scalars().all()]


async def revoke_device(
    db: AsyncSession, user_id: uuid.UUID, device_pk: uuid.UUID
) -> dict:
    """定向吊销一台设备：吊销其 refresh 家族，并标记记录

    Args:
        db: 异步数据库会话
        user_id: 当前用户（只能吊销自己的设备）
        device_pk: 设备记录 ID

    Returns:
        dict: ``{"family_id", "revoked"}``，供调用方连带吊销位图

    Raises:
        NotFoundException: 设备不存在或不属于该用户（不泄露他人设备存在性）
    """
    result = await db.execute(
        select(UserDevice).filter(
            UserDevice.id == device_pk, UserDevice.user_id == user_id
        )
    )
    device = result.scalar_one_or_none()
    if device is None:
        raise NotFoundException(detail="Device not found", error_code="device_not_found")

    if device.revoked_at is None:
        device.revoked_at = datetime.now(timezone.utc)
        await db.flush()
        logger.info("设备登出: user=%s device=%s", user_id, device.device_name)

    return {"family_id": device.family_id}
