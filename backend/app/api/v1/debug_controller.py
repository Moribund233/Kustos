"""
调试控制器

提供调试/开发用的管理接口：
- debug/initdb: 重置数据库（删除并重新创建所有表）
- debug/initconf: 重置数据库配置（config.example.toml 种子值覆盖 app_config）

安全要求：
- 仅在调试模式下可用（app.debug=true）
- 需要本地认证（Local Auth）或管理员用户认证
- 这些接口具有破坏性，谨慎使用
"""
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.config import ConfigManager, get_config
from app.core.constants import PROJECT_ROOT
from app.api.deps import get_current_user
from app.core.exception import AppServiceException, AuthorizationException
from app.models.user import User
from app.services.database_manager import DatabaseResetManager
from app.utils.logging import get_named_logger

router = APIRouter(prefix="/api/v1/debug", tags=["debug"])
logger = get_named_logger("debug")

# 配置文件路径（模块级常量，便于测试替换）
CONFIG_PATH = "config.toml"
EXAMPLE_CONFIG_PATH = PROJECT_ROOT / "config.example.toml"


# ============== Pydantic 模型 ==============


class InitDbResponse(BaseModel):
    """初始化数据库响应模型"""
    success: bool
    message: str
    details: dict = Field(default_factory=dict)


class InitConfResponse(BaseModel):
    """重置配置响应模型"""
    success: bool
    message: str


class DebugStatusResponse(BaseModel):
    """调试状态响应模型"""
    debug_mode: bool
    #: 源链健康态：db = env > app_config > 默认；degraded = 库配置层不可读（env > 默认）
    config_source: str = Field(..., description="配置源链健康态：db / degraded")
    database_url: str
    database_type: str
    environment: dict = Field(default_factory=dict, description="环境变量信息")
    stress_test_mode: bool = Field(default=False, description="是否处于压力测试模式")


# ============== 依赖函数 ==============


async def require_debug_mode():
    """
    检查是否处于调试模式

    Raises:
        HTTPException: 非调试模式下抛出 403 错误
    """
    config = get_config()
    if not config.app.debug:
        raise AuthorizationException(
            detail="Debug endpoints are only available in debug mode",
            error_code="debug_disabled",
        )


async def require_admin(
    current_user: User = Depends(get_current_user)
) -> User:
    """
    要求 JWT 管理员权限

    复用 api/deps.py 的 get_current_user 进行基础认证，
    然后额外检查管理员权限。

    Args:
        current_user: 当前认证用户（由 get_current_user 注入）

    Returns:
        User: 认证通过的管理员用户

    Raises:
        HTTPException: 权限不足时抛出 403 错误
    """
    if not current_user.is_admin:
        raise AuthorizationException(
            detail="Admin permission required",
            error_code="admin_required",
        )
    return current_user


# ============== API 端点 ==============


@router.get("/status", response_model=DebugStatusResponse)
async def debug_status(
    _: User = Depends(require_admin),
    __: None = Depends(require_debug_mode)
):
    """
    获取调试状态信息

    显示当前调试模式状态、配置文件状态、环境变量等信息

    Returns:
        DebugStatusResponse: 调试状态信息
    """
    config = get_config()

    # 收集环境变量信息（排除敏感信息）
    env_info = {}
    sensitive_keys = {'password', 'secret', 'token', 'key', 'jwt', 'auth'}

    for key, value in os.environ.items():
        # 只包含 KUSTOS_ 开头的环境变量
        if key.startswith('KUSTOS_'):
            # 检查是否是敏感信息
            key_lower = key.lower()
            is_sensitive = any(s in key_lower for s in sensitive_keys)

            if is_sensitive:
                env_info[key] = "***masked***"
            else:
                env_info[key] = value

    # 检查是否处于压力测试模式
    stress_test_mode = os.environ.get('KUSTOS_STRESS_TEST', 'false').lower() == 'true'

    return DebugStatusResponse(
        debug_mode=config.app.debug,
        config_source=ConfigManager().config_source,
        database_url=config.database._mask_url(config.database.url),
        database_type=config.database.db_type,
        environment=env_info,
        stress_test_mode=stress_test_mode
    )


@router.post("/initdb", response_model=InitDbResponse)
async def init_database(
    _: None = Depends(require_debug_mode),
    current_user: User = Depends(require_admin)
):
    """
    重置数据库

    删除所有表并重新建立，启动时自动引导管理员用户。

    Returns:
        InitDbResponse: 操作结果

    Raises:
        HTTPException: 非调试模式或权限不足时
    """
    try:
        manager = DatabaseResetManager()
        result = await manager.reset_database(preserve_config=True)

        return InitDbResponse(
            success=True,
            message=f"数据库重置成功 ({result['database_type']})",
            details=result
        )

    except Exception as e:
        logger.error(f"数据库重置失败: {e}")
        raise AppServiceException(
            status_code=500,
            detail=f"Database reset failed: {str(e)}",
            error_code="debug_db_reset_failed",
        )


@router.post("/initconf", response_model=InitConfResponse)
async def init_config(
    _: None = Depends(require_debug_mode),
    current_user: User = Depends(require_admin)
):
    """
    重置配置（恢复模板默认值）

    把 ``config.example.toml`` 过滤后的种子值**覆盖**写入 ``app_config``，
    随后各进程经配置版本检测收敛。TOML 层已移除，不再产生/备份配置文件。

    Returns:
        InitConfResponse: 操作结果

    Raises:
        HTTPException: 非调试模式或权限不足
        AppServiceException: 模板缺失或重置失败
    """
    if not EXAMPLE_CONFIG_PATH.exists():
        raise AppServiceException(
            status_code=500,
            detail="config.example.toml 不存在，无法重置配置",
            error_code="debug_config_template_missing",
        )

    from app.services.config_service import get_config_service

    ok, errors = get_config_service().reset_config(is_debug=True, is_admin=True)
    if not ok:
        logger.error(f"配置重置失败: {errors}")
        raise AppServiceException(
            status_code=500,
            detail="; ".join(errors) or "配置重置失败",
            error_code="debug_config_reset_failed",
        )

    logger.info("配置已重置为模板默认值（app_config）")

    return InitConfResponse(
        success=True,
        message="配置已重置为模板默认值（数据库）",
    )
