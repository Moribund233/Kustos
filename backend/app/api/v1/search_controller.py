"""
搜索控制器层

处理与代码搜索相关的HTTP请求，调用服务层方法并返回响应
"""
from dataclasses import asdict

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_

from app.api.prefixes import get_route_prefix
from app.models.async_db import get_async_db
from app.models import Repository, Issue, PullRequest
from app.models.user import User
from app.api.deps import get_current_user
from app.services.search_service import SearchService
from app.services.repository_service import get_accessible_repository_ids
from app.utils.git_utils import get_repository_storage_path
from app.core.exception import NotFoundException
from app.core.config import get_config_value
import asyncio
import logging
import uuid
from app.api.guards import require_repo_read

logger = logging.getLogger(__name__)

#: 搜索结果上限：``search.max_results`` 导入期读取——
#: controller ``Query`` 上限与 service 硬上限同源（改配置重启后收敛）。
_SEARCH_RESULTS_CAP = int(get_config_value("search", "max_results", 100) or 100)

router = APIRouter(
    prefix=get_route_prefix("repositories"), tags=["search"],
    dependencies=[Depends(require_repo_read())],
)
global_search_router = APIRouter(prefix="/api/v1/search", tags=["search"])


async def _get_repo(repo_id: uuid.UUID, db: AsyncSession) -> Repository:
    """
    获取仓库对象（用于取物理路径与仓库ID）

    Raises:
        NotFoundException: 仓库不存在
    """
    result = await db.execute(select(Repository).filter(Repository.id == repo_id))
    repo = result.scalar_one_or_none()
    if not repo:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")
    return repo


async def _ensure_read_access(repo: Repository, user: User, db: AsyncSession) -> None:
    """校验当前用户对该仓库有读权限（公开/拥有/活跃成员）"""
    accessible = await get_accessible_repository_ids(db, user.id)
    if repo.id not in accessible:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")


