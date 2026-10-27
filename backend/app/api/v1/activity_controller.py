"""审计日志控制器"""
from fastapi import APIRouter, Depends, Query
import uuid
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.prefixes import get_route_prefix
from app.models.async_db import get_async_db
from app.services import activity_service
import uuid
from app.core.permissions import require_repo_read
from app.core.constants import DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE

router = APIRouter(
    prefix=get_route_prefix("repositories"), tags=["activities"],
    dependencies=[Depends(require_repo_read())],
)


@router.get("/{repo_id}/activities", summary="获取仓库审计日志")
async def list_activities(
    repo_id: uuid.UUID,
    entity_type: str = Query(None, description="实体类型过滤"),
    actor_id: uuid.UUID = Query(None, description="操作者过滤"),
    page: int = Query(DEFAULT_PAGE, ge=1),
    limit: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    db: AsyncSession = Depends(get_async_db),
):
    """获取仓库审计日志，支持按实体类型和操作者过滤

    决策：**公开仓匿名可读**维持不变——公开仓内容本就匿名可读，
    活动流属同级信息；私仓由 router 级 ``require_repo_read`` 挡住
    （匿名 401 / 非成员 403）。本端点刻意不挂 ``get_current_user``。
    """
    return await activity_service.list_activities(
        repository_id=repo_id, db=db,
        entity_type=entity_type, actor_id=actor_id,
        page=page, limit=limit,
    )
