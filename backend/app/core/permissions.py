"""
仓库权限策略层（唯一裁决点）

背景问题：40+ 处调用各自手写 ``utils/permission_utils.check_repository_permission``
并**自带角色列表**（``["read"]`` / ``["viewer"]`` 等永不命中的角色、读操作误用默认写级
角色集），同一操作在不同 service 口径不一致 = 漏检型越权。

本模块把「谁在哪个仓库能做什么」收敛为 **(role × action) 矩阵** 单点裁决：

- ``Action``：操作声明（粗层级 + 领域动作，领域动作映射到层级集合）；
- ``ACTION_MATRIX``：action → 允许的角色集合（表驱动，唯一裁决依据）；
- ``has_repo_action`` / ``ensure_repo_action``：布尔裁决 / 无权抛 403 的断言入口；
- ``ensure_author_or_admin``：资源作者或仓库管理员（Issue/PR/评论作者操作）；
- ``require_repo_action``：FastAPI 依赖工厂（controller 声明式使用，路径参数取 repo_id）。

裁决规则（只在本模块实现一次）：
1. 全局 ``User.is_admin`` 旁路；
2. 仓库 ``owner_id`` 匹配 → 视为 owner 角色；
3. 活跃仓库成员角色 ∈ action 允许集合。

角色词汇表以 ``core.constants.VALID_ROLES``（owner/admin/developer/readonly）为准。

注意：全局管理面（admin 控制台的 ``is_debug or is_admin`` 门禁）不属仓库域，
不在本矩阵内。
"""
import enum
from typing import FrozenSet, Optional
from uuid import UUID

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import VALID_ROLES
from app.core.exception import AuthenticationException, AuthorizationException


# ---------------------------------------------------------------------------
# Action 与 (role × action) 矩阵
# ---------------------------------------------------------------------------

class Action(str, enum.Enum):
    """仓库域操作声明（值为 ``域:操作`` 形式，用于错误码与日志）"""

    # 仓库通用层级
    REPO_READ = "repo:read"
    REPO_WRITE = "repo:write"
    REPO_ADMIN = "repo:admin"
    REPO_OWNER = "repo:owner"
    # 成员
    MEMBER_READ = "member:read"
    MEMBER_MANAGE = "member:manage"
    # 标签
    LABEL_MANAGE = "label:manage"
    PRLABEL_MANAGE = "prlabel:manage"
    # 发布 / Webhook
    RELEASE_MANAGE = "release:manage"
    WEBHOOK_READ = "webhook:read"
    WEBHOOK_MANAGE = "webhook:manage"
    # 协作
    COLLAB_READ = "collab:read"
    COLLAB_WRITE = "collab:write"
    COLLAB_MANAGE = "collab:manage"
    INVITE_ISSUE = "invite:issue"
    INVITE_MANAGE = "invite:manage"
    # PR / Fork / 文件评论
    PR_MERGE = "pr:merge"
    FORK_SOURCE_READ = "fork:read"
    FILE_COMMENT_READ = "file-comment:read"
    # 参与型协作（GitHub 式——公开仓登录即可建 issue/PR/评论，
    # 私仓仍需成员身份；见 PUBLIC_PARTICIPATE_ACTIONS）
    ISSUE_CREATE = "issue:create"
    PR_CREATE = "pr:create"
    COMMENT_CREATE = "comment:create"
    # Agent 写工具门禁
    AGENT_WRITE = "agent:write"
    # LFS（预留：读写分离）
    LFS_READ = "lfs:read"
    LFS_WRITE = "lfs:write"


_ALL = frozenset(VALID_ROLES)                                    # owner/admin/developer/readonly
_ROLE_OWNER = "owner"
_ROLE_ADMIN = "admin"
_ROLE_DEVELOPER = "developer"
_ROLE_READONLY = "readonly"
_ROLE_ALIAS_VIEWER = "viewer"  # 历史遗留角色名
_WRITE = frozenset({_ROLE_OWNER, _ROLE_ADMIN, _ROLE_DEVELOPER})
_ADMIN = frozenset({_ROLE_OWNER, _ROLE_ADMIN})
_OWNER = frozenset({_ROLE_OWNER})

