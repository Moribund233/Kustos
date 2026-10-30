from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.prefixes import get_route_prefix
from app.core.permissions import Action
from app.api.guards import require_repo_action
from app.models.async_db import get_async_db
from app.services import label_service
import uuid
from app.api.guards import require_repo_read

router = APIRouter(
    prefix=get_route_prefix("repositories"), tags=["repo-labels"],
    dependencies=[Depends(require_repo_read())],
)


@router.get("/{repo_id}/labels")
async def get_labels(
    repo_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
):
    return await label_service.get_labels(repo_id, db)


@router.post("/{repo_id}/labels", status_code=201)
async def create_label(
    repo_id: uuid.UUID,
    label_data: dict,
    db: AsyncSession = Depends(get_async_db),
    _perm: None = Depends(require_repo_action(Action.LABEL_MANAGE, "create labels")),
):
    return await label_service.create_label(repo_id, label_data, db)


@router.put("/{repo_id}/labels/{label_id}")
async def update_label(
    repo_id: uuid.UUID,
    label_id: uuid.UUID,
    label_data: dict,
    db: AsyncSession = Depends(get_async_db),
    _perm: None = Depends(require_repo_action(Action.LABEL_MANAGE, "update labels")),
):
    return await label_service.update_label(repo_id, label_id, label_data, db)


@router.delete("/{repo_id}/labels/{label_id}")
async def delete_label(
    repo_id: uuid.UUID,
    label_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    _perm: None = Depends(require_repo_action(Action.LABEL_MANAGE, "delete labels")),
):
    return await label_service.delete_label(repo_id, label_id, db)


@router.post("/{repo_id}/labels/{label_id}/add")
async def add_label_to_repository(
    repo_id: uuid.UUID,
    label_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    _perm: None = Depends(require_repo_action(Action.LABEL_MANAGE, "manage labels")),
):
    return await label_service.add_label_to_repository(repo_id, label_id, db)


@router.post("/{repo_id}/labels/{label_id}/remove")
async def remove_label_from_repository(
    repo_id: uuid.UUID,
    label_id: uuid.UUID,
    db: AsyncSession = Depends(get_async_db),
    _perm: None = Depends(require_repo_action(Action.LABEL_MANAGE, "manage labels")),
):
    return await label_service.remove_label_from_repository(repo_id, label_id, db)
