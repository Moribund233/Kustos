"""
配置管理模块

使用 Pydantic Settings 进行配置验证和管理。
所有配置项都通过环境变量或配置文件加载，并经过严格的类型验证。
"""
import os
import time
import logging
from typing import ClassVar, Dict, Any, Literal, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic_settings.sources import PydanticBaseSettingsSource
from pydantic import Field, field_validator, ValidationInfo

from app.core.db_url import parse_db_url

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 配置源链：pydantic-settings 原生 source —— env > app_config[节] > 字段默认值
#
# config.toml 配置层已移除：运行期只读数据库与环境变量，
# config.example.toml 仅作播种模板与文档。
# ---------------------------------------------------------------------------

# ConfigManager 构造 Config() 期间激活的 DB 配置（{节: payload}，来自 app_config
# 表）；None = 本次不读库——直接实例化某配置节仍是「环境变量 + 默认值」。
_ACTIVE_DB_DATA: Optional[Dict[str, Dict[str, Any]]] = None


class ConfigWriteError(RuntimeError):
    """配置持久化失败（数据库写入失败）。

    内存配置**不得**先于持久化变更——否则失败时留下「内存已改、库里未改」
    的半生效状态。
    """


class ConfigVersionConflictError(ValueError):
    """乐观锁版本冲突：调用方提交的 ``expected`` 与库内行版本不符（转 409）。

    继承 ``ValueError`` 以复用 ``config_store`` 既有的「ValueError 原样上抛、
    其余异常转 ConfigWriteError」分流，不会被误包装成持久化失败。
    """


def _deep_merge_dicts(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """递归合并两个字典（override 覆盖 base；嵌套 dict 继续下钻）"""
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge_dicts(merged[key], value)
        else:
            merged[key] = value
    return merged


class _SectionDbSource(PydanticBaseSettingsSource):
    """按节返回 ``app_config`` 表中的配置值，并过滤**未知键**。

    行内可能残留字段定义已删除的死键（模板/历史写入漂移），原样进校验会因
    ``extra='forbid'`` 打崩启动——以字段集过滤保持容错，留 debug 日志。
    """

    def __init__(self, settings_cls, section: str):
        super().__init__(settings_cls)
        self._section = section

    def get_field_value(self, field, field_name):
        # 整节一次性返回（见 __call__），单字段查询无须实现——占位满足抽象契约
        return None, "", False

    def __call__(self) -> dict:
        data = (_ACTIVE_DB_DATA or {}).get(self._section)
        if not isinstance(data, dict):
            return {}
        fields = self.settings_cls.model_fields
        unknown = [k for k in data if k not in fields]
        if unknown:
            logger.debug(f"数据库配置 [{self._section}] 忽略未知键: {unknown}")
            return {k: v for k, v in data.items() if k in fields}
        return data


def _db_section_source(settings_cls, section: str):
    """构造 ``app_config[section]`` 的 settings source。

    Returns:
        source 实例；DB 未激活 / 该节无行时返回 ``None``（该节跳过 DB 层，
        直接用环境变量与字段默认值）。
    """
    if _ACTIVE_DB_DATA is None or not section or section not in _ACTIVE_DB_DATA:
        return None
    return _SectionDbSource(settings_cls, section)


def _load_db_section_values() -> Optional[Dict[str, Dict[str, Any]]]:
    """读 ``app_config`` 全表；失败/表未建/未配 URL → ``None``（跳过 DB 层）。

    函数内 import：``services.config_store`` 反向依赖 ``core.config`` 的字段集，
    模块级 import 会成环；且本函数在 ``ConfigManager`` 构造期执行，必须容忍
    任何异常（读库失败不得打崩启动——此时只剩 env + 默认值可用）。
    """
    try:
        from app.core.config_store import load_all_section_values

        return load_all_section_values()
    except Exception as e:  # noqa: BLE001 — 降级优先于细节
        logger.warning(f"加载数据库配置失败（退回 env/默认值）: {e}")
        return None


def _current_db_version() -> Optional[int]:
    """当前配置表版本号（``max(version)``）；失败 → ``None``（跳过本轮变更检测）。"""
    try:
        from app.core.config_store import max_version

        return max_version()
    except Exception as e:  # noqa: BLE001 — 检测失败不改变既有配置
        logger.debug(f"读取配置版本失败（跳过变更检测）: {e}")
        return None


class SectionSettings(BaseSettings):
    """配置节基类：原生 source 声明优先级 ``env > app_config[节] > 字段默认值``。

    子类声明 ``_config_section`` = 该节在数据库 ``app_config`` 与 ``Config``
    中的字段名（如 ``AppSettings._config_section = "app"``）。

    配置文件层已移除：
    ``config.toml`` 运行期不再被读取，``config.example.toml`` 仅作播种模板与
    文档。``DATABASE_URL`` / ``KUSTOS_STRESS_TEST`` 仍由 ``DatabaseSettings``
    的 field_validator 直读环境变量（引导层，优先级不变）。
    """

    _config_section: ClassVar[str] = ""

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls,
        init_settings,
        env_settings,
        dotenv_settings,
        file_secret_settings,
    ):
        # 优先级（高→低）：init kwargs > 环境变量 > app_config[节] > dotenv > 密钥文件
        # DB 层只在 ConfigManager 构造期间激活（_ACTIVE_DB_DATA）：直接实例化
        # 单个配置节 = 环境变量 + 默认值。
        sources = (init_settings, env_settings)
        db_source = _db_section_source(settings_cls, cls._config_section)
        if db_source is not None:
            sources += (db_source,)
        return sources + (dotenv_settings, file_secret_settings)


class ServerSettings(SectionSettings):
    """服务器配置类"""
    _config_section: ClassVar[str] = "server"
    host: str = Field(default="0.0.0.0", description="服务器监听地址")
    port: int = Field(default=8000, ge=1, le=65535, description="服务器监听端口")
    reload: bool = Field(default=False, description="是否启用热重载")
    log_level: str = Field(
        default="info",
        description="日志级别",
        pattern="^(debug|info|warning|error|critical)$"
    )


