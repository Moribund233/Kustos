"""
Issue 控制器层

处理 Issue 相关的 HTTP 请求
"""
from typing import Optional, List, Dict, Any
import uuid
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.prefixes import get_route_prefix
from app.core.permissions import Action
from app.api.guards import require_repo_permission, require_repo_read
from app.models.async_db import get_async_db
from app.models.user import User
from app.api.deps import get_current_user
from app.services.issue_service import (
    list_issues as service_list_issues,
    get_issue as service_get_issue,
    create_issue as service_create_issue,
    update_issue as service_update_issue,
    close_issue as service_close_issue,
    reopen_issue as service_reopen_issue,
    create_issue_comment as service_create_issue_comment,
    list_issue_comments as service_list_issue_comments,
    filter_issues as service_filter_issues,
    batch_close_issues as service_batch_close_issues,
    batch_reopen_issues as service_batch_reopen_issues,
    batch_update_issues as service_batch_update_issues,
    batch_add_labels as service_batch_add_labels,
    batch_remove_labels as service_batch_remove_labels,
)
from app.services.pr_issue_link_service import (
    list_linked_pull_requests as service_list_linked_prs,
    link_pr_to_issue as service_link_pr_to_issue,
    unlink_pr_from_issue as service_unlink_pr_from_issue,
)

# 创建路由实例
# router 级读可见性（issue 列表/详情/评论此前完全匿名可达）
router = APIRouter(
    prefix=get_route_prefix("issues"),
    tags=["issues"],
    dependencies=[Depends(require_repo_read())],
)


class IssueLinkPRRequest(BaseModel):
    """关联 PR 请求体"""
    pr_number: int = Field(..., gt=0, description="同仓库内的 PR 编号")
    closes_on_merge: bool = Field(default=True, description="该 PR 合并时自动关闭此 Issue")


class IssueCreateRequest(BaseModel):
    """创建 Issue 请求体"""
    title: str = Field(..., min_length=1, max_length=255, description="标题")
    description: Optional[str] = Field(None, description="描述")
    priority: str = Field(default="medium", description="优先级：low/medium/high/critical")
    assignee_id: Optional[uuid.UUID] = Field(None, description="指派人ID")
    label_ids: Optional[List[uuid.UUID]] = Field(None, description="标签ID列表")


class IssueUpdateRequest(BaseModel):
    """更新 Issue 请求体"""
    title: Optional[str] = Field(None, min_length=1, max_length=255, description="标题")
    description: Optional[str] = Field(None, description="描述")
    priority: Optional[str] = Field(None, description="优先级：low/medium/high/critical")
    assignee_id: Optional[uuid.UUID] = Field(None, description="指派人ID")
    label_ids: Optional[List[uuid.UUID]] = Field(None, description="标签ID列表")


class IssueCommentCreateRequest(BaseModel):
    """创建 Issue 评论请求体"""
    content: str = Field(..., min_length=1, description="评论内容")


@router.get("/{repo_id}/issues")
async def list_issues(
    repo_id: uuid.UUID,
    status: Optional[str] = Query(None, description="状态筛选：open/closed"),
    label: Optional[str] = Query(None, description="标签名称筛选"),
    assignee: Optional[uuid.UUID] = Query(None, description="指派人ID筛选"),
    author: Optional[uuid.UUID] = Query(None, description="作者ID筛选"),
    page: int = Query(1, ge=1, description="页码"),
    limit: int = Query(20, ge=1, le=100, description="每页数量"),
    db: AsyncSession = Depends(get_async_db)
):
    """
    获取 Issue 列表
    
    Args:
        repo_id: 仓库ID
        status: 状态筛选
        label: 标签名称筛选
        assignee: 指派人ID筛选
        author: 作者ID筛选
        page: 页码
        limit: 每页数量
        db: 数据库会话
    
    Returns:
        dict: Issue 列表和分页信息
    """
    return await service_list_issues(
        db=db,
        repository_id=repo_id,
        status=status,
        label=label,
        assignee_id=assignee,
        author_id=author,
        page=page,
        limit=limit
    )


@router.post("/{repo_id}/issues")
async def create_issue(
    repo_id: uuid.UUID,
    data: IssueCreateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
    # 决策：GitHub 式参与——公开仓登录即可建，私仓需成员（矩阵单点裁决）
    _perm=Depends(require_repo_permission(Action.ISSUE_CREATE, "create issues")),
):
    return await service_create_issue(
        db=db,
        repository_id=repo_id,
        author_id=current_user.id,
        title=data.title,
        description=data.description,
        priority=data.priority,
        assignee_id=data.assignee_id,
        label_ids=data.label_ids
    )


