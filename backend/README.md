# Kustos Backend

Kustos 的后端服务：一个 FastAPI 应用 + 一组 Compose 服务，提供 Git 托管、协作流程、实时通信、代码检索与内置 Agent。

仓库是 bare repo——代码浏览、diff、搜索、协作保存都直接读写 Git 对象（pygit2），不维护工作树；平台元数据（仓库、成员、PR、Issue、Release、Webhook、通知、聊天、构建状态）落在 PostgreSQL；实时消息走 WebSocket，协作文档由独立的 Hocuspocus 网关承担 CRDT。

## 目录结构

```
backend/               # 本 Python 项目的根（pyproject / uv.lock / Dockerfile 在此）
  app/                 # 唯一的导入根，所有导入写作 `app.xxx`
    main.py            # create_app / get_app，uvicorn app.main:app
    api/
      deps.py          # 共享 FastAPI 依赖（get_current_user 等）
      prefixes.py      # 路由前缀常量（无副作用，可被 controller 反向依赖）
      router.py        # create_api_router()：唯一路由装配点
      v1/              # HTTP 控制器
      ws/              # WebSocket（auth / manager / router / handlers）
    core/              # 配置、异常、权限矩阵、i18n、生命周期
    models/            # SQLAlchemy ORM + alembic Base
    services/          # 业务逻辑（agent / auth / indexing / realtime 子包）
    middleware/        # 并发、审计、可观测、指标
    utils/             # Git 封装、Redis、安全、响应构造、邮件、Webhook
  alembic/             # 数据库迁移
  scripts/             # 容器内脚本：初始化、迁移、审计、E2E（随镜像发布）
  tests/               # pytest（含 api 契约、路由顺序、schema 漂移等护栏）
```

> 编排文件 `docker-compose*.yml`、镜像构建资料 `docker/`、宿主机部署入口 `deploy/`
> 与协作网关 `services/collab` 都在仓库根，不在此目录下。

## 运行

**整栈（推荐）**

```bash
# 在仓库根执行（compose 与 .env 都在这层）
python3 deploy/generate_env.py          # 生成 .env（密钥类变量，幂等，可重复执行）
docker compose -p kustos up -d --build
```

| 入口 | 地址 |
| --- | --- |
| 网关（统一入口：API / WebSocket / Git HTTP） | http://127.0.0.1:8000 |
| API 直连 | http://127.0.0.1:8001 |
| Git HTTP | http://127.0.0.1:9000 |
| Git SSH | `ssh://git@127.0.0.1:2222/<owner>/<repo>.git` |

初始管理员账号在 `.env`（`KUSTOS_ADMIN_USERNAME` / `KUSTOS_ADMIN_PASSWORD`），首次登录后请立即修改。

**开发 compose（自包含，源码热重载）**

```bash
docker compose -f docker-compose.dev.yml -p kustos-dev up -d --build
# 网关 http://127.0.0.1:8080 · API 直连 http://127.0.0.1:8002
```

**裸进程**

```bash
uv sync --extra dev
export DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/kustos'
export KUSTOS_SECURITY_SECRET_KEY="$(openssl rand -hex 32)"
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000
```

## 环境变量

`.env` 由 `python3 deploy/generate_env.py` 生成或补全。

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（需启用 pgvector） |
| `REDIS_URL` | 缓存 / pub-sub / Agent 队列；缺失时多处降级 |
| `KUSTOS_SECURITY_SECRET_KEY` | JWT 签名密钥（必需） |
| `KUSTOS_INIT_DATABASE` | 启动时是否执行迁移与管理员引导；多副本部署应设 `false`，由 `init` profile 单独执行 |
| `KUSTOS_STORAGE_REPO_ROOT` | bare 仓库根目录（容器内 `/data/repositories`） |
| `KUSTOS_ADMIN_USERNAME` / `_PASSWORD` / `_EMAIL` | 初始管理员 |
| `KUSTOS_ADMIN_ALLOWED_SOURCES` | Admin 控制台来源白名单（IP/CIDR，留空即拒绝全部来源） |
| `KUSTOS_GATEWAY_PORT` | 网关对外端口（默认 8000） |
| `KUSTOS_APP_DEBUG` / `LOG_LEVEL` | 调试模式与日志级别 |

## 测试

统一使用 PostgreSQL：每个会话创建一次性临时库，结束时删除；要求 `vector` 扩展与 `CREATEDB` 权限。

```bash
# 容器内（推荐，环境一致）
docker compose -p kustos --profile test run --rm test
docker compose -p kustos --profile test run --rm test tests/test_pull_request_service_async.py -q

# 开发 compose
docker compose -f docker-compose.dev.yml -p kustos-dev run --rm test

# 裸进程
uv run pytest tests/ -q
```

`asyncio_mode=auto`；每个用例后清空所有表并清理物理仓库目录。除了业务用例，`tests/` 里还有几类护栏：`test_schema_drift`（模型 vs 迁移后的 schema）、`test_route_order_guard`（路由遮蔽）、`test_permission_matrix` / `test_authz_probe`（权限矩阵）。

## 迁移

```bash
uv run alembic upgrade head                             # 升级到最新
uv run alembic revision --autogenerate -m "..."         # 生成（需 DATABASE_URL）
docker compose -p kustos --profile init run --rm init   # 容器内迁移 + 管理员引导
```

模型改动必须同时提交迁移，否则 `test_schema_drift` 失败。

## 静态检查

```bash
uv sync --extra dev
uv run black app tests
uv run isort app tests
uv run flake8 app
uv run python scripts/security_audit.py
```

## 约定

- **导入根唯一**：一律 `app.*`，不写 `from models import ...` 这类裸顶层导入。
- **分层**：`controller → service → model`。控制器只做参数解析、依赖注入与响应构造；业务规则、事务、权限调用在服务层，控制器不直接写 SQL。
- **路由**：只在 `app/api/v1/` 下声明，装配统一在 `app/api/router.py`；不在 `/api/v1/repositories` 下制造相邻的双通配路由（会被 `test_route_order_guard` 拦下）。
- **权限**：唯一裁决点是 `app/core/permissions.py`。全局管理员（`User.is_admin`）与仓库角色（owner/admin/developer/readonly）是两套授权，互不推导。
- **响应**：统一经 `app/utils/response_builder.py` 构造；新增字段只做加法，不改变既有字段语义。
- **注释**：模块与函数使用中文 docstring（用途 / `Args` / `Returns` / `Raises`），行内注释解释“为什么”；错误码与标识符保持英文。

## 文档

完整架构与运维手册在仓库根目录 `docs/code-wiki/`：

- `03-bootstrap-and-config` — 启动流程与配置系统
- `04-api-layer` — 路由、认证与权限矩阵
- `05-data-model` — 数据表、关系与约束
- `06-service-layer` — 服务边界与调用方向
- `07-git-and-repository` — Git 存储、Smart HTTP / SSH / LFS
- `09-search-and-indexing` — 切块、符号、embedding、增量索引
- `10-agent-subsystem` — Agent 运行时、工具、审批、触发器
- `11-infrastructure` — 网关、Compose、监控、部署
- `12-development-and-operations` — 本地开发、测试、排障
