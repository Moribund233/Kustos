"""LFS 控制器层（仓库级 ACL + 短时效 transfer token）

授权分两层，缺一即为越权面：

1. **batch 入口** ``POST /{repo_id}/lfs/objects/batch``
   - 凭证：``Bearer <access token>``（实时撤销校验）或
     ``Basic 用户名:密码``（git-lfs 默认凭据形态，与 git-auth 同口径）；
   - 裁决：按 (role × action) 矩阵走 ``lfs:read`` / ``lfs:write``；
     **公开仓库读放行**（与 fork/star 口径一致），私仓必须是活跃成员；
   - 通过后签发**短时效 LFS transfer token**（绑定 repo + scope，默认 5min）
     放进 action 的 ``header``——不用 href query，避免 token 落进访问日志
     （同类问题）。
2. **传输端点**（upload / download / verify / delete）
   **只接受 LFS transfer token**，长时效 access token 与 Basic 一律 401：
   签名 + 过期 + repo 绑定 + scope + 撤销黑名单 + 用户活跃态逐请求实时校验。

存储路径带 repo 维度（``{storage_root}/{repo_id}/objects/...``），
跨仓取对象只能拿到本仓的 404。
"""
import base64
import hashlib
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.prefixes import API_V1_PREFIX, get_route_prefix
from app.core.config import get_config
from app.core.exception import (
    AuthenticationException,
    AuthorizationException,
    HttpStatusException,
    NotFoundException,
    ValidationException,
)
from app.core.permissions import Action, ensure_repo_action, has_repo_action
from app.models.async_db import get_async_db
from app.models.repository import Repository
from app.models.user import User
from app.services.auth import token_service
from app.services.lfs.lfs_service import LFSService
from app.services.lfs.lfs_storage import LocalFSStorage
from app.services.lfs.lfs_token import (
    LFSTransferClaims,
    SCOPE_READ,
    SCOPE_WRITE,
    create_lfs_transfer_token,
    transfer_token_ttl_minutes,
    verify_lfs_transfer_token,
)
from app.utils.password_utils import verify_password

#: batch 支持的操作 → 所需 action 与签发的 token scope
_BATCH_OPERATIONS = {
    "upload": (Action.LFS_WRITE, SCOPE_WRITE),
    "download": (Action.LFS_READ, SCOPE_READ),
    "basic": (Action.LFS_READ, SCOPE_READ),
}

#: oid 白名单：64 位小写 hex（sha256 摘要）。oid 会拼进存储路径参与
#: 存在性判断与文件读写，未校验即可探测/穿越任意路径
_OID_RE = re.compile(r"[0-9a-f]{64}")


def _require_valid_oid(oid: str) -> str:
    """校验 oid 为 64 位小写 hex；非法抛 400（`lfs_oid_invalid`）。

    Returns:
        原 oid（便于链式使用）
    """
    if not isinstance(oid, str) or _OID_RE.fullmatch(oid) is None:
        raise ValidationException(
            detail="Invalid LFS object id", error_code="lfs_oid_invalid"
        )
    return oid


def get_lfs_service(repo_id: uuid.UUID) -> LFSService:
    """获取 LFS 服务实例（按 repo_id 隔离——存储键带仓库维度）"""
    config = get_config()
    if config.lfs.storage_backend == "local":
        storage = LocalFSStorage(config.lfs.local_path, repo_id)
    else:
        raise HttpStatusException(status_code=501, detail="S3 storage not yet configured", error_code="lfs_s3_not_configured")
    return LFSService(storage)


router = APIRouter(prefix=get_route_prefix("repositories"), tags=["lfs"])


# ---------------------------------------------------------------------------
# batch 入口：用户凭证 + 仓库授权
# ---------------------------------------------------------------------------

