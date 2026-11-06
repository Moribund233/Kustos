"""配置节元数据（一处声明）。

把「能否写 / 是否保护 / 是否需重启 /
是否热生效 / 是否引导层」集中在本模块**一处声明**，各消费方只读派生，避免
新增一节要在多处同步改动（天然漂移源）：

| 消费方 | 派生 |
|---|---|
| ``config_service.ALLOWED_CONFIG_SECTIONS`` | ``writable=True`` 的节 |
| ``config_service.PROTECTED_CONFIG_SECTIONS`` | ``writable=False`` 的节（含无模型遗留节如 ``system``） |
| ``config_service.RESTART_REQUIRED_CONFIGS`` | 每节 ``restart_keys`` |
| ``config_service._validate_config_data`` | 节可写 + 节内 ``protected_keys`` 拒写（逐键保护） |
| ``agent_admin_service.HOT_KEYS / EDITABLE_KEYS`` | ``agent`` 节（热键 = 全字段 - restart；可写全集 = 全字段） |
| ``config_store.BOOTSTRAP_EXCLUDED_KEYS`` | 每节 ``bootstrap_excluded_keys`` |
| 前端 ``configField.ts`` | ``writable``（可编辑节）+ ``protected_keys ∪ bootstrap_excluded_keys``（只读字段） |

校验语义说明：

- ``writable=False`` 的节整节拒绝通用 PUT（与既有 ``PROTECTED_CONFIG_SECTIONS``
  同语义，错误文案保留）；
- ``writable=True`` 的节按提交键逐键校验：命中 ``protected_keys`` 拒写
  （``repo_root``、``server.reload`` 等），命中 ``bootstrap_excluded_keys`` 也拒写
  （引导层键只走 env）；
- ``restart_keys`` 命中的键返回「重启生效」提示（``RESTART_REQUIRED_CONFIGS``）；
- ``hot=True`` 表示读取点在请求/热路径，TTL 轮询即生效（存活键控分发）。

New section guideline: 新增一节只需在此声明一次 + ``config.example.toml`` 播种 +
消费点读 ``get_config_value`` 三处改动，其余上游元数据自动跟随。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, FrozenSet, Tuple


@dataclass(frozen=True)
class ConfigSection:
    """单个配置节的元数据。

    Attributes:
        writable: 是否可经**通用配置 PUT**（``/api/app/config``）整节或逐键写入。
            专用管理端点（agent / search-embedding）不受本字段约束——它们各自
            维护独立白名单，但白名单键必须 ⊆ 本节字段集（护栏测试断言）。
        hot: 是否热生效（TTL 轮询后即生效；False ≈ 进程启动期读取）。
        restart_keys: 修改后**重启才生效**的键集合（写回时返回重启提示）。
        protected_keys: 节可写但**逐键保护**的键（``writable=True`` 时仍拒
            写这些键，如 ``storage.repo_root``、``server.reload``）。
        bootstrap_excluded_keys: 引导层键——读表前必须先有值/拖库即泄露，
            只允许 env 注入，BLACK 拒写（如 ``database.url``、``security.secret_key``）。
    """

    writable: bool = False
    hot: bool = False
    restart_keys: FrozenSet[str] = frozenset()
    protected_keys: FrozenSet[str] = frozenset()
    bootstrap_excluded_keys: FrozenSet[str] = frozenset()


#: 各节元数据（键 = ``Config`` 字段名/配置节名；``system`` 为无模型遗留节）
SECTION_META: Dict[str, ConfigSection] = {
    "server": ConfigSection(
        writable=True,
        restart_keys=frozenset({"host", "port", "log_level"}),
        protected_keys=frozenset({"reload"}),
    ),
    "gunicorn": ConfigSection(
        writable=True,
        restart_keys=frozenset({
            "workers", "worker_class", "threads", "worker_connections", "backlog",
            "timeout", "graceful_timeout", "keepalive", "max_requests",
            "max_requests_jitter", "preload_app", "daemon", "access_log",
            "access_log_format", "capture_output", "enable_reuse_port",
        }),
    ),
    # ``app.debug`` 由专用端点（set_debug_mode）写入，通用 PUT 不放开
    "app": ConfigSection(writable=False),
    "cors": ConfigSection(
        writable=True,
        restart_keys=frozenset({
            "allow_origins", "allow_credentials", "allow_methods", "allow_headers",
            "max_age",
        }),
    ),
    "storage": ConfigSection(
        writable=True,
        hot=True,
        # 路径类键重启生效 + 逐键保护（storage 仅 max_* / 大小上限类可写）
        restart_keys=frozenset({"repo_root", "upload_root"}),
        protected_keys=frozenset({"repo_root", "upload_root"}),
    ),
    "security": ConfigSection(
        writable=False,
        bootstrap_excluded_keys=frozenset({"secret_key"}),
    ),
    "logging": ConfigSection(writable=False),
    "database": ConfigSection(
        writable=True,
        bootstrap_excluded_keys=frozenset({"url", "is_stress_test"}),
        restart_keys=frozenset({
            "pool_size", "max_overflow", "pool_timeout", "pool_recycle", "echo",
            "stress_pool_size", "stress_max_overflow", "stress_pool_timeout",
            "stress_pool_recycle", "stress_echo",
            "pg_ssl_mode", "pg_connect_timeout", "pg_application_name",
        }),
    ),
    "redis": ConfigSection(writable=False),
    "sentry": ConfigSection(writable=False),
    # ``lfs.s3_*`` 为占位死键（S3 后端未实现，``lfs_controller`` 501）；标注于
    # 配置视图，保持整节不可写
    "lfs": ConfigSection(writable=False),
    "search": ConfigSection(writable=True, hot=True),
    "metrics": ConfigSection(writable=False),
    "oauth": ConfigSection(writable=False),
    # agent 走专用端点（agent_admin_service）；generic PUT 不放开
    "agent": ConfigSection(
        writable=False,
        hot=True,
        # worker 进程参数重启才能真正生效（arq WorkerSettings 在启动时读取）
        restart_keys=frozenset({"worker_max_jobs", "worker_job_timeout_seconds"}),
    ),
    "realtime": ConfigSection(writable=False, hot=True),
    "webhook": ConfigSection(writable=False),
    "collab": ConfigSection(writable=False, hot=True),
    "idempotency": ConfigSection(writable=False, hot=True),
    "git": ConfigSection(writable=False),
    # 无模型遗留节：保持「整节拒绝」的错误文案（不落为「未知节」）
    "system": ConfigSection(writable=False),
}


def section_model_fields() -> Dict[str, FrozenSet[str]]:
    """节名 → pydantic 字段集（``Config`` 的嵌套节模型）。

    用于派生「可写全集」（如 agent 白名单）与护栏测试；缓存在模块级避免每次
    重建——``Config`` 类定义不触发配置加载，模块导入期安全。
    """
    from app.core.config import Config

    cached = getattr(section_model_fields, "_cache", None)
    if cached is not None:
        return cached
    out: Dict[str, FrozenSet[str]] = {}
    for name, field in Config.model_fields.items():
        ann = field.annotation
        # 允许 Optional[X] 包裹后取值
        if getattr(ann, "__origin__", None) is not None:
            args = getattr(ann, "__args__", ())
            ann = next((a for a in args if a is not type(None)), ann)
        if isinstance(ann, type) and hasattr(ann, "model_fields"):
            out[name] = frozenset(ann.model_fields)
    section_model_fields._cache = out  # type: ignore[attr-defined]
    return out


def writable_sections() -> FrozenSet[str]:
    """可经通用 PUT 写入的节集合（``ALLOWED_CONFIG_SECTIONS``）"""
    return frozenset(s for s, m in SECTION_META.items() if m.writable)


def protected_sections() -> FrozenSet[str]:
    """整节拒绝通用 PUT 的节集合（``PROTECTED_CONFIG_SECTIONS``）"""
    return frozenset(s for s, m in SECTION_META.items() if not m.writable)


def restart_required_configs() -> Dict[str, FrozenSet[str]]:
    """``{节: 重启生效键集}``（``RESTART_REQUIRED_CONFIGS``）"""
    return {s: m.restart_keys for s, m in SECTION_META.items() if m.restart_keys}


def bootstrap_excluded_keys() -> Dict[str, FrozenSet[str]]:
    """``{节: 引导层键集}``（``BOOTSTRAP_EXCLUDED_KEYS``）"""
    return {
        s: m.bootstrap_excluded_keys
        for s, m in SECTION_META.items()
        if m.bootstrap_excluded_keys
    }


def editable_key_sets(section: str) -> Tuple[Tuple[str, ...], Tuple[str, ...]]:
    """返回指定节的可写键划分 ``(hot_keys, restart_keys)``。

    用于 agent 专用管理端白名单（``agent_admin_service``）：热键 = 节字段全集
    − restart 键；可写全集 = 热键 + restart 键（= 全部字段，天然含新增字段）。
    """
    meta = SECTION_META.get(section)
    fields = section_model_fields().get(section, frozenset())
    if meta is None:
        return (), ()
    restart = tuple(sorted(meta.restart_keys & fields))
    hot = tuple(sorted(fields - meta.restart_keys))
    return hot, restart