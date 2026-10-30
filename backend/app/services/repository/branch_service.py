"""
分支服务层

处理与Git分支相关的所有业务逻辑
"""
import asyncio
import logging
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
import uuid
from app.models.branch import Branch
from app.models.repository import Repository
from app.core.exception import ValidationException, NotFoundException, ConflictException, AuthorizationException

logger = logging.getLogger(__name__)

#: update_branch 不可经 API 改写的字段（身份 + 磁盘真相）
_PROTECTED_BRANCH_FIELDS = {"id", "repository_id", "name", "commit_hash"}


async def _materialize_branch_ref(repo: Repository, branch_data: dict) -> Optional[str]:
    """把新分支落成 git 引用，返回 tip 提交哈希（空仓库/未物化仓库返回 None）。

    起点解析顺序：显式 ``branch_data["ref"]`` → 仓库默认分支 → HEAD。
    显式起点无法解析时抛 ValidationException（拒绝且不留 DB 孤儿）。
    """
    from app.utils.git_utils import (
        GitError,
        create_git_branch,
        get_local_branch_heads,
        get_repository_storage_path,
        repo_exists_async,
        resolve_ref_commit,
    )

    physical_path = get_repository_storage_path(repo.path)
    if not await repo_exists_async(physical_path):
        logger.warning("物理仓库不存在，分支仅登记 DB repo=%s", repo.path)
        return None

    if not await asyncio.to_thread(get_local_branch_heads, physical_path):
        # 仓库尚无任何提交/分支：仅登记，首次推送后由 post-receive 对账补齐
        # （不能用 HEAD 判空：bare 仓 HEAD 可能指向不存在的默认分支而处于 unborn）
        logger.info(
            "空仓库分支仅登记，待首次推送补齐 ref repo=%s branch=%s",
            repo.path, branch_data["name"],
        )
        return None

    explicit_ref = branch_data.get("ref")
    candidates = [explicit_ref] if explicit_ref else [repo.default_branch, "HEAD"]
    source = None
    for candidate in candidates:
        if candidate and await asyncio.to_thread(resolve_ref_commit, physical_path, candidate):
            source = candidate
            break
    if source is None:
        raise ValidationException(
            detail=(
                f"Source ref '{explicit_ref}' not found"
                if explicit_ref
                else "Cannot resolve source ref for new branch"
            ),
            error_code="branch_source_ref_not_found",
        )

    try:
        return await asyncio.to_thread(create_git_branch, physical_path, branch_data["name"], source)
    except GitError as e:
        raise ValidationException(detail=str(e), error_code="branch_create_failed")


async def ensure_branch_in_repository(
    db: AsyncSession, branch_id: uuid.UUID, repo_id: uuid.UUID
) -> None:
    """确认分支属于指定仓库；否则抛 404。

    提交接口用这个做归属校验——否则可以把提交行挂到**任意**仓库的分支上。

    Args:
        db: 数据库会话
        branch_id: 分支 ID
        repo_id: 仓库 ID

    Raises:
        NotFoundException: 分支不存在或不属于该仓库
    """
    from app.models.branch import Branch

    result = await db.execute(
        select(Branch).filter(
            Branch.id == branch_id,
            Branch.repository_id == repo_id,
        )
    )
    if result.scalar_one_or_none() is None:
        raise NotFoundException(detail="Branch not found", error_code="branch_not_found")


async def get_branches(repo_id: uuid.UUID, db: AsyncSession):
    """
    获取仓库的所有分支

    Args:
        repo_id: 仓库ID
        db: 异步数据库会话

    Returns:
        list[Branch]: 分支列表
    """
    result = await db.execute(select(Branch).filter(Branch.repository_id == repo_id))
    return result.scalars().all()


async def get_branch(repo_id: uuid.UUID, branch_name: str, db: AsyncSession):
    """
    获取仓库的特定分支

    Args:
        repo_id: 仓库ID
        branch_name: 分支名称
        db: 异步数据库会话

    Returns:
        Branch: 分支信息

    Raises:
        NotFoundException: 分支不存在时抛出404异常
    """
    result = await db.execute(
        select(Branch).filter(
            Branch.repository_id == repo_id,
            Branch.name == branch_name
        )
    )
    branch = result.scalar_one_or_none()

    if branch is None:
        raise NotFoundException(detail=f"Branch '{branch_name}' not found", error_code="branch_not_found")

    return branch


async def get_branch_by_id(branch_id: uuid.UUID, db: AsyncSession):
    """
    根据ID获取分支

    Args:
        branch_id: 分支ID
        db: 异步数据库会话

    Returns:
        Branch: 分支信息

    Raises:
        NotFoundException: 分支不存在时抛出404异常
    """
    result = await db.execute(select(Branch).filter(Branch.id == branch_id))
    branch = result.scalar_one_or_none()
    if branch is None:
        raise NotFoundException(detail="Branch not found", error_code="branch_not_found")
    return branch


