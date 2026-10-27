"""仓库标签服务模块"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
import uuid

from app.models.repository import Repository
from app.models.repo_label import RepoLabel, repo_label_association
from app.core.exception import NotFoundException, ConflictException
from app.utils.db_utils import get_or_404
from app.utils.response_builder import build_label_response, build_repo_response


async def create_label(repo_id: uuid.UUID, label_data: dict, db: AsyncSession) -> dict:
    await get_or_404(db, Repository, {"id": repo_id}, "Repository not found", error_code="repository_not_found")

    existing = await db.execute(
        select(RepoLabel).filter(
            RepoLabel.repository_id == repo_id,
            RepoLabel.name == label_data["name"],
        )
    )
    if existing.scalar_one_or_none():
        raise ConflictException(detail=f"Label '{label_data['name']}' already exists", error_code="label_already_exists")

    label = RepoLabel(
        repository_id=repo_id,
        name=label_data["name"],
        color=label_data.get("color", "#cccccc"),
        description=label_data.get("description"),
    )
    db.add(label)
    await db.flush()
    await db.refresh(label)
    return build_label_response(label)


async def get_labels(repo_id: uuid.UUID, db: AsyncSession) -> list[dict]:
    await get_or_404(db, Repository, {"id": repo_id}, "Repository not found", error_code="repository_not_found")

    result = await db.execute(
        select(RepoLabel)
        .filter(RepoLabel.repository_id == repo_id)
        .order_by(RepoLabel.name)
    )
    return [build_label_response(l) for l in result.scalars().all()]


async def update_label(repo_id: uuid.UUID, label_id: uuid.UUID, label_data: dict, db: AsyncSession) -> dict:
    label = await get_or_404(
        db, RepoLabel,
        {"id": label_id, "repository_id": repo_id},
        "Label not found", error_code="label_not_found",
    )

    if "name" in label_data and label_data["name"] != label.name:
        existing = await db.execute(
            select(RepoLabel).filter(
                RepoLabel.repository_id == repo_id,
                RepoLabel.name == label_data["name"],
                RepoLabel.id != label_id,
            )
        )
        if existing.scalar_one_or_none():
            raise ConflictException(detail=f"Label '{label_data['name']}' already exists", error_code="label_already_exists")
        label.name = label_data["name"]

    if "color" in label_data:
        label.color = label_data["color"]
    if "description" in label_data:
        label.description = label_data["description"]

    await db.flush()
    await db.refresh(label)
    return build_label_response(label)


async def delete_label(repo_id: uuid.UUID, label_id: uuid.UUID, db: AsyncSession) -> dict:
    label = await get_or_404(
        db, RepoLabel,
        {"id": label_id, "repository_id": repo_id},
        "Label not found", error_code="label_not_found",
    )
    await db.delete(label)
    await db.flush()
    return {"message": "Label deleted"}


async def add_label_to_repository(repo_id: uuid.UUID, label_id: uuid.UUID, db: AsyncSession) -> dict:
    result = await db.execute(
        select(Repository)
        .filter(Repository.id == repo_id)
        .options(selectinload(Repository.repo_labels))
    )
    repo = result.scalar_one_or_none()
    if not repo:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")

    label = await get_or_404(db, RepoLabel, {"id": label_id}, "Label not found", error_code="label_not_found")

    if label not in repo.repo_labels:
        repo.repo_labels.append(label)
        await db.flush()

    return {"message": "Label added to repository"}


async def remove_label_from_repository(repo_id: uuid.UUID, label_id: uuid.UUID, db: AsyncSession) -> dict:
    result = await db.execute(
        select(Repository)
        .filter(Repository.id == repo_id)
        .options(selectinload(Repository.repo_labels))
    )
    repo = result.scalar_one_or_none()
    if not repo:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")

    label = await get_or_404(db, RepoLabel, {"id": label_id}, "Label not found", error_code="label_not_found")

    if label in repo.repo_labels:
        repo.repo_labels.remove(label)
        await db.flush()

    return {"message": "Label removed from repository"}


async def get_repositories_by_label(label_id: uuid.UUID, db: AsyncSession) -> list[dict]:
    result = await db.execute(
        select(RepoLabel)
        .filter(RepoLabel.id == label_id)
        .options(selectinload(RepoLabel.labeled_repos))
    )
    label = result.scalar_one_or_none()
    if not label:
        raise NotFoundException(detail="Label not found", error_code="label_not_found")
    return [build_repo_response(repo) for repo in label.labeled_repos]
