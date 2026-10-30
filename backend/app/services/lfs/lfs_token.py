"""LFS 短时效 transfer token

git-lfs 的标准流程是「**batch 入口用用户凭证换取短时效 transfer token**，
token 随 action 回给客户端，传输端点（upload/download/verify）逐请求实时校验它」。

为什么不直接把 access token 交给 git-lfs：access token 有效期长，且会落进
``~/.git-credentials``、进程参数与传输日志（同类问题）。
本模块签发的 token：

- 绑定 ``repo_id``（拿 A 仓 token 访问 B 仓直接拒绝）与 ``scope``（read/write）；
- 默认 ``config.lfs.transfer_token_ttl_minutes``（5 分钟）过期；
- 经 ``src_jti`` 关联签发时使用的 access token——该 access token 被撤销
  （登出/改密）后，已签发的 LFS token 立即失效（复用
  ``token_service.is_token_revoked`` 的撤销位图；此后为
  Redis 单层直查，不再走 60s 正/负缓存）；
- ``type="lfs"``，与 access/refresh token 互不误判（``verify_token`` 校验 type）。

签名密钥与算法复用 ``config.security``（与 JWT 同一套），无需新增配置。
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional
import uuid

from jose import JWTError, jwt

from app.core.config import get_config

#: token 类型标记（与 access/refresh 区分，防止跨类型复用）
LFS_TOKEN_TYPE = "lfs"

#: 读权限（download）
SCOPE_READ = "read"
#: 写权限（upload/verify/delete）
SCOPE_WRITE = "write"

VALID_SCOPES = frozenset({SCOPE_READ, SCOPE_WRITE})


@dataclass(frozen=True)
class LFSTransferClaims:
    """transfer token 校验通过后的声明"""

    repo_id: uuid.UUID
    user_id: uuid.UUID
    scope: str
    jti: str
    #: 签发时所用 access token 的 jti（None = Basic 凭证签发，无会话可撤销）
    src_jti: Optional[str] = None


def transfer_token_ttl_minutes() -> int:
    """transfer token 有效期（分钟），运行时读配置（支持轮换）"""
    return get_config().lfs.transfer_token_ttl_minutes


def create_lfs_transfer_token(
    *,
    repo_id: uuid.UUID,
    user_id: uuid.UUID,
    scope: str,
    src_jti: Optional[str] = None,
    ttl_minutes: Optional[int] = None,
) -> str:
    """
    签发 LFS transfer token

    Args:
        repo_id: 目标仓库（token 只对该仓库有效）
        user_id: 授权主体
        scope: ``read`` 或 ``write``
        src_jti: 签发所用 access token 的 jti（用于撤销联动）
        ttl_minutes: 有效期，缺省取配置

    Returns:
        str: 签名后的 JWT

    Raises:
        ValueError: scope 非法
    """
    if scope not in VALID_SCOPES:
        raise ValueError(f"Invalid LFS token scope: {scope}")

    security = get_config().security
    minutes = ttl_minutes or transfer_token_ttl_minutes()
    now = datetime.now(timezone.utc)

    payload = {
        "sub": str(user_id),
        "repo_id": str(repo_id),
        "scope": scope,
        "type": LFS_TOKEN_TYPE,
        "jti": uuid.uuid4().hex,
        "iat": now,
        "exp": now + timedelta(minutes=minutes),
    }
    if src_jti:
        payload["src_jti"] = src_jti

    return jwt.encode(payload, security.secret_key, algorithm=security.algorithm)


def verify_lfs_transfer_token(token: str) -> Optional[LFSTransferClaims]:
    """
    校验 transfer token 的签名与有效期（不查撤销黑名单——那需要 db，
    由 controller 的 ``_require_lfs_transfer`` 叠加）。

    Returns:
        LFSTransferClaims | None: 非法/过期/类型不符一律返回 None
    """
    if not token or not isinstance(token, str):
        return None

    token = token.strip()
    if not token:
        return None

    # 与 token_service.verify_token 同样的格式前置检查（快速失败，不打日志噪音）
    parts = token.split(".")
    if len(parts) != 3 or any(not part.strip() for part in parts):
        return None

    security = get_config().security
    try:
        payload = jwt.decode(token, security.secret_key, algorithms=[security.algorithm])
    except JWTError:
        return None

    if payload.get("type") != LFS_TOKEN_TYPE:
        return None

    try:
        repo_id = uuid.UUID(payload.get("repo_id"))
        user_id = uuid.UUID(payload.get("sub"))
    except (ValueError, TypeError, AttributeError):
        return None

    scope = payload.get("scope")
    if scope not in VALID_SCOPES:
        return None

    jti = payload.get("jti")
    if not isinstance(jti, str) or not jti:
        return None

    src_jti = payload.get("src_jti")
    return LFSTransferClaims(
        repo_id=repo_id,
        user_id=user_id,
        scope=scope,
        jti=jti,
        src_jti=src_jti if isinstance(src_jti, str) and src_jti else None,
    )
