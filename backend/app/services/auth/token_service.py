"""
Token 认证服务

提供基于 JWT 的 Token 认证功能，替代 Basic Auth
"""
from datetime import datetime, timedelta, timezone
import uuid
from typing import Optional, Dict, Any
from jose import JWTError, jwt
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.revoked_token import RevokedToken
from app.core.config import get_config, get_config_value
from app.core.exception import AuthenticationException
from app.services.auth import token_state
from app.services.auth import device_service
from app.utils.password_utils import verify_password, get_password_hash

# 日志记录器
logger = logging.getLogger(__name__)

#: refresh 轮换宽限期（秒）——多标签页/并发刷新竞态窗口；
#: 超出宽限期重放旧 refresh 视为**重用**，吊销整个 family。
#: 默认值 = 既有常量；运行期读 [security] refresh_rotation_grace_seconds。
REFRESH_ROTATION_GRACE_SECONDS = 60


def _rotation_grace_seconds() -> int:
    """读取 ``security.refresh_rotation_grace_seconds``（默认 60）"""
    return int(get_config_value("security", "refresh_rotation_grace_seconds", REFRESH_ROTATION_GRACE_SECONDS))


def _default_ttl_seconds(token_type: str) -> int:
    """exp 缺失时按类型回退的 TTL（与签发配置一致）"""
    security = _get_security_config()
    if token_type == "refresh":
        return int(security.refresh_token_expire_days * 86400)
    return int(security.access_token_expire_minutes * 60)


def _get_security_config():
    """获取安全配置（运行时读取，支持密钥轮换）"""
    config = get_config()
    return config.security


class TokenData:
    """Token 数据类"""
    def __init__(
        self,
        user_id: uuid.UUID,
        username: str,
        scopes: list | None = None,
        oauth_provider: Optional[str] = None,
        jti: Optional[str] = None,
        family_id: Optional[str] = None,
        exp: Optional[datetime] = None,
        device_id: Optional[str] = None,
    ):
        self.user_id = user_id
        self.username = username
        self.scopes = scopes or []
        self.oauth_provider = oauth_provider
        self.jti = jti
        #: refresh 家族标识（轮换链的吊销单元）；旧 token 无此 claim 为 None
        self.family_id = family_id
        #: token 过期时刻（撤销位图 TTL 的依据）
        self.exp = exp
        #: 签发设备的标识；由客户端登录/刷新时上报，随家族链传递
        self.device_id = device_id


def create_access_token(
    data: Dict[str, Any],
    expires_delta: Optional[timedelta] = None
) -> str:
    """
    创建访问令牌

    Args:
        data: 要编码的数据
        expires_delta: 过期时间增量

    Returns:
        str: JWT 令牌
    """
    security_config = _get_security_config()
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=security_config.access_token_expire_minutes)

    to_encode.update({
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "type": "access",
        "jti": to_encode.get("jti") or uuid.uuid4().hex
    })

    encoded_jwt = jwt.encode(to_encode, security_config.secret_key, algorithm=security_config.algorithm)
    return encoded_jwt


def create_refresh_token(
    data: Dict[str, Any],
    expires_delta: Optional[timedelta] = None
) -> str:
    """
    创建刷新令牌

    Args:
        data: 要编码的数据
        expires_delta: 过期时间增量

    Returns:
        str: JWT 刷新令牌
    """
    security_config = _get_security_config()
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(days=security_config.refresh_token_expire_days)

    to_encode.update({
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "type": "refresh",
        "jti": to_encode.get("jti") or uuid.uuid4().hex
    })

    encoded_jwt = jwt.encode(to_encode, security_config.secret_key, algorithm=security_config.algorithm)
    return encoded_jwt


def create_token_pair(user: User, extra_claims: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """
    创建访问令牌和刷新令牌对

    Args:
        user: 用户对象
        extra_claims: 额外要编码到令牌中的声明（可选）

    Returns:
        dict: 包含 access_token 和 refresh_token 的字典
    """
    token_data = {
        "sub": str(user.id),
        "username": user.username,
        "is_admin": user.is_admin
    }
    if extra_claims:
        token_data.update(extra_claims)
    # refresh 轮换链的吊销单元：显式传入（轮换时沿用）否则新建
    if not token_data.get("family_id"):
        token_data["family_id"] = uuid.uuid4().hex

    access_token = create_access_token(token_data)
    refresh_token = create_refresh_token(token_data)

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer"
    }


