"""数据库配置表模型（按节存储运行期配置）。

**按节一行 JSON**：与 ``config_service`` 按节提交的语义一致——读取按节拉、
写入整节覆盖，避免逐键行的写放大；``version`` 供跨进程对账与乐观锁。

``payload`` 只存**引导层之外**的键：``database`` 连接参数（读表前必须先有连接，
鸡生蛋）与 ``security.secret_key``（拖库即可伪造 token）永不入表，排除清单见
``services/config_store.py``。
"""
from sqlalchemy import JSON, Integer, String, ForeignKey, UniqueConstraint, Uuid as SAUuid
from sqlalchemy.orm import mapped_column

from app.models.base import BaseModel


class AppConfig(BaseModel):
    """单行一节的运行态配置"""
    __tablename__ = "app_config"

    section = mapped_column(String(64), nullable=False)
    #: 该节的可覆盖键（引导层键已剔除）
    payload = mapped_column(JSON, nullable=False, default=dict)
    version = mapped_column(Integer, nullable=False, default=1)
    updated_by = mapped_column(SAUuid(as_uuid=True), ForeignKey("users.id"), nullable=True)

    __table_args__ = (
        UniqueConstraint("section", name="uq_app_config_section"),
    )
