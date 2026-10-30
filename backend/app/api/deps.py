"""
API 依赖模块

提供可复用的 FastAPI 依赖函数，如认证、权限检查等
"""
from fastapi import Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.exception import AuthenticationException, AuthorizationException
from app.models.async_db import get_async_db
from app.models.user import User
from app.services.auth.token_service import verify_token_active

# 使用 HTTPBearer 从 Authorization 头中提取 token
security = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_async_db)
) -> User:
    """
    获取当前认证用户（JWT 认证）

    Args:
        request: FastAPI 请求对象
        credentials: HTTP 认证凭证
        db: 数据库会话

    Returns:
        User: 当前认证用户对象

    Raises:
        HTTPException: 认证失败时抛出 401 异常
    """
    if not credentials:
        raise AuthenticationException(
            detail="Authentication required",
            error_code="auth_required",
        )

    token = credentials.credentials
    token_data = await verify_token_active(token, token_type="access")

    if token_data is None:
        raise AuthenticationException(
            detail="Invalid or expired token",
            error_code="invalid_token",
        )

    result = await db.execute(select(User).filter(User.id == token_data.user_id))
    user = result.scalar_one_or_none()

    if user is None:
        raise AuthenticationException(
            detail="User not found",
            error_code="user_not_found",
        )

    if not user.is_active:
        raise AuthenticationException(
            detail="User is inactive",
            error_code="user_inactive",
        )

    return user


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_async_db)
) -> User | None:
    """
    获取当前认证用户（可匿名）——读可见性守卫用

    与 :func:`get_current_user` 的差别：
    - 无 Authorization 头 → 返回 ``None``（匿名访问者，由调用方按公开/私仓裁决）；
    - 有头但无效/过期 → 401（用户明确尝试认证却失败，不应静默降级为匿名，
      否则带坏 token 的私仓请求会得到语义错误的 403 而非 401）。
    """
    if not credentials:
        return None

    token = credentials.credentials
    token_data = await verify_token_active(token, token_type="access")
    if token_data is None:
        raise AuthenticationException(
            detail="Invalid or expired token",
            error_code="invalid_token",
        )

    result = await db.execute(select(User).filter(User.id == token_data.user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise AuthenticationException(
            detail="User not found",
            error_code="user_not_found",
        )
    if not user.is_active:
        raise AuthenticationException(
            detail="User is inactive",
            error_code="user_inactive",
        )
    return user


async def get_current_admin_user(
    current_user: User = Depends(get_current_user)
) -> User:
    """
    获取当前管理员用户

    Args:
        current_user: 当前认证用户

    Returns:
        User: 当前管理员用户对象

    Raises:
        HTTPException: 用户不是管理员时抛出 403 异常
    """
    if not current_user.is_admin:
        raise AuthorizationException(
            detail="Admin privileges required",
            error_code="admin_required",
        )
    return current_user
