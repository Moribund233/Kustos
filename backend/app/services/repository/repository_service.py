"""
仓库服务层

处理与Git仓库相关的所有业务逻辑
"""
import os
import shutil
import asyncio
import logging
from typing import Dict, Optional, Tuple
import uuid
from datetime import datetime, timedelta
from sqlalchemy import select, asc, desc, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Repository
from app.models.branch import Branch
from app.models.repository_member import RepositoryMember
from app.core.exception import ValidationException, NotFoundException, ConflictException
from app.utils.git_utils import init_bare_repo, get_repository_storage_path, repo_exists_async, enable_receive_pack, GitError
from app.utils.response_builder import build_repo_response, build_pagination_response
from app.utils.db_utils import exists, paginate
from app.services.repository.language_service import detect_repo_languages
from app.core.constants import ROLE_PRIORITY
from app.core.config import get_config_value
from app.utils.redis_client import get_redis, key as redis_key

# 日志记录器
logger = logging.getLogger(__name__)

# 物理仓库存在状态缓存（仓库ID -> (存在状态, 缓存时间)）
# 缓存有效期默认 30 秒（读 [git] repo_exists_cache_ttl_seconds），减少频繁的磁盘IO检查
_repo_exists_cache: Dict[uuid.UUID, Tuple[bool, datetime]] = {}
_REPO_EXISTS_CACHE_TTL_SECONDS = 30


def _repo_exists_cache_ttl() -> int:
    """物理仓库存在缓存 TTL（秒）——读 ``git.repo_exists_cache_ttl_seconds``（0 = 关闭缓存）"""
    return int(get_config_value("git", "repo_exists_cache_ttl_seconds", _REPO_EXISTS_CACHE_TTL_SECONDS))


def _get_cached_repo_exists(repo_id: uuid.UUID) -> Tuple[bool, bool]:
    """
    获取缓存的仓库存在状态

    Args:
        repo_id: 仓库ID

    Returns:
        Tuple[bool, bool]: (是否存在, 是否命中缓存)
    """
    ttl = _repo_exists_cache_ttl()
    if repo_id in _repo_exists_cache:
        exists, cached_time = _repo_exists_cache[repo_id]
        if ttl > 0 and datetime.now() - cached_time < timedelta(seconds=ttl):
            return exists, True
        # 缓存过期 / 关闭缓存，删除
        del _repo_exists_cache[repo_id]
    return False, False


def _set_cached_repo_exists(repo_id: uuid.UUID, exists: bool) -> None:
    """
    设置仓库存在状态缓存

    Args:
        repo_id: 仓库ID
        exists: 是否存在
    """
    _repo_exists_cache[repo_id] = (exists, datetime.now())


def _repo_exists_key(repo_id: uuid.UUID) -> str:
    """跨 worker 共享的物理仓库存在状态键（统一命名空间）"""
    return redis_key("repo", "exists", str(repo_id))


async def _get_redis_repo_exists(repo_id: uuid.UUID) -> Optional[bool]:
    """读取 Redis L2 缓存；未命中/不可用返回 None"""
    client = await get_redis()
    if client is None:
        return None
    try:
        raw = await client.get(_repo_exists_key(repo_id))
    except Exception as exc:  # noqa: BLE001 — 缓存失败即回退磁盘
        logger.warning(f"仓库存在缓存读取失败: {exc}")
        return None
    if raw is None:
        return None
    return str(raw) == "1"


async def _set_redis_repo_exists(repo_id: uuid.UUID, exists: bool) -> None:
    """写入 Redis L2 缓存（TTL 与进程内缓存一致，读 [git] repo_exists_cache_ttl_seconds）"""
    ttl = _repo_exists_cache_ttl()
    if ttl <= 0:
        return  # 关闭缓存
    client = await get_redis()
    if client is None:
        return
    try:
        await client.set(
            _repo_exists_key(repo_id),
            "1" if exists else "0",
            ex=ttl,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"仓库存在缓存写入失败: {exc}")


