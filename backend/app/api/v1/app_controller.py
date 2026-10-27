"""
应用管理控制器

提供应用级别的管理 API：
- 根路由（欢迎信息）
- 健康检查
- 配置管理（读取、修改、重置、验证）
- 应用控制（关机、重启）
- 系统状态监控

配置管理、关机、重启等 API 仅在调试模式或管理员权限下可用
"""
from datetime import datetime
import logging
import socket
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, Query, Body, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.prefixes import get_route_prefix
from app.core.config import get_config
from app.core.constants import (
    DEFAULT_PAGE,
    LOG_DEFAULT_LINES,
    LOG_MAX_LINES,
    LOG_DEFAULT_KEEP_DAYS,
    LOG_MAX_KEEP_DAYS,
    AUDIT_DEFAULT_LOOKBACK_DAYS,
    AUDIT_MAX_LOOKBACK_DAYS,
    AUDIT_DEFAULT_PAGE_SIZE,
    AUDIT_MAX_PAGE_SIZE,
)
from app.services.app_service import get_app_service
from app.services.config_service import get_config_service
from app.services.grafana_service import get_grafana_service, GrafanaError
from app.services.monitoring_service import (
    get_monitoring_service,
    MonitoringControlError,
    MonitoringNotDeployedError,
)
from app.services.orchestration_service import get_orchestration_service
from app.services.audit_query_service import query_audit
from app.api.deps import get_current_user, get_current_admin_user
from app.models.user import User
from app.models.async_db import get_async_db
from app.core.exception import AuthorizationException, ConflictException, HttpStatusException

# 创建路由实例 - 根路由无前缀
router = APIRouter(prefix=get_route_prefix("root"), tags=["app-management"])

logger = logging.getLogger(__name__)


# ============== 根路由和健康检查 ==============


@router.get("/", tags=["root"])
async def root():
    """
    根路由 - 欢迎信息

    Returns:
        dict: 应用基本信息
    """
    config = get_config()
    return {
        "message": "Welcome to Kustos API",
        "title": config.app.title,
        "version": config.app.version,
        "status": "running"
    }


@router.get("/health", tags=["health"])
async def health_check():
    """
    健康检查路由

    Returns:
        dict: 健康状态信息
    """
    config = get_config()
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "service": config.app.title
    }


# ============== Pydantic 模型 ==============


class ConfigResponse(BaseModel):
    """配置响应模型"""
    success: bool
    data: Optional[Dict[str, Any]] = None
    errors: list = Field(default_factory=list)
    hints: list = Field(default_factory=list, description="提示信息列表，如需要重启的提示")
    meta: Optional[Dict[str, Any]] = Field(
        default=None,
        description="增强信息：sources={节:{键: env|db|default}}，供前端标注取值来源",
    )


class ConfigUpdateRequest(BaseModel):
    """配置更新请求模型"""
    config: Dict[str, Any] = Field(..., description="新的配置数据")


class ConfigSectionRequest(BaseModel):
    """配置节请求模型"""
    section: Optional[str] = Field(None, description="配置节名称")


class StatusResponse(BaseModel):
    """状态响应模型"""
    status: str
    debug_mode: bool
    uptime_seconds: int
    uptime_formatted: str
    version: str
    server_time: str
    process: Dict[str, Any]
    requests: Dict[str, Any]
    git_operations: Dict[str, Any]
    schema_state: Dict[str, Any] = Field(default_factory=dict, description="数据库 schema 版本（applied/head）")


class ActionResponse(BaseModel):
    """操作响应模型"""
    success: bool
    message: str


class MetricsPoint(BaseModel):
    """概览时序单点（一个降采样桶）"""
    t: int = Field(..., description="桶结束时刻（epoch 毫秒）")
    rpm: float = Field(0.0, description="每分钟请求数（桶内均值）")
    err_rate: float = Field(0.0, description="错误率百分比（非 2xx/3xx 占比）")
    avg_ms: float = Field(0.0, description="平均响应时间（毫秒）")
    p95_ms: float = Field(0.0, description="P95 响应时间（毫秒，直方图估算）")
    mem_mb: Optional[float] = Field(None, description="进程内存 RSS（MB，跨 worker 求和）")
    cpu_pct: Optional[float] = Field(None, description="进程 CPU 占用（%，跨 worker 求和）")
    s2xx: int = Field(0, description="2xx 请求数")
    s3xx: int = Field(0, description="3xx 请求数")
    s4xx: int = Field(0, description="4xx 请求数")
    s5xx: int = Field(0, description="5xx 请求数")


