"""
Pull Request 控制器层

处理 Pull Request 相关的 HTTP 请求
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
import uuid

from app.api.prefixes import get_route_prefix
from app.core.permissions import Action
from app.api.guards import require_repo_permission, require_repo_read
from app.models.async_db import get_async_db
from app.models.user import User
from app.api.deps import get_current_user
from app.services.collaboration.pull_request_service import (
    list_pull_requests as service_list_pull_requests,
    get_pull_request as service_get_pull_request,
    create_pull_request as service_create_pull_request,
    update_pull_request as service_update_pull_request,
    close_pull_request as service_close_pull_request,
    merge_pull_request as service_merge_pull_request,
    create_pr_comment as service_create_pr_comment,
    create_pr_review as service_create_pr_review,
    list_pr_comments as service_list_pr_comments,
    get_pr_diff as service_get_pr_diff,
    get_pr_file_diff as service_get_pr_file_diff,
)
from app.services.collaboration.pr_issue_link_service import (
    list_linked_issues as service_list_linked_issues,
    link_issue_to_pr as service_link_issue_to_pr,
    unlink_issue_from_pr as service_unlink_issue_from_pr,
)
from app.services.collaboration.pr_review_request_service import (
    list_review_requests as service_list_review_requests,
    request_reviewers as service_request_reviewers,
    remove_reviewer as service_remove_reviewer,
)

# 创建路由实例
# router 级读可见性（PR 列表/详情/diff 此前匿名可达）
router = APIRouter(
    prefix=get_route_prefix("pull_requests"),
    tags=["pull-requests"],
    dependencies=[Depends(require_repo_read())],
)


class PRCreateRequest(BaseModel):
    """创建 PR 请求体"""
    title: str = Field(..., min_length=1, max_length=255, description="PR 标题")
    description: Optional[str] = Field(None, description="PR 描述")
    source_branch: str = Field(..., min_length=1, max_length=100, description="源分支")
    target_branch: str = Field(..., min_length=1, max_length=100, description="目标分支")


class PRUpdateRequest(BaseModel):
    """更新 PR 请求体"""
    title: Optional[str] = Field(None, min_length=1, max_length=255, description="PR 标题")
    description: Optional[str] = Field(None, description="PR 描述")


class PRCommentCreateRequest(BaseModel):
    """创建 PR 评论请求体"""
    content: str = Field(..., min_length=1, description="评论内容")
    file_path: Optional[str] = Field(None, description="文件路径（行级评论）")
    line_number: Optional[int] = Field(None, description="行号（行级评论）")
    commit_hash: Optional[str] = Field(None, description="提交哈希（行级评论）")
    parent_id: Optional[uuid.UUID] = Field(None, description="父评论ID（回复）")


class PRReviewRequest(BaseModel):
    """PR 审查请求体"""
    status: str = Field(..., description="审查状态：approved/changes_requested")
    comment: Optional[str] = Field(None, description="审查意见")


class PRMergeRequest(BaseModel):
    """PR 合并请求体"""
    merge_method: str = Field(default="merge", description="合并方式：merge/squash/rebase")
    override: bool = Field(default=False, description="admin bypass：跳过保护分支裁决（需仓库 owner/admin，留审计）")
    override_reason: Optional[str] = Field(default=None, description="bypass 原因（写入 PR 活动流）")


class PRLinkIssueRequest(BaseModel):
    """关联 Issue 请求体"""
    issue_number: int = Field(..., gt=0, description="同仓库内的 Issue 编号")
    closes_on_merge: bool = Field(default=True, description="合并 PR 时自动关闭该 Issue")


class PRReviewersRequest(BaseModel):
    """请求评审请求体（user_ids 与 usernames 二选一或并用）"""
    user_ids: Optional[List[uuid.UUID]] = Field(default=None, description="评审人用户ID列表")
    usernames: Optional[List[str]] = Field(default=None, description="评审人用户名列表")


@router.get("/{repo_id}/pull-requests")
async def list_pull_requests(
    repo_id: uuid.UUID,
    status: Optional[str] = Query(None, description="状态筛选：open/merged/closed"),
    author: Optional[uuid.UUID] = Query(None, description="作者ID筛选"),
    page: int = Query(1, ge=1, description="页码"),
    limit: int = Query(20, ge=1, le=100, description="每页数量"),
    db: AsyncSession = Depends(get_async_db)
):
    """
    获取 PR 列表

    Args:
        repo_id: 仓库ID
        status: 状态筛选
        author: 作者ID筛选
        page: 页码
        limit: 每页数量
        db: 数据库会话

    Returns:
        dict: PR 列表和分页信息
    """
    return await service_list_pull_requests(
        db=db,
        repository_id=repo_id,
        status=status,
        author_id=author,
        page=page,
        limit=limit
    )


@router.post("/{repo_id}/pull-requests")
async def create_pull_request(
    repo_id: uuid.UUID,
    data: PRCreateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
    _perm=Depends(require_repo_permission(Action.PR_CREATE, "create pull requests")),
):
    """
    创建 Pull Request

    Args:
        repo_id: 仓库ID
        data: PR 创建数据
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 创建的 PR 数据
    """
    return await service_create_pull_request(
        db=db,
        repository_id=repo_id,
        author_id=current_user.id,
        title=data.title,
        description=data.description,
        source_branch=data.source_branch,
        target_branch=data.target_branch
    )


@router.get("/{repo_id}/pull-requests/{pr_number}")
async def get_pull_request(
    repo_id: uuid.UUID,
    pr_number: int,
    db: AsyncSession = Depends(get_async_db)
):
    """
    获取 PR 详情

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        db: 数据库会话

    Returns:
        dict: PR 详情（包含评论和审查）
    """
    return await service_get_pull_request(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        include_details=True
    )


@router.patch("/{repo_id}/pull-requests/{pr_number}")
async def update_pull_request(
    repo_id: uuid.UUID,
    pr_number: int,
    data: PRUpdateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    更新 Pull Request

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        data: 更新数据
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 更新后的 PR 数据
    """
    return await service_update_pull_request(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        user_id=current_user.id,
        title=data.title,
        description=data.description
    )


