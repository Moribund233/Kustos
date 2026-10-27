"""
权限矩阵测试（权限收口）

覆盖：
- 矩阵完整性：每个 Action 都有矩阵条目、角色均在 VALID_ROLES 内；
- (role × action) 全组合**自动生成**允许/拒绝用例（非仓库所有者的成员主体）；
- 裁决旁路：全局 is_admin、仓库所有者、非成员、已停用成员；
- ensure_repo_action / ensure_author_or_admin 的 403 语义；
- 防回潮 AST 断言：services/controller 不得直接引用 utils.permission_utils。
"""
import ast
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import VALID_ROLES
from app.core.exception import AuthorizationException
from app.core.permissions import (
    ACTION_MATRIX,
    Action,
    ensure_author_or_admin,
    ensure_repo_action,
    has_repo_action,
)
from app.models import Repository
from app.models.repository_member import RepositoryMember
from app.models.user import User

#: 所有 (role × action) 组合，用例自动生成
MATRIX_CASES = [
    (role, action) for role in VALID_ROLES for action in Action
]


def _case_id(role, action) -> str:
    return f"{role}-{action.value.replace(':', '.')}"


@pytest_asyncio.fixture
async def owner_user(async_db: AsyncSession):
    user = User(
        username="matrixowner",
        email="matrixowner@example.com",
        password="hashed_password_string",
        full_name="Matrix Owner",
        is_active=True,
        is_admin=False,
    )
    async_db.add(user)
    await async_db.commit()
    await async_db.refresh(user)
    return user


@pytest_asyncio.fixture
async def actor_user(async_db: AsyncSession):
    user = User(
        username="matrixactor",
        email="matrixactor@example.com",
        password="hashed_password_string",
        full_name="Matrix Actor",
        is_active=True,
        is_admin=False,
    )
    async_db.add(user)
    await async_db.commit()
    await async_db.refresh(user)
    return user


@pytest_asyncio.fixture
async def matrix_repo(async_db: AsyncSession, owner_user):
    repo = Repository(
        name="matrix-repo",
        path="matrixowner/matrix-repo",
        description="permission matrix test repo",
        is_public=False,
        owner_id=owner_user.id,
        default_branch="main",
    )
    async_db.add(repo)
    await async_db.commit()
    await async_db.refresh(repo)
    return repo


async def _add_member(db, repo, user, role, active=True):
    db.add(RepositoryMember(
        repository_id=repo.id, user_id=user.id, role=role, is_active=active,
    ))
    await db.commit()


# ============================== 矩阵完整性 ==============================


def test_matrix_covers_every_action():
    assert set(ACTION_MATRIX.keys()) == set(Action)


def test_matrix_roles_are_valid():
    for action, roles in ACTION_MATRIX.items():
        assert roles, f"{action} 的允许角色集合为空"
        assert set(roles) <= set(VALID_ROLES), f"{action} 含非法角色 {set(roles) - set(VALID_ROLES)}"


# ==================== (role × action) 自动生成用例 ====================


@pytest.mark.asyncio
@pytest.mark.parametrize("role,action", MATRIX_CASES, ids=[_case_id(r, a) for r, a in MATRIX_CASES])
async def test_role_action_matrix(async_db, actor_user, matrix_repo, role, action):
    """非 owner 主体：裁决结果必须与矩阵声明一致"""
    await _add_member(async_db, matrix_repo, actor_user, role)

    expected = role in ACTION_MATRIX[action]
    assert await has_repo_action(async_db, actor_user.id, matrix_repo.id, action) is expected

    if expected:
        await ensure_repo_action(async_db, actor_user.id, matrix_repo.id, action)
    else:
        with pytest.raises(AuthorizationException):
            await ensure_repo_action(async_db, actor_user.id, matrix_repo.id, action)


# ============================== 旁路与边界 ==============================


@pytest.mark.asyncio
async def test_global_admin_bypasses_matrix(async_db, actor_user, matrix_repo):
    actor_user.is_admin = True
    await async_db.commit()
    for action in Action:
        assert await has_repo_action(async_db, actor_user.id, matrix_repo.id, action) is True


@pytest.mark.asyncio
async def test_repo_owner_gets_owner_role(async_db, owner_user, matrix_repo):
    for action in Action:
        assert await has_repo_action(async_db, owner_user.id, matrix_repo.id, action) is True


@pytest.mark.asyncio
async def test_non_member_denied_everything(async_db, actor_user, matrix_repo):
    for action in Action:
        assert await has_repo_action(async_db, actor_user.id, matrix_repo.id, action) is False


@pytest.mark.asyncio
async def test_inactive_member_denied_everything(async_db, actor_user, matrix_repo):
    await _add_member(async_db, matrix_repo, actor_user, "developer", active=False)
    for action in Action:
        assert await has_repo_action(async_db, actor_user.id, matrix_repo.id, action) is False


@pytest.mark.asyncio
async def test_unknown_repo_denied_everything(async_db, actor_user):
    import uuid
    for action in Action:
        assert await has_repo_action(async_db, actor_user.id, uuid.uuid4(), action) is False


# ============================== 作者或管理员 ==============================


@pytest.mark.asyncio
async def test_author_can_act_on_own_resource(async_db, actor_user, matrix_repo):
    await ensure_author_or_admin(
        async_db, actor_user.id, actor_user.id, matrix_repo.id, "edit this issue"
    )


@pytest.mark.asyncio
async def test_non_author_non_admin_denied(async_db, actor_user, owner_user, matrix_repo):
    with pytest.raises(AuthorizationException):
        await ensure_author_or_admin(
            async_db, owner_user.id, actor_user.id, matrix_repo.id, "edit this issue"
        )