class MetricsTimeseriesResponse(BaseModel):
    """概览时序响应模型"""
    range: str
    step: int = Field(..., description="降采样步长（秒）")
    generated_at: str
    source: str = Field(..., description="数据来源：redis | memory")
    points: List[MetricsPoint] = Field(default_factory=list)


class DebugToggleRequest(BaseModel):
    """调试模式切换请求"""
    enabled: bool = Field(..., description="是否开启调试模式")


class DebugToggleResponse(BaseModel):
    """调试模式切换响应"""
    success: bool
    debug: Optional[bool] = None
    restart_required: bool = True
    message: str


class ComponentInfo(BaseModel):
    """编排组件（容器）状态"""
    service: str
    name: str
    label: Optional[str] = None
    state: str
    health: Optional[str] = None
    running: bool
    image: Optional[str] = None
    started_at: Optional[str] = None
    uptime_seconds: Optional[int] = None
    restart_count: Optional[int] = None
    exit_code: Optional[int] = None
    status_text: Optional[str] = None


class ComponentsResponse(BaseModel):
    """编排组件状态响应模型"""
    available: bool
    runtime: str = "docker"
    project: Optional[str] = None
    reason: Optional[str] = None
    generated_at: str
    components: List[ComponentInfo] = Field(default_factory=list)
    summary: Dict[str, int] = Field(default_factory=dict)


class MonitoringServiceState(BaseModel):
    """监控栈单服务状态（Grafana / Prometheus）"""
    running: bool
    configured: bool = False
    ready: bool = False
    entry: str = ""
    container_id: Optional[str] = None


class MonitoringResponse(BaseModel):
    """监控栈状态响应模型"""
    available: bool
    reason: Optional[str] = None
    generated_at: str
    grafana: MonitoringServiceState
    prometheus: MonitoringServiceState


class MonitoringEnabledRequest(BaseModel):
    """监控栈开关请求"""
    enabled: bool = Field(..., description="是否启用监控栈（启动/停止 Prometheus+Grafana）")


class GrafanaSsoResponse(BaseModel):
    """Grafana SSO 登录响应（会话 Cookie 已随响应下发）"""
    ok: bool
    entry: str


# ============== 依赖函数 ==============


def check_app_permission(
    current_user: User = Depends(get_current_user),
) -> tuple[bool, bool]:
    """
    检查应用管理权限（仅 JWT 管理员可访问）

    Args:
        current_user: 当前认证用户

    Returns:
        tuple[bool, bool]: (是否调试模式, 是否管理员)

    Raises:
        AuthorizationException: 权限不足
    """
    config = get_config()
    is_debug = config.app.debug
    is_admin = current_user.is_admin

    if not is_debug and not is_admin:
        raise AuthorizationException(
            detail="该操作需要管理员权限或调试模式"
        , error_code="app_admin_or_debug_required")

    return is_debug, is_admin


def _is_trusted_proxy(peer_host: str) -> bool:
    """直连 peer 是否为可信代理：本机回环，或网关容器（按 compose 服务名解析）。

    网关（nginx）对每个请求用 ``$remote_addr`` **覆写** ``X-Real-IP``，该头
    只有在直连 peer 是网关时才可信；同 docker 网络内其它容器可伪造
    ``X-Real-IP=127.0.0.1`` 冒充本机来源，绕过 debug 模式的本机限制。
    网关不可解析（单容器部署/测试）时仅回环可信。
    """
    if peer_host in ("localhost", "::1") or peer_host.startswith("127."):
        return True
    try:
        gateway_ip = socket.gethostbyname("gateway")
    except OSError:
        return False
    return peer_host == gateway_ip


