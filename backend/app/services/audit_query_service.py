"""
审计统一查询服务

要收口的是「两套独立审计体系 + 一个日志 handler 旁路」：

1. ``AuditLoggerMiddleware`` → ``audit.log``（HTTP 请求审计，JSON 行）
2. ``services.activity_service`` → ``activities`` 表（业务实体审计）
3. ``utils/logging.py`` 的 WebSocket handler → ``/ws/logs``（只是投递旁路，
   不构成第三套存储，查询入口不覆盖它）

接线前两者查询入口分离：Activity 只能按仓库维度从 Dashboard 侧查，
audit.log 只能靠 admin 日志查看器读**原始文本**，无法按用户/IP/操作/时间过滤。
本模块提供单一入口 ``query_audit()``，把两侧归一成同一形状后合并分页。
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime, time as dtime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity
from app.utils.logging import resolve_log_segments
from app.utils.response_builder import build_pagination_response

logger = logging.getLogger(__name__)

# 单次查询最多扫描的日志行数：admin 端点不做无界读取，触顶即置 truncated
MAX_SCAN_LINES = 50_000

# 文件行格式：%(asctime)s - %(name)s - %(levelname)s - %(message)s
_PREFIX_SEP = " - "
_SENSITIVE_PREFIX = "[SENSITIVE] "


# ---------------------------------------------------------------------------
# 数据源定位
# ---------------------------------------------------------------------------
def audit_source() -> Tuple[str, str]:
    """
    解析审计日志的 ``(日期目录根, 文件基名)``

    由 ``[logging] audit_log_path`` 推导——``_get_audit_file`` 把文件写在
    ``<父目录>/<YYYY-MM-DD>/<文件名>``，因此根目录取其父目录的父目录。
    """
    from app.core.config import get_config
    configured = Path(get_config().logging.audit_log_path)
    return str(configured.parent), configured.stem


def _daterange(start: datetime, end: datetime) -> List[str]:
    """日期字符串列表，**新→旧**（文件系统按日期分目录，倒序遍历即倒序时间）"""
    day = end.date()
    first = start.date()
    out: List[str] = []
    while day >= first:
        out.append(day.strftime("%Y-%m-%d"))
        day -= timedelta(days=1)
    return out


# ---------------------------------------------------------------------------
# HTTP 审计（audit.log JSON 行）
# ---------------------------------------------------------------------------
def parse_audit_line(raw: str) -> Optional[Dict[str, Any]]:
    """
    解析 audit.log 的一行

    Returns:
        Optional[Dict[str, Any]]: 审计条目；非审计行（半截行、轮转残留）返回 None
    """
    parts = raw.rstrip("\r\n").split(_PREFIX_SEP, 3)
    if len(parts) != 4:
        return None
    asctime, _name, level, message = parts

    sensitive = False
    if message.startswith(_SENSITIVE_PREFIX):
        sensitive = True
        message = message[len(_SENSITIVE_PREFIX):]

    try:
        entry = json.loads(message)
    except (ValueError, TypeError):
        return None
    if not isinstance(entry, dict):
        return None

    entry.setdefault("timestamp", asctime)
    entry["source"] = "http"
    entry["level"] = level
    if sensitive:
        entry["is_sensitive"] = True
    return entry


def _match_http(entry: Dict[str, Any], filters: Dict[str, Any]) -> bool:
    """HTTP 审计条目过滤"""
    method = filters.get("method")
    if method and (entry.get("method") or "").upper() != method.upper():
        return False

    username = filters.get("username")
    if username and username.casefold() not in (entry.get("username") or "").casefold():
        return False

    if filters.get("user_id") and str(entry.get("user_id") or "") != str(filters["user_id"]):
        return False

    path = filters.get("path")
    if path and path not in (entry.get("path") or ""):
        return False

    if filters.get("status_code") is not None and entry.get("status_code") != filters["status_code"]:
        return False

    if filters.get("level") and (entry.get("level") or "").upper() != filters["level"].upper():
        return False

    if filters.get("sensitive") is not None and bool(entry.get("is_sensitive")) != filters["sensitive"]:
        return False

    keyword = filters.get("q")
    if keyword:
        needle = keyword.casefold()
        haystack = " ".join(
            str(entry.get(k) or "") for k in ("path", "username", "method", "client_ip")
        ).casefold()
        if needle not in haystack:
            return False
    return True


def _read_http_entries(
    start: datetime,
    end: datetime,
    filters: Dict[str, Any],
    max_lines: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], int, bool]:
    """
    读取窗口内的 HTTP 审计条目

    Args:
        max_lines: 扫描行数上限；None 时取模块级 ``MAX_SCAN_LINES``
                    （调用期解析，便于测试覆盖截断行为）

    Returns:
        Tuple[条目列表（新→旧）, 命中总数, 是否触顶截断]
    """
    if max_lines is None:
        max_lines = MAX_SCAN_LINES
    log_dir, log_name = audit_source()
    entries: List[Dict[str, Any]] = []
    total = 0
    scanned = 0
    truncated = False

    for date in _daterange(start, end):
        if scanned >= max_lines:
            truncated = True
            break
        # 分片按 新→旧 排序；分片内行序为 旧→新，读入后倒序即可保持全局新→旧
        for _idx, path in resolve_log_segments(log_dir, date, log_name):
            if scanned >= max_lines:
                truncated = True
                break
            try:
                lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for line in reversed(lines):
                scanned += 1
                if scanned > max_lines:
                    truncated = True
                    break
                entry = parse_audit_line(line)
                if entry is None or not _match_http(entry, filters):
                    continue
                total += 1
                entries.append(entry)

    return entries, total, truncated


# ---------------------------------------------------------------------------
# Activity 审计（activities 表）
# ---------------------------------------------------------------------------
def _as_uuid(value: Any):
    """
    把过滤参数归一成 ``uuid.UUID``

    统一查询入口收的是 URL 字符串，而 ``activities`` 的三列都是原生 UUID 类型；
    直接拿字符串比对在 PostgreSQL 上依赖隐式类型转换，这里显式收口。
    无法解析时返回 ``None``，调用方据此退化成「恒不匹配」。
    """
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _activity_filters(stmt, filters: Dict[str, Any]):
    """把查询条件叠加到 Activity 语句上"""
    if filters.get("action"):
        stmt = stmt.filter(Activity.action == filters["action"])
    if filters.get("entity_type"):
        stmt = stmt.filter(Activity.entity_type == filters["entity_type"])

    for column, key in ((Activity.actor_id, "actor_id"),
                        (Activity.repository_id, "repository_id")):
        if filters.get(key):
            parsed = _as_uuid(filters[key])
            # 非法 UUID：列非空，用 IS NULL 恒不匹配，避免抛 500
            stmt = stmt.filter(column.is_(None) if parsed is None else column == parsed)

    keyword = filters.get("q")
    if keyword:
        # 转义 LIKE 通配符（%\）：HTTP 侧对 log 行是字面子串匹配，Activity 侧
        # 必须同口径——否则用户输入的 %/_ 被解释为任意匹配（语义不一致，非注入）
        escaped = keyword.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        needle = f"%{escaped}%"
        stmt = stmt.filter(
            (Activity.action.ilike(needle, escape="\\"))
            | (Activity.details.ilike(needle, escape="\\"))
        )
    return stmt


async def _query_activities(
    db: AsyncSession,
    start: datetime,
    filters: Dict[str, Any],
    window: int,
) -> Tuple[List[Dict[str, Any]], int]:
    """
    查询窗口内的 Activity 审计行

    Returns:
        Tuple[条目列表（新→旧）, 命中总数]
    """
    base = select(Activity).filter(Activity.created_at >= start)
    base = _activity_filters(base, filters)

    total = (
        await db.execute(select(func.count()).select_from(base.subquery()))
    ).scalar_one()

    rows = (
        await db.execute(base.order_by(Activity.created_at.desc()).limit(window))
    ).scalars().all()

    items = [
        {
            "source": "activity",
            "timestamp": a.created_at.isoformat() if a.created_at else None,
            "id": str(a.id),
            "repository_id": str(a.repository_id),
            "actor_id": str(a.actor_id),
            "entity_type": a.entity_type,
            "entity_id": str(a.entity_id),
            "action": a.action,
            "details": a.details,
        }
        for a in rows
    ]
    return items, int(total or 0)


# ---------------------------------------------------------------------------
# 统一入口
# ---------------------------------------------------------------------------
async def query_audit(
    db: AsyncSession,
    *,
    days: int = 7,
    source: str = "all",
    page: int = 1,
    limit: int = 20,
    method: Optional[str] = None,
    username: Optional[str] = None,
    user_id: Optional[str] = None,
    path: Optional[str] = None,
    status_code: Optional[int] = None,
    level: Optional[str] = None,
    sensitive: Optional[bool] = None,
    action: Optional[str] = None,
    entity_type: Optional[str] = None,
    actor_id: Optional[str] = None,
    repository_id: Optional[str] = None,
    q: Optional[str] = None,
) -> Dict[str, Any]:
    """
    审计统一查询：HTTP 请求审计 + Activity 业务审计合并分页

    Args:
        db: 数据库会话
        days: 向前回看的天数（含今天），同时约束文件扫描范围与表查询下界
        source: ``http`` | ``activity`` | ``all``
        page/limit: 分页
        method/username/user_id/path/status_code/level/sensitive: HTTP 侧过滤
        action/entity_type/actor_id/repository_id: Activity 侧过滤
        q: 关键词（HTTP 侧匹配 path/username/method/client_ip，
           Activity 侧匹配 action/details）

    Returns:
        Dict[str, Any]: ``build_pagination_response`` 形状 + ``truncated``
        （``truncated=True`` 表示已达日志扫描上限、更早记录可能未纳入）
    """
    days = max(1, min(int(days), 90))
    window = page * limit

    now = datetime.now()
    start_date = now.date() - timedelta(days=days - 1)
    start = datetime.combine(start_date, dtime.min)

    http_filters = {
        "method": method, "username": username, "user_id": user_id, "path": path,
        "status_code": status_code, "level": level, "sensitive": sensitive, "q": q,
    }
    activity_filters = {
        "action": action, "entity_type": entity_type, "actor_id": actor_id,
        "repository_id": repository_id, "q": q,
    }

    http_items: List[Dict[str, Any]] = []
    http_total = 0
    truncated = False

    if source in ("all", "http"):
        # 文件解析是同步 I/O，挪出事件循环：50k 行扫描足以卡住请求协程
        http_items, http_total, truncated = await asyncio.to_thread(
            _read_http_entries, start, now, http_filters
        )
        http_items = http_items[:window]

    activity_items: List[Dict[str, Any]] = []
    activity_total = 0
    if source in ("all", "activity"):
        # user_id 是跨两套体系的统一过滤项：Activity 侧对应 actor_id
        if activity_filters.get("actor_id") is None and user_id:
            activity_filters["actor_id"] = user_id
        activity_items, activity_total = await _query_activities(
            db, start, activity_filters, window
        )

    merged = sorted(
        http_items + activity_items,
        key=lambda e: e.get("timestamp") or "",
        reverse=True,
    )
    offset = (page - 1) * limit
    items = merged[offset:offset + limit]

    response = build_pagination_response(items, http_total + activity_total, page, limit)
    response["truncated"] = truncated
    return response