class GunicornSettings(SectionSettings):
    """Gunicorn生产环境配置类"""
    _config_section: ClassVar[str] = "gunicorn"
    workers: int = Field(default=4, ge=1, le=32, description="Worker进程数")
    worker_class: str = Field(
        default="gunicorn_worker.KustosUvicornWorker",
        description="Worker类"
    )
    threads: int = Field(default=1, ge=1, description="每个worker的线程数")
    worker_connections: int = Field(default=1000, ge=100, description="最大并发连接数")
    backlog: int = Field(default=2048, ge=128, description="等待连接的最大队列长度")
    timeout: int = Field(default=30, ge=10, le=300, description="Worker超时时间（秒）")
    graceful_timeout: int = Field(default=30, ge=5, le=120, description="优雅关闭超时时间（秒）")
    keepalive: int = Field(default=2, ge=1, le=60, description="Keep-alive连接超时时间（秒）")
    # max_requests=0 表示关闭按请求数回收 worker。默认关闭：
    # 周期回收会造成 WS/协作长连接的重连风暴（协作场景用户可见）；内存泄漏
    # 防护改由编排层滚动重启 + graceful_timeout 兜底。当前部署运行时为 uvicorn
    #（Dockerfile CMD），本项仅在改用 gunicorn 时生效。
    max_requests: int = Field(default=0, ge=0, description="Worker最大请求数（0=关闭周期回收）")
    max_requests_jitter: int = Field(default=0, ge=0, description="最大请求数随机偏移量（max_requests=0 时无效）")
    preload_app: bool = Field(default=False, description="是否预加载应用")
    daemon: bool = Field(default=False, description="是否以守护进程模式运行")
    access_log: bool = Field(default=True, description="是否启用访问日志")
    access_log_format: str = Field(
        default='%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s" %(D)s',
        description="访问日志格式"
    )
    capture_output: bool = Field(default=True, description="是否捕获stdout/stderr")
    enable_reuse_port: bool = Field(default=True, description="是否启用SO_REUSEPORT")


class AppSettings(SectionSettings):
    """应用配置类"""
    _config_section: ClassVar[str] = "app"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_APP_")

    title: str = Field(default="Kustos API", description="应用标题")
    description: str = Field(default="A Git-based collaborative development tool API", description="应用描述")
    version: str = Field(default="0.1.0", description="应用版本")
    debug: bool = Field(default=False, description="是否启用调试模式")
    slow_request_threshold_ms: int = Field(
        default=30_000, ge=1,
        description="慢请求告警阈值（毫秒，默认 30s；0 语义由 ge=1 排除）",
    )


class CORSSettings(SectionSettings):
    """CORS跨域配置类 (仅用于文档说明，实际CORS由Nginx处理)"""
    _config_section: ClassVar[str] = "cors"
    allow_origins: list = Field(default=["*"], description="允许的源列表（由Nginx处理）")
    allow_credentials: bool = Field(default=True, description="是否允许携带凭证（由Nginx处理）")
    allow_methods: list = Field(
        default=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        description="允许的HTTP方法（由Nginx处理）"
    )
    allow_headers: list = Field(
        default=["Content-Type", "Authorization", "X-Requested-With"],
        description="允许的请求头（由Nginx处理）"
    )
    max_age: int = Field(default=600, description="预检请求缓存时间（秒）（由Nginx处理）")


class StorageSettings(SectionSettings):
    """存储配置类"""
    _config_section: ClassVar[str] = "storage"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_STORAGE_")

    repo_root: str = Field(default="./repositories", description="Git仓库根目录路径")
    max_repo_size: int = Field(default=1073741824, ge=0, description="单个仓库最大大小（字节）——push 后校验并拒绝超限写入")
    max_file_size: int = Field(
        default=104857600, ge=0, description="单个文件最大大小（字节）——git 写入路径校验单 blob 上限"
    )
    # 上传目录/上限。``upload_root`` 是
    # 三个上传目录的公共根（附件/头像/发行附件各自挂其下子目录），仅作目录
    # 前缀拼接，不强制目录存在。
    upload_root: str = Field(default="./data/uploads", description="上传文件公共根目录（相对应用工作目录）")
    attachment_max_size: int = Field(default=20 * 1024 * 1024, ge=0, description="聊天附件大小上限（字节，默认 20MB）")
    avatar_max_size: int = Field(default=5 * 1024 * 1024, ge=0, description="头像大小上限（字节，默认 5MB）")
    release_asset_max_size: int = Field(default=50 * 1024 * 1024, ge=0, description="发行附件大小上限（字节，默认 50MB）")


class SecuritySettings(SectionSettings):
    """安全配置类"""
    _config_section: ClassVar[str] = "security"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_SECURITY_")

    secret_key: str = Field(
        default="",
        description="JWT密钥，生产环境必须通过环境变量设置"
    )
    access_token_expire_minutes: int = Field(default=30, ge=1, description="访问令牌过期时间（分钟）")
    refresh_token_expire_days: int = Field(default=7, ge=1, description="刷新令牌过期时间（天）")
    algorithm: str = Field(default="HS256", description="JWT加密算法")
    strict_status_checks: bool = Field(
        default=False,
        description="require_status_checks 严格模式：无任何检查记录视为未通过（当前无 CI 检查来源，默认'无 CI 即通过'）"
    )
    oauth_state_ttl_seconds: int = Field(default=600, ge=1, description="OAuth state 临时存储 TTL（秒，默认 10 分钟）")
    refresh_rotation_grace_seconds: int = Field(
        default=60, ge=0, description="refresh 轮换宽限期（秒）；超出宽限期重放旧 refresh 视为重用、吊销整个 family"
    )
    revocation_positive_ttl: int = Field(default=3600, ge=1, description="撤销黑名单正缓存 TTL（秒，已撤销条目）")
    revocation_negative_ttl: int = Field(default=60, ge=1, description="撤销黑名单负缓存 TTL（秒，未撤销条目）")
    hsts_max_age: int = Field(default=31536000, ge=0, description="HSTS max-age（秒；由 ObservabilityMiddleware 下发）")

    @field_validator("secret_key")
    @classmethod
    def validate_secret_key(cls, v: str, info: ValidationInfo) -> str:
        """验证密钥不为空（生产环境）"""
        # 注意：这里不强制要求，因为debug模式可能不需要
        # 实际验证在应用启动时进行
        return v


class RedisSettings(SectionSettings):
    """Redis 配置类"""
    _config_section: ClassVar[str] = "redis"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_REDIS_", extra="ignore")

    url: str = Field(default="", description="Redis 连接 URL，为空时不使用 Redis。优先读 KUSTOS_REDIS_URL，回退到 REDIS_URL")
    namespace: str = Field(default="kustos", description="Redis 键命名空间前缀（统一分域命名，如 kustos:req:*）")
    pubsub_prefix: str = Field(default="", description="实时广播通道前缀；为空时使用 <namespace>:ws")
    reconnect_cooldown: float = Field(default=5.0, ge=0.0, description="连接失败后的重试冷却秒数（避免每次调用都重连）")

    @field_validator("url", mode="before")
    @classmethod
    def fallback_to_redis_url(cls, v: str) -> str:
        if not v:
            return os.environ.get("REDIS_URL", "")
        return v

    @property
    def ws_prefix(self) -> str:
        """WebSocket 广播通道前缀"""
        return (self.pubsub_prefix or f"{self.namespace}:ws").strip(":")


