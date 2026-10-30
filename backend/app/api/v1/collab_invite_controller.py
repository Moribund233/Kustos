"""
协作邀请链接控制器

POST /{repo_id}/collab/invites — 由仓库成员签发短时邀请 token
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.repository.repository_service import (
    fetch_repository,
)
from app.api.prefixes import get_route_prefix
from app.api.deps import get_current_user
from app.models.async_db import get_async_db
from app.models import Repository, User
from app.core.exception import AuthorizationException, NotFoundException, ValidationException
from app.core.permissions import Action, has_repo_action
from app.api.v1.collab_internal_controller import parse_doc_key
from app.services.collaboration.collab_invite_service import (
    MAX_TTL_MINUTES,
    create_invite_token,
    revoke_invite_token,
    verify_invite_token,
)

router = APIRouter(prefix=get_route_prefix("repositories"), tags=["collab-invites"])


class IssueInviteRequest(BaseModel):
    """邀请链接签发请求体"""
    doc_key: str = Field(..., min_length=1, description="文档标识 repository_id:branch:path")
    scope: str = Field("read", pattern="read|write", description="权限档位")
    ttl_minutes: Optional[int] = Field(None, ge=1, le=MAX_TTL_MINUTES, description="有效期(分钟)")


class RevokeInviteRequest(BaseModel):
    """邀请链接撤销请求体"""
    token: str = Field(..., min_length=1, description="待撤销的邀请 token")


@router.post("/{repo_id}/collab/invites", status_code=201)
async def issue_collab_invite(
    repo_id: uuid.UUID,
    data: IssueInviteRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    签发协作会话邀请链接 (仅仓库成员)

    被邀请人凭 token 获得会话级临时权限 (绑定 docKey + read/write 档位 + 过期时间)。
    """
    repo = await fetch_repository(db, repo_id)

    if not await has_repo_action(db, current_user.id, repo_id, Action.INVITE_ISSUE):
        raise AuthorizationException(
            detail="仅仓库成员可生成协作邀请链接",
            error_code="collab_invite_forbidden",
        )

    parsed_repo_id, _branch, _path = parse_doc_key(data.doc_key)
    if parsed_repo_id != repo_id:
        raise ValidationException(
            detail="doc_key 不属于该仓库",
            error_code="collab_invite_dockey_mismatch",
        )

    issued = create_invite_token(
        doc_key=data.doc_key,
        scope=data.scope,
        issued_by=current_user.id,
        username=current_user.username,
        ttl_minutes=data.ttl_minutes,
    )
    issued["url"] = f"/collab/{issued['token']}"
    return issued


@router.post("/{repo_id}/collab/invites/revoke")
async def revoke_collab_invite(
    repo_id: uuid.UUID,
    data: RevokeInviteRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """
    撤销协作邀请链接 (仅仓库所有者/管理员)

    被撤销的 token 立即失效: `/collab/auth` 与 `/collab/save` 将拒绝其换取权限。
    """
    repo = await fetch_repository(db, repo_id)

    if not await has_repo_action(db, current_user.id, repo_id, Action.INVITE_MANAGE):
        raise AuthorizationException(
            detail="仅仓库所有者/管理员可撤销协作邀请链接",
            error_code="collab_invite_revoke_forbidden",
        )

    info = verify_invite_token(data.token)
    if info is None:
        raise ValidationException(
            detail="邀请 token 无效或已过期",
            error_code="collab_invite_invalid",
        )

    parsed_repo_id, _branch, _path = parse_doc_key(info["doc_key"])
    if parsed_repo_id != repo_id:
        raise ValidationException(
            detail="邀请 token 不属于该仓库",
            error_code="collab_invite_dockey_mismatch",
        )

    revoked = await revoke_invite_token(db, data.token, current_user.id)
    return {"jti": revoked["jti"], "doc_key": revoked["doc_key"], "revoked": True}
