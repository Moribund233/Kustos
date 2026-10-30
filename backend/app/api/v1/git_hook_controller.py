"""
Git hook 内部回调控制器

git-cgi / sshd 容器的集中 hook（docker/git-hooks/*）在 push 前后回调：

- POST /api/v1/git-internal/pre-receive  —— 保护分支裁决（403 = 拒绝推送）
- POST /api/v1/git-internal/post-receive —— 分支/提交同步 + push webhook 触发

鉴权：共享密钥请求头 ``X-Git-Hook-Secret``（与容器环境变量
``KUSTOS_GIT_HOOK_SECRET`` 比对）。未配置密钥时端点整体 503 不可用
（安全默认，与 collab-internal 的内部密钥模式一致）。
"""
import hmac
import os

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exception import AuthorizationException, HttpStatusException, NotFoundException
from app.models import Repository
from app.models.async_db import get_async_db
from app.services.integration import git_event_service
from app.utils.git_utils import get_repository_storage_path

router = APIRouter(tags=["git-internal"])

SECRET_ENV = "KUSTOS_GIT_HOOK_SECRET"
SECRET_HEADER = "X-Git-Hook-Secret"

_SHA_PATTERN = r"^(0+|[0-9a-f]{40}|[0-9a-f]{64})$"


class RefUpdate(BaseModel):
    """单个引用更新（hook 从 git stdin 解析后上报）。"""
    ref: str = Field(..., min_length=1, description="引用名，如 refs/heads/main")
    old: str = Field(..., pattern=_SHA_PATTERN, description="推送前 OID（全零=新建）")
    new: str = Field(..., pattern=_SHA_PATTERN, description="推送后 OID（全零=删除）")
    is_force: bool = Field(
        default=False,
        description="非快进更新（仅 pre-receive 需要；post-receive 恒 false）",
    )


class PushCallback(BaseModel):
    """hook 回调请求体。"""
    repo_path: str = Field(..., min_length=1, description="仓库相对路径 owner/repo（可带 .git 后缀）")
    updates: list[RefUpdate] = Field(..., min_length=1)


def _require_hook_secret(request: Request) -> None:
    """校验内部共享密钥；未配置时端点整体不可用（安全默认）。"""
    expected = os.environ.get(SECRET_ENV, "").strip()
    if not expected:
        raise HttpStatusException(
            status_code=503,
            detail="Git hook API 未启用（未配置 KUSTOS_GIT_HOOK_SECRET）",
            error_code="git_hook_disabled",
        )
    provided = request.headers.get(SECRET_HEADER, "")
    if not provided or not hmac.compare_digest(
        provided.encode("utf-8"), expected.encode("utf-8")
    ):
        raise AuthorizationException(
            detail="Git hook 密钥校验失败", error_code="git_hook_invalid_secret"
        )


async def _get_repo_or_404(db: AsyncSession, repo_path: str) -> Repository:
    """按相对路径定位仓库（容忍 .git 后缀）。"""
    path = repo_path[:-4] if repo_path.endswith(".git") else repo_path
    result = await db.execute(select(Repository).filter(Repository.path == path))
    repository = result.scalar_one_or_none()
    if repository is None:
        raise NotFoundException(
            detail=f"Repository not found: {path}", error_code="repository_not_found"
        )
    return repository


@router.post("/git-internal/pre-receive")
async def pre_receive(
    request: Request,
    body: PushCallback,
    db: AsyncSession = Depends(get_async_db),
):
    """推送前回调：保护分支 + 大小上限裁决。非 2xx 时 hook 拒绝本次推送。"""
    _require_hook_secret(request)
    repository = await _get_repo_or_404(db, body.repo_path)
    updates = [u.model_dump() for u in body.updates]

    reason = await git_event_service.evaluate_pre_receive(
        db, repository.id, updates,
        repo_path=get_repository_storage_path(repository.path),
    )
    if reason:
        # reason 由服务层动态生成（受保护分支规则文案），不加 i18n 词条以免覆盖
        # 原文，但给出稳定 error_code 供前端按码分支
        raise AuthorizationException(detail=reason, error_code="git_hook_rejected")
    return {"ok": True}


@router.post("/git-internal/post-receive")
async def post_receive(
    request: Request,
    body: PushCallback,
    db: AsyncSession = Depends(get_async_db),
):
    """推送后回调：分支对账 + 提交入库 + webhook。失败由 hook 记日志，下推自愈。"""
    _require_hook_secret(request)
    repository = await _get_repo_or_404(db, body.repo_path)
    updates = [u.model_dump() for u in body.updates]

    stats = await git_event_service.handle_post_receive(db, repository, updates)
    return {"ok": True, **stats}