"""
日志系统

基于 WebSocket 的实时日志系统

特性：
- 简化的配置
- 多文件分离：app.log (INFO及以下), error.log (WARNING及以上), audit.log (审计日志)
- 按日期分目录存储
- 保留文件日志（用于持久化）
- WebSocket 实时推送（所有日志自动继承）
- 内存缓冲区（用于快速查询历史日志）
"""
import logging
import re
import sys
from pathlib import Path
from typing import Optional, Dict, List, Any, Tuple
from logging.handlers import RotatingFileHandler
from datetime import datetime

_websocket_handler = None

# RotatingFileHandler 默认保留策略（init_logging 未显式传参时生效）
DEFAULT_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_BACKUP_COUNT = 5


def _get_websocket_log_handler():
    """延迟获取 WebSocket 日志处理器"""
    global _websocket_handler
    if _websocket_handler is None:
        from app.api.ws.handlers.log_handler import get_websocket_log_handler
        _websocket_handler = get_websocket_log_handler()
    return _websocket_handler


class LogManager:
    """
    日志管理器

    支持多文件分离：
    - app.log: INFO 级别及以下（DEBUG, INFO）
    - error.log: WARNING 级别及以上（WARNING, ERROR, CRITICAL）
    - audit.log: 审计日志（单独记录）

    按日期分目录存储：logs/YYYY-MM-DD/

    所有日志器自动继承根日志器的处理器，确保 WebSocket 能接收所有日志
    """

    DEFAULT_LOG_DIR = "logs"
    DATE_FORMAT = "%Y-%m-%d"

    LEVEL_MAP = {
        "debug": logging.DEBUG,
        "info": logging.INFO,
        "warning": logging.WARNING,
        "error": logging.ERROR,
        "critical": logging.CRITICAL,
    }

    def __init__(
        self,
        log_dir: str = DEFAULT_LOG_DIR,
        app_name: str = "kustos",
        level: str = "info",
        max_bytes: int = 10 * 1024 * 1024,
        backup_count: int = 5,
        console_output: bool = True,
        websocket_output: bool = True,
        separate_error_log: bool = True,
        use_date_directory: bool = True,
        audit_enabled: bool = True,
        audit_path: str = "logs/audit.log",
        audit_max_bytes: int = DEFAULT_MAX_BYTES,
        audit_backup_count: int = DEFAULT_BACKUP_COUNT,
    ):
        self.log_dir = Path(log_dir)
        self.app_name = app_name
        self.level = self.LEVEL_MAP.get(level.lower(), logging.INFO)
        self.max_bytes = max_bytes
        self.backup_count = backup_count
        self.console_output = console_output
        self.websocket_output = websocket_output
        self.separate_error_log = separate_error_log
        self.use_date_directory = use_date_directory

        # [logging] audit_log_* 四键的运行期消费者
        self.audit_enabled = audit_enabled
        self.audit_path = audit_path
        self.audit_max_bytes = audit_max_bytes
        self.audit_backup_count = audit_backup_count

        self._initialized = False
        # 已打开文件所在目录：自动清理必须豁免，否则会 rmtree 掉正在写入的
        # 目录（Linux 上 inode 被 unlink，轮转句柄继续写入已删除文件 → 审计静默丢失）
        self._active_dirs: set = set()
        # 当前日期目录所属日期，用于日切重绑
        self._current_date: str = datetime.now().strftime(self.DATE_FORMAT)
        self._audit_logger_created = False

    def _get_log_dir(self) -> Path:
        """获取日志目录（支持按日期分目录）"""
        if self.use_date_directory:
            today = datetime.now().strftime(self.DATE_FORMAT)
            log_dir = self.log_dir / today
        else:
            log_dir = self.log_dir
        log_dir.mkdir(parents=True, exist_ok=True)
        self._active_dirs.add(str(log_dir))
        return log_dir

    def _get_audit_file(self) -> Path:
        """
        定位审计日志文件

        ``audit_log_path`` 给出的是**文件**路径；启用日期目录时在其父目录下再分
        ``<YYYY-MM-DD>/``。默认 ``logs/audit.log`` → ``logs/<日期>/audit.log``，
        与接线前的行为完全一致。
        """
        cfg = Path(self.audit_path)
        if self.use_date_directory:
            day_dir = cfg.parent / datetime.now().strftime(self.DATE_FORMAT)
        else:
            day_dir = cfg.parent
        day_dir.mkdir(parents=True, exist_ok=True)
        self._active_dirs.add(str(day_dir))
        return day_dir / cfg.name

    @property
    def active_log_dirs(self) -> set:
        """当前被文件处理器占用的目录（自动清理豁免集）"""
        return set(self._active_dirs)

    def _create_formatter(self, simple: bool = False) -> logging.Formatter:
        """创建日志格式器"""
        if simple:
            fmt = "%(levelname)s:     %(message)s"
            date_fmt = None
        else:
            fmt = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
            date_fmt = "%Y-%m-%d %H:%M:%S"
        return logging.Formatter(fmt, date_fmt)

    def _create_file_handler(
        self,
        filename: str,
        level: int = logging.DEBUG
    ) -> RotatingFileHandler:
        """创建文件日志处理器"""
        log_file = self._get_log_dir() / filename

        handler = RotatingFileHandler(
            log_file,
            maxBytes=self.max_bytes,
            backupCount=self.backup_count,
            encoding="utf-8",
        )
        handler.setFormatter(self._create_formatter())
        handler.setLevel(level)
        # 标记为受本管理器支配：日切时据此识别需要重绑的处理器
        handler._kustos_date_managed = True
        return handler

    def _create_audit_handler(self) -> RotatingFileHandler:
        """创建审计日志处理器（轮转参数取自 [logging] audit_log_max_size / backup_count）"""
        audit_file = self._get_audit_file()
        handler = RotatingFileHandler(
            audit_file,
            maxBytes=self.audit_max_bytes,
            backupCount=self.audit_backup_count,
            encoding="utf-8",
        )
        handler.setFormatter(self._create_formatter())
        handler.setLevel(logging.INFO)
        handler._kustos_date_managed = True
        return handler

    def _create_console_handler(self) -> logging.StreamHandler:
        """创建控制台日志处理器"""
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(self._create_formatter(simple=True))
        handler.setLevel(self.level)
        return handler

    def _create_app_handler(self) -> RotatingFileHandler:
        """创建 app.log 处理器"""
        handler = self._create_file_handler(f"{self.app_name}.log", logging.DEBUG)
        if self.separate_error_log:
            handler.addFilter(lambda record: record.levelno <= logging.INFO)
        return handler

    def _create_error_handler(self) -> RotatingFileHandler:
        """创建 error.log 处理器（WARNING 及以上）"""
        handler = self._create_file_handler("error.log", logging.WARNING)
        return handler

    def setup_root_logger(self) -> None:
        """
        配置根日志器

        在根日志器上配置处理器，所有子日志器自动继承
        这确保 WebSocket 能接收所有模块的日志
        """
        if self._initialized:
            return

        root_logger = logging.getLogger()
        root_logger.setLevel(self.level)

        if not root_logger.handlers:
            root_logger.addHandler(self._create_app_handler())

            if self.separate_error_log:
                root_logger.addHandler(self._create_error_handler())

            if self.console_output:
                root_logger.addHandler(self._create_console_handler())

            if self.websocket_output:
                ws_handler = _get_websocket_log_handler()
                ws_handler.setLevel(self.level)
                root_logger.addHandler(ws_handler)

        self._initialized = True

    def get_logger(self, name: Optional[str] = None) -> logging.Logger:
        """
        获取日志记录器

        Args:
            name: 日志记录器名称

        Returns:
            logging.Logger: 日志记录器（继承根日志器的处理器）
        """
        self.setup_root_logger()

        if name is None:
            name = self.app_name

        logger = logging.getLogger(name)
        logger.setLevel(self.level)
        logger.propagate = True

        return logger

    def get_named_logger(self, name: str) -> logging.Logger:
        """获取指定名称的日志记录器"""
        return self.get_logger(f"{self.app_name}.{name}")

    def get_audit_logger(self) -> logging.Logger:
        """
        获取审计日志记录器

        审计日志单独存储在 audit.log；文件路径、轮转上限与开关均取自
        ``[logging] audit_log_*``。``audit_log_enabled = false``
        时返回只挂 ``NullHandler`` 的空记录器，文件 / 控制台 / WebSocket 三条出口
        一并关闭。
        """
        self.setup_root_logger()

        logger = logging.getLogger(f"{self.app_name}.audit")
        logger.setLevel(logging.INFO)
        logger.propagate = False
        self._audit_logger_created = True

        if not self.audit_enabled:
            # all([]) 为真，故不能只判「不全是 NullHandler」——空列表也要补上
            if not (logger.handlers and all(isinstance(h, logging.NullHandler) for h in logger.handlers)):
                self._drain_managed(logger, list(logger.handlers))
                logger.addHandler(logging.NullHandler())
            return logger

        if not logger.handlers:
            logger.addHandler(self._create_audit_handler())

            if self.console_output:
                console_handler = logging.StreamHandler(sys.stdout)
                console_handler.setFormatter(
                    logging.Formatter("[AUDIT] %(asctime)s - %(message)s", "%Y-%m-%d %H:%M:%S")
                )
                logger.addHandler(console_handler)

            if self.websocket_output:
                ws_handler = _get_websocket_log_handler()
                ws_handler.setLevel(logging.INFO)
                logger.addHandler(ws_handler)

        return logger

    # ------------------------------------------------------------------
    # 日切重绑
    # ------------------------------------------------------------------
    def ensure_date_rollover(self) -> bool:
        """
        日期跨天时把文件处理器重绑到新的日期目录

        接线前 ``setup_root_logger`` 只跑一次，处理器永久绑定启动当天的
        ``logs/<日期>/``：长驻进程既不会把日志写进"今天"（admin 日志查看读到空目录），
        也会让按日期清理把**正在写入**的目录 rmtree 掉。因此每次记录前调用本方法。

        Returns:
            bool: 是否发生了轮转
        """
        if not self.use_date_directory:
            return False

        today = datetime.now().strftime(self.DATE_FORMAT)
        if today == self._current_date:
            return False
        self._current_date = today

        if not self._initialized:
            # 尚未初始化：初始化时自然会用到新日期，无需重绑
            return False

        self._rebind_date_handlers()
        return True

    def _rebind_date_handlers(self) -> None:
        """把带日期目录的文件处理器重开到新日期目录（其余处理器原样保留）"""
        root_logger = logging.getLogger()
        root_managed = [
            h for h in root_logger.handlers if getattr(h, "_kustos_date_managed", False)
        ]
        if root_managed:
            self._drain_managed(root_logger, root_managed)
            root_logger.addHandler(self._create_app_handler())
            if self.separate_error_log:
                root_logger.addHandler(self._create_error_handler())

        if self._audit_logger_created and self.audit_enabled:
            audit_logger = logging.getLogger(f"{self.app_name}.audit")
            audit_managed = [
                h for h in audit_logger.handlers if getattr(h, "_kustos_date_managed", False)
            ]
            if audit_managed:
                self._drain_managed(audit_logger, audit_managed)
                audit_logger.addHandler(self._create_audit_handler())
            elif not audit_logger.handlers:
                audit_logger.addHandler(self._create_audit_handler())

    def _drain_managed(self, target: logging.Logger, handlers: list) -> None:
        """
        摘除处理器：文件处理器关句柄并注销活跃目录登记，其余只摘不关

        WebSocket 处理器是根日志器与审计日志器**共享的单例**，关掉会连累主日志链路。
        """
        for handler in handlers:
            target.removeHandler(handler)
            if isinstance(handler, RotatingFileHandler):
                self._active_dirs.discard(str(Path(handler.baseFilename).parent))
                handler.close()


