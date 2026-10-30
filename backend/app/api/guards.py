"""仓库域 FastAPI 守卫（依赖工厂）

把「角色 × 操作」的裁决留给 :mod:`app.core.permissions`——那里是唯一的
策略来源。本模块只做 FastAPI 侧的接线：把路径参数、认证依赖和数据库
会话组装成 ``Depends`` 可用的可调用对象。

放在 ``api`` 而非 ``core``：这些工厂要引用 ``api.deps`` 的认证依赖，而
``core`` 位于 ``api`` 之下，反向导入会形成跨层环。
"""
from typing import Optional
from uuid import UUID

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exception import AuthenticationException, NotFoundException
from app.core.permissions import (
    Action,
    ensure_repo_action,
    ensure_repo_read,
)


def require_repo_read():
    """
    依赖工厂：仓库**读可见性**（公开放行 / 私仓成员），挂 router 级。

    用法（router 级，一条覆盖全控制器）::

        router = APIRouter(
            prefix=...,
            dependencies=[Depends(require_repo_read())],
        )

    特性：
    - 从 ``request.path_params`` 读 ``repo_id``（不声明为依赖参数，避免与
      同名查询参数串扰）：路径无 ``{repo_id}`` 的路由自动跳过——混合路由器
      可安全挂载；值非 UUID 时放行（端点自身的 UUID 参数会报 422）；
    - 匿名放行交由 :func:`ensure_repo_read` 按公开/私仓裁决，
      这里用 ``get_optional_user``（无头→``None``，坏 token→401）。
    """
    from fastapi import Request

    from app.api.deps import get_optional_user
    from app.models.async_db import get_async_db

    async def _dependency(
        request: Request,
        db: AsyncSession = Depends(get_async_db),
        current_user=Depends(get_optional_user),
    ) -> None:
        raw = request.path_params.get("repo_id")
        if not raw:
            return  # 该路由不含仓库域路径参数，跳过
        try:
            repo_id = UUID(str(raw))
        except (ValueError, AttributeError, TypeError):
            return  # 非 UUID 段：交给端点自身的参数校验报 422
        await ensure_repo_read(
            db, repo_id, current_user.id if current_user is not None else None
        )

    return _dependency


def require_repo_permission(
    action: Action, action_description: Optional[str] = None
):
    """
    依赖工厂：写操作权限，**缺仓先 404**（404 → 401 → 403 顺序）。

    顺序与 :func:`require_repo_read` 同构——缺仓 404 **先于**鉴权：

    - 缺仓 → 404（匿名也 404，单独使用无外层读守卫兜底时不泄露
      仓库存在性）；
    - 无凭据 → 401（``auth_required``，带 ``WWW-Authenticate``）；
      坏 token → 401（``get_optional_user`` 依赖层先抛）；
    - 无权 → 403（``ensure_repo_action`` 矩阵裁决）。

    与既有 :func:`require_repo_action` 的差别仅在缺仓语义：本工厂先查
    仓库存在性再裁决权限（缺仓 404），``require_repo_action`` 对缺仓直接
    403。

    用法::

        @router.put("/{repo_id}/contents/{file_path:path}")
        async def update_repository_file(
            _=Depends(require_repo_permission(Action.REPO_WRITE, "write files")),
        ): ...
    """
    from app.api.deps import get_optional_user
    from app.models.async_db import get_async_db

    async def _dependency(
        repo_id: UUID,
        db: AsyncSession = Depends(get_async_db),
        current_user=Depends(get_optional_user),
    ) -> None:
        from app.models.repository import Repository

        result = await db.execute(
            select(Repository).filter(Repository.id == repo_id)
        )
        if result.scalar_one_or_none() is None:
            raise NotFoundException(
                detail="Repository not found", error_code="repository_not_found"
            )
        if current_user is None:
            raise AuthenticationException(
                detail="Authentication required",
                error_code="auth_required",
            )
        await ensure_repo_action(
            db, current_user.id, repo_id, action,
            action_description=action_description,
        )

    return _dependency


def require_repo_action(action: Action, action_description: Optional[str] = None):
    """
    依赖工厂：校验路径参数中的 repo_id 对当前用户的 action 权限

    用法::

        @router.get("/{repo_id}/webhooks")
        async def list_webhooks(
            _=Depends(require_repo_action(Action.WEBHOOK_READ, "view webhooks")),
        ): ...

    依赖声明 ``repo_id: uuid.UUID`` 由 FastAPI 从路径参数解析注入；
    未认证由 get_current_user 兜底（401）。
    """
    from app.api.deps import get_current_user
    from app.models.async_db import get_async_db

    async def _dependency(
        repo_id: UUID,
        db: AsyncSession = Depends(get_async_db),
        current_user=Depends(get_current_user),
    ) -> None:
        await ensure_repo_action(
            db, current_user.id, repo_id, action,
            action_description=action_description,
        )

    return _dependency