@router.get("/{repo_id}/search")
async def search_code(
    repo_id: uuid.UUID,
    q: str = Query(..., description="搜索关键词"),
    path: str = Query(None, description="限制搜索目录"),
    ref: str = Query(None, description="分支/标签/提交，缺省为默认分支"),
    semantic: bool = Query(None, description="是否叠加语义检索（缺省取 search.embedding_enabled）"),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    搜索仓库代码

    Args:
        repo_id: 仓库ID
        q: 搜索关键词
        path: 限制搜索目录
        ref: 分支/标签/提交（缺省默认分支）
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 搜索结果
    """
    repo = await _get_repo(repo_id, db)
    await _ensure_read_access(repo, current_user, db)
    repo_path = get_repository_storage_path(repo.path)
    search_service = SearchService()
    return await search_service.search_code(
        db=db,
        repository_id=repo.id,
        repo_path=repo_path,
        query=q,
        path=path,
        ref=ref,
        semantic=semantic,
    )


@router.get("/{repo_id}/symbols/{name}/definition")
async def find_symbol_definition(
    repo_id: uuid.UUID,
    name: str,
    path: str = Query(None, description="限制搜索目录"),
    exclude_tests: bool = Query(False, description="排除测试文件"),
    ref: str = Query(None, description="分支/标签/提交；缺省为默认分支（走块级索引）"),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """按精确符号名查找定义（符号图）。

    块级索引只覆盖默认分支 HEAD；传入非默认 ``ref`` 时改为按该 ref 现场扫描，
    响应中的 ``source`` / ``partial`` 用于标明答案来源与是否可能被护栏截断。
    """
    repo = await _get_repo(repo_id, db)
    await _ensure_read_access(repo, current_user, db)
    result = await SearchService().find_definition(
        db, repo.id, name, path=path, exclude_tests=exclude_tests,
        repo_path=get_repository_storage_path(repo.path), ref=ref,
    )
    return {
        "name": name,
        "definitions": [asdict(h) for h in result.hits],
        "source": result.source,
        "partial": result.partial,
    }


@router.get("/{repo_id}/symbols/{name}/usages")
async def find_symbol_usages(
    repo_id: uuid.UUID,
    name: str,
    path: str = Query(None, description="限制搜索目录"),
    exclude_tests: bool = Query(False, description="排除测试文件"),
    max_results: int = Query(
        min(200, _SEARCH_RESULTS_CAP), ge=1, le=_SEARCH_RESULTS_CAP,
        description="最大返回数（上限 = search.max_results）",
    ),
    ref: str = Query(None, description="分支/标签/提交；缺省为默认分支（走块级索引）"),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """按精确标识符名查找引用，附引用点所在符号块（引用图）。"""
    repo = await _get_repo(repo_id, db)
    await _ensure_read_access(repo, current_user, db)
    result = await SearchService().find_usages(
        db, repo.id, name, max_results=max_results, path=path,
        exclude_tests=exclude_tests,
        repo_path=get_repository_storage_path(repo.path), ref=ref,
    )
    return {
        "name": name,
        "usages": [asdict(h) for h in result.hits],
        "source": result.source,
        "partial": result.partial,
    }


# 手动重建的在途任务（进程内跟踪：防同进程重复触发；完成即自清理）
_reindex_tasks: set = set()


async def _run_reindex(repository_id, repo_path: str) -> None:
    """后台执行全量重建（独立会话；失败只留日志，状态由 index-status 如实反映）"""
    from app.models.async_db import get_async_db_context

    try:
        async with get_async_db_context() as db:
            files = await SearchService().rebuild_index(db, repository_id, repo_path)
        logger.info("手动重建索引完成: repo=%s files=%s", repository_id, files)
    except Exception:  # noqa: BLE001 — 后台任务不向调用方回传异常
        logger.exception("手动重建索引失败: repo=%s", repository_id)


def _spawn_reindex(repository_id, repo_path: str) -> None:
    task = asyncio.create_task(_run_reindex(repository_id, repo_path))
    _reindex_tasks.add(task)
    task.add_done_callback(_reindex_tasks.discard)


@router.get("/{repo_id}/search/index-status")
async def search_index_status(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    索引状态（认证 + 读权限即可；只读派生数据，不触发构建）

    Returns:
        dict: ``{head_commit, indexed_commit, index_generation,
        current_generation, in_sync, chunks, refs, embeddings,
        semantic_enabled, last_indexed_at}``
    """
    repo = await _get_repo(repo_id, db)
    await _ensure_read_access(repo, current_user, db)
    return await SearchService().index_status(
        db, repo.id, get_repository_storage_path(repo.path)
    )


@router.post("/{repo_id}/search/reindex")
async def search_reindex(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    手动重建块级索引（认证 + 读权限即可，**非管理员专属**）

    后台执行（大仓可达数十秒，避免同步请求撞网关超时）；响应 ``{started}``，
    前端轮询 ``index-status`` 等待 ``in_sync`` 翻转。同进程重复触发由
    per-repo 重建锁挡下（``started=false, reason=rebuilding``）；
    跨进程重复触发无害（Redis NX 锁使后到者空转返回）。

    Returns:
        dict: ``{started: bool, reason?: "rebuilding"}``
    """
    repo = await _get_repo(repo_id, db)
    await _ensure_read_access(repo, current_user, db)
    if await SearchService().is_rebuilding(repo.id):
        return {"started": False, "reason": "rebuilding"}
    _spawn_reindex(repo.id, get_repository_storage_path(repo.path))
    return {"started": True}


@global_search_router.get("/code")
async def global_search_code(
    q: str = Query(..., description="搜索关键词"),
    path: str = Query(None, description="限制搜索目录"),
    ref: str = Query(None, description="分支/标签/提交，缺省为各仓库默认分支"),
    max_results: int = Query(
        min(100, _SEARCH_RESULTS_CAP), ge=1, le=_SEARCH_RESULTS_CAP,
        description="最大返回结果数（上限 = search.max_results）",
    ),
    per_repo_max: int = Query(50, ge=1, le=200, description="每个仓库最大结果数"),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    跨仓库代码搜索

    在用户有权限访问的所有仓库中搜索代码，结果按仓库聚合。

    Args:
        q: 搜索关键词
        path: 限制搜索目录
        ref: 分支/标签/提交（缺省各仓库默认分支）
        max_results: 最大返回结果总数
        per_repo_max: 单个仓库最大结果数
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 搜索结果（按仓库聚合）
    """
    accessible_ids = await get_accessible_repository_ids(db, current_user.id)

    if not accessible_ids:
        return {
            "query": q,
            "repositories": [],
            "total_count": 0,
            "truncated": False,
        }

    result = await db.execute(
        select(Repository).filter(Repository.id.in_(accessible_ids))
    )
    repos = result.scalars().all()

    search_service = SearchService()

    async def search_one(repo: Repository):
        repo_path = get_repository_storage_path(repo.path)
        try:
            response = await search_service.search_code(
                db=db,
                repository_id=repo.id,
                repo_path=repo_path,
                query=q,
                path=path,
                ref=ref,
                max_results=per_repo_max,
            )
        except Exception:
            return None
        if not response.results:
            return None
        return {
            "repository_id": repo.id,
            "repository_name": repo.name,
            "repository_path": repo.path,
            "results": [
                {
                    "file": r.file,
                    "line": r.line,
                    "content": r.content,
                    "chunk": asdict(r.chunk) if r.chunk else None,
                }
                for r in response.results
            ],
            "total_count": response.total_count,
            "truncated": response.truncated,
            "source": response.source,
            "semantic_used": response.semantic_used,
        }

    # 串行执行：共用一个 AsyncSession，并发不安全
    aggregated = []
    for repo in repos:
        result = await search_one(repo)
        if result is not None:
            aggregated.append(result)

    # 按总结果数截断
    total_count = sum(r["total_count"] for r in aggregated)
    truncated = total_count > max_results
    if total_count > max_results:
        remaining = max_results
        limited = []
        for r in aggregated:
            if remaining <= 0:
                break
            results = r["results"]
            take = min(len(results), remaining)
            limited.append({
                **r,
                "results": results[:take],
                "total_count": take,
                "truncated": take < len(results) or r["truncated"],
            })
            remaining -= take
        aggregated = limited

    return {
        "query": q,
        "repositories": aggregated,
        "total_count": total_count,
        "truncated": truncated,
    }


@global_search_router.get("/global")
async def global_search(
    q: str = Query(..., min_length=1, description="搜索关键词"),
    per_type: int = Query(10, ge=1, le=50, description="每类结果最大返回数"),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    全局聚合搜索（仓库/Issue/PR）

    在用户可访问的仓库范围内，按关键词搜索：
    - 仓库名称 / 路径 / 描述
    - Issue 标题 / 描述
    - PR 标题 / 描述

    三类结果分组合并返回，每类最多 per_type 条。

    Args:
        q: 搜索关键词
        per_type: 每类结果最大返回数
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 三类分组搜索结果
    """
    empty = {"query": q, "repositories": [], "issues": [], "pull_requests": []}
    keyword = q.strip()
    if not keyword:
        return empty
    pattern = f"%{keyword}%"

    accessible_ids = await get_accessible_repository_ids(db, current_user.id)
    if not accessible_ids:
        return empty

    # 仓库：名称 / 路径 / 描述
    repo_result = await db.execute(
        select(Repository)
        .filter(
            Repository.id.in_(accessible_ids),
            or_(
                Repository.name.ilike(pattern),
                Repository.path.ilike(pattern),
                Repository.description.ilike(pattern),
            ),
        )
        .order_by(Repository.updated_at.desc())
        .limit(per_type)
    )
    repositories = [
        {
            "repository_id": repo.id,
            "name": repo.name,
            "path": repo.path,
            "description": repo.description,
            "is_public": repo.is_public,
        }
        for repo in repo_result.scalars().all()
    ]

    # Issue：标题 / 描述（限定可访问仓库）
    issue_result = await db.execute(
        select(Issue, Repository.name.label("repo_name"), Repository.path.label("repo_path"))
        .join(Repository, Repository.id == Issue.repository_id)
        .filter(
            Issue.repository_id.in_(accessible_ids),
            or_(Issue.title.ilike(pattern), Issue.description.ilike(pattern)),
        )
        .order_by(Issue.updated_at.desc())
        .limit(per_type)
    )
    issues = [
        {
            "repository_id": issue.repository_id,
            "repository_name": repo_name,
            "repository_path": repo_path,
            "issue_number": issue.issue_number,
            "title": issue.title,
            "status": issue.status,
        }
        for issue, repo_name, repo_path in issue_result.all()
    ]

    # PR：标题 / 描述（限定可访问仓库）
    pr_result = await db.execute(
        select(PullRequest, Repository.name.label("repo_name"), Repository.path.label("repo_path"))
        .join(Repository, Repository.id == PullRequest.repository_id)
        .filter(
            PullRequest.repository_id.in_(accessible_ids),
            or_(PullRequest.title.ilike(pattern), PullRequest.description.ilike(pattern)),
        )
        .order_by(PullRequest.updated_at.desc())
        .limit(per_type)
    )
    pull_requests = [
        {
            "repository_id": pr.repository_id,
            "repository_name": repo_name,
            "repository_path": repo_path,
            "pr_number": pr.pr_number,
            "title": pr.title,
            "status": pr.status,
        }
        for pr, repo_name, repo_path in pr_result.all()
    ]

    return {
        "query": q,
        "repositories": repositories,
        "issues": issues,
        "pull_requests": pull_requests,
    }