def _client_ip(request: Request) -> str:
    """取客户端 IP。

    仅在直连 peer 为可信代理（回环/网关）时采用 ``X-Real-IP``——网关用
    ``$remote_addr`` **覆写**该头，不像 ``X-Forwarded-For`` 会被客户端伪造
    首段再被网关追加，因此经可信代理后仍可信；
    直连（dev/测试/不可信 peer）一律退回 ASGI 的 client host。
    """
    if not request.client:
        return ""
    peer = (request.client.host or "").strip()
    xrip = (request.headers.get("x-real-ip") or "").strip()
    if xrip and _is_trusted_proxy(peer):
        return xrip
    return peer


def _is_loopback(request: Request) -> bool:
    """请求是否来自本机（127.0.0.0/8 / ::1 / localhost）"""
    ip = _client_ip(request)
    if not ip:
        return False
    return ip == "localhost" or ip == "::1" or ip.startswith("127.")


def check_app_danger_permission(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> tuple[bool, bool]:
    """
    危险操作权限：重启 / 关闭 / 配置写回 / 日志清理

    管理员恒放行；``KUSTOS_APP_DEBUG=true`` **只对来自本机的请求**放宽。
    原实现是「debug 或 admin」——一次 ``debug=true`` 误配，就等于把重启、
    配置写回交给任意已登录用户。

    读操作（GET config/status/logs/components…）仍用 ``check_app_permission``。

    Args:
        request: 当前请求（用于判定来源是否本机）
        current_user: 当前认证用户

    Returns:
        tuple[bool, bool]: (是否调试模式, 是否管理员)，供服务层二次校验

    Raises:
        AuthorizationException: 权限不足（403）
    """
    is_debug = get_config().app.debug
    is_admin = current_user.is_admin

    if is_admin:
        return is_debug, True
    if is_debug and _is_loopback(request):
        return True, False

    raise AuthorizationException(
        detail="该操作需要管理员权限（调试模式下仅对本机来源开放）",
        error_code="app_admin_required",
    )


# ============== API 路由 ==============


@router.get("/api/app/config", response_model=ConfigResponse)
async def get_config_endpoint(
    section: Optional[str] = Query(None, description="配置节名称"),
    permission: tuple = Depends(check_app_permission)
):
    """
    获取应用配置

    Args:
        section: 配置节名称，如 'server', 'app', 'storage' 等

    Returns:
        ConfigResponse: 配置数据
    """
    config_service = get_config_service()
    config_data = config_service.get_config(section)

    return ConfigResponse(
        success=True,
        data=config_data,
        errors=[],
        # 取值来源：env（部署硬约束）/ db（后台可写）/ default——前端据此标注
        meta={"sources": config_service.get_sources()},
    )


@router.post("/api/app/config", response_model=ConfigResponse)
async def update_config_endpoint(
    request: ConfigUpdateRequest,
    permission: tuple = Depends(check_app_danger_permission),
    current_user: User = Depends(get_current_user),
):
    """
    更新应用配置（写入 ``app_config`` 表；本进程立即生效，其余进程 ≤5s 收敛）

    Args:
        request: 配置更新请求
        current_user: 当前用户（落 ``app_config.updated_by`` 审计）

    Returns:
        ConfigResponse: 更新结果（包含重启提示）
    """
    is_debug, is_admin = permission
    config_service = get_config_service()

    success, errors, hints = config_service.update_config(
        request.config,
        is_debug=is_debug,
        is_admin=is_admin,
        updated_by=current_user.id,
    )

    return ConfigResponse(
        success=success,
        errors=errors,
        hints=hints
    )


@router.post("/api/app/config/reset", response_model=ConfigResponse)
async def reset_config_endpoint(
    permission: tuple = Depends(check_app_danger_permission)
):
    """
    重置配置为默认值

    Returns:
        ConfigResponse: 重置结果
    """
    is_debug, is_admin = permission
    config_service = get_config_service()

    success, errors = config_service.reset_config(
        is_debug=is_debug,
        is_admin=is_admin
    )

    return ConfigResponse(
        success=success,
        errors=errors
    )


@router.post("/api/app/config/validate", response_model=ConfigResponse)
async def validate_config_endpoint(
    config_data: Optional[Dict[str, Any]] = Body(None, description="要验证的配置数据"),
    permission: tuple = Depends(check_app_permission)
):
    """
    验证配置数据

    Args:
        config_data: 要验证的配置数据，为空则验证当前配置

    Returns:
        ConfigResponse: 验证结果
    """
    config_service = get_config_service()
    is_valid, errors = config_service.validate_config(config_data)

    return ConfigResponse(
        success=is_valid,
        errors=errors
    )


@router.post("/api/app/debug", response_model=DebugToggleResponse, tags=["app-management"])
async def set_debug_mode_endpoint(
    request: DebugToggleRequest,
    current_user: User = Depends(get_current_admin_user),
):
    """
    开启/关闭调试模式（仅管理员）

    将 ``app.debug`` 写入 ``app_config``（其余键保留）：本进程立即生效，
    其余进程经配置版本检测 ≤5s 收敛——**无需重启服务**。

    Returns:
        DebugToggleResponse: 切换结果与提示
    """
    config_service = get_config_service()
    result = config_service.set_debug_mode(request.enabled, is_admin=current_user.is_admin)
    return DebugToggleResponse(**result)


@router.get("/api/app/status", response_model=StatusResponse)
async def get_status_endpoint(
    current_user: User = Depends(get_current_user),
):
    """
    获取应用状态（登录可见）

    Args:
        current_user: 当前认证用户

    Returns:
        StatusResponse: 应用状态信息
    """
    from app.middleware.request_stats import get_request_stats

    app_service = get_app_service()
    requests_info = await get_request_stats().get_stats()
    status = app_service.get_status(requests_info=requests_info)

    return StatusResponse(**status)


@router.get("/api/v1/stats/platform", tags=["stats"])
async def get_platform_stats_endpoint(db: AsyncSession = Depends(get_async_db)):
    """
    获取平台级公开统计

    Returns:
        dict: 包含 repository_count, commit_count, user_count, uptime_seconds
    """
    from app.middleware.request_stats import get_request_stats
    from app.services import stats_service

    stats = await stats_service.get_platform_stats(db)
    app_service = get_app_service()
    requests_info = await get_request_stats().get_stats()
    status = app_service.get_status(requests_info=requests_info)

    return {
        **stats,
        "uptime_seconds": status["uptime_seconds"],
    }


@router.get(
    "/api/app/metrics/timeseries",
    response_model=MetricsTimeseriesResponse,
    tags=["app-management"],
)
async def get_metrics_timeseries_endpoint(
    range_key: Literal["5m", "30m", "1h", "6h", "24h"] = Query(
        "1h", alias="range", description="时间范围"
    ),
    current_user: User = Depends(get_current_admin_user),
):
    """
    获取概览趋势时序（仅管理员）。

    合并请求分钟桶与进程内存/CPU 采样，按范围降采样为点序列。历史存于 Redis
    （请求桶见 middleware/request_stats，进程采样见 services/process_metrics），
    保留时长由 ``metrics.history_minutes`` 控制；Redis 不可用时退回进程内实现。

    Returns:
        MetricsTimeseriesResponse: 范围、步长、数据来源与点序列
    """
    from app.services.metrics_service import get_timeseries

    return await get_timeseries(range_key)


@router.post("/api/app/shutdown", response_model=ActionResponse)
async def shutdown_endpoint(
    permission: tuple = Depends(check_app_danger_permission)
):
    """
    关闭应用

    发送信号触发优雅关闭

    Returns:
        ActionResponse: 操作结果
    """
    is_debug, is_admin = permission
    app_service = get_app_service()

    success = app_service.shutdown(
        is_debug=is_debug,
        is_admin=is_admin
    )

    return ActionResponse(
        success=success,
        message="应用将在稍后关闭" if success else "关闭失败"
    )


@router.post("/api/app/restart", response_model=ActionResponse)
async def restart_endpoint(
    permission: tuple = Depends(check_app_danger_permission)
):
    """
    重启应用（管理员；调试模式下仅对本机来源开放）

    多 worker 部署下信号交给**进程管理器**（uvicorn ``--workers`` /
    gunicorn）做滚动重启——新 worker 就绪后才退役旧 worker；单进程才回退到
    「拉起新进程 + 退出自身」。

    Returns:
        ActionResponse: 操作结果
    """
    is_debug, is_admin = permission
    app_service = get_app_service()

    success = app_service.restart(
        is_debug=is_debug,
        is_admin=is_admin
    )

    return ActionResponse(
        success=success,
        message="应用将在稍后重启" if success else "重启失败"
    )


# ============== 日志管理接口 ==============


class LogInfoResponse(BaseModel):
    """日志信息响应模型"""
    log_dir: str
    today_dir: str
    today_files: list
    available_dates: list


class LogContentResponse(BaseModel):
    """日志内容响应模型"""
    date: str
    log_name: str
    lines: int
    total_lines: int
    content: str
    exists: bool
    window_parts: list = Field(default_factory=list, description="返回窗口覆盖的分片（旧→新）")
    segment_starts: list = Field(default_factory=list, description="各分片在窗口内的起始行偏移")
    truncated: bool = Field(default=False, description="是否已达保留上限、更早分片可能被丢弃")


class LogCleanupResponse(BaseModel):
    """日志清理响应模型"""
    success: bool
    deleted_count: int
    keep_days: int


class AuditListResponse(BaseModel):
    """审计统一查询响应模型"""
    items: list
    total: int
    page: int
    limit: int
    pages: int
    has_next: bool
    has_prev: bool
    truncated: bool = Field(
        default=False,
        description="是否已达日志扫描行数上限、更早的记录可能未纳入统计",
    )


@router.get("/api/app/logs", response_model=LogInfoResponse)
async def get_log_info_endpoint(
    permission: tuple = Depends(check_app_permission)
):
    """
    获取日志系统信息

    Returns:
        LogInfoResponse: 日志目录、文件列表等信息
    """
    app_service = get_app_service()
    log_info = app_service.get_log_info()

    return LogInfoResponse(**log_info)


@router.get("/api/app/logs/content", response_model=LogContentResponse)
async def get_log_content_endpoint(
    date: Optional[str] = Query(None, description="日期 (YYYY-MM-DD)，默认为今天"),
    log_name: str = Query("app", description="日志文件名，如 app, error"),
    lines: int = Query(LOG_DEFAULT_LINES, ge=1, le=LOG_MAX_LINES, description="返回行数（1-5000）"),
    level: Optional[str] = Query(None, description="过滤级别 (debug/info/warning/error/critical)"),
    permission: tuple = Depends(check_app_permission)
):
    """
    获取日志内容

    Args:
        date: 日期字符串，格式 YYYY-MM-DD
        log_name: 日志文件名（不含扩展名）
        lines: 返回的行数（从末尾开始）
        level: 过滤日志级别

    Returns:
        LogContentResponse: 日志内容和元数据
    """
    app_service = get_app_service()
    log_content = app_service.get_log_content(
        date=date,
        log_name=log_name,
        lines=lines,
        level=level
    )

    return LogContentResponse(**log_content)


@router.post("/api/app/logs/cleanup", response_model=LogCleanupResponse)
async def cleanup_logs_endpoint(
    keep_days: int = Query(LOG_DEFAULT_KEEP_DAYS, ge=1, le=LOG_MAX_KEEP_DAYS, description="保留天数（1-365）"),
    permission: tuple = Depends(check_app_danger_permission)
):
    """
    清理旧日志文件

    Args:
        keep_days: 保留最近多少天的日志

    Returns:
        LogCleanupResponse: 清理结果
    """
    is_debug, is_admin = permission
    app_service = get_app_service()

    result = app_service.cleanup_old_logs(
        keep_days=keep_days,
        is_debug=is_debug,
        is_admin=is_admin
    )

    return LogCleanupResponse(**result)


@router.get("/api/app/audit", response_model=AuditListResponse, tags=["app-management"])
async def query_audit_endpoint(
    days: int = Query(AUDIT_DEFAULT_LOOKBACK_DAYS, ge=1, le=AUDIT_MAX_LOOKBACK_DAYS, description="向前回看的天数（含今天，1-90）"),
    source: Literal["all", "http", "activity"] = Query(
        "all", description="数据源：http=audit.log，activity=activities 表，all=合并"
    ),
    method: Optional[str] = Query(None, description="HTTP 方法过滤（仅 http 源）"),
    username: Optional[str] = Query(None, description="用户名子串匹配（仅 http 源）"),
    user_id: Optional[str] = Query(
        None, description="用户 ID 精确匹配（http 的 user_id / activity 的 actor_id）"
    ),
    path: Optional[str] = Query(None, description="请求路径子串匹配（仅 http 源）"),
    status_code: Optional[int] = Query(None, ge=100, le=599, description="响应状态码（仅 http 源）"),
    level: Optional[str] = Query(None, description="日志级别（仅 http 源）"),
    sensitive: Optional[bool] = Query(None, description="是否敏感操作（仅 http 源）"),
    action: Optional[str] = Query(None, description="业务动作精确匹配（仅 activity 源）"),
    entity_type: Optional[str] = Query(None, description="实体类型（仅 activity 源）"),
    q: Optional[str] = Query(None, description="关键词（http 匹配 path/用户名/IP，activity 匹配 action/details）"),
    page: int = Query(DEFAULT_PAGE, ge=1, description="页码"),
    limit: int = Query(AUDIT_DEFAULT_PAGE_SIZE, ge=1, le=AUDIT_MAX_PAGE_SIZE, description="每页数量"),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_admin_user),
):
    """
    审计统一查询（；收紧为 **admin-only**）

    合并两此前互不相通的审计体系：``audit.log`` 的 HTTP 请求审计与
    ``activities`` 表的业务实体审计，按时间倒序统一返回。

    原依赖 ``check_app_permission``（debug 或 admin 即放行）——debug 模式
    对任意已登录用户开放且无本机来源限制，审计含 client_ip/UA/query 并可
    扫 5 万行（debug 误配 = 普通用户读全量审计）。
    """
    return AuditListResponse(**await query_audit(
        db,
        days=days,
        source=source,
        page=page,
        limit=limit,
        method=method,
        username=username,
        user_id=user_id,
        path=path,
        status_code=status_code,
        level=level,
        sensitive=sensitive,
        action=action,
        entity_type=entity_type,
        q=q,
    ))