class LoggingSettings(SectionSettings):
    """
    日志配置类

    ``audit_log_*`` 四键由 ``utils.logging.LogManager`` 消费。
    在此之前它们只被 ``validate_config`` 读到过——运行期的 audit.log 路径、轮转上限
    与开关均由 ``init_logging()`` 的硬编码默认值决定，``audit_log_enabled = false``
    也关不掉审计。

    ``audit_log_path`` 语义：审计日志**文件**路径。启用日期目录（默认）时实际写入
    ``<父目录>/<YYYY-MM-DD>/<文件名>``；默认值 ``logs/audit.log`` 因此落位
    ``logs/<日期>/audit.log``，与既往行为一致。
    """
    _config_section: ClassVar[str] = "logging"
    audit_log_path: str = Field(default="logs/audit.log", description="审计日志文件路径（日期目录插入其父目录）")
    audit_log_max_size: int = Field(default=10485760, ge=1, description="审计日志文件最大大小（字节）")
    audit_log_backup_count: int = Field(default=5, ge=0, description="审计日志备份文件数量")
    audit_log_enabled: bool = Field(default=True, description="是否启用审计日志（false 时中间件与文件均不落盘）")
    log_keep_days: int = Field(default=30, ge=0, description="日期日志目录自动保留天数（0 = 关闭自动清理）")
    activity_keep_days: int = Field(default=180, ge=0, description="Activity 审计表自动保留天数（0 = 不清理）")
    retention_interval_hours: int = Field(default=6, ge=1, description="自动保留任务运行间隔（小时）")
    agent_steps_keep_days: int = Field(
        default=30, ge=0,
        description="Agent 作业步骤（agent_steps）保留天数，仅作用于已收尾的作业；0 = 不清理",
    )


class DatabaseSettings(SectionSettings):
    """
    数据库配置类

    使用 Pydantic 的验证机制，从环境变量自动读取配置。
    不再在 __init__ 中手动处理，而是通过 validators 和 Field 配置。
    """
    _config_section: ClassVar[str] = "database"
    # 数据库连接URL - 优先从环境变量 DATABASE_URL 读取（仅支持 PostgreSQL）
    url: str = Field(
        default="postgresql://postgres@localhost:5432/kustos",
        description="数据库连接URL"
    )

    # 压力测试模式 - 优先从环境变量 KUSTOS_STRESS_TEST 读取
    is_stress_test: bool = Field(default=False, description="是否启用压力测试模式")

    # 连接池配置
    pool_size: int = Field(default=20, ge=1, description="连接池大小")
    max_overflow: int = Field(default=40, ge=0, description="最大溢出连接数")
    pool_timeout: int = Field(default=10, ge=1, description="获取连接超时时间（秒）")
    pool_recycle: int = Field(default=1800, ge=0, description="连接回收时间（秒）")
    echo: bool = Field(default=False, description="是否打印SQL语句")

    # 压力测试模式专用配置
    stress_pool_size: int = Field(default=30, ge=1, description="压力测试模式：连接池大小")
    stress_max_overflow: int = Field(default=60, ge=0, description="压力测试模式：最大溢出连接数")
    stress_pool_timeout: int = Field(default=15, ge=1, description="压力测试模式：获取连接超时时间")
    stress_pool_recycle: int = Field(default=300, ge=0, description="压力测试模式：连接回收时间")
    stress_echo: bool = Field(default=False, description="压力测试模式：打印SQL")

    # PostgreSQL 特定配置
    pg_ssl_mode: str = Field(default="prefer", description="PostgreSQL SSL模式")
    pg_connect_timeout: int = Field(default=10, ge=1, description="PostgreSQL连接超时")
    pg_application_name: str = Field(default="kustos", description="PostgreSQL应用名称")

    model_config = SettingsConfigDict(
        env_prefix="KUSTOS_DATABASE_",
        extra='ignore'
    )

    @field_validator("url", mode="before")
    @classmethod
    def validate_url_from_env(cls, v):
        """从环境变量 DATABASE_URL 读取数据库URL"""
        env_url = os.environ.get("DATABASE_URL")
        if env_url:
            # 验证 URL 格式
            is_valid, error_msg = cls._validate_db_url_with_error(env_url)
            if not is_valid:
                raise ValueError(f"DATABASE_URL 格式无效: {error_msg}")
            return env_url
        return v

    @field_validator("is_stress_test", mode="before")
    @classmethod
    def validate_stress_test_from_env(cls, v):
        """从环境变量 KUSTOS_STRESS_TEST 读取压力测试模式"""
        env_stress = os.environ.get("KUSTOS_STRESS_TEST")
        if env_stress is not None:
            return env_stress.lower() in ("true", "1", "yes")
        return v

    @field_validator("url")
    @classmethod
    def validate_url_format(cls, v: str) -> str:
        """验证数据库URL格式（仅 PostgreSQL；解析规则见 app.core.db_url）"""
        if not v:
            raise ValueError("数据库URL不能为空")
        parse_db_url(v)  # 非 PostgreSQL 直接抛 ValueError
        return v

    @property
    def db_type(self) -> str:
        """数据库类型（PostgreSQL-only）"""
        return "postgresql"

    @property
    def is_postgresql(self) -> bool:
        """是否为 PostgreSQL 数据库"""
        return True

    @property
    def effective_pool_capacity(self) -> int:
        """连接池有效容量：``pool_size + max_overflow``。

        压力测试模式取 stress_* 对应值。

        并发中间件的 ``max_concurrent`` 必须 ≤ 该值：中间件是准入控制，
        要先于 ``pool_timeout`` 拒绝，否则慢 DB 下先抛池超时（500）
        而非中间件的有界 503。
        """
        if self.is_stress_test:
            return self.stress_pool_size + self.stress_max_overflow
        return self.pool_size + self.max_overflow

    @staticmethod
    def _mask_url(url: str) -> str:
        """掩码数据库 URL，隐藏敏感信息"""
        if not url or not isinstance(url, str):
            return "invalid_url"

        try:
            from urllib.parse import urlparse, urlunparse
            parsed = urlparse(url)

            if parsed.password:
                netloc = f"{parsed.username}:****@{parsed.hostname}"
                if parsed.port:
                    netloc += f":{parsed.port}"
                parsed = parsed._replace(netloc=netloc)

            return urlunparse(parsed)
        except Exception:
            try:
                if "://" in url:
                    scheme = url.split("://")[0]
                    return f"{scheme}://****"
            except Exception:
                pass
            return "masked_url"

    @staticmethod
    def _validate_db_url_with_error(url: str) -> tuple[bool, str]:
        """验证数据库 URL 是否有效"""
        if not url or not isinstance(url, str):
            return False, "URL 为空或格式错误"

        try:
            url.encode('utf-8')
        except (UnicodeDecodeError, UnicodeEncodeError) as e:
            return False, f"URL 编码错误: {str(e)}"

        try:
            parse_db_url(url)
        except ValueError as e:
            return False, str(e)

        return True, ""


