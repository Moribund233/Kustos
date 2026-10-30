"""
观测层中间件（合并）

把原先三处独立的 BaseHTTPMiddleware 合并为**一层**，消除多层
``BaseHTTPMiddleware`` 叠套（Starlette 官方对该类有流式响应/性能警告）：

| 原中间件 | 职责 | 去向 |
|---------|------|------|
| ``RequestTimeLoggerMiddleware`` | 慢请求告警 | 本层 |
| ``SecurityHeadersMiddleware`` | 安全响应头（HSTS/X-Frame 等） | 本层 |
| ``RequestStatsMiddleware`` + ``PrometheusMetricsMiddleware`` | 统计/计数记录 | 本层（单一记录点） |

记录语义：
- 范围由 ``middleware/scope.should_record`` **统一裁决**（与 ``/metrics``
  导出同口径，三套指标数字天然可对账）；
- 计数与 Prometheus 累计计数器经 ``RequestStats.record_request`` 写入
  **同一条 Redis pipeline**（原子同源），内存回退同步写进程内计数；
- 在途请求数（inflight gauge）取本进程内存值；
- **记录失败绝不影响请求结果**——原实现中记录异常会把已成功的请求变 500。
"""
import asyncio
import time
from typing import Optional, Sequence

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from app.utils.prometheus_metrics import get_prometheus_metrics
from app.utils.request_stats import get_request_stats
from app.middleware.scope import should_record
from app.utils.logging import get_logger

logger = get_logger("observability")

# 记录延迟隔离上限（秒）：指标面（Redis pipeline + 全局锁等待）卡死/慢响应时，
# 单请求最多多等这个时间，超时即放弃记录——只告警，绝不改变请求结果或让延迟无界
RECORD_TIMEOUT_SECONDS = 0.5


class ObservabilityMiddleware(BaseHTTPMiddleware):
    """观测层：安全响应头 + 慢请求告警 + 指标/统计记录（单一记录点）"""

    def __init__(
        self,
        app,
        threshold_seconds: float = 30.0,
        enable_hsts: bool = False,
        hsts_max_age: int = 31536000,
        allow_iframe: bool = False,
        add_security_headers: bool = True,
        exclude_paths: Optional[Sequence[str]] = None,
    ):
        """
        Args:
            threshold_seconds: 慢请求告警阈值（秒）
            enable_hsts: 是否启用 HSTS（生产环境建议启用）
            hsts_max_age: HSTS 最大年龄（秒）
            allow_iframe: 是否允许在 iframe 中嵌入
            add_security_headers: 是否添加安全响应头（Nginx 统一处理时可关）
            exclude_paths: 记录排除集覆盖（默认 ``scope.DEFAULT_EXCLUDE_PATHS``）
        """
        super().__init__(app)
        self.threshold_seconds = threshold_seconds
        self.enable_hsts = enable_hsts
        self.hsts_max_age = hsts_max_age
        self.allow_iframe = allow_iframe
        self.add_security_headers = add_security_headers
        # None → 交由 scope.should_record 使用统一默认排除集
        self.exclude_paths = tuple(exclude_paths) if exclude_paths is not None else None
        self.stats = get_request_stats()
        self.metrics = get_prometheus_metrics()

    # ---------------- 安全响应头（原 SecurityHeadersMiddleware） ----------------

    def _add_security_headers(self, response: Response) -> None:
        if self.add_security_headers:
            # 防止 MIME 类型嗅探
            response.headers["X-Content-Type-Options"] = "nosniff"

            # 防止点击劫持
            response.headers["X-Frame-Options"] = "SAMEORIGIN" if self.allow_iframe else "DENY"

            # 启用 XSS 过滤器
            response.headers["X-XSS-Protection"] = "1; mode=block"

            # Referrer 策略
            response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

            # 权限策略
            response.headers["Permissions-Policy"] = (
                "accelerometer=(), "
                "camera=(), "
                "geolocation=(), "
                "gyroscope=(), "
                "magnetometer=(), "
                "microphone=(), "
                "payment=(), "
                "usb=()"
            )

        # 强制 HTTPS (HSTS) - 始终由应用层控制
        if self.enable_hsts:
            response.headers["Strict-Transport-Security"] = (
                f"max-age={self.hsts_max_age}; includeSubDomains; preload"
            )

        # 注意：Content-Security-Policy 由 Nginx 统一添加（见 docker/nginx），
        # 应用层不重复下发——原中间件的 csp_policy 字段为死配置，已随合并删除。

        # 移除可能泄露信息的响应头
        for header in ("server", "x-powered-by"):
            if header in response.headers:
                del response.headers[header]

    # ---------------- 记录 ----------------

    async def _safe_record(
        self, method: str, elapsed_ms: float, success: bool, status_code: int
    ) -> None:
        """记录请求指标——失败仅告警，绝不改变请求结果（韧性）"""
        try:
            # 延迟隔离：record_request 含全局锁等待 + Redis pipeline 执行，
            # 卡死或高并发排队时必须在有界时间内放弃，避免拖慢响应
            await asyncio.wait_for(
                self.stats.record_request(
                    elapsed_ms, success, status_code, method=method
                ),
                timeout=RECORD_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            logger.warning("请求指标记录超时（忽略，不影响响应）")
        except Exception as e:  # noqa: BLE001 — 指标面故障不得影响服务面
            logger.warning(f"请求指标记录失败（忽略，不影响响应）: {e}")

    # ---------------- dispatch ----------------

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        record = should_record(path, self.exclude_paths)
        if record:
            self.metrics.enter()

        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception as e:
            elapsed_ms = (time.perf_counter() - start) * 1000
            if record:
                await self._safe_record(request.method, elapsed_ms, False, 500)
            logger.error(f"请求处理异常 ({elapsed_ms:.1f}ms): {e}")
            raise
        finally:
            # 正常返回 / 异常 / CancelledError（客户端断开、任务取消）都必须
            # 归还在途计数——取消路径绕过 except Exception，不在 finally 归还
            # 会让 inflight gauge 泄漏
            if record:
                self.metrics.leave()

        elapsed_ms = (time.perf_counter() - start) * 1000
        if record:
            # 2xx/3xx 视为成功；status_code 供状态分布与 Prometheus 状态类使用
            success = 200 <= response.status_code < 400
            await self._safe_record(request.method, elapsed_ms, success, response.status_code)

        # 慢请求告警（原 RequestTimeLoggerMiddleware，对全部请求生效）
        if elapsed_ms / 1000.0 > self.threshold_seconds:
            logger.warning(
                f"请求处理时间超过阈值: {request.method} {path} "
                f"({elapsed_ms / 1000.0:.2f}s > {self.threshold_seconds}s)"
            )

        self._add_security_headers(response)
        return response