async def create_branch(repo_id: uuid.UUID, branch_data: dict, db: AsyncSession):
    """
    创建新分支

    Args:
        repo_id: 仓库ID
        branch_data: 分支信息
        db: 异步数据库会话

    Returns:
        Branch: 创建的分支信息

    Raises:
        ValidationException: 请求参数不完整时抛出422异常
        ConflictException: 分支名称已存在时抛出409异常
    """
    # 验证请求参数
    if "name" not in branch_data:
        raise ValidationException(detail="Branch name is required", error_code="branch_name_required")

    # 仓库必须存在：PG 有 FK 约束，缺失时应显式 404（而非 FK violation 500）
    repo = (
        await db.execute(select(Repository).filter(Repository.id == repo_id))
    ).scalar_one_or_none()
    if repo is None:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")

    # 检查分支名称是否已存在
    result = await db.execute(
        select(Branch).filter(
            Branch.repository_id == repo_id,
            Branch.name == branch_data["name"]
        )
    )
    existing_branch = result.scalar_one_or_none()

    if existing_branch:
        raise ConflictException(detail=f"Branch '{branch_data['name']}' already exists", error_code="branch_already_exists")

    # 物化 git 引用（磁盘为真相）：物理仓库存在时先落 ref 再写 DB 行，
    # 磁盘失败不留 DB 孤儿；空仓库无提交可依附时仅登记（commit_hash=NULL，
    # 首次推送后由 post-receive 对账补齐 ref 与 tip）。
    commit_hash = await _materialize_branch_ref(repo, branch_data)

    # 创建新分支
    db_branch = Branch(
        name=branch_data["name"],
        repository_id=repo_id,
        commit_hash=commit_hash,
        is_protected=branch_data.get("is_protected", False),
        require_code_review=branch_data.get("require_code_review", False),
        require_status_checks=branch_data.get("require_status_checks", False),
        is_default=branch_data.get("is_default", False)
    )

    db.add(db_branch)
    await db.flush()
    await db.refresh(db_branch)

    # 如果设置为默认分支，更新其他分支的默认状态
    if db_branch.is_default:
        await set_default_branch(repo_id, db_branch.id, db)

    return db_branch


async def update_branch(repo_id: uuid.UUID, branch_name: str, branch_data: dict, db: AsyncSession):
    """
    更新分支信息

    Args:
        repo_id: 仓库ID
        branch_name: 分支名称
        branch_data: 更新的分支信息
        db: 异步数据库会话

    Returns:
        Branch: 更新后的分支信息

    Raises:
        NotFoundException: 分支不存在时抛出404异常
    """
    db_branch = await get_branch(repo_id, branch_name, db)

    # 更新分支信息（身份/真相字段禁止经 API 改写：id/repository_id/name/commit_hash）
    for key, value in branch_data.items():
        if key in _PROTECTED_BRANCH_FIELDS:
            continue
        if hasattr(db_branch, key):
            setattr(db_branch, key, value)

    await db.flush()
    await db.refresh(db_branch)

    # 如果设置为默认分支，更新其他分支的默认状态
    if db_branch.is_default:
        await set_default_branch(repo_id, db_branch.id, db)

    return db_branch


async def delete_branch(repo_id: uuid.UUID, branch_name: str, db: AsyncSession):
    """
    删除分支

    Args:
        repo_id: 仓库ID
        branch_name: 分支名称
        db: 异步数据库会话

    Returns:
        dict: 成功消息

    Raises:
        NotFoundException: 分支不存在时抛出404异常
        AuthorizationException: 无法删除默认分支时抛出403异常
    """
    db_branch = await get_branch(repo_id, branch_name, db)

    # 检查是否是默认分支
    if db_branch.is_default:
        raise AuthorizationException(detail="Cannot delete default branch", error_code="branch_delete_default_forbidden")

    # API 删分支与 pre-receive「受保护分支禁止删除」同一裁决
    from app.services.integration.git_event_service import ensure_local_branch_deletable
    await ensure_local_branch_deletable(db, repo_id, branch_name)

    # 同步删除物理引用（磁盘为真相；引用已缺失则忽略，仅删 DB 行自愈）
    from app.utils.git_utils import (
        GitError,
        delete_git_branch,
        get_repository_storage_path,
        repo_exists_async,
    )

    repo = (
        await db.execute(select(Repository).filter(Repository.id == repo_id))
    ).scalar_one_or_none()
    if repo is not None:
        physical_path = get_repository_storage_path(repo.path)
        if await repo_exists_async(physical_path):
            try:
                await asyncio.to_thread(delete_git_branch, physical_path, branch_name)
            except GitError as e:
                raise ConflictException(detail=str(e), error_code="branch_delete_failed")

    # 提交行**保留**（branch_id 置 NULL）——先于分支行删除执行，
    # 同时根治旧 schema（branch_id NOT NULL）下删除**已推送过**的分支必 FK 违约的问题。
    from app.models.commit import Commit
    await db.execute(
        update(Commit).where(Commit.branch_id == db_branch.id).values(branch_id=None)
    )

    await db.delete(db_branch)
    await db.flush()

    return {"message": f"Branch '{branch_name}' deleted successfully"}