# ==================== Issue 高级筛选 ====================


class IssueFilterRequest(BaseModel):
    """Issue 筛选请求体"""
    statuses: Optional[List[str]] = Field(None, description="状态列表")
    priorities: Optional[List[str]] = Field(None, description="优先级列表")
    assignee_ids: Optional[List[uuid.UUID]] = Field(None, description="指派人ID列表")
    author_ids: Optional[List[uuid.UUID]] = Field(None, description="作者ID列表")
    label_ids: Optional[List[uuid.UUID]] = Field(None, description="标签ID列表")
    search: Optional[str] = Field(None, description="搜索关键词")


class BatchIssueNumbersRequest(BaseModel):
    """批量操作请求体"""
    issue_numbers: List[int] = Field(..., description="Issue 编号列表", min_length=1)


class BatchUpdateRequest(BaseModel):
    """批量更新请求体"""
    issue_numbers: List[int] = Field(..., description="Issue 编号列表", min_length=1)
    updates: Dict[str, Any] = Field(..., description="更新字段")


class BatchLabelsRequest(BaseModel):
    """批量标签操作请求体"""
    issue_numbers: List[int] = Field(..., description="Issue 编号列表", min_length=1)
    label_ids: List[uuid.UUID] = Field(..., description="标签ID列表", min_length=1)


