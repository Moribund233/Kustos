"""
提交控制器层

处理与提交相关的HTTP请求，调用服务层方法并返回响应
"""
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.prefixes import get_route_prefix
from app.models.async_db import get_async_db
from app.models.user import User
from app.api.deps import get_current_user
from app.services.commit_service import (
    get_commits_by_branch as service_get_commits_by_branch,
    get_commit_by_hash as service_get_commit_by_hash,
    create_commit as service_create_commit,
    get_commit_history as service_get_commit_history,
    count_repo_commits as service_count_repo_commits,
    count_branch_commits as service_count_branch_commits,
    get_latest_commit as service_get_latest_commit,
    get_latest_commit_by_branch as service_get_latest_commit_by_branch,
    search_commits as service_search_commits,
    get_commits_by_author as service_get_commits_by_author
)
from app.services.branch_service import get_branch as service_get_branch
from app.core.permissions import Action, require_repo_read, require_repo_permission
from app.core.constants import (
    DEFAULT_PAGE_SIZE_LARGE,
    MAX_PAGE_SIZE,
    DEFAULT_PAGE_SIZE_MAX,
    MAX_PAGE_SIZE_MAX,
)
import uuid

# 创建路由实例
# router 级读可见性（提交历史/作者/搜索此前完全匿名可达）
router = APIRouter(
    prefix=get_route_prefix("commits"),
    tags=["commits"],
    dependencies=[Depends(require_repo_read())],
)


@router.get("/{repo_id}/commits/history")
async def get_commit_history(
    repo_id: uuid.UUID,
    branch_name: str | None = None,
    limit: int = Query(DEFAULT_PAGE_SIZE_LARGE, ge=1, le=MAX_PAGE_SIZE),
    db: AsyncSession = Depends(get_async_db)
):
    """
    获取仓库的提交历史树
    
    Args:
        repo_id: 仓库ID
        branch_name: 分支名称（可选，默认获取所有分支）
        limit: 返回记录数量限制（默认50，最大100）
        db: 数据库会话
    
    Returns:
        list[Commit]: 提交历史列表
    """
    return await service_get_commit_history(repo_id, db, branch_name, limit)


@router.get("/{repo_id}/commits/count")
async def count_repo_commits(repo_id: uuid.UUID, db: AsyncSession = Depends(get_async_db)):
    """
    统计仓库的提交数量
    
    Args:
        repo_id: 仓库ID
        db: 数据库会话
    
    Returns:
        dict: 提交数量统计
    """
    count = await service_count_repo_commits(repo_id, db)
    return {"count": count}


@router.get("/{repo_id}/commits/search")
async def search_commits(
    repo_id: uuid.UUID,
    query: str = Query(..., min_length=1),
    limit: int = Query(DEFAULT_PAGE_SIZE_LARGE, ge=1, le=MAX_PAGE_SIZE),
    db: AsyncSession = Depends(get_async_db)
):
    """
    搜索提交记录
    
    Args:
        repo_id: 仓库ID
        query: 搜索关键词
        limit: 返回记录数量限制（默认50，最大100）
        db: 数据库会话
    
    Returns:
        list[Commit]: 匹配的提交记录列表
    """
    return await service_search_commits(repo_id, query, db, limit)


@router.get("/{repo_id}/commits/author")
async def get_commits_by_author(
    repo_id: uuid.UUID,
    author_email: str = Query(..., description="作者邮箱"),
    limit: int = Query(DEFAULT_PAGE_SIZE_LARGE, ge=1, le=MAX_PAGE_SIZE),
    db: AsyncSession = Depends(get_async_db)
):
    """
    根据作者邮箱获取提交记录
    
    Args:
        repo_id: 仓库ID
        author_email: 作者邮箱
        limit: 返回记录数量限制（默认50，最大100）
        db: 数据库会话
    
    Returns:
        list[Commit]: 提交记录列表
    """
    return await service_get_commits_by_author(repo_id, author_email, db, limit)