async def set_default_branch(repo_id: uuid.UUID, branch_id: uuid.UUID, db: AsyncSession):
    """
    设置默认分支

    Args:
        repo_id: 仓库ID
        branch_id: 分支ID
        db: 异步数据库会话

    Returns:
        dict: 成功消息

    Raises:
        NotFoundException: 分支不存在时抛出404异常
    """
    # 检查分支是否存在
    branch = await get_branch_by_id(branch_id, db)

    # 确保分支属于指定仓库
    if branch.repository_id != repo_id:
        raise NotFoundException(detail="Branch does not belong to this repository", error_code="branch_repo_mismatch")

    # 将所有分支的默认状态设置为False
    await db.execute(
        select(Branch).filter(Branch.repository_id == repo_id)
    )
    # 使用update语句
    from sqlalchemy import update
    await db.execute(
        update(Branch)
        .where(Branch.repository_id == repo_id)
        .values(is_default=False)
    )

    # 设置指定分支为默认分支
    branch.is_default = True
    await db.flush()

    # 更新仓库的默认分支名称
    result = await db.execute(select(Repository).filter(Repository.id == repo_id))
    repo = result.scalar_one_or_none()
    if repo:
        repo.default_branch = branch.name
        await db.flush()

    return {"message": f"Default branch set to '{branch.name}'"}


async def protect_branch(repo_id: uuid.UUID, branch_name: str, protection_settings: dict, db: AsyncSession):
    """
    保护分支

    Args:
        repo_id: 仓库ID
        branch_name: 分支名称
        protection_settings: 保护设置
        db: 异步数据库会话

    Returns:
        Branch: 更新后的分支信息

    Raises:
        NotFoundException: 分支不存在时抛出404异常
    """
    db_branch = await get_branch(repo_id, branch_name, db)

    # 更新保护设置
    db_branch.is_protected = True
    db_branch.require_code_review = protection_settings.get("require_code_review", False)
    db_branch.require_status_checks = protection_settings.get("require_status_checks", False)

    await db.flush()
    await db.refresh(db_branch)

    return db_branch


async def unprotect_branch(repo_id: uuid.UUID, branch_name: str, db: AsyncSession):
    """
    取消分支保护

    Args:
        repo_id: 仓库ID
        branch_name: 分支名称
        db: 异步数据库会话

    Returns:
        Branch: 更新后的分支信息

    Raises:
        NotFoundException: 分支不存在时抛出404异常
    """
    db_branch = await get_branch(repo_id, branch_name, db)

    db_branch.is_protected = False
    db_branch.require_code_review = False
    db_branch.require_status_checks = False

    await db.flush()
    await db.refresh(db_branch)

    return db_branch


async def get_default_branch(repo_id: uuid.UUID, db: AsyncSession):
    """
    获取默认分支

    Args:
        repo_id: 仓库ID
        db: 异步数据库会话

    Returns:
        Branch: 默认分支信息

    Raises:
        NotFoundException: 没有默认分支时抛出404异常
    """
    result = await db.execute(
        select(Branch).filter(
            Branch.repository_id == repo_id,
            Branch.is_default == True
        )
    )
    branch = result.scalar_one_or_none()

    if branch is None:
        raise NotFoundException(detail="Default branch not found", error_code="default_branch_not_found")

    return branch


async def check_branch_protection(repo_id: uuid.UUID, branch_name: str, db: AsyncSession):
    """
    检查分支保护状态

    Args:
        repo_id: 仓库ID
        branch_name: 分支名称
        db: 异步数据库会话

    Returns:
        dict: 分支保护状态信息

    Raises:
        NotFoundException: 分支不存在时抛出404异常
    """
    branch = await get_branch(repo_id, branch_name, db)

    return {
        "is_protected": branch.is_protected,
        "require_code_review": branch.require_code_review,
        "require_status_checks": branch.require_status_checks
    }
