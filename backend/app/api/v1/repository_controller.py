"""
仓库控制器层

处理与仓库相关的HTTP请求，调用服务层方法并返回响应
"""
from fastapi import APIRouter, Depends, Path, Request, status
from fastapi.security import HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession
import uuid

from app.api.prefixes import get_route_prefix
from app.models.async_db import get_async_db
from app.models.user import User
from app.api.deps import get_current_user, get_current_admin_user
from app.core.permissions import Action, ensure_repo_action
from app.api.guards import require_repo_read
from app.core.exception import AuthorizationException, HttpStatusException

from app.services.repository.repository_service import (
    get_repositories as service_get_repositories,
    get_repository_by_id as service_get_repository_by_id,
    get_repository_by_path as service_get_repository_by_path,
    get_repositories_by_user as service_get_repositories_by_user,
    create_repository as service_create_repository,
    update_repository as service_update_repository,
    delete_repository as service_delete_repository,
    get_public_repositories as service_get_public_repositories,
    check_repository_access as service_check_repository_access,
    archive_repository as service_archive_repository,
    unarchive_repository as service_unarchive_repository,
)

# 创建路由实例
router = APIRouter(
    prefix=get_route_prefix("repositories"), tags=["repositories"],
    dependencies=[Depends(require_repo_read())],
)

# 安全方案
security = HTTPBearer(auto_error=False)