async def _invalidate_repo_exists_cache(repo_id: uuid.UUID) -> None:
    """创建/删除仓库后失效 L1 与 L2 缓存，避免 30s 内读到陈旧状态"""
    _repo_exists_cache.pop(repo_id, None)
    client = await get_redis()
    if client is None:
        return
    try:
        await client.delete(_repo_exists_key(repo_id))
    except Exception as exc:  # noqa: BLE001 — 失效为尽力而为
        logger.warning(f"仓库存在缓存失效失败: {exc}")


async def _check_physical_repo_exists_async(repo: Repository) -> bool:
    """
    检查物理仓库是否存在（异步版本，带缓存）

    优先从缓存获取，缓存未命中时执行异步IO检查
    缓存有效期30秒，减少频繁的磁盘IO操作

    Args:
        repo: Repository 模型对象

    Returns:
        bool: 物理仓库是否存在
    """
    # L1：进程内缓存
    cached_exists, cache_hit = _get_cached_repo_exists(repo.id)
    if cache_hit:
        return cached_exists

    # L2：跨 worker Redis 缓存
    redis_cached = await _get_redis_repo_exists(repo.id)
    if redis_cached is not None:
        _set_cached_repo_exists(repo.id, redis_cached)
        return redis_cached

    # 缓存未命中，执行异步检查
    try:
        physical_path = get_repository_storage_path(repo.path)
        exists = await repo_exists_async(physical_path)
        # 更新缓存
        _set_cached_repo_exists(repo.id, exists)
        await _set_redis_repo_exists(repo.id, exists)
        return exists
    except Exception:
        return False


async def sync_repository_default_branch(repo: Repository, db: AsyncSession) -> None:
    """
    将数据库默认分支与物理仓库实际分支对齐（自愈逻辑）

    背景：早期创建的仓库 DB 默认分支为 master，而用户本地以 main 推送，
    导致仓库页按 default_branch 查询 commits/tree 时 404/500。

    策略（物理仓库存在且非空时）：
    - DB 默认分支物理存在：仅修复悬空的物理 HEAD 指向
    - DB 默认分支物理不存在：采用物理分支（优先 main，否则首个分支），
      同步 Repository.default_branch 与 Branch 表默认标记

    Args:
        repo: Repository 模型对象
        db: 异步数据库会话
    """
    from app.utils.git_utils import get_local_branch_heads, set_head_branch

    try:
        physical_path = get_repository_storage_path(repo.path)
        heads = await asyncio.to_thread(get_local_branch_heads, physical_path)
        if not heads:
            return  # 物理仓库不存在或为空，无需处理

        default_branch = repo.default_branch
        adopted: str | None = None

        if default_branch in heads:
            # DB 默认分支存在，确保物理 HEAD 指向它（修复悬空 HEAD）
            await asyncio.to_thread(set_head_branch, physical_path, default_branch)
        else:
            # DB 默认分支不存在（如推送的是 main），采用物理分支
            adopted = "main" if "main" in heads else sorted(heads)[0]

        if adopted is None:
            # 默认分支已一致，仅同步 Branch 表中缺失的分支行（推送产生的分支）
            await _sync_branch_rows(repo.id, heads, repo.default_branch, db)
            return

        repo.default_branch = adopted
        await asyncio.to_thread(set_head_branch, physical_path, adopted)
        await _sync_branch_rows(repo.id, heads, adopted, db)
        await db.flush()
        logger.info(
            f"Repository {repo.path}: default branch migrated "
            f"{default_branch!r} -> {adopted!r} (physical branches: {sorted(heads)})"
        )
    except Exception as e:
        logger.warning(f"Failed to sync default branch for {repo.path}: {e}")


