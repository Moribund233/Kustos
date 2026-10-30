"""搜索域 · 跨仓库聚合检索

控制器只做参数与响应编排；「在用户可访问的仓库里搜代码」「按类型分组搜
仓库/Issue/PR」这两类**聚合查询**属于业务规则，放在这里。

与 :mod:`app.services.search.service` 的区别：那个模块管**单个仓库**的索引
与检索；本模块管**跨仓库**的编排与分组。
"""
from dataclasses import asdict
from typing import Any, Dict, List, Optional

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.issue import Issue
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.services.repository.repository_service import get_accessible_repository_ids
from app.services.search.service import SearchService
from app.utils.git_utils import get_repository_storage_path


async def search_across_repositories(
    db: AsyncSession,
    user_id,
    q: str,
    path: Optional[str] = None,
    ref: Optional[str] = None,
    max_results: int = 50,
    per_repo_max: int = 10,
) -> Dict[str, Any]:
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
    accessible_ids = await get_accessible_repository_ids(db, user_id)

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


async def search_global_entities(
    db: AsyncSession,
    user_id,
    q: str,
    per_type: int = 20,
) -> Dict[str, Any]:
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

    accessible_ids = await get_accessible_repository_ids(db, user_id)
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