_log_manager: Optional[LogManager] = None

# [logging] audit_log_* 默认值（与 core.config.LoggingSettings 同源，配置不可用时回落）
_DEFAULT_AUDIT_SETTINGS: Dict[str, Any] = {
    "audit_enabled": True,
    "audit_path": "logs/audit.log",
    "audit_max_bytes": DEFAULT_MAX_BYTES,
    "audit_backup_count": DEFAULT_BACKUP_COUNT,
}
_audit_settings_loading = False


def _load_audit_settings() -> Dict[str, Any]:
    """
    读取 ``[logging] audit_log_*`` 四键

    配置不可用时回落默认值，绝不阻断日志初始化；重入保护用于避免
    「初始化日志 → 读配置 → 配置侧打日志 → 再次初始化」的递归。
    """
    global _audit_settings_loading
    if _audit_settings_loading:
        return dict(_DEFAULT_AUDIT_SETTINGS)

    _audit_settings_loading = True
    try:
        from app.core.config import get_config
        logging_cfg = get_config().logging
        return {
            "audit_enabled": logging_cfg.audit_log_enabled,
            "audit_path": logging_cfg.audit_log_path,
            "audit_max_bytes": logging_cfg.audit_log_max_size,
            "audit_backup_count": logging_cfg.audit_log_backup_count,
        }
    except Exception:  # noqa: BLE001 — 配置未就绪/循环导入：回落默认
        return dict(_DEFAULT_AUDIT_SETTINGS)
    finally:
        _audit_settings_loading = False


