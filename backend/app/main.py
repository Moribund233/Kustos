import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI

from app.core.init import init_app

# 注意：logger 和 config 的导入被延迟到 create_app() 内部
# 以确保 init_app() 先执行环境变量检查


def create_app() -> FastAPI:
    """
    创建FastAPI应用实例

    注意：CORS 由 Nginx 反向代理统一处理，不在应用层配置。
    无论是开发环境还是生产环境，都通过 Nginx 处理跨域。

    配置来源固定为「env > app_config > 默认值」，没有配置文件路径参数。

    Returns:
        FastAPI: FastAPI应用实例
    """
    # 延迟导入所有可能触发 config/models 加载的模块
    # 确保 init_app() 先执行环境变量检查
    from app.lifespan import app_lifespan
    from app.core.config import get_config
    from app.core.init import init_app
    from app.utils.logging import get_logger

    # 应用初始化：配置校验、日志、数据库表与管理员引导、仓库目录
    if not init_app():
        raise RuntimeError("应用初始化失败，请检查启动日志")

    # 获取 logger
    logger = get_logger("app")

    # 获取配置
    config = get_config()

    # Sentry 错误监控初始化（未配置 DSN 时零开销跳过）
    from app.core.sentry import init_sentry
    init_sentry(config)

    # 创建FastAPI应用实例，使用lifespan管理生命周期
    app = FastAPI(
        title=config.app.title,
        description=config.app.description,
        version=config.app.version,
        debug=config.app.debug,
        lifespan=app_lifespan
    )

    # 添加并发限制中间件（最先添加 = 最内层，保护服务免受过多并发请求影响）
    from app.middleware.concurrency import ConcurrencyMiddleware
    from app.core.config import ConcurrencySettings
    conc = config.concurrency
    # 中间件是准入控制，上限不超过连接池有效容量（否则慢 DB 下先抛
    # pool_timeout 而非中间件的有界 503）
    desired = ConcurrencySettings.from_database(
        config.database, apply_pool_cap=False
    ).max_concurrent
    capacity = config.database.effective_pool_capacity
    if capacity and desired > capacity:
        logger.info(
            f"并发准入上限按连接池容量收窄: {desired} → {conc.max_concurrent}"
            f"（池容量 {capacity}）"
        )
    logger.info(
        f"并发准入: max_concurrent={conc.max_concurrent}, "
        f"max_wait_time={conc.max_wait_time}s, "
        f"global_max_concurrent={conc.global_max_concurrent}"
    )
    app.add_middleware(
        ConcurrencyMiddleware,
        max_concurrent=conc.max_concurrent,
        max_wait_time=conc.max_wait_time,
        global_max_concurrent=conc.global_max_concurrent,
    )

    # 添加审计日志中间件（内层：可记录并发准入拒绝的 503）
    # 开关显式接到 [logging] audit_log_enabled（中间件内还会与
    # is_audit_enabled() 取与，两处同源于同一配置项）
    from app.middleware.audit_logger import AuditLoggerMiddleware
    app.add_middleware(AuditLoggerMiddleware, enabled=config.logging.audit_log_enabled)

    # 观测层（最后添加 = 最外层）：安全响应头 + 慢请求告警 +
    # 指标/统计单一记录点（合并原 timeout / security_headers /
    # request_stats / prometheus_metrics 四层 BaseHTTPMiddleware，6 层 → 3 层；
    # 记录范围由 middleware.scope 统一裁决，与 /metrics 导出同口径）
    from app.middleware.observability import ObservabilityMiddleware
    enable_hsts = not config.app.debug
    app.add_middleware(
        ObservabilityMiddleware,
        threshold_seconds=config.app.slow_request_threshold_ms / 1000.0,
        enable_hsts=enable_hsts,
        hsts_max_age=config.security.hsts_max_age,
        allow_iframe=False,
        add_security_headers=True,
    )

    # /metrics 导出端点（读 Redis 跨 worker 聚合，见 middleware/prometheus_metrics）
    from app.utils.prometheus_metrics import metrics_response
    app.add_route("/metrics", metrics_response, include_in_schema=False)

    # 注意：CORS 由 Nginx 反向代理统一处理
    # 开发环境: docker-compose.dev.yml 中的 Nginx 处理
    # 生产环境: docker-compose.yml 中的 Nginx 处理
    logger.info("CORS 由 Nginx 反向代理处理")

    # 包含所有 API v1 路由（包括根路由、健康检查、应用管理等）
    from app.api.router import api_v1_router
    app.include_router(api_v1_router)

    # 注意：Git HTTP Smart Protocol 由 Nginx + git-http-backend 处理
    # 参见 docker/nginx/nginx.conf 配置

    # 设置全局异常处理器（必须在路由注册之后设置，确保能捕获所有异常）
    from app.utils.exception_handler import setup_exception_handlers
    setup_exception_handlers(app)

    # Sentry ASGI 中间件（包装在最外层，捕获所有请求异常）
    from app.core.sentry import sentry_middleware
    app = sentry_middleware(app)

    return app


class AppCache:
    """
    FastAPI应用实例缓存

    缓存已创建的应用实例，避免重复初始化。
    使用模块级缓存而非手动单例模式，降低复杂度。
    """
    _app: Optional[FastAPI] = None

    @classmethod
    def get_app(cls) -> FastAPI:
        """
        获取FastAPI应用实例（缓存）

        Returns:
            FastAPI: FastAPI应用实例
        """
        if cls._app is None:
            cls._app = create_app()
        return cls._app

    @classmethod
    def reset(cls):
        """重置缓存（用于测试）"""
        cls._app = None


def get_app() -> FastAPI:
    """
    获取FastAPI应用实例（缓存）

    Returns:
        FastAPI: FastAPI应用实例
    """
    return AppCache.get_app()


# 模块级 app 实例（供 uvicorn app.main:app 使用）
app = get_app()


def start_server():
    """
    启动 Web 服务器

    仅 debug 模式（开发）在此启动 Uvicorn 单进程并支持热重载；
    **生产运行时不走本函数**——由 Dockerfile CMD 直接起
    ``uvicorn --workers 4``（gunicorn 配置保留为备选路径，
    切换时用 ``gunicorn -c core/gunicorn.conf.py app.main:app``）。
    """
    import uvicorn
    from app.utils.logging import get_logger
    from app.core.config import get_config

    # 创建应用实例（在 init_app() 成功之后）
    app = get_app()

    config = get_config()
    logger = get_logger("app")
    debug = config.app.debug

    env_name = "开发环境" if debug else "生产环境"
    logger.info(f"服务启动: http://{config.server.host}:{config.server.port} ({env_name})")

    if debug:
        uvicorn.run(
            app,
            host=config.server.host,
            port=config.server.port,
            reload=config.server.reload,
            log_level=config.server.log_level,
            workers=1,
            reload_excludes=["frontend/**"]
        )


if __name__ == "__main__":
    start_server()