# ============== 编排组件状态接口 ==============


@router.get("/api/app/components", response_model=ComponentsResponse, tags=["app-management"])
async def get_components_endpoint(
    current_user: User = Depends(get_current_admin_user),
):
    """
    获取编排中各组件（容器）的状态。

    通过只读 Docker socket 代理查询，用于 admin 控制台可视化各组件健康度。
    仅管理员可访问；Docker 不可用时返回 available=false 而非报错。

    Returns:
        ComponentsResponse: 组件状态列表与汇总
    """
    orchestration_service = get_orchestration_service()
    data = await orchestration_service.get_components()

    return ComponentsResponse(**data)


# ============== 监控栈（Prometheus / Grafana）接口 ==============


@router.get("/api/app/monitoring", response_model=MonitoringResponse, tags=["app-management"])
async def get_monitoring_endpoint(
    current_user: User = Depends(get_current_admin_user),
):
    """
    探测可选监控栈（Prometheus / Grafana）是否在运行。

    经只读 docker-socket-proxy 复用编排容器清单判定；Docker 不可用时降级
    available=false。Grafana 的 ready 表示容器运行中且已注入凭据，
    admin 控制台据此展示「打开 Grafana」入口。

    Returns:
        MonitoringResponse: 监控栈服务状态
    """
    monitoring_service = get_monitoring_service()
    data = await monitoring_service.get_monitoring()

    return MonitoringResponse(**data)


