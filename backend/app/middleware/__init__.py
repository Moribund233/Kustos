"""
中间件模块

提供安全与观测相关的中间件功能：
- observability: 观测层（安全响应头 + 慢请求告警 + 指标/统计单一记录点，
  +合并了原 timeout / security_headers / request_stats /
  prometheus_metrics 四层）
- audit_logger: 审计日志中间件
- concurrency: 并发限制中间件
- scope: 请求记录范围（单一裁决点）
"""
from .audit_logger import AuditLoggerMiddleware
from .concurrency import ConcurrencyMiddleware
from .observability import ObservabilityMiddleware
from .scope import DEFAULT_EXCLUDE_PATHS, should_record

__all__ = [
    "AuditLoggerMiddleware",
    "ConcurrencyMiddleware",
    "ObservabilityMiddleware",
    "DEFAULT_EXCLUDE_PATHS",
    "should_record",
]
