"""客户端兼容性端点

桌面端需要判断"我能不能跟这个实例正常协作"。核心认识：**服务端版本不等于
API 契约版本**——实例可能升到 0.2 而 API 仍是 v1，也可能打了补丁却没动 API。
所以这里区分两个字段：

- ``api_version``：当前 API 契约版本（基线为 ``v1``）
- ``api_min``：客户端最低可用的契约版本；低于它就应阻断，而不是"尽量兼容"

再加一份**特性开关**：客户端按能力降级，而不是按版本号猜。协作感知就是
典型例子——老实例没有 ``collab_active``，客户端不该显示 live 圆点。

位置说明：设计文档原本写 ``/api/app/client-compat``，但同一份文档的 bridge
白名单显式拒绝 ``/api/app/``（那是只在受信网络里开放的管理面）。放那儿等于
桌面端永远访问不到，所以改到 ``/api/v1`` 的公开面——它本来就该是公开信息，
不含任何敏感内容。

**声明式而非判定式**：客户端各自知道自己的版本，服务端只需如实公布契约版本
与能力，不替客户端假设"你是哪个版本"。
"""

import os

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.prefixes import API_V1_PREFIX
from app.core.config import get_config

router = APIRouter(prefix=API_V1_PREFIX, tags=["client-compat"])

#: 当前 API 契约版本。改破坏性契约时提升，并同步提出新的 api_min。
API_VERSION = "v1"
#: 客户端最低可用契约版本。低于此值即阻断（不尝试降级兼容）。
API_MIN_VERSION = "v1"

#: 协作感知所需的网关地址与密钥环境变量（与 collab_active_service 同源）
_COLLAB_ENDPOINTS_ENV = "KUSTOS_COLLAB_ACTIVE_ENDPOINTS"
_COLLAB_SECRET_ENV = "KUSTOS_COLLAB_INTERNAL_SECRET"


def _server_version() -> str:
    """服务端应用版本；配置不可用时给占位值而不是抛错（兼容性查询不该失败）。"""
    try:
        return get_config().app.version
    except Exception:  # noqa: BLE001 — 配置未就绪时不影响兼容性判断
        return "unknown"


def _collab_active_enabled() -> bool:
    """协作感知是否可用：需要网关地址与内部密钥同时就位。"""
    endpoints = (os.environ.get(_COLLAB_ENDPOINTS_ENV) or "").strip()
    secret = (os.environ.get(_COLLAB_SECRET_ENV) or "").strip()
    return bool(endpoints) and bool(secret)


class ClientCompatResponse(BaseModel):
    """服务端能力声明；客户端据此决定启用哪些功能"""

    api_version: str = Field(..., description="当前 API 契约版本")
    api_min: str = Field(..., description="客户端最低可用契约版本，低于即应阻断")
    server_version: str = Field(..., description="服务端应用版本")
    features: dict = Field(
        ...,
        description=(
            "能力开关；客户端按能力降级而不是按版本号猜。"
            "键为功能名，值为该实例是否支持"
        ),
    )


@router.get("/client-compat", response_model=ClientCompatResponse)
async def get_client_compat():
    """公布 API 契约版本与能力开关（公开，无需鉴权）。

    桌面端启动时在登录之前就要判断兼容性，因此这个端点不能要求鉴权；
    它也不包含任何实例敏感信息（组件、配置、用户、日志一律没有）。
    """
    return {
        "api_version": API_VERSION,
        "api_min": API_MIN_VERSION,
        "server_version": _server_version(),
        "features": {
            # 本轮新增：桌面端文件树 live 提示依赖它
            "collab_active": _collab_active_enabled(),
            # 离线 outbox 自动补发依赖它
            "idempotency_key": True,
            # 桌面端免密码登录依赖它
            "pkce_login": True,
        },
    }