async def _sync_branch_rows(
    repo_id: uuid.UUID,
    physical_branches: dict,
    default_branch: str,
    db: AsyncSession,
) -> None:
    """
    同步 Branch 表：为物理存在的分支补建行（含 tip 哈希），并维护默认分支标记

    不删除物理侧已消失的分支行（可能被 PR 等引用）
    """
    result = await db.execute(select(Branch).filter(Branch.repository_id == repo_id))
    db_branches = result.scalars().all()
    existing_names = {b.name for b in db_branches}

    changed = False
    for name, tip in physical_branches.items():
        if name not in existing_names:
            db.add(Branch(
                name=name,
                repository_id=repo_id,
                commit_hash=tip,
                is_protected=False,
                is_default=(name == default_branch),
            ))
            existing_names.add(name)
            changed = True

    for b in db_branches:
        expected = b.name == default_branch
        if b.is_default != expected:
            b.is_default = expected
            changed = True
        tip = physical_branches.get(b.name)
        if tip is not None and b.commit_hash != tip:
            b.commit_hash = tip
            changed = True

    if changed:
        await db.flush()


async def _enrich_repos_with_physical_status(repos: list) -> list[dict]:
    """
    为仓库列表添加物理存在状态

    并行检查所有仓库的物理存在状态（异步IO优化）

    Args:
        repos: Repository 模型对象列表

    Returns:
        list[dict]: 包含物理状态的仓库响应列表
    """
    if not repos:
        return []

    physical_checks = await asyncio.gather(
        *[_check_physical_repo_exists_async(repo) for repo in repos],
        return_exceptions=True
    )
    exists_flags = [isinstance(c, bool) and c for c in physical_checks]

    language_map: Dict[str, dict] = {}
    queries = [
        detect_repo_languages(get_repository_storage_path(repo.path), repo.default_branch or "HEAD")
        for repo, ok in zip(repos, exists_flags)
        if ok
    ]
    if queries:
        results = await asyncio.gather(*queries, return_exceptions=True)
        it = iter(results)
        for repo, ok in zip(repos, exists_flags):
            if ok:
                lang_result = next(it)
                language_map[repo.id] = lang_result if isinstance(lang_result, dict) else {}

    return [
        build_repo_response(
            repo,
            ok,
            language_map.get(repo.id, {}),
        )
        for repo, ok in zip(repos, exists_flags)
    ]


async def get_repositories(
    db: AsyncSession,
    page: int = 1,
    limit: int = 20,
    sort: str = "updated_at",
    order: str = "desc",
    q: str | None = None,
    is_public: bool | None = None,
    viewer_id: uuid.UUID | None = None,
    viewer_is_admin: bool = False,
):
    """
    获取所有仓库（支持分页、排序、搜索、筛选）

    Args:
        db: 异步数据库会话
        page: 页码，从1开始
        limit: 每页数量
        sort: 排序字段（name, updated_at, stars）
        order: 排序方向（asc, desc）
        q: 搜索关键词（按名称、描述、路径模糊匹配）
        is_public: 可见性筛选
        viewer_id: 访问者（可见性 scope——非 admin 只见
            公开仓 ∪ 自己拥有的 ∪ 自己参与的；``None`` 表示不过滤
            （内部/测试调用保持旧行为））
        viewer_is_admin: 访问者是否全局管理员（admin 不过滤）

    Returns:
        dict: 分页响应，包含 items, total, page, limit, pages, has_next, has_prev
    """
    stmt = select(Repository).filter(Repository.is_archived == False)

    if is_public is not None:
        stmt = stmt.filter(Repository.is_public == is_public)

    # 跨租户可见性收口——原 `is_public=None` 时只滤 is_archived，
    # 返回全部私仓元数据（任何登录账号可枚举私仓名称/描述/语言/owner）
    if viewer_id is not None and not viewer_is_admin:
        stmt = stmt.filter(
            or_(
                Repository.is_public == True,
                Repository.owner_id == viewer_id,
                Repository.id.in_(
                    select(RepositoryMember.repository_id).filter(
                        RepositoryMember.user_id == viewer_id,
                        RepositoryMember.is_active == True,  # noqa: E712
                    )
                ),
            )
        )

    if q:
        like_pattern = f"%{q}%"
        stmt = stmt.filter(
            or_(
                Repository.name.ilike(like_pattern),
                Repository.description.ilike(like_pattern),
                Repository.path.ilike(like_pattern),
            )
        )

    sort_column_map = {
        "name": Repository.name,
        "updated_at": Repository.updated_at,
        "stars": Repository.star_count,
    }
    sort_col = sort_column_map.get(sort, Repository.updated_at)
    order_func = asc if order == "asc" else desc
    stmt = stmt.order_by(order_func(sort_col))

    repos, total = await paginate(db, stmt, page, limit)
    items = await _enrich_repos_with_physical_status(list(repos))

    return build_pagination_response(items, total, page, limit)


