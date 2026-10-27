"""
Database configuration validation module

PostgreSQL-only：只做 URL 形态、驱动可用性与连通性检查。
"""
import importlib.util
import logging
import re
from typing import Optional, Tuple

from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from app.core.db_url import parse_db_url, sync_db_url

logger = logging.getLogger(__name__)


class DatabaseValidationError(Exception):
    """Database configuration validation error"""
    pass


class DatabaseDriverNotFoundError(DatabaseValidationError):
    """Database driver not installed error"""
    pass


class DatabaseConnectionError(DatabaseValidationError):
    """Database connection failed error"""
    pass


def check_driver_installed(db_type: str, url: str | None = None) -> Tuple[bool, Optional[str]]:
    """
    Check if the database driver is installed

    Args:
        db_type: Database type（仅 postgresql）
        url: Database URL (optional，用于检测具体的驱动类型)

    Returns:
        Tuple[bool, Optional[str]]: (is_installed, error_message)
    """
    if db_type == "postgresql":
        if importlib.util.find_spec("psycopg2") is None:
            return False, "Driver 'psycopg2' not installed. Please install: pip install psycopg2-binary"
        return True, None
    return False, f"Unknown database type: {db_type}（仅支持 postgresql）"


def validate_database_url(url: str) -> Tuple[bool, Optional[str]]:
    """
    Validate database URL format

    Args:
        url: Database connection URL

    Returns:
        Tuple[bool, Optional[str]]: (is_valid, error_message)
    """
    try:
        parsed = parse_db_url(url)
    except ValueError as e:
        return False, str(e)

    if not parsed.host:
        return False, "Database URL missing hostname"
    if not parsed.database:
        return False, "Database URL missing database name"
    return True, None


def test_database_connection(url: str, db_type: str, timeout: int = 10, auto_create_db: bool = False) -> Tuple[bool, Optional[str]]:
    """
    Test database connection

    Args:
        url: Database connection URL
        db_type: Database type
        timeout: Connection timeout in seconds
        auto_create_db: 如果数据库不存在，是否自动创建（仅对 PostgreSQL 有效）

    Returns:
        Tuple[bool, Optional[str]]: (is_connected, error_message)
    """
    try:
        engine = create_engine(
            sync_db_url(url),
            connect_args={"connect_timeout": timeout},
            pool_pre_ping=True,
        )

        # Test connection
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))

        engine.dispose()
        return True, None

    except SQLAlchemyError as e:
        error_msg = str(e)

        # 检查是否是数据库不存在的错误
        if auto_create_db and db_type == "postgresql":
            db_not_exist_keywords = [
                "unknown database",
                "database.*does not exist",
            ]
            if any(re.search(keyword, error_msg, re.IGNORECASE) for keyword in db_not_exist_keywords):
                # 注意：自动创建数据库功能已移除，请手动创建数据库
                logger.warning(f"数据库不存在，请手动创建: {url}")
                return False, f"数据库不存在，请手动创建: {error_msg}"

        if "password" in error_msg.lower() or "authentication" in error_msg.lower():
            return False, f"Authentication failed: {error_msg}"
        elif "database" in error_msg.lower() and "does not exist" in error_msg.lower():
            return False, f"Database does not exist: {error_msg}"
        elif "connection" in error_msg.lower():
            return False, f"Connection failed: {error_msg}"
        else:
            return False, f"Database error: {error_msg}"
    except Exception as e:
        return False, f"Unexpected error: {str(e)}"


def validate_database_config(url: str, db_type: str) -> bool:
    """
    Validate database configuration comprehensively

    Args:
        url: Database connection URL
        db_type: Database type

    Returns:
        bool: 验证是否通过，失败时记录警告但不抛出异常
    """
    is_valid, error = validate_database_url(url)
    if not is_valid:
        logger.warning(f"Database URL validation failed: {error}")
        return False

    is_installed, error = check_driver_installed(db_type, url)
    if not is_installed:
        logger.warning(f"Database driver not found: {error}")
        return False

    is_connected, error = test_database_connection(url, db_type)
    if not is_connected:
        logger.warning(f"Database connection test failed: {error}")

    return True
