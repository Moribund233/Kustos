"""
模型初始化模块

提供数据库引擎、会话工厂和基础模型类的配置驱动初始化
"""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.pool import QueuePool
from sqlalchemy.engine import Engine
import logging
from typing import Optional, Any

from app.core.db_url import sync_db_url

logger = logging.getLogger(__name__)

# 导入配置
from app.core.config import get_config
from app.utils.db_validation import validate_database_config

# 延迟初始化的全局变量
_engine: Optional[Engine] = None
SessionLocal = None
Base: Any = declarative_base()


def _get_postgresql_connect_args(db_config):
    """获取 PostgreSQL 连接参数"""
    connect_args = {}

    # SSL 模式
    if db_config.pg_ssl_mode and db_config.pg_ssl_mode != "prefer":
        connect_args["sslmode"] = db_config.pg_ssl_mode

    # 连接超时
    connect_args["connect_timeout"] = db_config.pg_connect_timeout

    return connect_args


def _get_postgresql_url_with_driver(url: str) -> str:
    """归一化为带 psycopg2 驱动的连接串（兼容旧调用方，实现见 db_url）"""
    return sync_db_url(url)


def _resolve_pool_config(db_config):
    """
    统一解析池配置

    Args:
        db_config: 数据库配置对象

    Returns:
        dict: 包含 pool_size, max_overflow, pool_timeout, pool_recycle, echo 的字典
    """
    if db_config.is_stress_test:
        return {
            "pool_size": db_config.stress_pool_size,
            "max_overflow": db_config.stress_max_overflow,
            "pool_timeout": db_config.stress_pool_timeout,
            "pool_recycle": db_config.stress_pool_recycle,
            "echo": db_config.stress_echo,
        }
    return {
        "pool_size": db_config.pool_size,
        "max_overflow": db_config.max_overflow,
        "pool_timeout": db_config.pool_timeout,
        "pool_recycle": db_config.pool_recycle,
        "echo": db_config.echo,
    }


def _create_postgresql_engine(db_config):
    """创建 PostgreSQL 引擎"""
    url_with_driver = _get_postgresql_url_with_driver(db_config.url)
    pool_config = _resolve_pool_config(db_config)
    return create_engine(
        url_with_driver,
        connect_args=_get_postgresql_connect_args(db_config),
        poolclass=QueuePool,
        pool_pre_ping=True,
        **pool_config
    )


def _create_engine_with_config(db_config):
    """
    根据配置创建数据库引擎

    Args:
        db_config: 数据库配置

    Returns:
        Engine: SQLAlchemy引擎实例
    """
    if db_config.db_type != "postgresql":
        raise ValueError(f"不支持的数据库类型: {db_config.db_type}（仅 PostgreSQL）")
    return _create_postgresql_engine(db_config)


def init_engine():
    """
    初始化数据库引擎

    在应用启动时调用，替代原来的模块级初始化
    """
    global _engine, SessionLocal

    if _engine is not None:
        return _engine

    config = get_config()
    db_config = config.database

    # 验证数据库配置
    validation_passed = validate_database_config(db_config.url, db_config.db_type)
    if not validation_passed:
        logger.warning("数据库配置验证未通过，但应用仍将继续启动")

    # 创建引擎
    _engine = _create_engine_with_config(db_config)

    # 创建会话工厂
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)

    logger.info(f"数据库引擎初始化完成: {db_config.db_type}")
    return _engine


def get_engine() -> Engine:
    """
    获取数据库引擎实例

    Returns:
        Engine: SQLAlchemy引擎实例

    Raises:
        RuntimeError: 引擎未初始化时抛出
    """
    if _engine is None:
        raise RuntimeError("数据库引擎未初始化，请先调用 init_engine()")
    return _engine


def get_db_config():
    """
    获取当前数据库配置

    Returns:
        DatabaseSettings: 数据库配置对象
    """
    config = get_config()
    return config.database


# 导入所有模型（必须在 Base 定义之后）
from app.models.base import TimestampMixin
from app.models.user import User
from app.models.repository import Repository
from app.models.repository_member import RepositoryMember
from app.models.branch import Branch
from app.models.commit import Commit
from app.models.pull_request import PullRequest, PRComment, PRReview
from app.models.pr_issue_link import PullRequestIssueLink
from app.models.pr_review_request import PRReviewRequest
from app.models.issue import Issue, Label, IssueComment
from app.models.release import Release, ReleaseAsset
from app.models.webhook import WebHook, WebHookDelivery
from app.models.ssh_key import SSHKey
from app.models.stargazer import Stargazer
from app.models.watcher import Watcher
from app.models.repo_label import RepoLabel, repo_label_association
from app.models.pr_label import PRLabel, pr_label_association
from app.models.pr_activity import PRActivity
from app.models.activity import Activity
from app.models.notification import Notification
from app.models.notification_preference import NotificationPreference
from app.models.user_oauth import UserOAuthAccount
from app.models.realtime_room import RealtimeRoom, RoomMember, DirectMessage
from app.models.chat_message import ChatMessage
from app.models.file_comment import FileComment
from app.models.build_status import BuildStatus
from app.models.build_log_entry import BuildLogEntry
from app.models.collab_session_override import CollabSessionOverride
from app.models.collab_invite_revocation import CollabInviteRevocation
from app.models.revoked_token import RevokedToken
from app.models.repo_search import RepoSearchState
from app.models.repo_search_chunk import RepoSearchChunk
from app.models.repo_search_ref import RepoSearchRef
from app.models.repo_search_embedding import RepoSearchEmbedding
from app.models.repo_commit_file import RepoCommitFile, RepoCommitIndexState
from app.models.agent import AgentSession, AgentJob, AgentStep
from app.models.agent_trigger import AgentTrigger, AgentTriggerRun
from app.models.app_config import AppConfig
from app.models.config_secret import ConfigSecret

__all__ = [
    "Base", "SessionLocal", "TimestampMixin",
    "init_engine", "get_engine", "get_db_config",
    "User", "Repository", "RepositoryMember", "Branch", "Commit",
    "PullRequest", "PRComment", "PRReview", "PullRequestIssueLink", "PRReviewRequest",
    "Issue", "Label", "IssueComment",
    "Release", "ReleaseAsset",
    "WebHook", "WebHookDelivery",
    "SSHKey",
    "Stargazer",
    "Watcher",
    "RepoLabel", "repo_label_association",
    "PRLabel", "pr_label_association",
    "PRActivity",
    "Activity",
    "Notification",
    "NotificationPreference",
    "UserOAuthAccount",
    "RealtimeRoom",
    "RoomMember",
    "DirectMessage",
    "ChatMessage",
    "FileComment",
    "BuildStatus",
    "BuildLogEntry",
    "CollabSessionOverride",
    "CollabInviteRevocation",
    "RevokedToken",
    "RepoSearchState",
    "RepoSearchChunk",
    "RepoSearchRef",
    "RepoSearchEmbedding",
    "RepoCommitFile", "RepoCommitIndexState",
    "AgentSession", "AgentJob", "AgentStep",
    "AgentTrigger", "AgentTriggerRun",
    "AppConfig",
    "ConfigSecret",
]
