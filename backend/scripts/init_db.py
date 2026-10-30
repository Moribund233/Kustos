#!/usr/bin/env python3
"""独立数据库初始化入口（init 容器 / 任务使用）。

执行内容：
1. Alembic 迁移到最新 schema（幂等，可重复执行）
2. 首启自动引导管理员（KUSTOS_ADMIN_* 环境变量）
   - 已存在管理员时跳过，不覆盖已有凭据

用法:
  python scripts/init_db.py                # 迁移 + 管理员引导
  python scripts/init_db.py --check-only   # 只读就绪校验（不执行任何 DDL）

退出码:
  0  成功
  1  失败 / 未就绪
"""
import argparse
import sys
from pathlib import Path

# 将项目根目录加入 sys.path，确保从任意 CWD 都可直接执行
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Kustos 数据库初始化任务（迁移 + 管理员引导）",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="仅校验 schema 是否就绪，不执行任何迁移或写入",
    )
    args = parser.parse_args()

    from app.core.config import ConfigManager
    from app.utils.logging import init_logging, get_named_logger

    init_logging(
        log_dir="logs",
        app_name="init",
        level="info",
        console_output=True,
        use_date_directory=True,
        separate_error_log=True,
        websocket_output=False,
    )
    logger = get_named_logger("init")
    ConfigManager("config.toml")

    if args.check_only:
        from app.utils.init_database import verify_database_ready

        ready, state = verify_database_ready()
        logger.info(
            f"schema 状态: applied={state.get('applied')} head={state.get('head')} "
            f"ready={ready}"
        )
        return 0 if ready else 1

    from app.utils.init_database import init_database

    logger.info("开始数据库初始化（迁移 + 管理员引导）")
    success = init_database()
    if success:
        # 迁移完成后播种配置表（幂等：只补缺键，不覆盖后台已改的值）。
        # 放在迁移之后而非迁移内：迁移保持纯 schema，播种可在任意环境重跑。
        from app.core.config_store import seed_from_example

        logger.info(f"配置表播种: {seed_from_example()}")

        from app.utils.db_migrate import get_applied_revision, get_head_revision

        logger.info(
            f"初始化完成: schema applied={get_applied_revision()} head={get_head_revision()}"
        )
        return 0

    logger.error("数据库初始化失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())