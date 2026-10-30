"""Pull Request 标签服务模块"""
import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.repository import Repository
from app.models.pull_request import PullRequest
from app.models.pr_label import PRLabel
from app.core.exception import NotFoundException, ConflictException
from app.utils.db_utils import get_or_404
from app.utils.response_builder import build_label_response, build_pr_response


async def _get_pr_with_labels_or_404(
    db: AsyncSession,
    repository_id: uuid.UUID,
    pr_number: int,
) -> PullRequest:
    """
    获取 PR 并预加载 pr_labels 关系

    AsyncSession 下直接访问未预加载的关系会触发同步懒加载
    (MissingGreenlet)，必须 selectinload 预加载。
    """
    result = await db.execute(
        select(PullRequest)
        .options(selectinload(PullRequest.pr_labels))
        .filter(
            PullRequest.repository_id == repository_id,
            PullRequest.pr_number == pr_number,
        )
    )
    pr = result.scalar_one_or_none()
    if not pr:
        raise NotFoundException(detail=f"Pull Request #{pr_number} not found", error_code="pr_not_found")
    return pr


async def create_label(repo_id: uuid.UUID, data: dict, db: AsyncSession) -> dict:
    """创建 PR 标签"""
    await get_or_404(db, Repository, {"id": repo_id}, "Repository not found", error_code="repository_not_found")

    existing = await db.execute(
        select(PRLabel).filter(
            PRLabel.repository_id == repo_id,
            PRLabel.name == data["name"],
        )
    )
    if existing.scalar_one_or_none():
        raise ConflictException(detail=f"Label '{data['name']}' already exists", error_code="label_already_exists")

    label = PRLabel(
        repository_id=repo_id,
        name=data["name"],
        color=data.get("color", "#cccccc"),
        description=data.get("description"),
    )
    db.add(label)
    await db.flush()
    await db.refresh(label)
    return build_label_response(label)


async def get_labels(repo_id: uuid.UUID, db: AsyncSession) -> list[dict]:
    """获取仓库的所有 PR 标签"""
    await get_or_404(db, Repository, {"id": repo_id}, "Repository not found", error_code="repository_not_found")

    result = await db.execute(
        select(PRLabel)
        .filter(PRLabel.repository_id == repo_id)
        .order_by(PRLabel.name)
    )
    return [build_label_response(l) for l in result.scalars().all()]


async def update_label(repo_id: uuid.UUID, label_id: uuid.UUID, data: dict, db: AsyncSession) -> dict:
    """更新 PR 标签"""
    label = await get_or_404(
        db, PRLabel,
        {"id": label_id, "repository_id": repo_id},
        "Label not found", error_code="label_not_found",
    )

    if "name" in data and data["name"] != label.name:
        existing = await db.execute(
            select(PRLabel).filter(
                PRLabel.repository_id == repo_id,
                PRLabel.name == data["name"],
                PRLabel.id != label_id,
            )
        )
        if existing.scalar_one_or_none():
            raise ConflictException(detail=f"Label '{data['name']}' already exists", error_code="label_already_exists")
        label.name = data["name"]

    if "color" in data:
        label.color = data["color"]
    if "description" in data:
        label.description = data["description"]

    await db.flush()
    await db.refresh(label)
    return build_label_response(label)


async def delete_label(repo_id: uuid.UUID, label_id: uuid.UUID, db: AsyncSession) -> dict:
    """删除 PR 标签"""
    label = await get_or_404(
        db, PRLabel,
        {"id": label_id, "repository_id": repo_id},
        "Label not found", error_code="label_not_found",
    )
    await db.delete(label)
    await db.flush()
    return {"message": "Label deleted"}


async def add_label_to_pr(
    repository_id: uuid.UUID,
    pr_number: int,
    label_id: uuid.UUID,
    db: AsyncSession,
) -> dict:
    """为 PR 添加标签

    Args:
        repository_id: 仓库ID
        pr_number: PR 编号（仓库内自增）
        label_id: 标签ID
        db: 数据库会话

    Returns:
        dict: 操作结果

    Raises:
        NotFoundException: PR 或标签不存在
    """
    pr = await _get_pr_with_labels_or_404(db, repository_id, pr_number)
    label = await get_or_404(
        db,
        PRLabel,
        {"id": label_id, "repository_id": repository_id},
        "Label not found", error_code="label_not_found",
    )

    if label not in pr.pr_labels:
        pr.pr_labels.append(label)
        await db.flush()

    return {"message": "Label added to pull request"}


async def remove_label_from_pr(
    repository_id: uuid.UUID,
    pr_number: int,
    label_id: uuid.UUID,
    db: AsyncSession,
) -> dict:
    """从 PR 移除标签

    Args:
        repository_id: 仓库ID
        pr_number: PR 编号（仓库内自增）
        label_id: 标签ID
        db: 数据库会话

    Returns:
        dict: 操作结果

    Raises:
        NotFoundException: PR 或标签不存在
    """
    pr = await _get_pr_with_labels_or_404(db, repository_id, pr_number)
    label = await get_or_404(
        db,
        PRLabel,
        {"id": label_id, "repository_id": repository_id},
        "Label not found", error_code="label_not_found",
    )

    if label in pr.pr_labels:
        pr.pr_labels.remove(label)
        await db.flush()

    return {"message": "Label removed from pull request"}


async def get_prs_by_label(label_id: uuid.UUID, db: AsyncSession) -> list[dict]:
    """获取使用指定标签的所有 PR"""
    result = await db.execute(
        select(PRLabel)
        .filter(PRLabel.id == label_id)
        .options(
            selectinload(PRLabel.labeled_prs).options(
                selectinload(PullRequest.author),
                selectinload(PullRequest.merger),
                selectinload(PullRequest.pr_labels),
            )
        )
    )
    label = result.scalar_one_or_none()
    if not label:
        raise NotFoundException(detail="Label not found", error_code="label_not_found")
    return [build_pr_response(pr) for pr in label.labeled_prs]