@router.post("/{repo_id}/issues/filter")
async def filter_issues(
    repo_id: uuid.UUID,
    data: IssueFilterRequest,
    sort_by: str = Query("created_at", description="排序字段"),
    sort_order: str = Query("desc", description="排序方向"),
    page: int = Query(1, ge=1, description="页码"),
    per_page: int = Query(20, ge=1, le=100, description="每页数量"),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    高级筛选 Issue

    Args:
        repo_id: 仓库ID
        data: 筛选条件
        sort_by: 排序字段
        sort_order: 排序方向
        page: 页码
        per_page: 每页数量
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 筛选结果
    """
    filters = data.model_dump(exclude_none=True)
    return await service_filter_issues(
        db=db,
        repository_id=repo_id,
        filters=filters,
        sort_by=sort_by,
        sort_order=sort_order,
        page=page,
        per_page=per_page
    )


# ==================== Issue 批量操作 ====================


@router.post("/{repo_id}/issues/batch/close")
async def batch_close_issues(
    repo_id: uuid.UUID,
    data: BatchIssueNumbersRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    批量关闭 Issue

    Args:
        repo_id: 仓库ID
        data: Issue 编号列表
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 操作结果统计
    """
    return await service_batch_close_issues(
        db=db,
        repository_id=repo_id,
        user_id=current_user.id,
        issue_numbers=data.issue_numbers
    )


@router.post("/{repo_id}/issues/batch/reopen")
async def batch_reopen_issues(
    repo_id: uuid.UUID,
    data: BatchIssueNumbersRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    批量重新打开 Issue

    Args:
        repo_id: 仓库ID
        data: Issue 编号列表
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 操作结果统计
    """
    return await service_batch_reopen_issues(
        db=db,
        repository_id=repo_id,
        user_id=current_user.id,
        issue_numbers=data.issue_numbers
    )


@router.patch("/{repo_id}/issues/batch")
async def batch_update_issues(
    repo_id: uuid.UUID,
    data: BatchUpdateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    批量更新 Issue

    Args:
        repo_id: 仓库ID
        data: 更新数据
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 操作结果统计
    """
    return await service_batch_update_issues(
        db=db,
        repository_id=repo_id,
        user_id=current_user.id,
        issue_numbers=data.issue_numbers,
        updates=data.updates
    )


@router.post("/{repo_id}/issues/batch/labels")
async def batch_add_labels(
    repo_id: uuid.UUID,
    data: BatchLabelsRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    批量为 Issue 添加标签

    Args:
        repo_id: 仓库ID
        data: Issue 编号和标签ID列表
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 操作结果统计
    """
    return await service_batch_add_labels(
        db=db,
        repository_id=repo_id,
        user_id=current_user.id,
        issue_numbers=data.issue_numbers,
        label_ids=data.label_ids
    )


@router.delete("/{repo_id}/issues/batch/labels")
async def batch_remove_labels(
    repo_id: uuid.UUID,
    data: BatchLabelsRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    批量从 Issue 移除标签

    Args:
        repo_id: 仓库ID
        data: Issue 编号和标签ID列表
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 操作结果统计
    """
    return await service_batch_remove_labels(
        db=db,
        repository_id=repo_id,
        user_id=current_user.id,
        issue_numbers=data.issue_numbers,
        label_ids=data.label_ids
    )


@router.get("/{repo_id}/issues/{issue_number}")
async def get_issue(
    repo_id: uuid.UUID,
    issue_number: int,
    db: AsyncSession = Depends(get_async_db)
):
    """
    获取 Issue 详情
    
    Args:
        repo_id: 仓库ID
        issue_number: Issue 编号
        db: 数据库会话
    
    Returns:
        dict: Issue 详情（包含评论）
    """
    return await service_get_issue(
        db=db,
        repository_id=repo_id,
        issue_number=issue_number,
        include_details=True
    )


@router.patch("/{repo_id}/issues/{issue_number}")
async def update_issue(
    repo_id: uuid.UUID,
    issue_number: int,
    data: IssueUpdateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    更新 Issue

    Args:
        repo_id: 仓库ID
        issue_number: Issue 编号
        data: 更新数据
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 更新后的 Issue 数据
    """
    return await service_update_issue(
        db=db,
        repository_id=repo_id,
        issue_number=issue_number,
        user_id=current_user.id,
        title=data.title,
        description=data.description,
        priority=data.priority,
        assignee_id=data.assignee_id,
        label_ids=data.label_ids
    )


@router.post("/{repo_id}/issues/{issue_number}/close")
async def close_issue(
    repo_id: uuid.UUID,
    issue_number: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    关闭 Issue

    Args:
        repo_id: 仓库ID
        issue_number: Issue 编号
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 更新后的 Issue 数据
    """
    return await service_close_issue(
        db=db,
        repository_id=repo_id,
        issue_number=issue_number,
        user_id=current_user.id
    )


@router.post("/{repo_id}/issues/{issue_number}/reopen")
async def reopen_issue(
    repo_id: uuid.UUID,
    issue_number: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    """
    重新打开 Issue

    Args:
        repo_id: 仓库ID
        issue_number: Issue 编号
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 更新后的 Issue 数据
    """
    return await service_reopen_issue(
        db=db,
        repository_id=repo_id,
        issue_number=issue_number,
        user_id=current_user.id
    )


# ==================== Issue 评论 ====================

@router.get("/{repo_id}/issues/{issue_number}/comments")
async def list_issue_comments(
    repo_id: uuid.UUID,
    issue_number: int,
    db: AsyncSession = Depends(get_async_db)
):
    """
    获取 Issue 评论列表

    Args:
        repo_id: 仓库ID
        issue_number: Issue 编号
        db: 数据库会话

    Returns:
        list: 评论列表
    """
    return await service_list_issue_comments(
        db=db,
        repository_id=repo_id,
        issue_number=issue_number
    )


@router.post("/{repo_id}/issues/{issue_number}/comments")
async def create_issue_comment(
    repo_id: uuid.UUID,
    issue_number: int,
    data: IssueCommentCreateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
    _perm=Depends(require_repo_permission(Action.COMMENT_CREATE, "comment on issues")),
):
    """
    创建 Issue 评论

    Args:
        repo_id: 仓库ID
        issue_number: Issue 编号
        data: 评论数据
        db: 数据库会话
        current_user: 当前认证用户

    Returns:
        dict: 创建的评论数据
    """
    return await service_create_issue_comment(
        db=db,
        repository_id=repo_id,
        issue_number=issue_number,
        author_id=current_user.id,
        content=data.content
    )




# ==================== 关联 PR ====================

@router.get("/{repo_id}/issues/{issue_number}/pull-requests")
async def list_issue_linked_prs(
    repo_id: uuid.UUID,
    issue_number: int,
    db: AsyncSession = Depends(get_async_db),
):
    """列出关联该 Issue 的 PR。"""
    return await service_list_linked_prs(
        db=db, repository_id=repo_id, issue_number=issue_number
    )


@router.post("/{repo_id}/issues/{issue_number}/pull-requests", status_code=201)
async def link_issue_pr(
    repo_id: uuid.UUID,
    issue_number: int,
    data: IssueLinkPRRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """从 Issue 侧关联一个 PR（幂等）。"""
    return await service_link_pr_to_issue(
        db=db,
        repository_id=repo_id,
        issue_number=issue_number,
        actor_id=current_user.id,
        pr_number=data.pr_number,
        closes_on_merge=data.closes_on_merge,
    )


@router.delete("/{repo_id}/issues/{issue_number}/pull-requests/{pr_number}")
async def unlink_issue_pr(
    repo_id: uuid.UUID,
    issue_number: int,
    pr_number: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """解除 Issue 与 PR 的关联。"""
    return await service_unlink_pr_from_issue(
        db=db,
        repository_id=repo_id,
        issue_number=issue_number,
        actor_id=current_user.id,
        pr_number=pr_number,
    )