def init_logging(
    log_dir: str = "logs",
    app_name: str = "kustos",
    level: str = "info",
    max_bytes: int = 10 * 1024 * 1024,
    backup_count: int = 5,
    console_output: bool = True,
    websocket_output: bool = True,
    separate_error_log: bool = True,
    use_date_directory: bool = True,
    audit_enabled: Optional[bool] = None,
    audit_path: Optional[str] = None,
    audit_max_bytes: Optional[int] = None,
    audit_backup_count: Optional[int] = None,
) -> LogManager:
    """
    初始化日志系统

    在根日志器上配置处理器，所有子日志器自动继承。

    ``audit_*`` 四参未显式传入时从 ``[logging]`` 节读取。
    """
    global _log_manager

    if _log_manager is not None:
        return _log_manager

    audit_cfg = _load_audit_settings()

    _log_manager = LogManager(
        log_dir=log_dir,
        app_name=app_name,
        level=level,
        max_bytes=max_bytes,
        backup_count=backup_count,
        console_output=console_output,
        websocket_output=websocket_output,
        separate_error_log=separate_error_log,
        use_date_directory=use_date_directory,
        audit_enabled=audit_cfg["audit_enabled"] if audit_enabled is None else audit_enabled,
        audit_path=audit_cfg["audit_path"] if audit_path is None else audit_path,
        audit_max_bytes=audit_cfg["audit_max_bytes"] if audit_max_bytes is None else audit_max_bytes,
        audit_backup_count=audit_cfg["audit_backup_count"] if audit_backup_count is None else audit_backup_count,
    )

    _log_manager.setup_root_logger()

    return _log_manager