@router.get("", summary="获取所有仓库")
async def get_repositories(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    获取所有仓库（需要认证）

    Args:
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        list[Repository]: 仓库列表
    """
    return await service_get_repositories(
        db,
        # 可见性 scope（admin 不过滤；内部调用不传则保持旧行为）
        viewer_id=current_user.id,
        viewer_is_admin=current_user.is_admin,
    )


@router.get("/public")
async def get_public_repositories(db: AsyncSession = Depends(get_async_db)):
    """
    获取所有公开仓库

    Args:
        db: 数据库会话

    Returns:
        list[Repository]: 公开仓库列表
    """
    return await service_get_public_repositories(db)


@router.get("/user/{user_id}")
async def get_repositories_by_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    根据用户ID获取仓库列表（需要认证）

    Args:
        user_id: 用户ID
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        list[Repository]: 用户的仓库列表
    """
    return await service_get_repositories_by_user(
        user_id,
        db,
        viewer_id=current_user.id,
        viewer_is_admin=current_user.is_admin,
    )


@router.get("/{repo_id}")
async def get_repository(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    根据ID获取仓库（需要认证）

    Args:
        repo_id: 仓库ID
        db: 异步数据库会话
        current_user: 当前认证用户

    Returns:
        Repository: 仓库信息

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
    """
    return await service_get_repository_by_id(repo_id, db)


@router.post("", summary="创建新仓库")
async def create_repository(
    request: Request,
    repo: dict,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    创建新仓库（需要认证）

    路径自动生成，格式为: {username}/{repo_name}
    符合 Git HTTP 标准 URL 格式

    Args:
        request: HTTP请求对象（用于速率限制）
        repo: 仓库信息（包含 name, description, is_public, default_branch 等）
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        Repository: 创建的仓库信息

    Raises:
        ValidationException: 请求参数不完整时抛出422异常
        ConflictException: 仓库路径已存在时抛出409异常
    """
    # 验证必要参数
    if "name" not in repo:
        # 保持既有 422 状态码（与 FastAPI 体校验一致），仅补齐 error_code
        raise HttpStatusException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Repository name is required",
            error_code="repository_name_required",
        )

    # 设置当前用户为仓库所有者
    repo["owner_id"] = current_user.id

    # 自动生成路径，格式: {username}/{repo_name}
    # 这是 Git HTTP 标准 URL 格式，如: admin/test-repo
    repo["path"] = f"{current_user.username}/{repo['name']}"

    return await service_create_repository(repo, db)


@router.put("/{repo_id}")
async def update_repository(
    request: Request,
    repo_id: uuid.UUID,
    repo: dict,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    更新仓库信息（需要认证）

    Args:
        request: HTTP请求对象（用于速率限制）
        repo_id: 仓库ID
        repo: 更新的仓库信息
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        Repository: 更新后的仓库信息

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
        AuthorizationException: 无权限时抛出403异常
    """
    # 使用工具函数检查权限（需要所有者或管理员权限）
    await ensure_repo_action(db, current_user.id, repo_id, Action.REPO_ADMIN, "update this repository")
    return await service_update_repository(repo_id, repo, db)


@router.delete("/{repo_id}")
async def delete_repository(
    request: Request,
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    删除仓库（需要认证）

    Args:
        request: HTTP请求对象（用于速率限制）
        repo_id: 仓库ID
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 删除成功消息

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
        AuthorizationException: 无权限时抛出403异常
    """
    # 使用工具函数检查权限（只有所有者可以删除）
    await ensure_repo_action(db, current_user.id, repo_id, Action.REPO_OWNER, "delete this repository")
    return await service_delete_repository(repo_id, db)


@router.get("/{repo_id}/access")
async def check_repository_access(
    repo_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    检查用户对仓库的访问权限（需要认证）

    Args:
        repo_id: 仓库ID
        user_id: 用户ID
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 访问权限信息

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
    """
    has_access = await service_check_repository_access(repo_id, user_id, db)
    return {"has_access": has_access}


@router.post("/{repo_id}/archive", summary="归档仓库")
async def archive_repository(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    归档仓库（需要认证）

    Args:
        repo_id: 仓库ID
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        Repository: 归档后的仓库信息

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
        AuthorizationException: 无权限时抛出403异常
    """
    await ensure_repo_action(db, current_user.id, repo_id, Action.REPO_ADMIN, "archive this repository")
    return await service_archive_repository(repo_id, db)


@router.post("/{repo_id}/unarchive", summary="取消归档仓库")
async def unarchive_repository(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    取消归档仓库（需要认证）

    Args:
        repo_id: 仓库ID
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        Repository: 取消归档后的仓库信息

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
        AuthorizationException: 无权限时抛出403异常
    """
    await ensure_repo_action(db, current_user.id, repo_id, Action.REPO_ADMIN, "unarchive this repository")
    return await service_unarchive_repository(repo_id, db)


# ---------------------------------------------------------------------------
# slug 解析路由：固定前缀 /api/v1/repo/{owner}/{repo}（根治 + 统一）
# ---------------------------------------------------------------------------
# 历史上本路由是主 router 下的 `/{owner}/{repo}` 两段通配，与 `/{repo_id}/access`
# 形状相同（先注册者胜出，曾把 /access 整个遮蔽）——「顺序 + 回归测试」只是压制、
# 不是根治。把它搬出 `/api/v1/repositories` 命名空间、给固定段 `repo`：
# 段数与字面量双重区分，该命名空间下不再存在相邻双通配路由，结构上不可能再发生
# 类遮蔽（结构断言见 tests/test_route_order_guard.py）。
#
# 口径：UUID `{repo_id}` 是 API 唯一寻址；slug 仅作为**导航别名解析器**
# （前端 SPA URL ↔ repo_id 的一次性解析入口），不再构成第二套资源寻址。

path_router = APIRouter(prefix="/api/v1/repo", tags=["repositories"])


@path_router.get("/{owner}/{repo}")
async def get_repository_by_path(
    owner: str,
    repo: str,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    根据 owner/repo 路径获取仓库（需要认证）

    Args:
        owner: 仓库所有者用户名
        repo: 仓库名称
        db: 异步数据库会话
        current_user: 当前认证用户

    Returns:
        Repository: 仓库信息

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
        AuthorizationException: 无权限访问私有仓库时抛出403异常
    """
    repository = await service_get_repository_by_path(owner, repo, db)
    has_access = await service_check_repository_access(repository["id"], current_user.id, db)
    if not has_access:
        raise AuthorizationException(detail="You do not have access to this repository", error_code="repository_access_denied")
    return repository
