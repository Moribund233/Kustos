"""Pull Request 标签控制器"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.prefixes import get_route_prefix
from app.core.permissions import Action, ensure_repo_action
from app.models.async_db import get_async_db
from app.models.user import User
from app.api.deps import get_current_user
from app.services.collaboration import pr_label_service
import uuid
from app.api.guards import require_repo_read

router = APIRouter(
    prefix=get_route_prefix("repositories"), tags=["pr-labels"],
    dependencies=[Depends(require_repo_read())],
)


@router.get("/{repo_id}/pr-labels")
async def get_labels(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    return await pr_label_service.get_labels(repo_id, db)


@router.post("/{repo_id}/pr-labels", status_code=201)
async def create_label(
    repo_id: uuid.UUID,
    data: dict,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_repo_action(db, current_user.id, repo_id, Action.PRLABEL_MANAGE, "create PR labels")
    return await pr_label_service.create_label(repo_id, data, db)


@router.put("/{repo_id}/pr-labels/{label_id}")
async def update_label(
    repo_id: uuid.UUID,
    label_id: uuid.UUID,
    data: dict,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_repo_action(db, current_user.id, repo_id, Action.PRLABEL_MANAGE, "update PR labels")
    return await pr_label_service.update_label(repo_id, label_id, data, db)


@router.delete("/{repo_id}/pr-labels/{label_id}")
async def delete_label(
    repo_id: uuid.UUID,
    label_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_repo_action(db, current_user.id, repo_id, Action.PRLABEL_MANAGE, "delete PR labels")
    return await pr_label_service.delete_label(repo_id, label_id, db)


@router.post("/{repo_id}/pull-requests/{pr_number}/labels/{label_id}")
async def add_label_to_pr(
    repo_id: uuid.UUID,
    pr_number: int,
    label_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """为指定仓库的 PR 添加标签

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        label_id: 标签ID
    """
    await ensure_repo_action(db, current_user.id, repo_id, Action.PRLABEL_MANAGE, "add labels to pull requests")
    return await pr_label_service.add_label_to_pr(repo_id, pr_number, label_id, db)


@router.delete("/{repo_id}/pull-requests/{pr_number}/labels/{label_id}")
async def remove_label_from_pr(
    repo_id: uuid.UUID,
    pr_number: int,
    label_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """从指定仓库的 PR 移除标签

    Args:
        repo_id: 仓库ID
        pr_number: PR 编号
        label_id: 标签ID
    """
    await ensure_repo_action(db, current_user.id, repo_id, Action.PRLABEL_MANAGE, "remove labels from pull requests")
    return await pr_label_service.remove_label_from_pr(repo_id, pr_number, label_id, db)


@router.get("/pr-labels/{label_id}/pull-requests")
async def get_prs_by_label(
    label_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    return await pr_label_service.get_prs_by_label(label_id, db)
