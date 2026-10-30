"""
协作草稿发布控制器

POST /{repo_id}/collab/publish — 把草稿分支 squash 成工作分支上的一次发布提交:

- 协作保存一律落 `collab/draft-{branch}` 草稿分支, 正式历史不被保存洪泛;
- 发布时草稿侧全部变更压成目标分支顶端的一次提交, 成功后草稿重置;
- 落正式分支 → 与 Editor 保存链路同一权限 (REPO_WRITE) 与分支保护裁决。
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.guards import require_repo_permission
from app.api.prefixes import get_route_prefix
from app.core.config import get_config_value
from app.core.permissions import Action
from app.models import User
from app.models.async_db import get_async_db
from app.services.repository.repository_browser_service import publish_draft
from app.services.repository.repository_service import (
    fetch_repository,
    fetch_repository_storage_path,
)

router = APIRouter(prefix=get_route_prefix("repositories"), tags=["collab-publish"])


class PublishDraftRequest(BaseModel):
    """草稿发布请求体"""
    branch: Optional[str] = Field(None, description="目标工作分支, 默认仓库默认分支")
    message: Optional[str] = Field(None, description="发布提交信息")


class PublishDraftResponse(BaseModel):
    """草稿发布结果: 无待发布变更时 commit_id 为 None、paths 为空"""
    commit_id: Optional[str] = Field(None, description="发布提交 SHA; 无变更时为 None")
    branch: str = Field(..., description="发布落点的工作分支")
    paths: list = Field(..., description="本次发布的文件路径列表")


@router.post("/{repo_id}/collab/publish", response_model=PublishDraftResponse)
async def publish_collab_draft(
    repo_id: uuid.UUID,
    data: PublishDraftRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
    _perm: None = Depends(require_repo_permission(Action.REPO_WRITE, "publish collab draft")),
):
    """
    发布协作草稿: 草稿分支 squash 成目标分支上的一次提交

    Returns:
        {commit_id, branch, paths}; 无待发布变更时 commit_id 为 None
    """
    repo = await fetch_repository(db, repo_id)
    branch = data.branch or repo.default_branch or "main"
    message = (data.message or "").strip() or f"Publish collab draft to {branch}"

    # 本地 pygit2 写统一过保护裁决（与 pre-receive 同一规则）
    from app.services.integration.git_event_service import ensure_local_write
    await ensure_local_write(db, repo_id, branch)

    repo_path = await fetch_repository_storage_path(db, repo_id)
    return await publish_draft(
        repo_path,
        branch,
        current_user.full_name or current_user.username,
        current_user.email,
        message,
    )