#: 历史角色别名：归一后参与矩阵裁决（只在本模块处理一次）
ROLE_ALIASES = {_ROLE_ALIAS_VIEWER: _ROLE_READONLY}

#: 公开仓「参与型」操作（决策拍板）：**公开仓 + 已认证**即可执行，
#: 不要求成员身份；私仓仍按矩阵走成员裁决（_ALL）。调用方均为
#: ``get_current_user`` 之上的守卫（user_id 必非空），匿名在进入裁决前
#: 已被 401 拦截。
PUBLIC_PARTICIPATE_ACTIONS: FrozenSet[Action] = frozenset(
    {Action.ISSUE_CREATE, Action.PR_CREATE, Action.COMMENT_CREATE}
)

#: action → 允许角色集合（唯一裁决依据；新增 action 必须在此登记）
ACTION_MATRIX: dict[Action, FrozenSet[str]] = {
    Action.REPO_READ: _ALL,
    Action.REPO_WRITE: _WRITE,
    Action.REPO_ADMIN: _ADMIN,
    Action.REPO_OWNER: _OWNER,
    Action.MEMBER_READ: _ALL,
    Action.MEMBER_MANAGE: _ADMIN,
    Action.LABEL_MANAGE: _ADMIN,
    Action.PRLABEL_MANAGE: _ADMIN,
    Action.RELEASE_MANAGE: _ADMIN,
    # webhook 含回调地址/密钥等敏感配置，读也按管理级（对齐 GitHub 语义）
    Action.WEBHOOK_READ: _ADMIN,
    Action.WEBHOOK_MANAGE: _ADMIN,
    Action.COLLAB_READ: _ALL,
    Action.COLLAB_WRITE: _WRITE,
    Action.COLLAB_MANAGE: _ADMIN,
    Action.INVITE_ISSUE: _ALL,
    Action.INVITE_MANAGE: _ADMIN,
    Action.PR_MERGE: _WRITE,
    Action.FORK_SOURCE_READ: _ALL,
    Action.FILE_COMMENT_READ: _ALL,
    # 参与型：私仓侧任意活跃成员（_ALL）；公开仓侧见 PUBLIC_PARTICIPATE_ACTIONS
    Action.ISSUE_CREATE: _ALL,
    Action.PR_CREATE: _ALL,
    Action.COMMENT_CREATE: _ALL,
    Action.AGENT_WRITE: _WRITE,
    Action.LFS_READ: _ALL,
    Action.LFS_WRITE: _WRITE,
}


# ---------------------------------------------------------------------------
# 裁决引擎
# ---------------------------------------------------------------------------