def get_logger(name: Optional[str] = None) -> logging.Logger:
    """
    获取日志记录器

    Args:
        name: 日志记录器名称

    Returns:
        logging.Logger: 日志记录器
    """
    global _log_manager
    if _log_manager is None:
        _log_manager = init_logging()
    return _log_manager.get_logger(name)


def get_named_logger(name: str) -> logging.Logger:
    """
    获取指定名称的日志记录器

    Args:
        name: 日志记录器名称

    Returns:
        logging.Logger: 日志记录器
    """
    global _log_manager
    if _log_manager is None:
        _log_manager = init_logging()
    return _log_manager.get_named_logger(name)


def get_audit_logger() -> logging.Logger:
    """
    获取审计日志记录器

    Returns:
        logging.Logger: 审计日志记录器
    """
    global _log_manager
    if _log_manager is None:
        _log_manager = init_logging()
    return _log_manager.get_audit_logger()


def is_audit_enabled() -> bool:
    """
    审计日志是否启用（``[logging] audit_log_enabled``）

    中间件据此整体短路，避免在关闭时仍构造审计记录。
    """
    global _log_manager
    if _log_manager is None:
        _log_manager = init_logging()
    return _log_manager.audit_enabled


def maybe_rollover() -> bool:
    """
    检查日期是否跨天，必要时把文件处理器重绑到新的日期目录

    Returns:
        bool: 是否发生了轮转；日志系统尚未初始化时返回 False
    """
    if _log_manager is None:
        return False
    return _log_manager.ensure_date_rollover()


