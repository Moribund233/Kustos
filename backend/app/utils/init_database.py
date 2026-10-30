"""
数据库初始化工具模块

提供数据库迁移、首次运行管理员引导等功能。
schema 演进统一走 Alembic 迁移（utils/db_migrate），不再使用 create_all。
管理员凭据通过环境变量注入，不在代码中硬编码。

**同步引擎的边界**
--------------------
应用运行时的数据库引擎是**异步**的（:mod:`app.models.async_db`）。
本模块里的同步引擎只服务于两类「一次性运维动作」，且都是**用完即弃**的
（创建 → 执行 → ``dispose``），不留全局状态：

- Alembic 迁移（迁移框架本身要求同步驱动）；
- 管理员引导 / 重设密码（启动期或 CLI 执行，此时没有运行中的事件循环）。

之所以不用异步引擎做引导：异步引擎一旦创建就绑定在当时的事件循环上，
而启动期的 ``asyncio.run`` 用的是临时循环——用它建好的引擎留给后续
uvicorn 事件循环会直接报「attached to a different loop」。
"""
import os
from typing import Optional

from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.core.config import get_config
from app.core.db_url import sync_db_url
from app.utils.logging import get_named_logger

logger = get_named_logger("database")

# 管理员环境变量名称
ENV_ADMIN_USERNAME = "KUSTOS_ADMIN_USERNAME"
ENV_ADMIN_PASSWORD = "KUSTOS_ADMIN_PASSWORD"
ENV_ADMIN_EMAIL = "KUSTOS_ADMIN_EMAIL"


class DatabaseInitializer:
    """
    数据库初始化器

    负责数据库 schema 迁移（Alembic），以及首次运行时自动创建管理员用户。
    """

    def __init__(self, db_url: Optional[str] = None):
        self.db_url = db_url

    def _resolve_sync_url(self) -> str:
        """解析同步连接串：显式传入优先，否则读配置。"""
        if self.db_url:
            return sync_db_url(self.db_url)
        return sync_db_url(get_config().database.url)

    def _open_session(self):
        """打开一个**一次性**同步会话（调用方负责关闭与释放引擎）。

        用完即弃是刻意的：同步引擎不进全局状态，避免与应用内的异步引擎
        形成两套并行的连接池。
        """
        engine = create_engine(self._resolve_sync_url())
        return engine, sessionmaker(bind=engine)()

    def run_migrations(self, db_url: Optional[str] = None) -> dict:
        """
        将数据库 schema 升级到最新（Alembic，幂等）。

        Returns:
            dict: 含 ``success`` / ``applied`` / ``head``
        """
        from app.utils.db_migrate import run_migrations
        return run_migrations(db_url or self.db_url)

    def is_schema_ready(self, db_url: Optional[str] = None) -> tuple:
        """
        只读就绪校验：schema 是否已迁移到位（不执行 DDL）。

        Returns:
            tuple: ``(ready: bool, state: dict)``
        """
        from app.utils.db_migrate import is_schema_ready
        return is_schema_ready(db_url or self.db_url)

    def autobootstrap_admin(self) -> bool:
        """
        首次运行自动创建管理员用户。

        仅在没有任何管理员用户（is_admin=True）时执行。
        凭据从环境变量读取，不硬编码在代码中。

        环境变量:
            KUSTOS_ADMIN_USERNAME: 管理员用户名（默认: admin）
            KUSTOS_ADMIN_PASSWORD: 管理员密码（必需）
            KUSTOS_ADMIN_EMAIL:    管理员邮箱（默认: admin@example.com）

        Returns:
            bool: 操作是否成功（无管理员需要创建时也返回 True）
        """
        from app.models.user import User
        from app.utils.password_utils import get_password_hash

        username = os.environ.get(ENV_ADMIN_USERNAME, "admin")
        password = os.environ.get(ENV_ADMIN_PASSWORD)
        email = os.environ.get(ENV_ADMIN_EMAIL, "admin@example.com")

        if not password:
            logger.warning(
                f"{ENV_ADMIN_PASSWORD} 未设置，跳过管理员自动创建。"
                f"请通过注册接口或设置 {ENV_ADMIN_PASSWORD} 环境变量创建管理员。"
            )
            return True

        engine, session = self._open_session()
        try:
            admin_exists = session.execute(
                select(User).where(User.is_admin == True).limit(1)
            ).scalars().first()
            if admin_exists:
                return True

            admin = User(
                username=username,
                email=email,
                password=get_password_hash(password),
                full_name="System Administrator",
                is_active=True,
                is_admin=True,
            )
            session.add(admin)
            try:
                session.commit()
            except IntegrityError:
                # 多进程/多 worker 并发启动时的竞态：唯一约束冲突
                # 说明管理员已由其他进程创建，视为成功
                session.rollback()
                logger.info(f"管理员用户已由其他进程创建: {username}")
                return True

            logger.info(f"管理员用户已自动创建: {username} <{email}>")
            return True
        except Exception as e:
            session.rollback()
            logger.error(f"管理员自动创建失败: {e}")
            return False
        finally:
            session.close()
            engine.dispose()

    def reset_admin_password(self, new_password: str) -> bool:
        """
        重设管理员密码（运维用，由 scripts/reset_admin.py 调用）。

        管理员按 ``KUSTOS_ADMIN_USERNAME``（默认 admin）定位。

        Returns:
            bool: 操作是否成功
        """
        if not new_password:
            logger.error("未提供新密码，拒绝重设")
            return False

        from app.models.user import User
        from app.utils.password_utils import get_password_hash

        username = os.environ.get(ENV_ADMIN_USERNAME, "admin")

        engine, session = self._open_session()
        try:
            admin = session.execute(
                select(User).where(User.username == username).limit(1)
            ).scalars().first()
            if admin is None:
                logger.error(f"管理员用户不存在: {username}")
                return False
            admin.password = get_password_hash(new_password)
            session.commit()
            logger.info(f"管理员密码已重置: {username}")
            return True
        except Exception as e:
            session.rollback()
            logger.error(f"管理员密码重设失败: {e}")
            return False
        finally:
            session.close()
            engine.dispose()


def init_database(db_url: Optional[str] = None) -> bool:
    """
    初始化数据库的便捷函数

    执行:
    1. Alembic 迁移到最新 schema（幂等）
    2. 首次运行自动创建管理员用户（由 autobootstrap_admin 控制）

    Args:
        db_url: 数据库连接URL，默认使用配置中的 URL

    Returns:
        bool: 初始化是否成功
    """
    initializer = DatabaseInitializer(db_url)

    migrated = initializer.run_migrations()
    if not migrated["success"]:
        logger.error("数据库迁移失败，初始化中止")
        return False

    if not initializer.autobootstrap_admin():
        return False

    return True


def verify_database_ready(db_url: Optional[str] = None) -> tuple[bool, dict]:
    """
    运行容器启动时的只读就绪校验（不执行任何 DDL / 写入）。

    多容器部署中业务容器应设置 ``KUSTOS_INIT_DATABASE=false``，
    由独立的 init 任务先完成迁移与管理员引导。

    Returns:
        tuple: ``(ready: bool, state: dict)``，state 含 applied/head
    """
    return DatabaseInitializer(db_url).is_schema_ready(db_url)