async def _authenticate_batch_user(
    request: Request, db: AsyncSession
) -> Tuple[User, Optional[str]]:
    """
    batch 入口凭证（**仅此入口接受用户凭证**）

    Returns:
        (user, src_jti)：src_jti 为 access token 的 jti（Basic 凭证为 None），
        用于把签发出的 LFS token 与该会话的撤销状态联动。

    Raises:
        AuthenticationException: 401
    """
    auth = request.headers.get("Authorization") or ""

    if auth.startswith("Bearer "):
        token = auth[7:].strip()
        token_data = await token_service.verify_token_active(token, token_type="access")
        if token_data is None:
            raise AuthenticationException(
                detail="Invalid or expired token", error_code="invalid_token"
            )
        result = await db.execute(select(User).filter(User.id == token_data.user_id))
        user = result.scalar_one_or_none()
        if user is None or not user.is_active:
            raise AuthenticationException(
                detail="Invalid or expired token", error_code="invalid_token"
            )
        return user, token_data.jti

    if auth.startswith("Basic "):
        try:
            decoded = base64.b64decode(auth[6:], validate=True).decode("utf-8")
        except Exception:
            raise AuthenticationException(
                detail="Invalid Basic auth format", error_code="invalid_basic_auth"
            )
        username, _, password = decoded.partition(":")
        username, password = username.strip(), password.strip()
        if not username or not password:
            raise AuthenticationException(
                detail="Missing username or password", error_code="missing_credentials"
            )

        result = await db.execute(
            select(User).filter(
                User.username == username,
                User.is_active == True,  # noqa: E712
            )
        )
        user = result.scalar_one_or_none()
        # 用户不存在与密码错误同文案（不泄露用户名是否存在）
        if user is None or not user.password or not verify_password(password, user.password):
            raise AuthenticationException(
                detail="Invalid username or password", error_code="invalid_credentials"
            )
        return user, None

    raise AuthenticationException(detail="Authentication required", error_code="auth_required")


async def _ensure_lfs_action(
    db: AsyncSession, user: User, repo_id: uuid.UUID, action: Action
) -> None:
    """
    LFS 授权：公开仓库读放行；其余一律走 core.permissions 矩阵。

    Raises:
        NotFoundException: 仓库不存在（404，不区分公开/私有）
        AuthorizationException: 无权限（403）
    """
    result = await db.execute(select(Repository).filter(Repository.id == repo_id))
    repo = result.scalar_one_or_none()
    if repo is None:
        raise NotFoundException(detail="Repository not found", error_code="repository_not_found")

    if action is Action.LFS_READ and repo.is_public:
        return

    await ensure_repo_action(db, user.id, repo_id, action)


# ---------------------------------------------------------------------------
# 传输端点：只认 LFS transfer token
# ---------------------------------------------------------------------------

def _require_lfs_transfer(scope: str):
    """依赖工厂：校验传输端点的 LFS transfer token（scope = 读/写所需最低权限）"""

    async def _dependency(
        request: Request,
        repo_id: uuid.UUID,
        db: AsyncSession = Depends(get_async_db),
    ) -> LFSTransferClaims:
        # 传输端点不接受用户凭证（access token / Basic）——见模块 docstring
        auth = request.headers.get("Authorization") or ""
        if not auth.startswith("Bearer "):
            raise AuthenticationException(
                detail="LFS transfer token required", error_code="lfs_token_required"
            )

        claims = verify_lfs_transfer_token(auth[7:].strip())
        if claims is None:
            raise AuthenticationException(
                detail="Invalid or expired LFS token", error_code="lfs_token_invalid"
            )

        # token 只对签发时绑定的仓库有效
        if claims.repo_id != repo_id:
            raise AuthorizationException(
                detail="LFS token is not valid for this repository",
                error_code="lfs_token_repo_mismatch",
            )

        # scope：写令牌可读；只读令牌不可写
        if scope == SCOPE_WRITE and claims.scope != SCOPE_WRITE:
            raise AuthorizationException(
                detail="LFS token does not grant write access",
                error_code="lfs_token_write_denied",
            )

        # 撤销黑名单实时校验（签发所用 access token 被撤销 → 立即失效）
        if claims.src_jti and await token_service.is_token_revoked(claims.src_jti):
            raise AuthenticationException(
                detail="Invalid or expired LFS token", error_code="lfs_token_invalid"
            )

        # 主体仍然存在且活跃（封禁/删除即时生效）
        result = await db.execute(select(User).filter(User.id == claims.user_id))
        user = result.scalar_one_or_none()
        if user is None or not user.is_active:
            raise AuthenticationException(
                detail="Invalid or expired LFS token", error_code="lfs_token_invalid"
            )

        return claims

    return _dependency


# ---------------------------------------------------------------------------
# 端点
# ---------------------------------------------------------------------------

