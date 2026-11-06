"""PKCE 授权码流控制器

桌面端的登录缺口：企业环境的 SSO/2FA 账号无法在应用内输密码，只能被迫开浏览器。
这条流程让桌面端把登录交给系统浏览器（用户在那儿本来就登录过），桌面端只拿回
授权码，再凭自己生成的 ``code_verifier`` 换令牌。

与既有登录的关系：**并存，不替换**。密码登录保持原样，PKCE 是给"不能输密码"
的场景多开一条路——这样引入风险被限制在新端点内。
"""

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.prefixes import get_route_prefix
from app.core.exception import ValidationException
from app.models.async_db import get_async_db
from app.models.user import User
from app.services.auth import device_service, token_service
from app.services.auth.pkce_service import (
    consume_authorization_code,
    issue_authorization_code,
)
from app.services.auth.token_service import create_token_pair

router = APIRouter(prefix=get_route_prefix("auth"), tags=["auth-pkce"])


class PkceAuthorizeResponse(BaseModel):
    """授权结果：桌面端据此拼出深链回跳"""

    code: str = Field(..., description="一次性授权码")
    state: str = Field("", description="原样回传调用方提供的 state（防 CSRF）")


class PkceTokenRequest(BaseModel):
    """授权码换令牌请求"""

    grant_type: str = Field("authorization_code", description="固定 authorization_code")
    client_id: str = Field(..., min_length=1, max_length=64)
    redirect_uri: str = Field(..., min_length=1, max_length=500)
    code: str = Field(..., min_length=1, max_length=128)
    code_verifier: str = Field(
        ..., min_length=43, max_length=128, description="RFC 7636 的 code_verifier"
    )
    device_id: str = Field("", max_length=64, description="可选：登记登录设备")
    device_name: str = Field("", max_length=128, description="可选：设备显示名")
    platform: str = Field("", max_length=32, description="可选：平台标识")


class PkceTokenResponse(BaseModel):
    """令牌对"""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"


@router.get("/pkce/authorize", response_model=PkceAuthorizeResponse)
async def pkce_authorize(
    client_id: str = Query(..., min_length=1, max_length=64),
    redirect_uri: str = Query(..., min_length=1, max_length=500),
    code_challenge: str = Query(..., min_length=43, max_length=128),
    code_challenge_method: str = Query("S256", max_length=16),
    state: str = Query("", max_length=256),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """用户在浏览器中已登录，确认授权后签发一次性授权码。

    需要已登录：授权的主体就是当前浏览器会话的用户。
    """
    record = await issue_authorization_code(
        db,
        user_id=current_user.id,
        client_id=client_id,
        redirect_uri=redirect_uri,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
    )
    await db.commit()
    return {"code": record.code, "state": state}


@router.post("/pkce/token", response_model=PkceTokenResponse)
async def pkce_token(
    data: PkceTokenRequest,
    db: AsyncSession = Depends(get_async_db),
):
    """用授权码 + code_verifier 换令牌。

    不需要鉴权头：凭证就是授权码本身。校验失败一律返回同一句文案，避免成为
    枚举工具（区分"码不存在"与"verifier 不对"会泄露前者是否存在）。
    """
    if data.grant_type != "authorization_code":
        raise ValidationException(
            detail="仅支持 grant_type=authorization_code",
            error_code="pkce_unsupported_grant_type",
        )

    record = await consume_authorization_code(
        db,
        code=data.code,
        client_id=data.client_id,
        redirect_uri=data.redirect_uri,
        code_verifier=data.code_verifier,
    )

    user = await db.get(User, record.user_id)
    if user is None or not user.is_active:
        raise ValidationException(
            detail="用户不存在或已禁用", error_code="user_not_found_inactive"
        )

    # 设备登记复用密码登录那一套：桌面端换到令牌后也应出现在"已登录设备"里，
    # 否则用户无法定向吊销它。
    device_id, device_name, platform = device_service.normalize_device(
        data.device_id or None, data.device_name or None, data.platform or None
    )
    extra_claims = {"device_id": device_id} if device_id else None
    tokens = create_token_pair(user, extra_claims=extra_claims)

    if device_id:
        refresh_payload = token_service.verify_token(
            tokens["refresh_token"], token_type="refresh"
        )
        if refresh_payload is not None:
            await device_service.register_login(
                db,
                user.id,
                refresh_payload.family_id,
                device_id,
                device_name,
                platform,
                None,
            )

    # 授权码已用 + 设备登记 + 令牌签发同事务提交：避免出现"码已作废但没换到令牌"
    await db.commit()
    return {
        "access_token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "token_type": "bearer",
    }
