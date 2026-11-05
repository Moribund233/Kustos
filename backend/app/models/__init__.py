"""
模型包入口

只做两件事：

1. 声明 declarative ``Base``（所有 ORM 模型的基类）；
2. 导入全部模型，使 ``Base.metadata`` 完整——Alembic 的
   ``target_metadata`` 依赖于此，漏导入就会生成「少表」的迁移。

**本模块不再持有数据库引擎。** 应用的引擎是异步的
（见 :mod:`app.models.async_db`）；同步引擎只存在于 Alembic 迁移工具链
（:mod:`app.utils.db_migrate` / ``alembic/env.py``），因为 Alembic 需要同步驱动。
"""
import logging
from typing import Any

from sqlalchemy.orm import declarative_base

logger = logging.getLogger(__name__)

#: 所有 ORM 模型的 declarative 基类
Base: Any = declarative_base()


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
from app.models.user_device import UserDevice
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
    "Base", "TimestampMixin",
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
    "UserDevice",
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