def verify_token(token: str, token_type: str = "access") -> Optional[TokenData]:
    """
    验证令牌

    执行严格的令牌验证：
    1. 检查令牌是否为空或无效格式
    2. 验证 JWT 签名和结构
    3. 检查令牌类型匹配
    4. 验证必需的声明字段

    Args:
        token: JWT 令牌
        token_type: 期望的令牌类型（access 或 refresh）

    Returns:
        TokenData: 令牌数据，验证失败返回 None
    """
    # 严格检查：空令牌、纯空白字符、或明显的无效格式
    if not token or not isinstance(token, str):
        logger.warning("Token is empty or not a string")
        return None

    token = token.strip()

    if not token or token.lower() in ('null', 'undefined', 'none', 'admin', 'user', 'test'):
        logger.warning(f"Token is empty or contains invalid keyword: {token}")
        return None

    # 检查 JWT 基本格式（应该包含两个点，分为三个部分）
    parts = token.split('.')
    if len(parts) != 3:
        logger.warning(f"Invalid JWT format: expected 3 parts, got {len(parts)}")
        return None

    # 检查每个部分是否为空
    if any(not part.strip() for part in parts):
        logger.warning("Invalid JWT format: empty part detected")
        return None

    try:
        security_config = _get_security_config()
        payload = jwt.decode(token, security_config.secret_key, algorithms=[security_config.algorithm])

        # 检查令牌类型
        if payload.get("type") != token_type:
            logger.warning(f"Token type mismatch: expected {token_type}, got {payload.get('type')}")
            return None

        # 检查必需字段
        user_id = payload.get("sub")
        username = payload.get("username")

        if user_id is None or username is None:
            logger.warning("Token missing required claims: sub or username")
            return None

        # 验证 user_id 是有效的 UUID
        try:
            user_id = uuid.UUID(user_id)
        except (ValueError, TypeError):
            logger.warning(f"user_id is not a valid UUID: {user_id}")
            return None

        # 验证 username 是非空字符串
        if not isinstance(username, str) or not username.strip():
            logger.warning("username is empty or not a string")
            return None

        oauth_provider = payload.get("oauth_provider")
        if oauth_provider is not None and not isinstance(oauth_provider, str):
            oauth_provider = None

        family_id = payload.get("family_id")
        if family_id is not None and not isinstance(family_id, str):
            family_id = None

        device_id = payload.get("device_id")
        if device_id is not None and not isinstance(device_id, str):
            device_id = None

        exp_raw = payload.get("exp")
        exp = (
            datetime.fromtimestamp(exp_raw, tz=timezone.utc)
            if isinstance(exp_raw, (int, float))
            else None
        )

        return TokenData(
            user_id=user_id,
            username=username,
            oauth_provider=oauth_provider,
            jti=payload.get("jti"),
            family_id=family_id,
            exp=exp,
            device_id=device_id,
        )

    except JWTError as e:
        logger.warning(f"Token verification failed: {e}")
        return None


