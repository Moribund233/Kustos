"""
数据库生命周期管理模块

提供统一的数据库重置、初始化和清理功能，
用于调试接口和测试场景。
"""
import asyncio
import gc
import logging
from typing import Optional
from sqlalchemy import text

from app.core.config import get_config
from app.models.async_db import close_async_engine, get_async_db_context
from app.utils.init_database import DatabaseInitializer

logger = logging.getLogger(__name__)


class DatabaseResetManager:
    """
    数据库重置管理器

    统一管理数据库的生命周期操作，包括：
    - 关闭现有连接
    - 删除数据（文件或表）
    - 重新创建表结构（自动引导管理员）
    """

    def __init__(self):
        self.config = get_config()
        self.db_type = self.config.database.db_type
        self.db_url = self.config.database.url

    async def reset_database(
        self,
        preserve_config: bool = True
    ) -> dict:
        """
        重置数据库

        执行完整的数据库重置流程：
        1. 关闭所有现有连接
        2. 删除现有数据
        3. 重新创建表
        4. 自动引导管理员用户

        Args:
            preserve_config: 是否保留配置（用于区分调试/测试场景）

        Returns:
            dict: 重置结果信息
        """
        import time
        start_time = time.time()

        try:
            # 步骤1: 关闭现有连接
            await self._close_connections()

            # 步骤2: 删除现有数据
            await self._drop_data()

            # 步骤3: 重新创建表
            self._create_tables()

            # 步骤4: 自动引导管理员用户
            admin_created = self._bootstrap_admin()

            elapsed = time.time() - start_time

            logger.info(f"数据库重置完成，耗时 {elapsed:.2f} 秒")

            return {
                "success": True,
                "database_type": self.db_type,
                "elapsed_seconds": round(elapsed, 2),
                "admin_bootstrapped": admin_created,
            }

        except Exception as e:
            logger.error(f"数据库重置失败: {e}")
            raise

    async def _close_connections(self) -> None:
        """关闭所有现有数据库连接"""
        # 关闭异步引擎（应用唯一的运行时引擎）
        try:
            await close_async_engine()
            logger.debug("异步引擎已关闭")
        except Exception as e:
            logger.warning(f"关闭异步引擎时出错: {e}")

        # 强制垃圾回收
        gc.collect()

    async def _drop_data(self) -> None:
        """删除数据库中所有业务表（仅 PostgreSQL）"""
        if self.db_type != "postgresql":
            raise ValueError(f"不支持的数据库类型: {self.db_type}（仅 PostgreSQL）")
        await self._drop_postgresql_data()

    async def _drop_postgresql_data(self) -> None:
        """删除 PostgreSQL 所有表"""
        # 用异步引擎（应用的运行时引擎）执行 DDL，避免在事件循环里跑同步 IO
        async with get_async_db_context() as db:
            result = await db.execute(text("""
                SELECT tablename FROM pg_tables
                WHERE schemaname = 'public'
            """))
            tables = [row[0] for row in result.fetchall()]

            dropped_count = 0
            for table in tables:
                if self._is_valid_table_name(table):
                    await db.execute(text(f'DROP TABLE IF EXISTS "{table}" CASCADE'))
                    dropped_count += 1
                else:
                    logger.warning(f"跳过非法表名: {table}")

            await db.commit()
            logger.info(f"已删除 PostgreSQL 数据库中的 {dropped_count} 个表")

    async def _create_tables(self) -> None:
        """重新创建数据库表（通过 Alembic 迁移）"""
        # Alembic 需要同步驱动，只能同步执行——放到线程池，别阻塞事件循环
        def _migrate() -> bool:
            initializer = DatabaseInitializer()
            return initializer.run_migrations()["success"]

        success = await asyncio.to_thread(_migrate)

        if not success:
            raise RuntimeError("创建表失败")

        logger.info("数据库表已通过 Alembic 迁移重建")

    async def _bootstrap_admin(self) -> bool:
        """重置后自动引导管理员用户"""
        initializer = DatabaseInitializer()
        # 管理员引导走一次性同步会话（见 utils/init_database 的「同步引擎的边界」），
        # 放到线程池执行，别阻塞事件循环
        result = await asyncio.to_thread(initializer.autobootstrap_admin)
        if result:
            logger.info("管理员用户引导完成")
        return result

    @staticmethod
    def _is_valid_table_name(table_name: str) -> bool:
        """
        验证表名是否合法

        Args:
            table_name: 表名

        Returns:
            bool: 是否合法
        """
        if not table_name or not isinstance(table_name, str):
            return False
        return all(c.isalnum() or c == '_' for c in table_name)
