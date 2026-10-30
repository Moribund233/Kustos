"""
Watch(关注) 控制器层

处理仓库 Watch 相关的 HTTP 请求
"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.prefixes import get_route_prefix
from app.models.async_db import get_async_db
from app.models.repository import Repository
from app.models.user import User
from app.api.deps import get_current_user
from app.services.repository import watch_service
from app.core.exception import NotFoundException
from app.core.permissions import Action, ensure_repo_action
import uuid
from app.api.guards import require_repo_read

router = APIRouter(
    prefix=get_route_prefix("repositories"), tags=["watches"],
    dependencies=[Depends(require_repo_read())],
)


@router.post("/{repo_id}/watch", status_code=201)
async def watch_repository(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    关注仓库

    Args:
        repo_id: 仓库ID
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 关注操作结果
    """
    return await watch_service.watch_repository(repo_id, current_user.id, db)


@router.delete("/{repo_id}/watch")
async def unwatch_repository(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    取消关注仓库

    Args:
        repo_id: 仓库ID
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 取消关注操作结果
    """
    return await watch_service.unwatch_repository(repo_id, current_user.id, db)


@router.get("/{repo_id}/watch")
async def get_watch_status(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    获取当前用户对仓库的关注状态

    Args:
        repo_id: 仓库ID
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 关注状态和数量
    """
    return await watch_service.get_watch_status(repo_id, current_user.id, db)


@router.get("/{repo_id}/watchers")
async def get_watchers(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    获取仓库的 Watcher 列表

    Args:
        repo_id: 仓库ID
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        list: Watcher 列表
    """
    result = await db.execute(select(Repository).filter(Repository.id == repo_id))
    repo = result.scalar_one_or_none()
    if not repo:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")
    if not repo.is_public:
        await ensure_repo_action(db, current_user.id, repo_id, Action.REPO_READ, "view watchers")
    return await watch_service.get_watchers(repo_id, db)
