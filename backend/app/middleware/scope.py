"""
请求记录范围（单一裁决点）

背景：Prometheus 导出、RequestStats 分钟桶、审计日志过去各有一套
exclude 路径，三套口径互不一致——同一时刻三处数字必然对不上，
出问题时无法判定「谁对」。

本模块是**指标类记录方**（观测层的统计/计数、/metrics 导出）的唯一
范围裁决点：谁被记录、谁被排除，只在此处定义一次，所有记录方共享。
审计（``middleware/audit_logger``）的排除集合服务于审计语义
（排除应用状态监控等），不在此列。
"""
from typing import Optional, Sequence, Tuple

# 默认排除：健康检查 / API 文档（/docs 与 /redoc）/ OpenAPI schema / 指标导出自身。
# 口径与 RequestStats 历史排除集一致（/metrics 自排除防递归膨胀）。
DEFAULT_EXCLUDE_PATHS: Tuple[str, ...] = (
    "/health",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/metrics",
)


def should_record(
    path: str, exclude_paths: Optional[Sequence[str]] = None
) -> bool:
    """该路径是否计入指标（统计 + Prometheus 计数）。

    边界匹配（``path == p`` 或 ``path.startswith(p + "/")``），而非裸
    ``startswith``——避免 ``/healthz`` 之类碰巧带前缀的路径被误排除。

    Args:
        path: 请求路径（``request.url.path``）
        exclude_paths: 覆盖默认排除集；``None`` 用 :data:`DEFAULT_EXCLUDE_PATHS`
    """
    excludes = DEFAULT_EXCLUDE_PATHS if exclude_paths is None else exclude_paths
    for p in excludes:
        if path == p or path.startswith(p + "/"):
            return False
    return True