@router.post(
    "/api/app/monitoring/enabled",
    response_model=MonitoringResponse,
    tags=["app-management"],
)
async def set_monitoring_enabled_endpoint(
    request: MonitoringEnabledRequest,
    current_user: User = Depends(get_current_admin_user),
):
    """
    开关可选监控栈（Prometheus / Grafana 一并启停，仅管理员）。

    经窄写代理（docker-write-proxy）对监控栈容器做 start/stop；容器需已创建
    （曾以监控 compose 部署过一次，之后可被后续一键部署遗漏而停摆），
    从未部署过时返回 409 并给出拉起命令。编排不可用或控制失败返回 502。

    Returns:
        MonitoringResponse: 启停后重新探测的监控栈状态
    """
    monitoring_service = get_monitoring_service()
    try:
        data = await monitoring_service.set_enabled(request.enabled)
    except MonitoringNotDeployedError as exc:
        logger.warning(
            "审计[monitoring-toggle] 管理员 %s 尝试%s监控栈但栈从未部署: %s",
            current_user.username, "启动" if request.enabled else "停止", exc,
        )
        raise ConflictException(detail=str(exc), error_code="monitoring_not_deployed") from exc
    except MonitoringControlError as exc:
        logger.error(
            "审计[monitoring-toggle] 管理员 %s %s监控栈失败: %s",
            current_user.username, "启动" if request.enabled else "停止", exc,
        )
        raise HttpStatusException(status_code=502, detail=str(exc), error_code="monitoring_control_failed") from exc

    logger.info(
        "审计[monitoring-toggle] 管理员 %s %s了监控栈: grafana=%s prometheus=%s",
        current_user.username,
        "启动" if request.enabled else "停止",
        data["grafana"]["container_id"] or "-",
        data["prometheus"]["container_id"] or "-",
    )
    return MonitoringResponse(**data)