@router.post("/{repo_id}/lfs/objects/batch")
async def batch(
    repo_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_async_db),
):
    """LFS 批量操作（repo_id 寻址；唯一接受用户凭证的入口）"""
    return await _run_batch(repo_id, request, db)


#: git-lfs 客户端入口（网关把 `/{owner}/{repo}.git/info/lfs/batch` 重写到这里）。
#: 独立于 repositories 前缀（历史上为避开 `/{owner}/{repo}` 通配的注册顺序耦合，
#: 根治后该约束已消除，前缀保留因网关重写目标即此路径）。
path_router = APIRouter(prefix=f"{API_V1_PREFIX}/lfs", tags=["lfs"])


@path_router.post("/{owner}/{repo_name}/batch")
async def batch_by_path(
    owner: str,
    repo_name: str,
    request: Request,
    db: AsyncSession = Depends(get_async_db),
):
    """LFS 批量操作（owner/repo 寻址，供 git-lfs 经网关重写调用）"""
    # 先凭证后解析：避免未认证即可探测仓库路径是否存在
    user, src_jti = await _authenticate_batch_user(request, db)
    result = await db.execute(
        select(Repository).filter(Repository.path == f"{owner}/{repo_name}")
    )
    repo = result.scalar_one_or_none()
    if repo is None:
        raise NotFoundException(
            detail="Repository not found", error_code="repository_not_found"
        )
    return await _run_batch(repo.id, request, db, user=user, src_jti=src_jti)


def _external_base_url(request: Request) -> str:
    """action href 的绝对基址。

    网关以 ``Host $http_host`` 转发（含端口），故 ``request.base_url`` 的主机
    部分已是客户端可见地址；协议取反代注入的 ``X-Forwarded-Proto``——HTTPS
    部署时 ASGI 侧仍是 ``http``，直接用会签发出打到 80 口的 href。无该头或值
    为 http 时行为不变（直连应用即此情形）。
    """
    origin = str(request.base_url).rstrip("/")
    if request.headers.get("x-forwarded-proto", "").lower() == "https":
        if origin.startswith("http://"):
            origin = "https://" + origin[len("http://"):]
    return origin