async def refresh_access_token(
    refresh_token: str, db: AsyncSession, ip: Optional[str] = None
) -> Dict[str, Any]:
    """
    使用刷新令牌换发新令牌对——**带轮换与重用检测**

    流程：签名/时效校验 → jti 撤销检查 → family 吊销检查 → 轮换重用检测
    （宽限期内重放放行且不重置计时；超宽限重放视为泄露，吊销整个 family）
    → 用户回源（保留）→ 标记旧 jti 已轮换（SET NX，首次时间戳为准）
    → 换发新对（沿用 family_id 与 device_id；存量无 family 的 token 换发时
    进入 family 体系）→ 回填设备存活证据。

    Args:
        refresh_token: 刷新令牌
        db: 异步数据库会话（用户回源 + family 吊销审计）
        ip: 来源 IP（仅用于刷新设备最近活跃时间，可为空）

    Returns:
        dict: 新的令牌对

    Raises:
        AuthenticationException: 令牌无效/已撤销/family 已吊销/重用（401），
            或用户不存在/未激活（401）
    """
    token_data = verify_token(refresh_token, token_type="refresh")
    if not token_data:
        raise AuthenticationException(
            detail="Invalid or expired refresh token", error_code="invalid_refresh_token"
        )

    # 1. jti 撤销（登出/改密按 token 撤销）
    if await token_state.is_revoked("token", token_data.jti):
        raise AuthenticationException(
            detail="Invalid or expired refresh token", error_code="invalid_refresh_token"
        )

    # 2. family 吊销（登出整体吊销 / 重用检测吊销）
    if token_data.family_id and await token_state.is_revoked("family", token_data.family_id):
        raise AuthenticationException(
            detail="Invalid or expired refresh token", error_code="invalid_refresh_token"
        )

    # 3. 轮换重用检测：宽限期内重放放行（多标签页/崩溃重试竞态），超宽限视为泄露
    rotated_at = await token_state.get_rotated(token_data.jti)
    if rotated_at is not None and (datetime.now(timezone.utc).timestamp() - rotated_at) > _rotation_grace_seconds():
        logger.warning(
            "refresh token 重用检测（超宽限期重放）：family=%s jti=%s → 吊销整个 family",
            token_data.family_id, token_data.jti,
        )
        if token_data.family_id:
            await revoke_family(db, token_data.family_id, revoked_by=token_data.user_id)
        raise AuthenticationException(
            detail="Invalid or expired refresh token", error_code="invalid_refresh_token"
        )

    # 4. 用户回源（方向：保留每请求回源）
    result = await db.execute(select(User).filter(User.id == token_data.user_id))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise AuthenticationException(
            detail="User not found or inactive", error_code="user_not_found_inactive"
        )

    # 5. 标记旧 jti 已轮换（NX：宽限期内重放不重置首次时间戳）
    now = datetime.now(timezone.utc)
    ttl = (
        int((token_data.exp - now).total_seconds())
        if token_data.exp
        else _default_ttl_seconds("refresh")
    )
    await token_state.mark_rotated(token_data.jti, ttl)

    # 6. 换发：沿用 family_id 与 device_id（存量 token 无 family → 新对自动进入新 family）
    extra: Dict[str, Any] = {}
    if token_data.family_id:
        extra["family_id"] = token_data.family_id
    if token_data.device_id:
        extra["device_id"] = token_data.device_id
    # 7. 设备存活证据（缺失时静默跳过，不影响刷新）
    await device_service.touch_family(db, token_data.family_id, ip)
    return create_token_pair(user, extra_claims=extra or None)


async def is_token_revoked(jti: Optional[str]) -> bool:
    """该 jti 是否已被撤销（Redis 位图单层直查，不回源 DB；）

    Redis 不可用时回退进程内内存兜底并登记 degraded——同 worker 撤销
    始终生效，跨 worker 在故障窗口内失效（显式暴露，非静默）。
    """
    return await token_state.is_revoked("token", jti)


async def revoke_family(
    db: AsyncSession,
    family_id: str,
    revoked_by: Optional[uuid.UUID] = None,
) -> bool:
    """吊销整个 refresh 家族（登出整体失效 / 轮换重用检测），幂等。

    Redis 位图（热路径）+ ``RevokedToken`` 表（token_type='family'，
    审计 + 启动回填源——Redis 丢失后家族吊销不复活）。TTL 取
    ``refresh_token_expire_days``：家族吊销后无法再换发，现存 refresh
    token 的剩余寿命不超过该窗口。
    """
    if not family_id:
        return False
    ttl = int(_get_security_config().refresh_token_expire_days * 86400)
    await token_state.revoke("family", family_id, ttl)

    existing = await db.execute(
        select(RevokedToken.id).filter(RevokedToken.jti == family_id)
    )
    if existing.scalar_one_or_none() is not None:
        return True
    db.add(
        RevokedToken(
            jti=family_id,
            user_id=revoked_by,
            token_type="family",
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=ttl),
        )
    )
    await db.flush()
    logger.info(f"Refresh family revoked: family={family_id} by={revoked_by}")
    return True