@router.get(
    "/api/app/monitoring/grafana/sso",
    response_model=GrafanaSsoResponse,
    tags=["app-management"],
)
async def grafana_sso_endpoint(
    response: Response,
    current_user: User = Depends(get_current_admin_user),
):
    """
    Grafana 免密登录（SSO）：以管理员身份在 app 侧登录 Grafana，
    取出 ``grafana_session`` 并以同源 Cookie（Path=/grafana）下发给浏览器，
    前端随后跳转到网关反代子路径 ``/grafana`` 即可直接进入 Grafana。

    仅管理员可访问；Grafana 不可达或凭据无效时返回 502。

    Returns:
        GrafanaSsoResponse: 登录成功 + 入口路径（前端据此 location.assign）
    """
    grafana_service = get_grafana_service()
    try:
        session = await grafana_service.login()
    except GrafanaError as exc:
        raise HttpStatusException(
            status_code=502,
            detail=f"Grafana 登录失败: {exc}",
            error_code="grafana_login_failed",
        ) from exc

    response.set_cookie(
        "grafana_session",
        session,
        path=grafana_service.entry_path,
        httponly=True,
        samesite="lax",
    )
    return GrafanaSsoResponse(ok=True, entry=grafana_service.entry_path)


# ============== Redis 运维状态（只读） ==============


@router.get("/api/app/redis/status", tags=["app-management"])
async def get_redis_status_endpoint(
    current_user: User = Depends(get_current_admin_user),
):
    """
    获取 Redis 运维状态（仅管理员，只读）。

    聚合连接探活/延迟、各 worker 存活与广播总线状态（Redis 心跳注册表）、
    订阅模式数（PUBSUB NUMPAT）、INFO 指标、命名空间键数与降级计数。
    Redis 不可用时返回 reachable=false 而非报错。

    Returns:
        dict: Redis 连接/worker/订阅/指标/键空间/降级
    """
    from app.services.redis_admin_service import get_redis_admin_service

    return await get_redis_admin_service().get_status()


@router.get("/api/app/redis/config", tags=["app-management"])
async def get_redis_config_endpoint(
    current_user: User = Depends(get_current_admin_user),
):
    """
    获取 Redis 配置（仅管理员，只读；连接 URL 脱敏）。

    Returns:
        dict: settings（脱敏）/runtime（INFO memory）/editable/source
    """
    from app.services.redis_admin_service import get_redis_admin_service

    return await get_redis_admin_service().get_config()