async def _run_batch(
    repo_id: uuid.UUID,
    request: Request,
    db: AsyncSession,
    user: Optional[User] = None,
    src_jti: Optional[str] = None,
) -> dict:
    """batch 主体（repo_id 与 owner/repo 两个入口共用）"""
    try:
        body = await request.json()
        operation = str(body.get("operation") or "download").lower()
        if operation not in _BATCH_OPERATIONS:
            raise ValidationException(detail="Unsupported LFS operation", error_code="lfs_operation_unsupported")

        action, scope = _BATCH_OPERATIONS[operation]

        # 1. 凭证 + 仓库授权（lfs:read / lfs:write）
        if user is None:
            user, src_jti = await _authenticate_batch_user(request, db)
        await _ensure_lfs_action(db, user, repo_id, action)

        # 2. 签发短时效 transfer token（全部 action 共用一枚，5min 内完成传输）
        ttl = transfer_token_ttl_minutes()
        token = create_lfs_transfer_token(
            repo_id=repo_id,
            user_id=user.id,
            scope=scope,
            src_jti=src_jti,
            ttl_minutes=ttl,
        )
        auth_header = {"Authorization": f"Bearer {token}"}
        expires_at = (
            datetime.now(timezone.utc) + timedelta(minutes=ttl)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")

        lfs_service = get_lfs_service(repo_id)
        base_url = _external_base_url(request)
        object_path = f"{get_route_prefix('repositories')}/{repo_id}/lfs/objects"

        def _action(href: str) -> dict:
            return {"href": f"{base_url}{href}", "header": auth_header,
                    "expires_at": expires_at}

        results = []
        for obj in body.get("objects", []) or []:
            oid = obj.get("oid")
            if not oid:
                continue
            # oid 随即进入存储路径做存在性判断：先过白名单，挡住路径探测
            _require_valid_oid(oid)
            entry = {"oid": oid, "size": obj.get("size", 0)}

            if operation == "upload":
                # 已在服务端 → 不下发动作，客户端跳过上传（LFS 规范允许）
                if await lfs_service.exists(oid):
                    results.append(entry)
                    continue
                entry["actions"] = {
                    "upload": _action(f"{object_path}/{oid}"),
                    "verify": _action(f"{object_path}/{oid}/verify"),
                }
            else:
                # 不存在 → 显式 404 条目，客户端不必先拉一次才发现
                if not await lfs_service.exists(oid):
                    entry["error"] = {"code": 404, "message": "Object not found"}
                    results.append(entry)
                    continue
                entry["actions"] = {"download": _action(f"{object_path}/{oid}")}

            results.append(entry)

        return {"transfer": "basic", "hash_algo": "sha256", "objects": results}
    except (FileNotFoundError, HTTPException):
        raise
    except Exception as e:
        raise HttpStatusException(status_code=500, detail=str(e), error_code="lfs_operation_failed")


@router.put("/{repo_id}/lfs/objects/{oid}", status_code=201)
async def upload_object(
    repo_id: uuid.UUID,
    oid: str,
    request: Request,
    _claims: LFSTransferClaims = Depends(_require_lfs_transfer(SCOPE_WRITE)),
):
    """上传 LFS 对象（只接受 LFS transfer token）"""
    try:
        _require_valid_oid(oid)
        max_size = get_config().lfs.max_upload_size
        content_length = request.headers.get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > max_size:
            raise HttpStatusException(status_code=413, detail="LFS object too large", error_code="lfs_object_too_large")

        data = await request.body()
        if len(data) > max_size:
            raise HttpStatusException(status_code=413, detail="LFS object too large", error_code="lfs_object_too_large")

        # oid 即内容 sha256：不校验则同仓既有对象可被写入任意内容
        # （覆盖破坏），且存储的「存在」语义失真
        if hashlib.sha256(data).hexdigest() != oid:
            raise ValidationException(
                detail="LFS object content does not match oid",
                error_code="lfs_hash_mismatch",
            )

        lfs_service = get_lfs_service(repo_id)
        return await lfs_service.upload(oid, data)
    except (FileNotFoundError, HTTPException):
        raise
    except Exception as e:
        raise HttpStatusException(status_code=500, detail=str(e), error_code="lfs_operation_failed")


@router.get("/{repo_id}/lfs/objects/{oid}")
async def download_object(
    repo_id: uuid.UUID,
    oid: str,
    request: Request,
    _claims: LFSTransferClaims = Depends(_require_lfs_transfer(SCOPE_READ)),
):
    """下载 LFS 对象（只接受 LFS transfer token）"""
    try:
        _require_valid_oid(oid)
        lfs_service = get_lfs_service(repo_id)
        data = await lfs_service.download(oid)
        return Response(content=data, media_type="application/octet-stream")
    except (FileNotFoundError, HTTPException):
        raise
    except Exception as e:
        raise HttpStatusException(status_code=500, detail=str(e), error_code="lfs_operation_failed")


@router.post("/{repo_id}/lfs/objects/{oid}/verify")
async def verify_object(
    repo_id: uuid.UUID,
    oid: str,
    request: Request,
    _claims: LFSTransferClaims = Depends(_require_lfs_transfer(SCOPE_WRITE)),
):
    """上传完成校验（LFS verify 动作；对象缺失 404、大小不符 400）"""
    _require_valid_oid(oid)
    try:
        body = await request.json()
    except Exception:
        body = {}

    declared = body.get("size")
    try:
        declared = int(declared) if declared is not None else None
    except (TypeError, ValueError):
        declared = None

    lfs_service = get_lfs_service(repo_id)
    if not await lfs_service.verify_upload(oid, declared):
        if not await lfs_service.exists(oid):
            raise NotFoundException(detail=f"LFS object not found: {oid}", error_code="lfs_object_not_found")
        raise ValidationException(detail="LFS object size mismatch", error_code="lfs_object_size_mismatch")
    return {"oid": oid}


@router.delete("/{repo_id}/lfs/objects/{oid}", status_code=204)
async def delete_object(
    repo_id: uuid.UUID,
    oid: str,
    request: Request,
    _claims: LFSTransferClaims = Depends(_require_lfs_transfer(SCOPE_WRITE)),
):
    """删除 LFS 对象（只接受 LFS transfer token）"""
    try:
        _require_valid_oid(oid)
        lfs_service = get_lfs_service(repo_id)
        await lfs_service.delete(oid)
        return None
    except (FileNotFoundError, HTTPException):
        raise
    except Exception as e:
        raise HttpStatusException(status_code=500, detail=str(e), error_code="lfs_operation_failed")
