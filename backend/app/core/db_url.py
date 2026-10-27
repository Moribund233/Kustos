"""数据库连接串归一化

PostgreSQL 是本项目唯一的数据库。凡是需要把 ``DATABASE_URL`` 喂给
SQLAlchemy 引擎（同步 psycopg2 / 异步 asyncpg）或 Alembic 的地方，
都通过本模块取驱动后缀正确的连接串——**不要**再用
``url.replace("postgresql://", "postgresql+psycopg2://", 1)`` 这类字符串拼接，
它对已带驱动、带密码特殊字符、带查询参数的 URL 都会出错。

用法::

    from app.core.db_url import async_db_url, sync_db_url

    create_async_engine(async_db_url(config.database.url))
    create_engine(sync_db_url(config.database.url))
"""
from __future__ import annotations

from sqlalchemy.engine import URL, make_url

#: 同步路径（SQLAlchemy 2.1 起 ``postgresql://`` 默认走 psycopg3，
#: 项目依赖 psycopg2，必须显式固定驱动）
SYNC_DRIVER = "postgresql+psycopg2"

#: 异步路径
ASYNC_DRIVER = "postgresql+asyncpg"

#: 只做建库/连接串比较时用的"裸"后缀
CANONICAL_DRIVER = "postgresql"

#: 允许的后缀（``postgres`` 是历史别名，SQLAlchemy 不会自动归一）
_BACKENDS = {"postgresql", "postgres"}


def parse_db_url(url: str | URL) -> URL:
    """解析并校验连接串；非 PostgreSQL（含 SQLite）一律拒绝。

    Args:
        url: 用户配置的 ``DATABASE_URL``

    Returns:
        URL: 已解析的 SQLAlchemy URL（驱动后缀未固定）

    Raises:
        ValueError: 连接串为空、无法解析或不是 PostgreSQL
    """
    raw = str(url).strip() if url is not None else ""
    if not raw:
        raise ValueError("DATABASE_URL 未设置")
    try:
        parsed = make_url(raw)
    except Exception as exc:  # noqa: BLE001 - make_url 抛多种异常，统一转成配置错误
        raise ValueError(f"DATABASE_URL 无法解析: {raw}") from exc
    if parsed.get_backend_name() not in _BACKENDS:
        raise ValueError(
            f"仅支持 PostgreSQL，收到: {raw}"
            "（示例 postgresql://user:pass@host:5432/dbname）"
        )
    return parsed


def _render(url: URL) -> str:
    """渲染为连接串。必须显式 ``hide_password=False``：``str(url)`` 会把密码打成 ``***``。"""
    return url.render_as_string(hide_password=False)


def sync_db_url(url: str | URL) -> str:
    """→ ``postgresql+psycopg2://...``（同步引擎 / Alembic / psycopg2 连接）"""
    return _render(parse_db_url(url).set(drivername=SYNC_DRIVER))


def async_db_url(url: str | URL) -> str:
    """→ ``postgresql+asyncpg://...``（异步引擎）"""
    return _render(parse_db_url(url).set(drivername=ASYNC_DRIVER))


def canonical_db_url(url: str | URL) -> str:
    """→ ``postgresql://...``（无驱动后缀；用于建库、连维护库、连串比较）"""
    return _render(parse_db_url(url).set(drivername=CANONICAL_DRIVER))