class ConcurrencySettings(BaseSettings):
    """并发控制配置类（派生自数据库压力测试模式）"""
    max_concurrent: int = Field(default=100, description="最大并发请求数（每 worker）")
    max_wait_time: float = Field(default=5.0, description="最大等待时间（秒）")
    global_max_concurrent: int = Field(
        default=0,
        description="跨 worker 全局并发上限（Redis 计数；0=关闭，仅用每 worker 信号量）",
    )

    @classmethod
    def from_database(
        cls, db: "DatabaseSettings", apply_pool_cap: bool = True
    ) -> "ConcurrencySettings":
        """
        按数据库配置派生并发控制

        期望值维持历史口径：常态 100（``MAX_CONCURRENT`` 环境变量可覆盖）/
        压力测试 200、等待 5s / 10s；但**不高于连接池有效容量**
        （``DatabaseSettings.effective_pool_capacity``）——中间件是准入控制，
        必须先于 ``pool_timeout`` 拒绝请求。

        Args:
            db: 数据库配置
            apply_pool_cap: False 时只算期望值、不套池容量上限
                （供配置校验报告「收窄前 vs 收窄后」对比）
        """
        if db.is_stress_test:
            settings = cls(max_concurrent=200, max_wait_time=10.0)
        else:
            # 读取 MAX_CONCURRENT / MAX_WAIT_TIME 环境变量，默认 100 / 5s
            settings = cls()

        if apply_pool_cap:
            capacity = db.effective_pool_capacity
            if capacity and settings.max_concurrent > capacity:
                settings.max_concurrent = capacity
        return settings


class LFSSettings(SectionSettings):
    """LFS 配置"""
    _config_section: ClassVar[str] = "lfs"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_LFS_")

    # `enabled` 已删除（D2c）：运行时以 `storage_backend` 为准，LFS 分支是否
    # 启用看 `lfs_controller`；保留独立开关只会造成「改配置成功、行为零变化」。
    storage_backend: Literal["local", "s3"] = Field(default="local", description="LFS 存储后端 (local | s3)")
    local_path: str = Field(default="/data/lfs", description="本地 LFS 文件存储路径")
    s3_bucket: str = Field(default="kustos-lfs", description="S3 存储桶名称")
    s3_endpoint: str = Field(default="http://minio:9000", description="S3 端点地址")
    s3_access_key: str = Field(default="", description="S3 访问密钥")
    s3_secret_key: str = Field(default="", description="S3 密钥")
    s3_region: str = Field(default="us-east-1", description="S3 区域")
    max_upload_size: int = Field(default=5 * 1024 * 1024 * 1024, ge=0, description="最大上传文件大小（字节，默认 5GB）")
    transfer_token_ttl_minutes: int = Field(
        default=5, ge=1, le=60,
        description="LFS transfer token 有效期（分钟，用户凭证仅在 batch 入口换取）",
    )


class SearchSettings(SectionSettings):
    """搜索配置"""
    _config_section: ClassVar[str] = "search"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_SEARCH_")

    enabled: bool = Field(default=True, description="是否启用搜索功能")
    max_results: int = Field(default=100, ge=1, description="最大搜索结果数（service 默认值兼硬上限，显式传参受其约束）")

    # 语义检索（embedding；key 不入配置，只给环境变量名）
    embedding_enabled: bool = Field(default=False, description="是否启用语义检索（混合排序）")
    embedding_model: str = Field(default="text-embedding-3-small", description="embedding 模型名")
    embedding_dim: int = Field(default=1536, ge=16, le=8192, description="embedding 维度")
    embedding_base_url: str = Field(default="https://api.openai.com/v1", description="OpenAI 兼容 API base_url")
    embedding_api_key_env: str = Field(
        default="KUSTOS_AGENT_API_KEY", description="存放 embedding API key 的环境变量名（不是 key 本身）"
    )
    embedding_batch: int = Field(default=64, ge=1, le=512, description="每批 embedding 文本数")
    embedding_timeout: float = Field(
        default=30.0, ge=1.0, description="单次 embedding HTTP 请求超时（秒）"
    )
    embedding_concurrency: int = Field(
        default=4, ge=1, le=32, description="索引构建时 embedding 批次的并发数"
    )
    embedding_build_budget: float = Field(
        default=15.0, ge=1.0,
        description="单次索引构建中 embedding 阶段的总预算（秒），超时则跳过剩余批次",
    )
    embedding_query_cache_size: int = Field(
        default=256, ge=0,
        description="查询向量的进程内 LRU 容量（按 (model, 查询) 计）；0 = 关闭缓存",
    )
    embedding_query_cache_ttl: float = Field(
        default=600.0, ge=0.0,
        description="查询向量缓存 TTL（秒）；0 = 不缓存（每次现算）",
    )
    rrf_k: int = Field(default=60, ge=1, description="RRF 融合常数 k")
    max_file_size: int = Field(
        default=2 * 1024 * 1024, ge=0,
        description="索引/扫描/兜底搜索的单文件大小上限（字节，默认 2MB）——"
                    "与 [storage].max_file_size（git 写入 blob 上限）是不同语义",
    )
    # 索引构建资源护栏
    index_max_files: int = Field(default=5000, ge=1, description="索引构建的文件数上限（超出跳过索引，搜索退回 Git tree 全扫）")
    index_max_bytes: int = Field(default=32 * 1024 * 1024, ge=1, description="索引构建的源文本字节上限（任一超限即跳过）")
    scan_file_limit: int = Field(default=200, ge=1, description="待索引候选文件扫描上限")
    symbol_scan_max_files: int = Field(default=2000, ge=1, description="非默认 ref 符号/引用现场扫描的文件数护栏")
    symbol_scan_max_bytes: int = Field(default=16 * 1024 * 1024, ge=1, description="非默认 ref 符号/引用现场扫描的字节护栏")
    rebuild_lock_ttl: int = Field(default=180, ge=1, description="跨 worker 索引重建锁 TTL（秒）")
    index_file_batch: int = Field(default=200, ge=1, description="每批读取/切分的文件数")
    index_row_batch: int = Field(default=2000, ge=1, description="每批 INSERT 的 chunk 行数")
    model_heal_cooldown: float = Field(default=300.0, ge=0.0, description="换 embedding 模型后的重嵌冷却（秒）")
    commit_index_max_commits: int = Field(
        default=300, ge=1,
        description="变更图索引（repo_commit_files）单次构建/增量回填的最大提交数",
    )
    # 切分护栏（chunker，默认值 = 既有模块常量）
    chunk_max_lines: int = Field(default=400, ge=1, description="超限声明按行数切分小段的块行数上限")
    chunk_max_bytes: int = Field(default=64 * 1024, ge=1, description="块字节上限")
    chunk_max_chunks_per_file: int = Field(default=200, ge=1, description="单文件块数上限（防护病态文件）")
    chunk_max_refs_per_file: int = Field(default=4000, ge=1, description="单文件引用数上限（防护病态文件）")


class RealtimeSettings(SectionSettings):
    """WebSocket / 实时配置（原散落 api/websocket· 与 services/realtime· 模块常量）"""
    _config_section: ClassVar[str] = "realtime"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_REALTIME_")

    ws_heartbeat_timeout_seconds: int = Field(default=120, ge=0, description="WS 心跳超时判定（秒；0 = 关闭超时判定）")
    ws_max_message_bytes: int = Field(default=262144, ge=1, description="WS 单条消息大小上限（字节）")
    presence_ttl_seconds: int = Field(default=90, ge=1, description="在线状态（presence）Redis 条目 TTL（秒）")
    chat_max_content_length: int = Field(default=10000, ge=1, description="聊天消息内容长度上限（字符）")
    collab_save_max_content_chars: int = Field(default=2_000_000, ge=1, description="协作保存文档内容上限（字符）")
    log_buffer_max: int = Field(default=10000, ge=1, description="WS 日志缓冲条数上限（deque maxlen）")


