"""
WebSocket认证模块

提供WebSocket连接的认证功能，支持：
- Token验证（**首选** ``Sec-WebSocket-Protocol`` 握手头）
- 用户身份绑定
- 权限检查
"""
from typing import Optional, Dict, Any, List
from fastapi import WebSocket, HTTPException, status
from sqlalchemy import select
import uuid
import logging

from app.services.auth.token_service import verify_token as jwt_verify_token, is_token_revoked
from app.services.auth import token_state
from app.models.async_db import get_async_db_context
from app.models.user import User
from app.utils.ws_manager import requested_subprotocols

logger = logging.getLogger(__name__)

#: 客户端在 ``Sec-WebSocket-Protocol`` 中声明的应用子协议名（token 放第二位）。
#: **不含点**——取 token 时按「JWT 形状 = 两段点分」判定，避免与协议名混淆。
SUBPROTOCOL = "kustos-bearer"


def extract_token_from_header(websocket: WebSocket) -> Optional[str]:
    """
    从握手头 ``Sec-WebSocket-Protocol`` 提取 access token

    URL query 会被 Nginx ``access_log`` 原样记录——``/ws?token=<jwt>`` 等于把
    密钥写进日志。改走握手头后 URI 里只剩路径，不再泄 token。
    客户端约定：``["kustos-bearer", <jwt>]``；这里取「JWT 形状」（恰好两段点分）
    的那个值，协议名 ``kustos-bearer`` 不含点，不会被误判。
    """
    for value in requested_subprotocols(websocket):
        if value.count(".") == 2:
            return value
    return None


async def extract_token(websocket: WebSocket) -> Optional[str]:
    """提取 access token：**只认握手头** ``Sec-WebSocket-Protocol``。

    历史上曾支持 ``/ws?token=<jwt>`` 形态，已移除——query 会被 Nginx
    ``access_log`` 原样记录，等于把密钥写进日志。客户端一律走握手头。
    """
    return extract_token_from_header(websocket)


class WebSocketAuthError(Exception):
    """WebSocket认证异常"""
    def __init__(self, message: str, code: int = 1008):
        self.message = message
        self.code = code
        super().__init__(message)


async def verify_token(token: str) -> Optional[Dict[str, Any]]:
    """
    验证 JWT token 并返回用户信息

    Args:
        token: JWT token

    Returns:
        Optional[Dict]: 用户信息字典，验证失败返回None

        用户信息格式：
        {
            "user_id": uuid.UUID,
            "username": str,
            "is_active": bool,
            "is_admin": bool,
        }
    """
    token_data = jwt_verify_token(token, token_type="access")

    if not token_data:
        logger.warning("WebSocket token verification failed: invalid token")
        return None

    # 从数据库获取完整的用户信息
    try:
        async with get_async_db_context() as db:
            # jti 撤销之外叠加 family 吊销——登出/重用检测吊销整个
            # family 后，同 family 的 access token 在 WS 握手处也立即失效
            if await is_token_revoked(token_data.jti):
                logger.warning("WebSocket token verification failed: token revoked")
                return None

            if token_data.family_id and await token_state.is_revoked("family", token_data.family_id):
                logger.warning("WebSocket token verification failed: family revoked")
                return None

            result = await db.execute(select(User).filter(User.id == token_data.user_id))
            user = result.scalar_one_or_none()

            if not user:
                logger.warning(f"WebSocket token valid but user not found: user_id={token_data.user_id}")
                return None

            user_info = {
                "user_id": user.id,
                "username": user.username,
                "is_active": user.is_active,
                "is_admin": user.is_admin,
            }
            if token_data.oauth_provider:
                user_info["oauth_provider"] = token_data.oauth_provider
            return user_info
    except Exception as e:
        logger.error(f"WebSocket token verification error: {e}")
        return None


async def authenticate_websocket(
    websocket: WebSocket,
    required: bool = True,
) -> Optional[Dict[str, Any]]:
    """
    认证WebSocket连接

    完整的认证流程：
    1. 从query参数提取token
    2. 验证token有效性
    3. 返回用户信息

    Args:
        websocket: FastAPI WebSocket对象
        required: 是否强制要求认证。
            - True（默认）: 认证失败抛出 WebSocketAuthError
            - False: 认证失败时返回 None（匿名连接）

    Returns:
        Optional[Dict]: 用户信息字典，匿名连接返回 None

    Raises:
        WebSocketAuthError: required=True 且认证失败时抛出
    """
    try:
        token = await extract_token(websocket)

        if not token:
            raise WebSocketAuthError("Missing authentication token", code=1008)

        user_info = await verify_token(token)

        if not user_info:
            raise WebSocketAuthError("Invalid authentication token", code=1008)

        if not user_info.get("is_active", True):
            raise WebSocketAuthError("User account is inactive", code=1008)

        logger.info(f"WebSocket认证成功: user_id={user_info.get('user_id')}, username={user_info.get('username')}")
        return user_info

    except WebSocketAuthError:
        if required:
            raise
        return None


def check_permission(user_info: Dict[str, Any], permission: str) -> bool:
    """
    检查用户权限
    
    Args:
        user_info: 用户信息字典
        permission: 权限标识
        
    Returns:
        bool: 有权限返回True
    """
    if not user_info:
        return False
    
    # 管理员拥有所有权限
    if user_info.get("is_admin", False):
        return True
    
    # TODO: 根据你的权限系统扩展
    # 示例权限检查
    permissions = user_info.get("permissions", [])
    return permission in permissions

