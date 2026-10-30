from sqlalchemy import DateTime
from sqlalchemy.orm import mapped_column
from sqlalchemy import Uuid as SAUuid
from sqlalchemy.sql import func
from app.models import Base
from app.models.uuid7 import generate_uuid7


class TimestampMixin(Base):
    """统一的主键 + 创建/更新时间戳基类。

    命名说明：历史上这里曾导出别名 ``BaseModel``，与 pydantic 的
    ``BaseModel`` 同名，极易混淆；现统一使用 ``TimestampMixin``。
    """

    __abstract__ = True

    id = mapped_column(
        SAUuid(as_uuid=True),
        primary_key=True,
        index=True,
        default=generate_uuid7,
    )

    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())

    updated_at = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
