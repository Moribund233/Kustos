"""PKCE 授权码服务

实现 RFC 7636 的 S256 授权码流，供桌面端把登录交给系统浏览器。

流程::

    桌面端                      浏览器                     Kustos
      |  生成 verifier/challenge  |                          |
      |  打开 authorize URL ─────────────────────────────────▶|
      |                            |  用户已登录，确认授权     |
      |◀────── kustos://...?code=...&state=... ───────────────|
      |   POST /pkce/token {code, code_verifier} ─────────────▶|
      |◀────────────── {access_token, refresh_token} ─────────|

关键点：**verifier 始终只在桌面端**。服务端只保存它的 SHA256，因此即使授权码
在回跳链路里泄漏，没有 verifier 也换不出令牌。

刻意不支持 ``plain``：那等于把 verifier 明文放进 URL，PKCE 的保护归零。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_config_value
from app.core.exception import AuthenticationException, ValidationException
from app.models.pkce_auth_code import PkceAuthorizationCode

logger = logging.getLogger(__name__)

#: 授权码默认有效期（分钟）。够用户点一次"允许"，短到泄漏窗口可忽略。
DEFAULT_CODE_TTL_MINUTES = 5
#: 授权码熵（字节）。32 字节 base64url ≈ 43 字符，暴力枚举不可行。
CODE_BYTES = 32

#: 已注册的客户端与回调地址。桌面端走自建深链；不开放任意 redirect_uri，
#: 否则授权码可被引导到攻击者地址（这是授权码流最常见的失陷方式）。
DEFAULT_CLIENTS: Dict[str, tuple] = {
    "kustos-desktop": ("kustos://auth/callback",),
}


def _ttl_minutes() -> int:
    return int(
        get_config_value("security", "pkce_code_ttl_minutes", DEFAULT_CODE_TTL_MINUTES)
    )


def registered_redirects(client_id: str) -> Optional[tuple]:
    """已注册客户端允许的回调地址；未知客户端返回 None。"""
    return DEFAULT_CLIENTS.get(client_id)


def verify_code_challenge(verifier: str, challenge: str, method: str = "S256") -> bool:
    """校验 ``SHA256(verifier)`` 是否等于 challenge。

    用 ``hmac.compare_digest`` 而非 ``==``：挑战比对是凭证校验，逐字节短路
    比较会泄漏前缀匹配长度。
    """
    if method != "S256":
        return False
    try:
        digest = hashlib.sha256(verifier.encode("ascii")).digest()
        computed = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    except (UnicodeEncodeError, AttributeError):
        return False
    return hmac.compare_digest(computed, challenge)


async def issue_authorization_code(
    db: AsyncSession,
    *,
    user_id,
    client_id: str,
    redirect_uri: str,
    code_challenge: str,
    code_challenge_method: str = "S256",
) -> PkceAuthorizationCode:
    """签发一次性授权码。

    Raises:
        ValidationException: 客户端未注册、回调地址不符、或使用了 plain。
    """
    allowed = registered_redirects(client_id)
    if allowed is None:
        raise ValidationException(
            detail="未注册的客户端", error_code="pkce_unknown_client"
        )
    if redirect_uri not in allowed:
        raise ValidationException(
            detail="回调地址未注册", error_code="pkce_redirect_uri_mismatch"
        )
    if code_challenge_method != "S256":
        raise ValidationException(
            detail="仅支持 code_challenge_method=S256",
            error_code="pkce_unsupported_challenge_method",
        )

    record = PkceAuthorizationCode(
        code=secrets.token_urlsafe(CODE_BYTES),
        client_id=client_id,
        redirect_uri=redirect_uri,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
        user_id=user_id,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=_ttl_minutes()),
    )
    db.add(record)
    await db.flush()
    return record


async def consume_authorization_code(
    db: AsyncSession,
    *,
    code: str,
    client_id: str,
    redirect_uri: str,
    code_verifier: str,
) -> PkceAuthorizationCode:
    """校验并消费授权码，返回其归属记录。

    按顺序校验，任何一步失败都不透露额外信息：

    1. 授权码存在且属于该客户端/回调地址；
    2. 未过期、未被使用；
    3. ``SHA256(verifier)`` 与 challenge 一致。

    成功后立即标记 ``used_at``——调用方必须在**同一事务**里完成令牌签发，
    否则标记了却签发失败，用户会拿到一个"已作废但没换到令牌"的码。

    Raises:
        AuthenticationException: 任一校验失败。错误文案统一，避免成为枚举工具。
    """
    result = await db.execute(
        select(PkceAuthorizationCode).filter(
            PkceAuthorizationCode.code == code,
            PkceAuthorizationCode.client_id == client_id,
            PkceAuthorizationCode.redirect_uri == redirect_uri,
        )
    )
    record = result.scalar_one_or_none()

    generic = AuthenticationException(
        detail="授权码无效或已过期", error_code="pkce_invalid_grant"
    )
    if record is None:
        raise generic
    if not record.is_usable():
        logger.warning("PKCE 授权码被重放: code=%s...", code[:8])
        raise generic

    now = datetime.now(timezone.utc)
    expires_at = record.expires_at
    # 数据库取回的时间可能带时区，也可能因驱动差异为朴素时间：统一按 UTC 比较
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < now:
        raise generic

    if not verify_code_challenge(
        code_verifier, record.code_challenge, record.code_challenge_method
    ):
        logger.warning("PKCE verifier 不匹配: code=%s...", code[:8])
        raise generic

    record.used_at = now
    await db.flush()
    return record