@router.get("/{repo_id}/commits/latest")
async def get_latest_commit(repo_id: uuid.UUID, branch_name: str | None = None, db: AsyncSession = Depends(get_async_db)):
    """
    获取仓库的最新提交
    
    Args:
        repo_id: 仓库ID
        branch_name: 分支名称（可选，默认获取所有分支的最新提交）
        db: 数据库会话
    
    Returns:
        Commit: 最新提交记录
    
    Raises:
        NotFoundException: 没有提交记录时抛出404异常
    """
    if branch_name:
        branch = await service_get_branch(repo_id, branch_name, db)
        return await service_get_latest_commit_by_branch(branch.id, db)
    else:
        return await service_get_latest_commit(repo_id, db)


@router.get("/{repo_id}/commits/{commit_hash}")
async def get_commit_by_hash(repo_id: uuid.UUID, commit_hash: str, db: AsyncSession = Depends(get_async_db)):
    """
    根据提交哈希获取提交详情
    
    Args:
        repo_id: 仓库ID
        commit_hash: 提交哈希值
        db: 数据库会话
    
    Returns:
        Commit: 提交详情
    
    Raises:
        NotFoundException: 提交不存在时抛出404异常
    """
    return await service_get_commit_by_hash(repo_id, commit_hash, db)


@router.post("/{repo_id}/commits")
async def create_commit(
    request: Request,
    repo_id: uuid.UUID,
    commit_data: dict,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
    _perm: None = Depends(require_repo_permission(Action.REPO_WRITE, "create commits")),
):
    """
    创建提交记录（需要认证 + 仓库写权限）

    Args:
        request: HTTP请求对象（用于速率限制）
        repo_id: 仓库ID
        commit_data: 提交信息
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        Commit: 创建的提交记录

    Raises:
        ValidationException: 请求参数不完整时抛出422异常
        ConflictException: 提交哈希已存在时抛出409异常
        NotFoundException: 分支不存在时抛出404异常
    """
    # 确保仓库ID匹配
    commit_data["repository_id"] = repo_id

    # branch_id 必须属于本仓库（否则可经此把提交行挂到任意仓库的分支上）
    branch_id = commit_data.get("branch_id")
    if branch_id is not None:
        from app.models.branch import Branch
        from sqlalchemy import select as sa_select
        from app.core.exception import NotFoundException
        branch = (
            await db.execute(sa_select(Branch).filter(
                Branch.id == branch_id,
                Branch.repository_id == repo_id,
            ))
        ).scalar_one_or_none()
        if branch is None:
            raise NotFoundException(detail="Branch not found", error_code="branch_not_found")
    return await service_create_commit(commit_data, db)


@router.get("/{repo_id}/branches/{branch_name}/commits")
async def get_branch_commits(
    repo_id: uuid.UUID,
    branch_name: str,
    limit: int = Query(DEFAULT_PAGE_SIZE_MAX, ge=1, le=MAX_PAGE_SIZE_MAX),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_async_db)
):
    """
    获取特定分支的提交记录
    
    Args:
        repo_id: 仓库ID
        branch_name: 分支名称
        limit: 返回记录数量限制（默认100，最大1000）
        offset: 记录偏移量（默认0）
        db: 数据库会话
    
    Returns:
        list[Commit]: 提交记录列表
    
    Raises:
        NotFoundException: 分支不存在时抛出404异常
    """
    branch = await service_get_branch(repo_id, branch_name, db)
    return await service_get_commits_by_branch(branch.id, db, limit, offset)


@router.get("/{repo_id}/branches/{branch_name}/commits/count")
async def count_branch_commits(repo_id: uuid.UUID, branch_name: str, db: AsyncSession = Depends(get_async_db)):
    """
    统计特定分支的提交数量
    
    Args:
        repo_id: 仓库ID
        branch_name: 分支名称
        db: 数据库会话
    
    Returns:
        dict: 提交数量统计
    
    Raises:
        NotFoundException: 分支不存在时抛出404异常
    """
    branch = await service_get_branch(repo_id, branch_name, db)
    count = await service_count_branch_commits(branch.id, db)
    return {"count": count}