class WebhookSettings(SectionSettings):
    """WebHook 投递治理配置（原 services/webhook_service 模块常量）"""
    _config_section: ClassVar[str] = "webhook"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_WEBHOOK_")

    max_concurrent_deliveries: int = Field(default=20, ge=1, description="单次投递并发上限（含重试等待的信号量）")
    delivery_timeout_seconds: float = Field(default=30.0, ge=1.0, description="单次投递 HTTP 超时（秒，默认值 = webhook_service 现值 30s）")
    max_retries: int = Field(default=3, ge=0, description="投递失败最大重试次数")
    shutdown_timeout_seconds: float = Field(default=5.0, ge=0.0, description="优雅关闭时等待在途投递完成的时限（秒）")


class CollabSettings(SectionSettings):
    """协作文档 / 邀请配置（原 services/collab_invite_service 模块常量）"""
    _config_section: ClassVar[str] = "collab"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_COLLAB_")

    invite_default_ttl_minutes: int = Field(default=60, ge=1, le=10080, description="协作邀请默认有效期（分钟）")
    invite_max_ttl_minutes: int = Field(default=1440, ge=1, le=10080, description="协作邀请最长有效期（分钟）")


class GitSettings(SectionSettings):
    """Git / 仓库运维配置（原 utils/git_utils· 与 services/git_event_service· 模块常量）"""
    _config_section: ClassVar[str] = "git"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_GIT_")

    push_max_commits: int = Field(default=200, ge=1, description="单次推送入库提交数上限（保护 DB 与请求时长）")
    git_thread_pool_workers: int = Field(default=4, ge=1, le=64, description="git 同步操作的线程池并发数")
    repo_exists_cache_ttl_seconds: int = Field(default=30, ge=0, description="仓库物理存在状态缓存 TTL（秒；0 = 关闭缓存）")


class AgentSettings(SectionSettings):
    """内置 Agent 配置。

    安全：LLM API key 不落配置/库——此处只保存**环境变量名** ``api_key_env``，
    运行期从进程环境读取其值；或由请求在内存中携带（``agent_service`` 不持久化）。
    """
    _config_section: ClassVar[str] = "agent"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_AGENT_")

    enabled: bool = Field(default=False, description="是否启用内置 Agent（kill switch：关闭时拒绝一切作业创建）")
    provider: str = Field(default="openai", description="模型 provider 适配器（OpenAI 兼容 /chat/completions）")
    base_url: str = Field(default="https://api.openai.com/v1", description="模型 API base_url（配置级，管理员可信）")
    allowed_base_urls: str = Field(
        default="",
        description=(
            "请求级 base_url 白名单（逗号分隔的 origin，如 "
            "'https://api.openai.com,http://127.0.0.1:11434'）。"
            "**仅约束请求体传入的 base_url**（不可信输入，防 SSRF）；"
            "留空 = 拒绝一切请求级覆盖。配置级 base_url 不受此限制。"
        ),
    )
    model: str = Field(default="gpt-4o-mini", description="默认模型名")
    api_key_env: str = Field(
        default="KUSTOS_AGENT_API_KEY",
        description="存放 API key 的环境变量名（不是 key 本身）",
    )
    max_steps: int = Field(default=8, ge=1, le=50, description="单次作业最大工具循环步数")
    max_tokens: int = Field(default=1024, ge=1, description="单次模型调用最大输出 token")
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    request_timeout: float = Field(default=60.0, ge=1.0, description="模型请求超时（秒）")
    max_tool_result_chars: int = Field(
        default=14000, ge=256,
        description=(
            "单条工具结果注入模型的字符上限（runtime 兜底）：工具应按各自的产出上限"
            "自夹取并置 truncated，使其不被触发；一旦触发说明某工具未夹取，"
            "故本值应大于下方各工具上限"
        ),
    )
    # --- 内置 Agent 常量 ---
    max_prompt_chars: int = Field(default=8000, ge=1, description="作业 prompt 注入模型的字符上限")
    read_file_max_chars: int = Field(
        default=12000, ge=256,
        description=(
            "read_file 单次返回正文字符上限（须小于 max_tool_result_chars，超限置 truncated）；"
            "默认保留工具层既有值，与 runtime 兜底是两个不同截断点"
        ),
    )
    list_tree_max_entries: int = Field(
        default=300, ge=1, description="list_tree 单次返回条目上限（超限置 truncated）",
    )
    list_items_max: int = Field(
        default=50, ge=1, description="list_pull_requests / list_issues 单次返回条数上限",
    )
    max_summary_chars: int = Field(
        default=2000, ge=0,
        description=(
            "会话记忆：注入下一次作业的会话摘要字符上限（0=关闭会话记忆——"
            "既不生成摘要也不注入）"
        ),
    )
    job_token_budget: int = Field(
        default=0, ge=0,
        description=(
            "单作业 token 预算：跨模型轮次累计达上限即停止继续调用并优雅降级为"
            "「已有结论 + 建议人工确认」（0=不限）"
        ),
    )
    triggers_enabled: bool = Field(
        default=False,
        description=(
            "是否启用 Agent 触发器（事件驱动/定时巡航）；关闭时不派发任何触发作业。"
            "触发作业为自主**只读**，结论回帖目标频道，不经写工具审批"
        ),
    )
    trigger_sweep_minute: int = Field(
        default=0, ge=0, le=59,
        description="定时触发器扫描的 cron 分钟位（每小时的第 N 分钟执行；须重启 worker 生效）",
    )
    worker_max_jobs: int = Field(default=4, ge=1, le=64, description="arq worker 同时处理的作业数（max_jobs）")
    worker_job_timeout_seconds: int = Field(default=600, ge=1, description="arq 作业超时（秒）")
    # --- 配额 / 成本控制---
    # 全部以 0 表示不限制；计数基于 agent_jobs 表（不依赖 Redis，跨 worker 天然一致）。
    max_active_jobs_per_user: int = Field(
        default=3, ge=0,
        description="每用户同时在跑（queued/running/awaiting_approval）的作业上限，0=不限",
    )
    max_active_jobs_global: int = Field(
        default=20, ge=0,
        description="全局同时在跑的作业上限（保护 agent-worker 容量），0=不限",
    )
    daily_job_limit_per_user: int = Field(
        default=200, ge=0, description="每用户每日（UTC）作业数上限，0=不限",
    )
    daily_token_budget_per_user: int = Field(
        default=1_000_000, ge=0, description="每用户每日（UTC）token 预算，0=不限",
    )
    # --- 中断作业回收（运行面自愈）---
    stale_job_timeout_minutes: int = Field(
        default=15, ge=0,
        description=(
            "僵尸作业回收阈值（分钟）：running/queued 作业超过该时长没有任何更新"
            "即判定执行中断并回收为失败（终态写入为 CAS，不会覆盖既有结果）；0=关闭回收"
        ),
    )