@pytest.mark.asyncio
async def test_repo_admin_can_act_on_others_resource(async_db, owner_user, actor_user, matrix_repo):
    await _add_member(async_db, matrix_repo, actor_user, "admin")
    await ensure_author_or_admin(
        async_db, owner_user.id, actor_user.id, matrix_repo.id, "edit this issue"
    )


@pytest.mark.asyncio
async def test_developer_cannot_act_on_others_resource(async_db, owner_user, actor_user, matrix_repo):
    await _add_member(async_db, matrix_repo, actor_user, "developer")
    with pytest.raises(AuthorizationException):
        await ensure_author_or_admin(
            async_db, owner_user.id, actor_user.id, matrix_repo.id, "edit this issue"
        )


# ============================== 防回潮断言 ==============================


def test_no_raw_permission_utils_references():
    """services/ 下不得直接引用 utils.permission_utils（唯一裁决点是 core.permissions）"""
    root = Path(__file__).resolve().parent.parent / "app"
    offenders = []
    for base in ("services", "api", "middleware"):
        for py in sorted((root / base).rglob("*.py")):
            tree = ast.parse(py.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module == "app.utils.permission_utils":
                    offenders.append(f"{py.relative_to(root)}:{node.lineno} from utils.permission_utils")
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name == "app.utils.permission_utils":
                            offenders.append(f"{py.relative_to(root)}:{node.lineno} import utils.permission_utils")
    assert offenders == [], "以下位置直接引用了 utils.permission_utils：\n" + "\n".join(offenders)


def test_permission_matrix_is_the_single_source():
    """矩阵是唯一裁决依据：core.permissions 内不得出现散写角色列表比较"""
    root = Path(__file__).resolve().parent.parent / "app"
    src = (root / "core" / "permissions.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    # 允许矩阵定义处出现角色字面量（ACTION_MATRIX/_ALL/_WRITE/_ADMIN/_OWNER），
    # 其余函数体内不得再散写角色列表
    fn_role_literals = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) or isinstance(node, ast.AsyncFunctionDef):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Constant) and sub.value in VALID_ROLES:
                    fn_role_literals.append(f"{node.name}:{sub.lineno} -> {sub.value}")
    assert fn_role_literals == [], (
        "裁决函数体内出现散写角色字面量（应只出现在 ACTION_MATRIX/层级集合定义处）：\n"
        + "\n".join(fn_role_literals)
    )


# ========= 写守卫顺序自洽（require_repo_permission：404 → 401 → 403）=========
#
# 工厂在**无外层读守卫兜底**单独使用时，
# 顺序必须与 require_repo_read 同构——缺仓 404 先于鉴权；下列用例把
# 工厂函数体的顺序矩阵钉成契约（依赖层选择另见
# test_read_guard_structure.py::test_write_guard_uses_optional_user）。


@pytest.mark.asyncio
async def test_write_guard_missing_repo_404_even_anonymous(async_db):
    """缺仓 + 匿名 → 404（404 先于 401，与读守卫同序，不泄露仓库存在性）"""
    from uuid import uuid4

    from app.core.exception import NotFoundException
    from app.core.permissions import require_repo_permission

    dep = require_repo_permission(Action.REPO_WRITE, "write files")
    with pytest.raises(NotFoundException) as exc:
        await dep(repo_id=uuid4(), db=async_db, current_user=None)
    assert exc.value.error_code == "repository_not_found"


@pytest.mark.asyncio
async def test_write_guard_missing_repo_404_for_authenticated(async_db, actor_user):
    """缺仓 + 已认证 → 404（既有「缺仓 404」口径回归）"""
    from uuid import uuid4

    from app.core.exception import NotFoundException
    from app.core.permissions import require_repo_permission

    dep = require_repo_permission(Action.REPO_WRITE, "write files")
    with pytest.raises(NotFoundException) as exc:
        await dep(repo_id=uuid4(), db=async_db, current_user=actor_user)
    assert exc.value.error_code == "repository_not_found"


@pytest.mark.asyncio
async def test_write_guard_existing_repo_anonymous_401(async_db, matrix_repo):
    """仓存在 + 匿名 → 401 auth_required（WWW-Authenticate: Bearer 由异常类携带）"""
    from app.core.exception import AuthenticationException
    from app.core.permissions import require_repo_permission

    dep = require_repo_permission(Action.REPO_WRITE, "write files")
    with pytest.raises(AuthenticationException) as exc:
        await dep(repo_id=matrix_repo.id, db=async_db, current_user=None)
    assert exc.value.error_code == "auth_required"


@pytest.mark.asyncio
async def test_write_guard_non_member_403_after_auth(async_db, matrix_repo, actor_user):
    """仓存在 + 已认证非成员 → 403（鉴权之后才进矩阵裁决）"""
    from app.core.exception import AuthorizationException
    from app.core.permissions import require_repo_permission

    dep = require_repo_permission(Action.REPO_WRITE, "write files")
    with pytest.raises(AuthorizationException):
        await dep(repo_id=matrix_repo.id, db=async_db, current_user=actor_user)


@pytest.mark.asyncio
async def test_write_guard_owner_allowed(async_db, matrix_repo, owner_user):
    """仓存在 + owner → 放行（返回 None）"""
    from app.core.permissions import require_repo_permission

    dep = require_repo_permission(Action.REPO_WRITE, "write files")
    assert await dep(
        repo_id=matrix_repo.id, db=async_db, current_user=owner_user
    ) is None