async def get_repository_by_id(repo_id: uuid.UUID, db: AsyncSession):
    """
    根据ID获取仓库

    Args:
        repo_id: 仓库ID
        db: 异步数据库会话

    Returns:
        dict: 仓库信息（包含物理仓库信息）

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
    """
    result = await db.execute(select(Repository).filter(Repository.id == repo_id))
    repo = result.scalar_one_or_none()
    if repo is None:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")
    await sync_repository_default_branch(repo, db)
    physical_exists = await _check_physical_repo_exists_async(repo)
    languages = await detect_repo_languages(get_repository_storage_path(repo.path), repo.default_branch or "HEAD") if physical_exists else {}
    return build_repo_response(repo, physical_exists, languages)


async def get_repository_by_path(owner: str, repo_name: str, db: AsyncSession):
    """
    根据 owner/repo 路径获取仓库

    Repository.path 格式固定为 {username}/{repo_name}，且具有唯一约束。

    Args:
        owner: 仓库所有者用户名
        repo_name: 仓库名称
        db: 异步数据库会话

    Returns:
        dict: 仓库信息（包含物理仓库信息）

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
    """
    path = f"{owner}/{repo_name}"
    result = await db.execute(select(Repository).filter(Repository.path == path))
    repo = result.scalar_one_or_none()
    if repo is None:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")
    await sync_repository_default_branch(repo, db)
    physical_exists = await _check_physical_repo_exists_async(repo)
    languages = await detect_repo_languages(get_repository_storage_path(repo.path), repo.default_branch or "HEAD") if physical_exists else {}
    return build_repo_response(repo, physical_exists, languages)