@router.post("/{repo_id}/pull-requests/{pr_number}/close")
async def close_pull_request(
    repo_id: uuid.UUID,
    pr_number: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    关闭 Pull Request

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 更新后的 PR 数据
    """
    return await service_close_pull_request(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        user_id=current_user.id
    )


@router.post("/{repo_id}/pull-requests/{pr_number}/merge")
async def merge_pull_request(
    repo_id: uuid.UUID,
    pr_number: int,
    data: PRMergeRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    合并 Pull Request

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        data: 合并请求数据
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 更新后的 PR 数据
    """
    return await service_merge_pull_request(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        merger_id=current_user.id,
        merge_method=data.merge_method,
        override=data.override,
        override_reason=data.override_reason
    )


# ==================== PR 评论 ====================

@router.get("/{repo_id}/pull-requests/{pr_number}/comments")
async def list_pr_comments(
    repo_id: uuid.UUID,
    pr_number: int,
    db: AsyncSession = Depends(get_async_db)
):
    """
    获取 PR 评论列表

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        db: 数据库会话

    Returns:
        list: 评论列表
    """
    return await service_list_pr_comments(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number
    )


@router.post("/{repo_id}/pull-requests/{pr_number}/comments")
async def create_pr_comment(
    repo_id: uuid.UUID,
    pr_number: int,
    data: PRCommentCreateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
    _perm=Depends(require_repo_permission(Action.COMMENT_CREATE, "comment on pull requests")),
):
    """
    创建 PR 评论

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        data: 评论数据
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 创建的评论数据
    """
    return await service_create_pr_comment(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        author_id=current_user.id,
        content=data.content,
        file_path=data.file_path,
        line_number=data.line_number,
        commit_hash=data.commit_hash,
        parent_id=data.parent_id
    )


# ==================== PR 审查 ====================

@router.post("/{repo_id}/pull-requests/{pr_number}/reviews")
async def create_pr_review(
    repo_id: uuid.UUID,
    pr_number: int,
    data: PRReviewRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    创建 PR 审查

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        data: 审查数据
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 创建的审查数据
    """
    return await service_create_pr_review(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        reviewer_id=current_user.id,
        status=data.status,
        comment=data.comment
    )


# ==================== PR Diff ====================

@router.get("/{repo_id}/pull-requests/{pr_number}/diff")
async def get_pr_diff(
    repo_id: uuid.UUID,
    pr_number: int,
    db: AsyncSession = Depends(get_async_db)
):
    """
    获取 PR 的整体 diff（文本 + 文件列表 + 统计）

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        db: 数据库会话

    Returns:
        dict: {diff, files, stats, base_commit, head_commit}
    """
    return await service_get_pr_diff(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number
    )


@router.get("/{repo_id}/pull-requests/{pr_number}/diff/{file_path:path}")
async def get_pr_file_diff(
    repo_id: uuid.UUID,
    pr_number: int,
    file_path: str,
    db: AsyncSession = Depends(get_async_db)
):
    """
    获取 PR 中单个文件的 diff

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        file_path: 文件路径
        db: 数据库会话

    Returns:
        dict: {file_path, diff, base_commit, head_commit}
    """
    return await service_get_pr_file_diff(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        file_path=file_path
    )


# ==================== 关联 Issue ====================

@router.get("/{repo_id}/pull-requests/{pr_number}/issues")
async def list_pr_linked_issues(
    repo_id: uuid.UUID,
    pr_number: int,
    db: AsyncSession = Depends(get_async_db),
):
    """列出该 PR 关联的 Issue。"""
    return await service_list_linked_issues(db=db, repository_id=repo_id, pr_number=pr_number)


@router.post("/{repo_id}/pull-requests/{pr_number}/issues", status_code=201)
async def link_pr_issue(
    repo_id: uuid.UUID,
    pr_number: int,
    data: PRLinkIssueRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """把同仓库的 Issue 关联到该 PR（幂等）。"""
    return await service_link_issue_to_pr(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        actor_id=current_user.id,
        issue_number=data.issue_number,
        closes_on_merge=data.closes_on_merge,
    )


@router.delete("/{repo_id}/pull-requests/{pr_number}/issues/{issue_number}")
async def unlink_pr_issue(
    repo_id: uuid.UUID,
    pr_number: int,
    issue_number: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """解除该 PR 与 Issue 的关联。"""
    return await service_unlink_issue_from_pr(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        actor_id=current_user.id,
        issue_number=issue_number,
    )


# ==================== 评审请求 ====================

@router.get("/{repo_id}/pull-requests/{pr_number}/reviewers")
async def list_pr_reviewers(
    repo_id: uuid.UUID,
    pr_number: int,
    db: AsyncSession = Depends(get_async_db),
):
    """列出被请求的评审人，state 由已提交的评审推导。"""
    return await service_list_review_requests(db=db, repository_id=repo_id, pr_number=pr_number)


@router.post("/{repo_id}/pull-requests/{pr_number}/reviewers", status_code=201)
async def request_pr_reviewers(
    repo_id: uuid.UUID,
    pr_number: int,
    data: PRReviewersRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """请求一个或多个仓库成员评审该 PR（重复请求幂等）。"""
    return await service_request_reviewers(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        actor_id=current_user.id,
        user_ids=data.user_ids,
        usernames=data.usernames,
    )


@router.delete("/{repo_id}/pull-requests/{pr_number}/reviewers/{reviewer_id}")
async def remove_pr_reviewer(
    repo_id: uuid.UUID,
    pr_number: int,
    reviewer_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """撤回评审请求（已提交的评审记录不受影响）。"""
    return await service_remove_reviewer(
        db=db,
        repository_id=repo_id,
        pr_number=pr_number,
        actor_id=current_user.id,
        reviewer_id=reviewer_id,
    )