async def has_repo_action(
    db: AsyncSession,
    user_id: UUID,
    repository_id: UUID,
    action: Action,
) -> bool:
    """
    布尔裁决：用户在该仓库是否可执行 action

    Args:
        db: 异步数据库会话
        user_id: 操作者用户ID
        repository_id: 仓库ID
        action: 操作声明

    Returns:
        bool: 是否允许
    """
    from app.models.repository import Repository
    from app.models.repository_member import RepositoryMember
    from app.models.user import User

    allowed = ACTION_MATRIX[action]

    # 1. 全局管理员旁路
    result = await db.execute(select(User).filter(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is not None and user.is_admin:
        return True

    result = await db.execute(select(Repository).filter(Repository.id == repository_id))
    repo = result.scalar_one_or_none()
    if repo is None:
        return False

    # 2. 公开仓参与型操作：登录即可（见 PUBLIC_PARTICIPATE_ACTIONS）
    if action in PUBLIC_PARTICIPATE_ACTIONS and repo.is_public:
        return True

    # 3. 仓库所有者 = owner 角色
    if repo.owner_id == user_id and _ROLE_OWNER in allowed:
        return True

    # 4. 活跃成员角色 ∈ 允许集合（历史角色名经 ROLE_ALIASES 归一）
    result = await db.execute(
        select(RepositoryMember).filter(
            RepositoryMember.repository_id == repository_id,
            RepositoryMember.user_id == user_id,
            RepositoryMember.is_active == True,  # noqa: E712
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        return False
    effective_role = ROLE_ALIASES.get(member.role, member.role)
    return effective_role in allowed


async def ensure_repo_action(
    db: AsyncSession,
    user_id: UUID,
    repository_id: UUID,
    action: Action,
    action_description: Optional[str] = None,
) -> None:
    """
    裁决断言：无权时抛 AuthorizationException（403）

    Args:
        action_description: 操作描述（用于错误信息），默认使用 action 值

    Raises:
        AuthorizationException: 无权限时抛出403异常
    """
    if not await has_repo_action(db, user_id, repository_id, action):
        raise AuthorizationException(
            detail=f"You don't have permission to {action_description or action.value}",
            error_code="repository_access_denied",
        )


async def ensure_author_or_admin(
    db: AsyncSession,
    resource_author_id: UUID,
    current_user_id: UUID,
    repository_id: UUID,
    action_description: str = "perform this action",
) -> None:
    """
    资源作者或仓库管理员（owner/admin）可操作（Issue/PR/文件评论作者域）

    Args:
        resource_author_id: 资源作者ID
        current_user_id: 当前用户ID
        repository_id: 仓库ID
        action_description: 操作描述，用于错误信息

    Raises:
        AuthorizationException: 无权限时抛出403异常
    """
    if resource_author_id == current_user_id:
        return
    if not await has_repo_action(db, current_user_id, repository_id, Action.REPO_ADMIN):
        raise AuthorizationException(
            detail=f"You don't have permission to {action_description}",
            error_code="author_or_admin_only",
        )


# ---------------------------------------------------------------------------
# 读可见性（私仓读泄露收口）
# ---------------------------------------------------------------------------

async def ensure_repo_read(
    db: AsyncSession,
    repository_id: UUID,
    user_id: Optional[UUID],
) -> None:
    """
    读可见性裁决：公开仓任何人（含匿名）可读；私仓需 REPO_READ。

    - 仓库不存在 → ``NotFoundException``（404，**先于**可见性判断，
      与各读端点既有「缺仓 404」语义一致）；
    - 公开仓 → 放行（匿名 OK，与 ``test_*_no_auth`` 断言的
      「公开仓库浏览不需要登录」口径一致）；
    - 私仓 + 匿名 → 401（提示认证，带 ``WWW-Authenticate``）；
    - 私仓 + 已认证非成员 → 403（``has_repo_action(REPO_READ)`` 裁决，
      含全局 admin 旁路与 owner 判定）。

    Args:
        db: 异步数据库会话
        repository_id: 仓库ID
        user_id: 当前用户ID（匿名传 ``None``）
    """
    from app.models.repository import Repository

    result = await db.execute(
        select(Repository).filter(Repository.id == repository_id)
    )
    repo = result.scalar_one_or_none()
    if repo is None:
        from app.core.exception import NotFoundException
        raise NotFoundException(
            detail="Repository not found", error_code="repository_not_found"
        )

    if repo.is_public:
        return

    if user_id is None:
        raise AuthenticationException(
            detail="Authentication required",
            error_code="auth_required",
        )

    await ensure_repo_action(db, user_id, repository_id, Action.REPO_READ,
                             action_description="view this repository")


# ---------------------------------------------------------------------------
# FastAPI 依赖工厂（controller 声明式使用）
# ---------------------------------------------------------------------------

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
            from app.core.exception import NotFoundException
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