async def revoke_token(
    db: AsyncSession,
    token: str,
    token_type: str = "access",
    revoked_by: Optional[uuid.UUID] = None,
) -> bool:
    """
    撤销令牌（按 jti 写入位图 + DB 审计行，幂等）

    热路径生效靠 Redis 位图（TTL = token 剩余寿命，过期自失效）；
    ``RevokedToken`` 行保留为审计与启动回填源（留表、热路径不查）。

    Args:
        db: 异步数据库会话
        token: 要撤销的 JWT（access 或 refresh）
        token_type: 令牌类型，须与 token 的 type 声明一致
        revoked_by: 执行撤销的用户ID（可选，通常为 token 本人）

    Returns:
        bool: 是否成功撤销；token 非法、类型不符或缺少 jti 时返回 False
    """
    token_data = verify_token(token, token_type=token_type)
    if token_data is None or not token_data.jti:
        logger.warning("revoke_token: invalid token or missing jti")
        return False

    # 位图先写：热路径立即生效（幂等覆盖）
    now = datetime.now(timezone.utc)
    ttl = (
        int((token_data.exp - now).total_seconds())
        if token_data.exp
        else _default_ttl_seconds(token_type)
    )
    if ttl > 0:
        await token_state.revoke("token", token_data.jti, ttl)

    # DB 审计行（幂等；同时是启动回填源）
    existing = await db.execute(
        select(RevokedToken.id).filter(RevokedToken.jti == token_data.jti)
    )
    if existing.scalar_one_or_none() is not None:
        return True

    db.add(
        RevokedToken(
            jti=token_data.jti,
            user_id=revoked_by or token_data.user_id,
            token_type=token_type,
            expires_at=token_data.exp,
        )
    )
    await db.flush()
    logger.info(f"Token revoked: jti={token_data.jti} type={token_type}")
    return True


async def verify_token_active(token: str, token_type: str = "access") -> Optional[TokenData]:
    """
    校验令牌且未被撤销。

    在纯签名/时效校验（verify_token）基础上叠加撤销位图检查；
    被撤销的 token 一律视为失效（返回 None）。

    检查顺序：jti 撤销 → **family 吊销**。family 检查只在 claim 带
    ``family_id`` 时多发一次 Redis 读——登出/重用检测吊销整个 family 后，
    同 family 其它标签页的 access token **立即失效**（原实现只查 jti，
    攻击者经重用检测换得的 access 仍可活到过期）。

    热路径 = 至多 2 次 Redis 读（位图）+ 调用方 1 次用户查询，不回源 DB
    （；原为撤销 DB 查询 + 60s 负缓存两层）。
    """
    token_data = verify_token(token, token_type=token_type)
    if token_data is None:
        return None
    if await token_state.is_revoked("token", token_data.jti):
        return None
    if token_data.family_id and await token_state.is_revoked("family", token_data.family_id):
        logger.info(
            "Token rejected: family revoked jti=%s family=%s",
            token_data.jti, token_data.family_id,
        )
        return None
    return token_data


async def backfill_revocations(db: AsyncSession) -> int:
    """启动回填：把未过期的 ``RevokedToken`` 审计行写回位图

    覆盖 Redis 重启（``--appendonly no``）与 ``volatile-lru`` 淘汰造成的
    撤销丢失：``token_type='family'`` 行回填到 family 位图，其余回填到
    jti 位图。幂等（SET 覆盖写），worker 重复执行无害。

    Returns:
        int: 回填条数
    """
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(RevokedToken).filter(
            (RevokedToken.expires_at.is_(None)) | (RevokedToken.expires_at > now)
        )
    )
    count = 0
    for row in result.scalars().all():
        kind = "family" if row.token_type == "family" else "token"
        if row.expires_at is not None:
            exp = (
                row.expires_at
                if row.expires_at.tzinfo is not None
                else row.expires_at.replace(tzinfo=timezone.utc)
            )
            ttl = int((exp - now).total_seconds())
        else:
            ttl = _default_ttl_seconds("refresh" if kind == "family" else row.token_type)
        if ttl <= 0:
            continue
        await token_state.revoke(kind, row.jti, ttl)
        count += 1
    return count


