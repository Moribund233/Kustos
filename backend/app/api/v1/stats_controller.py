"""
仓库统计控制器

处理仓库聚合统计的HTTP请求
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.prefixes import get_route_prefix
from app.models.async_db import get_async_db
from app.services import stats_service
import uuid
from app.api.guards import require_repo_read

router = APIRouter(
    prefix=get_route_prefix("repositories"), tags=["repository-stats"],
    dependencies=[Depends(require_repo_read())],
)


@router.get("/{repo_id}/stats", summary="获取仓库统计")
async def get_repo_stats(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
):
    """获取仓库聚合统计"""
    return await stats_service.get_repo_stats(repo_id, db)