def get_active_log_dirs() -> set:
    """当前被文件处理器占用的日志目录（自动清理必须豁免）"""
    if _log_manager is None:
        return set()
    return _log_manager.active_log_dirs


def cleanup_old_logs(
    log_dir: str = "logs",
    keep_days: int = 30,
    active_dirs: Optional[set] = None,
) -> int:
    """
    清理指定天数之前的日志目录

    **活跃目录豁免**：进程正在写入的 ``logs/<日期>/`` 即使早于保留期也不会删除——
    否则 Linux 上 unlink 后轮转句柄仍会写入已删除 inode，审计日志静默丢失。

    Args:
        log_dir: 日志根目录
        keep_days: 保留天数
        active_dirs: 需豁免的目录；为 None 时取当前日志系统的活跃目录

    Returns:
        int: 删除的目录数量
    """
    from datetime import timedelta
    import shutil

    log_path = Path(log_dir)
    if not log_path.exists():
        return 0

    exempt = {
        str(Path(p).resolve())
        for p in (get_active_log_dirs() if active_dirs is None else active_dirs)
    }

    cutoff_date = datetime.now() - timedelta(days=keep_days)
    deleted_count = 0

    for item in log_path.iterdir():
        if item.is_dir():
            try:
                if str(item.resolve()) in exempt:
                    continue
                dir_date = datetime.strptime(item.name, "%Y-%m-%d")
                if dir_date < cutoff_date:
                    shutil.rmtree(item, ignore_errors=True)
                    deleted_count += 1
            except ValueError:
                pass

    return deleted_count


def get_log_retention() -> Tuple[int, int]:
    """返回当前日志保留策略 (max_bytes, backup_count)"""
    global _log_manager
    if _log_manager is not None:
        return _log_manager.max_bytes, _log_manager.backup_count
    return DEFAULT_MAX_BYTES, DEFAULT_BACKUP_COUNT


_SEGMENT_RE = re.compile(r"^(?P<base>.+\.log)(?:\.(?P<idx>\d+))?$")


def parse_log_segment(name: str) -> Optional[Tuple[str, int]]:
    """
    解析日志文件名中的基名与分片序号。

    - ``error.log``   → ``("error.log", 0)``（当前段）
    - ``error.log.3`` → ``("error.log", 3)``（第 3 个备份，数字越大越旧）
    - 非日志文件      → ``None``
    """
    m = _SEGMENT_RE.match(name)
    if not m:
        return None
    return m.group("base"), int(m.group("idx") or 0)


