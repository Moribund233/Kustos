from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.prefixes import get_route_prefix
from app.api.deps import get_current_user
from app.core.config import get_config
from app.core.exception import AuthenticationException, NotFoundException, ValidationException
from app.models.async_db import get_async_db
from app.models.user import User
from app.services.auth.oauth_service import OAuthService

router = APIRouter(prefix=get_route_prefix("auth"), tags=["oauth"])

# OAuth account management - under /users prefix for RESTful resource hierarchy
account_router = APIRouter(prefix=get_route_prefix("users"), tags=["oauth-accounts"])


def _get_oauth_service():
    return OAuthService(get_config())


@router.get("/{provider}/login")
async def oauth_login(provider: str):
    service = _get_oauth_service()
    try:
        return await service.initiate_login(provider)
    except ValueError as e:
        # ValueError 文案为服务层动态诊断，不设 i18n 词条以免覆盖原文
        raise ValidationException(detail=str(e), error_code="oauth_error")


@router.get("/{provider}/callback")
async def oauth_callback(
    provider: str,
    code: str = Query(...),
    state: str = Query(...),
    db: AsyncSession = Depends(get_async_db),
):
    service = _get_oauth_service()
    try:
        return await service.handle_callback(db, provider, code, state)
    except ValueError as e:
        # ValueError 文案为服务层动态诊断，不设 i18n 词条以免覆盖原文
        raise ValidationException(detail=str(e), error_code="oauth_error")


@account_router.get("/me/oauth")
async def list_linked_accounts(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    service = _get_oauth_service()
    return await service.list_linked_accounts(db, current_user.id)


@account_router.delete("/me/oauth/{provider}")
async def unlink_account(
    provider: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    service = _get_oauth_service()
    try:
        await service.unlink_account(db, current_user.id, provider)
        return {"detail": f"{provider} account unlinked"}
    except NotFoundException:
        raise NotFoundException(
            detail=f"Linked {provider} account not found",
            error_code="oauth_account_not_found",
        )
