"""API 层 FastAPI 守卫（依赖工厂）

把「角色 × 操作」的裁决留给 :mod:`app.core.permissions`——那里是唯一的
策略来源。本模块只做 FastAPI 侧的接线：把路径参数、认证依赖和数据库
会话组装成 ``Depends`` 可用的可调用对象。

同时承载 ``/api/app/*`` 的管理面权限依赖（读 / 危险操作两档），供
``app_controller`` 与各管理面子控制器共用——控制器之间不互相 import。

放在 ``api`` 而非 ``core``：这些工厂要引用 ``api.deps`` 的认证依赖，而
``core`` 位于 ``api`` 之下，反向导入会形成跨层环。
"""
import socket
from typing import Optional
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import get_config
from app.core.exception import (
    AuthenticationException,
    AuthorizationException,
    NotFoundException,
)
from app.core.permissions import (
    Action,
    ensure_repo_action,
    ensure_repo_read,
)
from app.models.user import User


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


# ============== 应用管理权限（/api/app/*） ==============


def check_app_permission(
    current_user: User = Depends(get_current_user),
) -> tuple[bool, bool]:
    """
    检查应用管理权限（仅 JWT 管理员可访问）

    Args:
        current_user: 当前认证用户

    Returns:
        tuple[bool, bool]: (是否调试模式, 是否管理员)

    Raises:
        AuthorizationException: 权限不足
    """
    config = get_config()
    is_debug = config.app.debug
    is_admin = current_user.is_admin

    if not is_debug and not is_admin:
        raise AuthorizationException(
            detail="该操作需要管理员权限或调试模式",
            error_code="app_admin_or_debug_required",
        )

    return is_debug, is_admin


def _is_trusted_proxy(peer_host: str) -> bool:
    """直连 peer 是否为可信代理：本机回环，或网关容器（按 compose 服务名解析）。

    网关（nginx）对每个请求用 ``$remote_addr`` **覆写** ``X-Real-IP``，该头
    只有在直连 peer 是网关时才可信；同 docker 网络内其它容器可伪造
    ``X-Real-IP=127.0.0.1`` 冒充本机来源，绕过 debug 模式的本机限制。
    网关不可解析（单容器部署/测试）时仅回环可信。
    """
    if peer_host in ("localhost", "::1") or peer_host.startswith("127."):
        return True
    try:
        gateway_ip = socket.gethostbyname("gateway")
    except OSError:
        return False
    return peer_host == gateway_ip


def _client_ip(request: Request) -> str:
    """取客户端 IP。

    仅在直连 peer 为可信代理（回环/网关）时采用 ``X-Real-IP``——网关用
    ``$remote_addr`` **覆写**该头，不像 ``X-Forwarded-For`` 会被客户端伪造
    首段再被网关追加，因此经可信代理后仍可信；
    直连（dev/测试/不可信 peer）一律退回 ASGI 的 client host。
    """
    if not request.client:
        return ""
    peer = (request.client.host or "").strip()
    xrip = (request.headers.get("x-real-ip") or "").strip()
    if xrip and _is_trusted_proxy(peer):
        return xrip
    return peer


def _is_loopback(request: Request) -> bool:
    """请求是否来自本机（127.0.0.0/8 / ::1 / localhost）"""
    ip = _client_ip(request)
    if not ip:
        return False
    return ip == "localhost" or ip == "::1" or ip.startswith("127.")


def check_app_danger_permission(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> tuple[bool, bool]:
    """
    危险操作权限：重启 / 关闭 / 配置写回 / 日志清理

    管理员恒放行；``KUSTOS_APP_DEBUG=true`` **只对来自本机的请求**放宽。
    原实现是「debug 或 admin」——一次 ``debug=true`` 误配，就等于把重启、
    配置写回交给任意已登录用户。

    读操作（GET config/status/logs/components…）仍用 ``check_app_permission``。

    Args:
        request: 当前请求（用于判定来源是否本机）
        current_user: 当前认证用户

    Returns:
        tuple[bool, bool]: (是否调试模式, 是否管理员)，供服务层二次校验

    Raises:
        AuthorizationException: 权限不足（403）
    """
    is_debug = get_config().app.debug
    is_admin = current_user.is_admin

    if is_admin:
        return is_debug, True
    if is_debug and _is_loopback(request):
        return True, False

    raise AuthorizationException(
        detail="该操作需要管理员权限（调试模式下仅对本机来源开放）",
        error_code="app_admin_required",
    )
