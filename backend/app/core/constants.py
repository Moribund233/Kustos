"""
核心常量模块

定义项目中使用的共享常量
"""
from pathlib import Path

#: 项目根目录（`backend/`）。唯一权威定义，任何需要定位
#: alembic.ini / config.example.toml 之类的文件都从这里推导，
#: 不要再用 `Path(__file__).parents[N]` 硬编码层级深度。
PROJECT_ROOT = Path(__file__).resolve().parents[2]

# 仓库成员角色优先级定义
# 数值越高，权限越大
ROLE_PRIORITY = {
    "owner": 4,
    "admin": 3,
    "developer": 2,
    "readonly": 1
}

# 有效的角色列表
VALID_ROLES = list(ROLE_PRIORITY.keys())


# ---------------------------------------------------------------------------
# 分页 / 列表查询契约（API 默认与上限；**不进配置**）。
#
# 这些是跨 controller 复用的「API 契约」值——集中在此避免散落漂移；调整只改
# 这里。注意与 utils/db_utils.paginate 的默认保持一致（同一契约）。
# ---------------------------------------------------------------------------

DEFAULT_PAGE = 1             # 页码默认（从 1 开始）
DEFAULT_PAGE_SIZE = 20       # 通用列表每页条数默认
MAX_PAGE_SIZE = 100          # 通用列表每页条数上限

DEFAULT_PAGE_SIZE_LARGE = 50  # 提交历史 / 协作消息 / 构建列表默认
DEFAULT_PAGE_SIZE_MAX = 100   # 提交差异等宽上限批量默认
MAX_PAGE_SIZE_MAX = 1000      # 提交差异等宽上限批量上限

# 审计查询（app 管理接口）
AUDIT_DEFAULT_PAGE_SIZE = 20
AUDIT_MAX_PAGE_SIZE = 200
AUDIT_DEFAULT_LOOKBACK_DAYS = 7
AUDIT_MAX_LOOKBACK_DAYS = 90

# 日志查询 / 清理（app 管理接口）
LOG_DEFAULT_LINES = 100
LOG_MAX_LINES = 5000
LOG_DEFAULT_KEEP_DAYS = 30
LOG_MAX_KEEP_DAYS = 365