async def get_accessible_repository_ids(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """
    获取指定用户可访问的仓库 ID 列表

    包括：公开仓库、用户拥有的仓库、用户作为活跃成员参与的仓库。

    Args:
        db: 异步数据库会话
        user_id: 用户ID

    Returns:
        list[int]: 可访问仓库 ID 列表
    """
    stmt = (
        select(Repository.id)
        .outerjoin(
            RepositoryMember,
            (RepositoryMember.repository_id == Repository.id) &
            (RepositoryMember.user_id == user_id) &
            (RepositoryMember.is_active == True)
        )
        .filter(
            or_(
                Repository.is_public == True,
                Repository.owner_id == user_id,
                RepositoryMember.user_id.is_not(None)
            )
        )
        .distinct()
    )
    result = await db.execute(stmt)
    return [row[0] for row in result.all()]


async def get_repositories_by_user(
    user_id: uuid.UUID,
    db: AsyncSession,
    viewer_id: uuid.UUID | None = None,
    viewer_is_admin: bool = False,
):
    """
    根据用户ID获取仓库列表

    Args:
        user_id: 用户ID
        db: 异步数据库会话
        viewer_id: 访问者（非本人且非 admin 只见公开仓——
            原全量返回 owner/member 仓 = 任意账号可枚举他人私仓清单与成员关系）
        viewer_is_admin: 访问者是否全局管理员

    Returns:
        list[dict]: 仓库列表（包含物理仓库信息）
    """
    # 可见性 scope：本人/admin 看全部，否则只看公开仓
    public_only = (
        viewer_id is not None
        and viewer_id != user_id
        and not viewer_is_admin
    )

    # 查询用户拥有的仓库
    stmt = select(Repository).filter(Repository.owner_id == user_id)
    if public_only:
        stmt = stmt.filter(Repository.is_public == True)  # noqa: E712
    result = await db.execute(stmt)
    owned_repos = result.scalars().all()

    # 查询用户参与的仓库（通过repository_members表）
    stmt = (
        select(Repository)
        .join(RepositoryMember)
        .filter(RepositoryMember.user_id == user_id)
    )
    if public_only:
        stmt = stmt.filter(Repository.is_public == True)  # noqa: E712
    result = await db.execute(stmt)
    member_repos = result.scalars().all()

    # 合并结果，去重
    all_repos = list(set(list(owned_repos) + list(member_repos)))

    return await _enrich_repos_with_physical_status(all_repos)


async def create_repository(repo_data: dict, db: AsyncSession):
    """
    创建新仓库

    Args:
        repo_data: 仓库信息
        db: 异步数据库会话

    Returns:
        dict: 创建的仓库信息

    Raises:
        ValidationException: 请求参数不完整时抛出422异常
        ConflictException: 仓库路径已存在时抛出409异常
    """
    # 验证请求参数
    if "name" not in repo_data or "path" not in repo_data or "owner_id" not in repo_data:
        raise ValidationException(detail="Name, path and owner_id are required", error_code="repository_required_fields")

    # 检查路径是否已存在
    if await exists(db, Repository, {"path": repo_data["path"]}):
        raise ConflictException(detail="Repository path already exists", error_code="repository_path_already_exists")

    # 创建新仓库
    db_repo = Repository(
        name=repo_data["name"],
        path=repo_data["path"],
        description=repo_data.get("description"),
        is_public=repo_data.get("is_public", True),
        owner_id=repo_data["owner_id"],
        default_branch=repo_data.get("default_branch") or "main"
    )

    db.add(db_repo)
    await db.flush()
    await db.refresh(db_repo)

    # 为仓库创建默认分支
    default_branch = Branch(
        name=db_repo.default_branch,
        repository_id=db_repo.id,
        is_protected=True,
        is_default=True
    )
    db.add(default_branch)
    await db.flush()

    # 添加仓库所有者为成员
    owner_member = RepositoryMember(
        repository_id=db_repo.id,
        user_id=db_repo.owner_id,
        role="owner"
    )
    db.add(owner_member)
    await db.flush()

    # 创建物理 Git 仓库（空仓库，无初始提交），HEAD 与默认分支对齐
    try:
        physical_path = get_repository_storage_path(db_repo.path)
        branch_for_init = db_repo.default_branch

        def _init_physical_repo(path: str, branch: str) -> None:
            init_bare_repo(path, default_branch=branch)
            # 启用 HTTP push（git-http-backend 默认禁止 receive-pack）
            enable_receive_pack(path)

        await asyncio.to_thread(_init_physical_repo, physical_path, branch_for_init)
    except GitError as e:
        # 物理仓库创建失败，记录错误但不阻止创建
        logger.warning(f"Failed to create physical git repository at {physical_path}: {e}")
    except Exception as e:
        # 其他错误，记录但不阻止
        logger.warning(f"Unexpected error creating git repository: {e}")

    # 物理仓库已就绪，清掉可能存在的陈旧缓存
    await _invalidate_repo_exists_cache(db_repo.id)
    physical_exists = await _check_physical_repo_exists_async(db_repo)

    from app.services.realtime.room_service import RoomService
    try:
        await RoomService.create_room(db, db_repo.id, db_repo.name, db_repo.owner_id)
    except Exception:
        logger.warning(f"Failed to create room for repository {db_repo.id}")

    # Agent 启用时 bot 入驻仓库成员（延迟导入：agent_service 依赖本模块，防环）
    try:
        from app.services.agent.agent_service import AgentService

        await AgentService().ensure_bot_repo_member(db, db_repo.id)
    except Exception:
        logger.warning(f"Failed to add agent bot as member of repository {db_repo.id}")

    return build_repo_response(db_repo, physical_exists)


async def update_repository(repo_id: uuid.UUID, repo_data: dict, db: AsyncSession):
    """
    更新仓库信息

    Args:
        repo_id: 仓库ID
        repo_data: 更新的仓库信息
        db: 异步数据库会话

    Returns:
        dict: 更新后的仓库信息（包含物理仓库信息）

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
        ConflictException: 仓库路径已存在时抛出409异常
    """
    result = await db.execute(select(Repository).filter(Repository.id == repo_id))
    db_repo = result.scalar_one_or_none()
    if db_repo is None:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")

    # 检查路径是否已存在（如果更新了路径）
    if "path" in repo_data and repo_data["path"] != db_repo.path:
        if await exists(db, Repository, {"path": repo_data["path"]}):
            raise ConflictException(detail="Repository path already exists", error_code="repository_path_already_exists")

    # 更新仓库信息
    for key, value in repo_data.items():
        if hasattr(db_repo, key):
            setattr(db_repo, key, value)

    await db.flush()
    await db.refresh(db_repo)

    # 搜索索引已改为主库持久化（按 repository_id 键），路径变更无需清理：
    # 查询时按提交差异自动增量重建。

    physical_exists = await _check_physical_repo_exists_async(db_repo)
    return build_repo_response(db_repo, physical_exists)


def _repository_delete_plan() -> list:
    """返回仓库删除涉及的表，按外键深度从深到浅排列（子表先删）。"""
    from app.models.base import Base

    tables = Base.metadata.tables
    depth = {"repositories": 0}
    # 迭代取「最长路径」：同一张表可能同时直接挂仓库、又被另一张子表引用
    for _ in range(len(tables)):
        changed = False
        for table in tables.values():
            if table.name == "repositories":
                continue
            parents = [
                fk.column.table.name
                for fk in table.foreign_keys
                if fk.column.table.name in depth and fk.column.table.name != table.name
            ]
            if not parents:
                continue
            new_depth = max(depth[parent] for parent in parents) + 1
            if depth.get(table.name, 0) < new_depth:
                depth[table.name] = new_depth
                changed = True
        if not changed:
            break

    return sorted(
        ((tables[name], level) for name, level in depth.items() if name != "repositories"),
        key=lambda item: (item[1], item[0].name),
        reverse=True,
    )


def _repository_scope_condition(
    table, repo_id: uuid.UUID, plan_names: set, memo: dict
):
    """
    构造「属于该仓库」的过滤条件。

    直接挂在仓库上的表按 `repository_id` 过滤；没有该列的表沿外键上溯到父表，
    生成 `fk IN (SELECT id FROM 父表 WHERE 父表条件)`。
    """
    if table.name in memo:
        return memo[table.name]

    if "repository_id" in table.c:
        condition = table.c.repository_id == repo_id
    else:
        conditions = []
        for fk in table.foreign_keys:
            parent = fk.column.table
            # 自引用（如 chat_messages.reply_to_id）由同表其它外键覆盖
            if parent.name == table.name or parent.name not in plan_names:
                continue
            conditions.append(
                fk.parent.in_(
                    select(parent.c.id).where(
                        _repository_scope_condition(parent, repo_id, plan_names, memo)
                    )
                )
            )
        condition = or_(*conditions) if conditions else None

    memo[table.name] = condition
    return condition


async def _purge_repository_rows(db: AsyncSession, repo_id: uuid.UUID) -> None:
    """硬删除仓库前清空后代表，避免 NOT NULL 外键被 ORM 置空后触发 500。"""
    plan = _repository_delete_plan()
    plan_names = {table.name for table, _ in plan}
    memo: dict = {}
    for table, _ in plan:
        condition = _repository_scope_condition(table, repo_id, plan_names, memo)
        if condition is not None:
            await db.execute(table.delete().where(condition))


async def delete_repository(repo_id: uuid.UUID, db: AsyncSession):
    """
    删除仓库

    Args:
        repo_id: 仓库ID
        db: 异步数据库会话

    Returns:
        dict: 成功消息

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
    """
    result = await db.execute(select(Repository).filter(Repository.id == repo_id))
    db_repo = result.scalar_one_or_none()
    if db_repo is None:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")

    # 获取物理仓库路径（get_repository_storage_path 已包含 .git 后缀）
    physical_path = None
    try:
        physical_path = get_repository_storage_path(db_repo.path)
        if os.path.exists(physical_path):
            shutil.rmtree(physical_path)
            logger.info(f"物理仓库已删除: {physical_path}")
    except Exception as e:
        # 物理仓库删除失败，记录错误但不阻止数据库删除
        path_info = physical_path if physical_path else "unknown"
        logger.warning(f"Failed to delete physical repository at {path_info}: {e}")

    # 失效存在状态缓存，避免删除后仍读到存在
    await _invalidate_repo_exists_cache(repo_id)

    # 先清理搜索索引行（外键约束，必须在删除仓库行之前）
    try:
        from app.services.search.search_service import SearchService
        await SearchService().cleanup_index(db, repo_id)
    except Exception as e:
        logger.warning(f"Failed to cleanup search index for repo {repo_id}: {e}")

    await _purge_repository_rows(db, repo_id)
    # Fork 是独立仓库：保留它，只把指向被删仓库的来源置空
    await db.execute(
        update(Repository)
        .where(Repository.forked_from_id == repo_id)
        .values(forked_from_id=None)
    )

    await db.delete(db_repo)
    await db.flush()

    return {"message": "Repository deleted successfully"}


async def get_public_repositories(db: AsyncSession):
    """
    获取所有公开仓库

    Args:
        db: 异步数据库会话

    Returns:
        list[dict]: 公开仓库列表（包含物理仓库信息）
    """
    result = await db.execute(select(Repository).filter(Repository.is_public == True))
    repos = result.scalars().all()

    return await _enrich_repos_with_physical_status(list(repos))


async def check_repository_access(repo_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession, required_role: str | None = None):
    """
    检查用户对仓库的访问权限

    Args:
        repo_id: 仓库ID
        user_id: 用户ID
        db: 异步数据库会话
        required_role: 所需的最低权限角色（可选）

    Returns:
        bool: 是否有访问权限

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
    """
    repo = await get_repository_by_id(repo_id, db)

    # 检查仓库是否公开
    if repo["is_public"] and required_role is None:
        return True

    # 检查用户是否是仓库所有者
    if repo["owner_id"] == user_id:
        return True

    # 检查用户是否是仓库成员
    result = await db.execute(
        select(RepositoryMember)
        .filter(
            RepositoryMember.repository_id == repo_id,
            RepositoryMember.user_id == user_id,
            RepositoryMember.is_active == True
        )
    )
    member = result.scalar_one_or_none()

    if not member:
        return False

    # 如果需要特定角色，检查角色权限
    if required_role:
        user_role_priority = ROLE_PRIORITY.get(member.role, 0)
        required_role_priority = ROLE_PRIORITY.get(required_role, 0)
        return user_role_priority >= required_role_priority

    return True


async def archive_repository(repo_id: uuid.UUID, db: AsyncSession) -> dict:
    """
    归档仓库

    将仓库标记为已归档状态，归档后的仓库不会出现在普通仓库列表中。

    Args:
        repo_id: 仓库ID
        db: 异步数据库会话

    Returns:
        dict: 归档后的仓库信息

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
    """
    result = await db.execute(select(Repository).filter(Repository.id == repo_id))
    repo = result.scalar_one_or_none()
    if repo is None:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")
    repo.is_archived = True
    await db.flush()
    await db.refresh(repo)
    physical_exists = await _check_physical_repo_exists_async(repo)
    return build_repo_response(repo, physical_exists)


async def unarchive_repository(repo_id: uuid.UUID, db: AsyncSession) -> dict:
    """
    取消归档仓库

    将已归档的仓库恢复为正常状态，重新出现在仓库列表中。

    Args:
        repo_id: 仓库ID
        db: 异步数据库会话

    Returns:
        dict: 取消归档后的仓库信息

    Raises:
        NotFoundException: 仓库不存在时抛出404异常
    """
    result = await db.execute(select(Repository).filter(Repository.id == repo_id))
    repo = result.scalar_one_or_none()
    if repo is None:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")
    repo.is_archived = False
    await db.flush()
    await db.refresh(repo)
    physical_exists = await _check_physical_repo_exists_async(repo)
    return build_repo_response(repo, physical_exists)