class SentrySettings(SectionSettings):
    """Sentry 错误监控配置"""
    _config_section: ClassVar[str] = "sentry"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_SENTRY_")

    dsn: str = Field(default="", description="Sentry DSN，为空时不启用 Sentry")
    traces_sample_rate: float = Field(
        default=1.0, ge=0.0, le=1.0, description="事务采样率"
    )
    environment: str = Field(default="", description="环境名，为空时按 debug 推导")
    release: str = Field(default="", description="发布版本号")


class MetricsSettings(SectionSettings):
    """运行时指标时序配置（admin 概览趋势图）"""
    _config_section: ClassVar[str] = "metrics"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_METRICS_")

    history_minutes: int = Field(
        default=1440, ge=5, le=10080,
        description="请求/进程指标分钟桶保留时长（分钟，默认 24h）",
    )
    sample_interval_seconds: int = Field(
        default=15, ge=5, le=300,
        description="进程指标（内存/CPU）采样间隔（秒）",
    )
    max_points: int = Field(
        default=120, ge=10, le=1000,
        description="时序接口单次返回的最大点数（超出则降采样）",
    )


class OAuthSettings(SectionSettings):
    """OAuth2 认证配置"""
    _config_section: ClassVar[str] = "oauth"
    model_config = SettingsConfigDict(env_prefix="KUSTOS_OAUTH_")

    github_client_id: str = Field(default="", description="GitHub OAuth App Client ID")
    github_client_secret: str = Field(default="", description="GitHub OAuth App Client Secret")
    github_redirect_uri: str = Field(default="http://localhost:5173/auth/github/callback", description="GitHub OAuth 回调地址")
    gitlab_client_id: str = Field(default="", description="GitLab OAuth App Client ID")
    gitlab_client_secret: str = Field(default="", description="GitLab OAuth App Client Secret")
    gitlab_redirect_uri: str = Field(default="http://localhost:5173/auth/gitlab/callback", description="GitLab OAuth 回调地址")


class Config(BaseSettings):
    """配置主类"""
    server: ServerSettings = Field(default_factory=ServerSettings)
    gunicorn: GunicornSettings = Field(default_factory=GunicornSettings)
    app: AppSettings = Field(default_factory=AppSettings)
    cors: CORSSettings = Field(default_factory=CORSSettings)
    storage: StorageSettings = Field(default_factory=StorageSettings)
    security: SecuritySettings = Field(default_factory=SecuritySettings)
    logging: LoggingSettings = Field(default_factory=LoggingSettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    redis: RedisSettings = Field(default_factory=RedisSettings)
    sentry: SentrySettings = Field(default_factory=SentrySettings)
    lfs: LFSSettings = Field(default_factory=LFSSettings)
    search: SearchSettings = Field(default_factory=SearchSettings)
    metrics: MetricsSettings = Field(default_factory=MetricsSettings)
    oauth: OAuthSettings = Field(default_factory=OAuthSettings)
    agent: AgentSettings = Field(default_factory=AgentSettings)
    realtime: RealtimeSettings = Field(default_factory=RealtimeSettings)
    webhook: WebhookSettings = Field(default_factory=WebhookSettings)
    collab: CollabSettings = Field(default_factory=CollabSettings)
    git: GitSettings = Field(default_factory=GitSettings)

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls,
        init_settings,
        env_settings,
        dotenv_settings,
        file_secret_settings,
    ):
        """根类**不直接读环境变量**。

        各配置节自带 ``env_prefix`` 读取自己的变量（``KUSTOS_APP_*`` 等）；
        根类 env 源只会以**节名**（``AGENT``/``APP``/``SERVER``/``REDIS``…）
        匹配裸环境变量——大小写不敏感下极易碰撞（实测宿主机 ``AGENT=1``
        直接把 ``agent`` 节打成校验失败）。纯碰撞面，禁用。
        """
        return (init_settings, dotenv_settings, file_secret_settings)

    @property
    def concurrency(self) -> ConcurrencySettings:
        """获取并发配置（压力测试模式自适应 + **池容量对齐**）

        ``max_concurrent ≤ database.effective_pool_capacity`` 由本派生保证。
        """
        return ConcurrencySettings.from_database(self.database)


