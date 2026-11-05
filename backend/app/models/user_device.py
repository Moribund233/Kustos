from sqlalchemy import DateTime, ForeignKey, Index, String, Uuid as SAUuid
from sqlalchemy.orm import mapped_column

from app.models.base import TimestampMixin


class UserDevice(TimestampMixin):
    """登录设备登记 - 用户可见、可定向吊销的登录来源

    设备维度是 ``refresh`` 家族的吊销单元：一次登录签到一条记录，
    后续每次刷新沿 family 找回同一条并刷新 ``last_seen_at``。
    同用户同 ``device_id`` 再次登录覆盖既有记录，避免同名设备堆叠。
    """

    __tablename__ = "user_devices"

    user_id = mapped_column(
        SAUuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    """所属用户 ID"""

    device_id = mapped_column(String(64), nullable=False)
    """客户端持久化的设备标识（桌面端生成一次并长期复用）"""

    device_name = mapped_column(String(128), nullable=False)
    """用户可辨认的设备名，如 ``Kustos Desktop (macOS)``"""

    platform = mapped_column(String(32), nullable=True)
    """客户端平台标识，桌面端传 ``desktop``，Web 端留空"""

    family_id = mapped_column(String(64), nullable=False)
    """当前登录会话的 refresh 家族 ID；该设备被定向吊销时按此吊销"""

    last_ip = mapped_column(String(64), nullable=True)
    """最近一次登录/刷新的来源 IP"""

    last_seen_at = mapped_column(DateTime(timezone=True), nullable=True)
    """最近一次刷新时刻（会话存活证据；吊销后不再更新）"""

    revoked_at = mapped_column(DateTime(timezone=True), nullable=True)
    """本设备被吊销的时刻；非空即视为已登出"""

    __table_args__ = (
        Index("uq_user_devices_device", "user_id", "device_id", unique=True),
        Index("ix_user_devices_family", "family_id"),
    )

    def __repr__(self) -> str:
        return f"<UserDevice(user_id={self.user_id}, device={self.device_name})>"
