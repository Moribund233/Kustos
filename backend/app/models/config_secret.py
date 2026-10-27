"""配置密钥表：API key **密文**存储（明文永不落库、永不回显）。

 ``(section, name)`` 唯一一行；``ciphertext`` 为 ``utils/config_crypto`` 产出的
``enc:v1:...`` 密文（AES-GCM + AAD 绑定节/字段名）。运行期由
``services/config_store.get_secret`` 解密读取（进程内 5s TTL 缓存），
写入与 ``app_config`` 的行版本 CAS 在**同一事务**内完成
（``config_store.update_sections(secrets=...)``）。

与 ``app_config.payload`` 分表的原因：配置读路径（``ConfigManager``/各 GET
端点）**完全不经过本表**，从结构上杜绝「密钥被 model_dump 顺带回显」。
"""
from sqlalchemy import ForeignKey, String, Text, UniqueConstraint, Uuid as SAUuid
from sqlalchemy.orm import mapped_column

from app.models.base import BaseModel


class ConfigSecret(BaseModel):
    """单个配置密钥的密文行"""

    __tablename__ = "config_secrets"

    section = mapped_column(String(64), nullable=False)
    """所属配置节（``agent`` / ``search``）——同时是解密 AAD 的一部分"""

    name = mapped_column(String(64), nullable=False)
    """密钥字段名（``api_key`` / ``embedding_api_key``）——同上"""

    ciphertext = mapped_column(Text, nullable=False)
    """``enc:v1:...`` 密文（AES-256-GCM）"""

    updated_by = mapped_column(SAUuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    """最后写入者（审计归属）"""

    __table_args__ = (
        UniqueConstraint("section", "name", name="uq_config_secrets_section_name"),
    )