class ConfigManager:
    """配置管理器 - 单例模式"""
    _instance: Optional['ConfigManager'] = None
    _config: Optional[Config] = None

    #: 配置变更检测间隔（秒）：多进程（uvicorn workers / agent-worker）靠轮询
    #: ``max(version)`` 收敛——后台保存后最迟该间隔内全进程生效，无需新增总线。
    VERSION_CHECK_INTERVAL: ClassVar[float] = 5.0
    #: 上次读到的配置版本与上次检测时刻（实例属性，单例下等价进程级）
    _db_version: Optional[int] = None
    _db_check_at: float = 0.0

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._load_config()
        return cls._instance

    def _maybe_reload_db(self) -> None:
        """按 TTL 轮询 ``max(version)``，变更即重载（跨进程配置热生效）。

        先占位再查询：并发下每个窗口只有首个访问者真正打一次库，其余直接返回。
        """
        now = time.monotonic()
        if now - self._db_check_at < self.VERSION_CHECK_INTERVAL:
            return
        self._db_check_at = now
        version = _current_db_version()
        if version is None or version == self._db_version:
            return
        logger.info(f"检测到配置变更（version {self._db_version} → {version}），重新加载")
        self._load_config()

    def _load_config(self):
        """
        加载配置（pydantic-settings 原生 source 合并）

        优先级（从低到高）:
        1. Pydantic Field 默认值
        2. 数据库 ``app_config[节]`` 的值（后台可写层；读失败/表未建自动跳过）
        3. 环境变量（最高优先级）。``DATABASE_URL`` / ``KUSTOS_STRESS_TEST``
           仍由 ``DatabaseSettings`` 的 field_validator 直读环境变量，语义不变。

        配置文件层已移除：运行期不再
        读 ``config.toml``，读库失败时只剩 env + 默认值——告警一次、不打崩启动。

        按节读取由 ``SectionSettings.settings_customise_sources`` 注入 source
        完成——仅在构造 ``Config()`` 期间激活 :data:`_ACTIVE_DB_DATA`，构造完毕
        即失活；因此直接实例化单个配置节（如 ``SecuritySettings()``）仍是
        「环境变量 + 默认值」。
        """
        global _ACTIVE_DB_DATA

        db_data = _load_db_section_values()
        # 源链健康态：库可读 → "db"（env > app_config > 默认）；读失败/未配 URL
        # → "degraded"（只剩 env > 默认，启动时已告警一次），供 admin 状态展示
        self._config_source = "degraded" if db_data is None else "db"
        prev_db = _ACTIVE_DB_DATA
        _ACTIVE_DB_DATA = db_data
        try:
            self._config = Config()
        finally:
            _ACTIVE_DB_DATA = prev_db

        self._db_version = _current_db_version()
        if db_data:
            logger.info(f"数据库配置已加载: {len(db_data)} 节 version={self._db_version}")

    @staticmethod
    def _merge_nested_sub_model(parent: Any, field: str, data: dict) -> None:
        """
        合并嵌套子模型（如 rate_limit 下的 default_limits、strict 等）

        Args:
            parent: 父模型实例
            field: 字段名
            data: 配置数据中该字段的字典值
        """
        nested = getattr(parent, field, None)
        if nested is None:
            return
        try:
            updated = nested.model_copy(update=data)
            setattr(parent, field, updated)
        except Exception:
            logger.debug(f"跳过嵌套模型更新 {field}: 类型不匹配")

    @property
    def config(self) -> Config:
        """获取配置对象（访问时做一次**有界的**配置变更检测）"""
        self._maybe_reload_db()
        if self._config is None:
            raise RuntimeError("Config has not been initialized")
        return self._config

    @property
    def config_source(self) -> str:
        """配置源链健康态：``db`` = env > app_config > 默认 正常生效；
        ``degraded`` = 数据库配置层不可读（失败/未配 URL），已降级 env > 默认。"""
        return self._config_source

    def reload(self):
        """重新加载配置（重读数据库与环境变量）"""
        self._load_config()

    def get_config(self, force_reload: bool = False) -> Config:
        """获取配置对象，force_reload=True 时强制从数据库重新加载"""
        if force_reload:
            self.reload()
        return self.config

    def update_config(
        self,
        new_config: Dict[str, Any],
        updated_by: Any = None,
        expected: Optional[Dict[str, int]] = None,
        secrets: Optional[Dict[str, Dict[str, Optional[str]]]] = None,
    ) -> None:
        """持久化到 ``app_config`` 并同步到内存。

        **先持久化、成功后再改内存**：反向顺序在写失败时会留下「内存已改、
        库里未改」的半生效状态。写失败抛 :class:`ConfigWriteError`（服务层转
        4xx），内存保持原状；提交引导层键抛 ``ValueError``。

        Args:
            new_config: ``{节: {键: 值}}``，只覆盖提交的键（同节其余键保留）
            updated_by: 可选——操作者 id，落 ``app_config.updated_by``
            expected: 可选——``{节: 期望行版本}``，在写事务内做 CAS；
                不符抛 :class:`ConfigVersionConflictError`（行不存在视为 0）
            secrets: 可选——``{节: {字段: 明文 或 None(清除)}}``，与配置
                **同一事务**密文落 ``config_secrets``（明文不入库）
        """
        from app.core.config_store import update_sections

        update_sections(
            new_config,
            updated_by=updated_by,
            expected=expected,
            secrets=secrets,
        )
        self._apply_in_memory(new_config)
        self._db_version = _current_db_version()

    def _apply_in_memory(self, new_config: Dict[str, Any]) -> None:
        """把已持久化的配置就地应用到当前进程的 Config 对象"""
        for section, section_data in new_config.items():
            if not isinstance(section_data, dict):
                continue
            sub_model = getattr(self._config, section, None)
            if sub_model is None:
                continue
            scalar_updates: Dict[str, Any] = {}
            for key, value in section_data.items():
                if isinstance(value, dict):
                    self._merge_nested_sub_model(sub_model, key, value)
                else:
                    scalar_updates[key] = value
            if scalar_updates:
                setattr(
                    self._config,
                    section,
                    sub_model.model_copy(update=scalar_updates),
                )


def get_config() -> Config:
    """获取配置对象的便捷函数

    配置来源固定为「env > app_config > 默认值」，不存在配置文件路径参数。

    Returns:
        Config: 全局配置对象
    """
    return ConfigManager().config


def get_config_value(section: str, key: str, default: Any) -> Any:
    """降级读取配置值（统一 helper）。

    语义与既有多处 ``try/except`` 降级完全一致：配置不可用、节缺失或键缺失时
    返回 ``default``；**合法假值原样返回**（0 / False / 空串不做 ``or default``
    折叠——否则会把 0 上限误判为未设置，与既有实现仅在无此类非法值时等价）。

    后续接线一律复用本 helper（冷启动 / 配置未就绪 / DB 层不可读时兜底），
    不再各 service 各自写 try/except。

    Args:
        section: 配置节名（如 ``"search"``）
        key: 键名（如 ``"max_file_size"``）
        default: 读取失败/缺失时的回退值（= 现状硬编码常量，零行为变化）

    Returns:
        配置值，或 ``default``。
    """
    try:
        section_obj = getattr(get_config(), section, None)
        if section_obj is None:
            return default
        value = getattr(section_obj, key, None)
        return default if value is None else value
    except Exception:  # noqa: BLE001 — 配置未就绪时用默认值
        return default


def reset_module_config_manager():
    """重置配置管理器单例（用于测试）"""
    ConfigManager._instance = None
    ConfigManager._config = None


# =============================================================================
# 启动配置完整性校验
# =============================================================================


class ConfigValidationResult:
    """配置校验结果"""

    def __init__(self):
        self.errors: list[str] = []
        self.warnings: list[str] = []

    @property
    def is_valid(self) -> bool:
        """是否全部通过（无错误）"""
        return len(self.errors) == 0

    def add_error(self, message: str) -> None:
        """添加错误"""
        self.errors.append(message)

    def add_warning(self, message: str) -> None:
        """添加警告"""
        self.warnings.append(message)

    def merge(self, other: "ConfigValidationResult") -> None:
        """合并另一个校验结果"""
        self.errors.extend(other.errors)
        self.warnings.extend(other.warnings)

    def print_report(self) -> None:
        """打印校验报告"""
        if self.is_valid and not self.warnings:
            logger.info("✅ 配置校验全部通过")
            return

        if self.errors:
            logger.error("=" * 60)
            logger.error("❌ 配置校验失败")
            logger.error("=" * 60)
            for err in self.errors:
                logger.error(f"  • {err}")
            logger.error("=" * 60)

        if self.warnings:
            for warn in self.warnings:
                logger.warning(f"  ⚠ {warn}")