def resolve_log_segments(
    log_dir: str,
    date: str,
    log_name: str,
) -> List[Tuple[int, Path]]:
    """
    解析某日期下某个日志文件的全部磁盘分片（RotatingFileHandler 产物）。

    Args:
        log_dir: 日志根目录
        date: 日期 (YYYY-MM-DD)
        log_name: 文件基名（不含 .log）

    Returns:
        List[Tuple[int, Path]]: ``(分片序号, 路径)`` 按**新→旧**排序；
        序号 0 为当前段，数字越大越旧。无匹配时返回空列表。
    """
    day_dir = Path(log_dir) / date
    base = f"{log_name}.log"
    segments: List[Tuple[int, Path]] = []
    if day_dir.exists():
        for path in day_dir.iterdir():
            parsed = parse_log_segment(path.name)
            if parsed and parsed[0] == base:
                segments.append((parsed[1], path))
    segments.sort(key=lambda item: item[0])
    return segments


def get_log_info(log_dir: str = "logs") -> Dict[str, Any]:
    """
    获取日志系统信息

    每个日志文件按基名聚合其磁盘分片（``X.log`` + ``X.log.1..N``），
    返回分片数、合计大小与是否已达保留上限（更早分片可能已被丢弃）。

    Args:
        log_dir: 日志根目录

    Returns:
        Dict: 日志信息
    """
    log_path = Path(log_dir)
    today = datetime.now().strftime("%Y-%m-%d")
    today_dir = log_path / today

    files = []
    total_size = 0
    _, backup_count = get_log_retention()

    if today_dir.exists():
        groups: Dict[str, List[Tuple[int, Path]]] = {}
        for log_file in today_dir.iterdir():
            parsed = parse_log_segment(log_file.name)
            if parsed:
                groups.setdefault(parsed[0], []).append((parsed[1], log_file))

        for base in sorted(groups):
            segs = sorted(groups[base], key=lambda item: item[0])
            seg_total = 0
            for _, seg_path in segs:
                try:
                    seg_total += seg_path.stat().st_size
                except OSError:
                    pass
            total_size += seg_total

            current = next((p for idx, p in segs if idx == 0), None)
            newest_path = current or segs[0][1]
            current_size = current.stat().st_size if current else 0
            max_idx = segs[-1][0]

            files.append({
                "name": base,
                "size": current_size,
                "size_formatted": _format_file_size(current_size),
                "modified": datetime.fromtimestamp(newest_path.stat().st_mtime).isoformat(),
                "parts": len(segs),
                "total_size": seg_total,
                "total_size_formatted": _format_file_size(seg_total),
                "truncated": backup_count > 0 and max_idx >= backup_count,
            })

    available_dates = []
    if log_path.exists():
        for item in log_path.iterdir():
            if item.is_dir():
                try:
                    datetime.strptime(item.name, "%Y-%m-%d")
                    available_dates.append(item.name)
                except ValueError:
                    pass

    available_dates.sort(reverse=True)

    return {
        "log_dir": str(log_path),
        "today_dir": str(today_dir),
        "files": files,
        "total_size": total_size,
        "total_size_formatted": _format_file_size(total_size),
        "available_dates": available_dates[:30],
    }


def _format_file_size(size_bytes: float) -> str:
    """格式化文件大小"""
    for unit in ["B", "KB", "MB", "GB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


def read_log_file(
    date: str,
    filename: str = "kustos.log",
    lines: int = 100,
    log_dir: str = "logs"
) -> List[str]:
    """
    读取日志文件内容

    Args:
        date: 日期 (YYYY-MM-DD)
        filename: 日志文件名
        lines: 读取行数（从末尾开始）
        log_dir: 日志根目录

    Returns:
        List[str]: 日志行列表
    """
    log_path = Path(log_dir) / date / filename

    if not log_path.exists():
        return []

    try:
        with open(log_path, "r", encoding="utf-8") as f:
            all_lines = f.readlines()
            return all_lines[-lines:] if len(all_lines) > lines else all_lines
    except Exception:
        return []