def _validate_database_config(config: Config, result: ConfigValidationResult) -> None:
    """校验数据库配置"""
    db = config.database

    # 1. URL 协议检查（Pydantic 层已做格式校验：仅 PostgreSQL）

    # 2. 连接池配置合理性
    if db.pool_size < 1:
        result.add_error("连接池大小必须 >= 1")
    if db.max_overflow < 0:
        result.add_error("最大溢出连接数不能为负数")
    if db.pool_timeout < 1:
        result.add_error("连接超时时间必须 >= 1 秒")
    if db.pool_recycle < 0:
        result.add_error("连接回收时间不能为负数")

    # 3. PostgreSQL SSL 模式检查
    if db.is_postgresql:
        valid_ssl_modes = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}
        if db.pg_ssl_mode not in valid_ssl_modes:
            result.add_error(f"无效的 PostgreSQL SSL 模式: {db.pg_ssl_mode}")

    # 4. 并发准入与池容量对齐：中间件必须先于 pool_timeout 拒绝
    desired = ConcurrencySettings.from_database(db, apply_pool_cap=False).max_concurrent
    capacity = db.effective_pool_capacity
    if capacity and desired > capacity:
        pool = db.stress_pool_size if db.is_stress_test else db.pool_size
        overflow = db.stress_max_overflow if db.is_stress_test else db.max_overflow
        result.add_warning(
            f"并发上限已按连接池容量收窄为 {capacity}（期望 {desired}；"
            f"pool_size={pool} + max_overflow={overflow}）。要更高并发请同步调大连接池"
            f"——否则慢查询下会先抛 pool_timeout({db.pool_timeout}s) 而非中间件 503"
        )


def _validate_storage_config(config: Config, result: ConfigValidationResult) -> None:
    """校验存储配置"""
    storage = config.storage

    # 1. 仓库根目录可写性
    repo_root = os.path.abspath(storage.repo_root)
    if not os.path.exists(repo_root):
        try:
            os.makedirs(repo_root, exist_ok=True)
            logger.info(f"已创建仓库根目录: {repo_root}")
        except (OSError, PermissionError) as e:
            result.add_error(f"仓库根目录不可创建: {repo_root} ({e})")
    elif not os.access(repo_root, os.W_OK):
        result.add_error(f"仓库根目录不可写: {repo_root}")

    # 2. 仓库大小限制
    if storage.max_repo_size <= 0:
        result.add_warning("仓库大小限制未设置 (max_repo_size <= 0)")
    if storage.max_file_size <= 0:
        result.add_warning("文件大小限制未设置 (max_file_size <= 0)")
    if storage.max_file_size > storage.max_repo_size:
        result.add_warning("单文件大小限制大于仓库大小限制")

    # 3. LFS 存储路径（D2c：以 storage_backend 为准，不再有 lfs.enabled 开关）
    lfs = config.lfs
    if lfs.storage_backend == "local":
        if lfs.local_path:
            lfs_path = os.path.abspath(lfs.local_path)
            if not os.path.exists(lfs_path):
                try:
                    os.makedirs(lfs_path, exist_ok=True)
                except (OSError, PermissionError) as e:
                    result.add_warning(f"LFS 存储路径不可创建: {lfs_path} ({e})")
        else:
            result.add_warning("LFS 已启用但未设置存储路径，将使用默认位置")


def _validate_security_config(config: Config, result: ConfigValidationResult) -> None:
    """校验安全配置"""
    security = config.security

    # 1. Secret Key 检查（生产环境必须设置）
    if not security.secret_key:
        if config.app.debug:
            result.add_warning("JWT Secret Key 未设置，开发环境将使用 fallback 密钥")
        else:
            result.add_error("生产环境必须通过环境变量 KUSTOS_SECURITY_SECRET_KEY 设置 JWT 密钥")

    # 2. Token 过期时间合理性
    if security.access_token_expire_minutes < 5:
        result.add_warning(f"访问令牌过期时间过短 ({security.access_token_expire_minutes} 分钟)")
    if security.access_token_expire_minutes > 1440:
        result.add_warning(f"访问令牌过期时间过长 ({security.access_token_expire_minutes} 分钟 > 24 小时)")

    if security.refresh_token_expire_days < 1:
        result.add_warning(f"刷新令牌过期时间过短 ({security.refresh_token_expire_days} 天)")
    if security.refresh_token_expire_days > 90:
        result.add_warning(f"刷新令牌过期时间过长 ({security.refresh_token_expire_days} 天 > 90 天)")

    # 3. JWT 算法检查
    valid_algorithms = {"HS256", "HS384", "HS512", "RS256", "RS384", "RS512"}
    if security.algorithm not in valid_algorithms:
        result.add_error(f"不支持的 JWT 算法: {security.algorithm}")


def _validate_server_config(config: Config, result: ConfigValidationResult) -> None:
    """校验服务器配置"""
    server = config.server

    # 1. 端口权限检查
    if server.port < 1024:
        result.add_warning(f"使用特权端口 ({server.port}) 可能需要 root 权限")


def _validate_search_config(config: Config, result: ConfigValidationResult) -> None:
    """校验搜索配置。

    列维度受迁移约束（``VECTOR_DIM``，见 ``services/indexing/vector_type.py``），
    ``search.embedding_dim`` 与列维度不一致时索引写入会失败——启动即校验，
    而不是放任可配。警告而非错误：embedding 是可选
    增强，关闭时维度差异不阻塞启动。
    """
    search = config.search
    try:
        from app.models.vector_type import VECTOR_DIM

        if search.embedding_enabled and search.embedding_dim != VECTOR_DIM:
            result.add_warning(
                f"search.embedding_dim={search.embedding_dim} 与 DB 列维度 "
                f"VECTOR_DIM={VECTOR_DIM} 不一致，embedding 索引写入将失败"
            )
    except Exception:  # noqa: BLE001 — 无法导入维度常量时跳过校验
        pass


def _validate_logging_config(config: Config, result: ConfigValidationResult) -> None:
    """校验日志配置"""
    logging_cfg = config.logging

    if logging_cfg.audit_log_enabled:
        log_path = logging_cfg.audit_log_path
        log_dir = os.path.dirname(os.path.abspath(log_path))
        if not os.path.exists(log_dir):
            try:
                os.makedirs(log_dir, exist_ok=True)
            except (OSError, PermissionError) as e:
                result.add_warning(f"审计日志目录不可创建: {log_dir} ({e})")


def validate_config(config: Optional[Config] = None) -> ConfigValidationResult:
    """
    执行完整的配置完整性校验

    检查项包括:
    1. 数据库配置（URL 协议、连接池参数、SSL 模式）
    2. 存储配置（仓库根目录可写性、大小限制、LFS 路径）
    3. 安全配置（JWT 密钥、Token 过期时间、签名算法）
    4. 服务器配置（端口权限）
    5. 日志配置（审计日志路径可写性）

    Args:
        config: 配置对象，为 None 时自动加载

    Returns:
        ConfigValidationResult: 校验结果，包含 errors 和 warnings
    """
    result = ConfigValidationResult()

    # 加载配置（来源：env + app_config + 默认值；不再要求配置文件存在）
    if config is None:
        try:
            config = get_config()
        except Exception as e:
            result.add_error(f"配置加载失败: {e}")
            return result

    # 1. 数据库配置
    _validate_database_config(config, result)

    # 2. 存储配置
    _validate_storage_config(config, result)

    # 3. 安全配置
    _validate_security_config(config, result)

    # 3.5 搜索配置（embedding 维度一致性）
    _validate_search_config(config, result)

    # 4. 服务器配置
    _validate_server_config(config, result)

    # 5. 日志配置
    _validate_logging_config(config, result)

    return result
