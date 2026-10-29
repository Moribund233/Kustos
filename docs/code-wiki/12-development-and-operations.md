# 12 · 开发与运维指南

> 目标：从零启动、运行测试、部署升级、排障的实操手册。

---

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| Python | 3.12（`>=3.12,<3.13`）|
| 包管理 | `uv`（推荐，仓库含 `uv.lock`）|
| 数据库 | PostgreSQL 16 + pgvector（开发也必须）|
| Redis | 可选；缺失时多处降级 |
| Docker | 生产/开发 Compose 方式需要 Docker + Compose V2 |
| 系统库 | `libgit2`、`libpq`、`gcc/g++`、`pkg-config`（构建 pygit2/psycopg2）|
| Node | 22（协作网关 `collab-gateway`；前端 `frontend/web` 构建；两者都在容器内完成，宿主机可不装）|

---

## 2. 本地开发

### 2.1 方式 A：Docker Compose Dev（推荐）

```bash
cd backend
# 仓库未提供 .env.dev；请按 compose 变量清单创建 .env
# （或运行 python scripts/generate_env.py 生成密钥类变量）
cp .env.dev .env          # 若文件存在
# 编辑 .env：KUSTOS_SECURITY_SECRET_KEY、POSTGRES_PASSWORD、管理员账号
docker compose -p kustos-dev -f docker-compose.dev.yml up -d --build
```

或在 Windows：

```powershell
cd backend
.\scripts\dev-start.ps1 start
.\scripts\dev-start.ps1 logs
.\scripts\dev-start.ps1 shell
```

开发 compose 特点：

- 独立 PostgreSQL（`kustos-postgres-dev`）与数据卷，避免与生产冲突；
- app 挂载源码热重载，暴露 `127.0.0.1:8002:8000`；
- `KUSTOS_INIT_DATABASE=true`，启动自动迁移 + 管理员引导；
- git-cgi/collab/gateway 一并启动；
- 前端在 `frontend/web`，开发时单独 `pnpm dev`（Vite 默认 `5173`，dev 网关回源到 `host.docker.internal:5173`）。

### 2.2 方式 B：裸进程 + 外部依赖

```bash
cd backend
uv sync                                   # 安装依赖（含 dev）
cp config.example.toml config.toml        # 可选：仅遗留兼容，实际不读取
export DATABASE_URL='postgresql://user:pass@localhost:5432/kustos'
export KUSTOS_SECURITY_SECRET_KEY="$(openssl rand -hex 32)"
export KUSTOS_ADMIN_USERNAME=admin
export KUSTOS_ADMIN_PASSWORD='...'
export KUSTOS_ADMIN_EMAIL=admin@example.com
python scripts/init_db.py                 # 迁移 + 管理员 + 配置播种
uv run uvicorn app.main:app --reload --port 8000
```

访问：

- API 文档：`http://127.0.0.1:8000/docs`
- 健康检查：`/health`
- 指标：`/metrics`

### 2.3 关键环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | 仅 PostgreSQL |
| `KUSTOS_SECURITY_SECRET_KEY` | 是 | JWT 密钥（生产必须） |
| `REDIS_URL` | 否 | 缓存/pubsub/队列 |
| `KUSTOS_INIT_DATABASE` | 否 | true=启动迁移；false=只读校验 |
| `KUSTOS_ADMIN_USERNAME/PASSWORD/EMAIL` | 首次 | 管理员引导 |
| `KUSTOS_APP_DEBUG` | 否 | 调试/热重载 |
| `KUSTOS_STRESS_TEST` | 否 | 压力测试连接池 |
| `KUSTOS_STORAGE_REPO_ROOT` | 否 | 裸仓库根目录 |
| `KUSTOS_COLLAB_INTERNAL_SECRET` | 协作 | 网关 ↔ app |
| `KUSTOS_GIT_HOOK_SECRET` | Git | hooks ↔ app |
| `KUSTOS_AGENT_ENABLED` / `KUSTOS_AGENT_API_KEY` | Agent | LLM |
| `KUSTOS_SEARCH_EMBEDDING_ENABLED` | 语义 | 复用 Agent key |
| `KUSTOS_ADMIN_ALLOWED_SOURCES` | 生产 | Admin 控制台 IP 白名单 |
| `KUSTOS_DOCKER_HOST` / `KUSTOS_DOCKER_WRITE_HOST` | 生产 | 编排状态/窄写 |
| `KUSTOS_GRAFANA_*` | 监控 | Grafana SSO |

完整清单见 [03-bootstrap-and-config.md](03-bootstrap-and-config.md) 与 `config.example.toml`。

---

## 3. 生产部署

### 3.1 一键安装

```bash
cd backend
bash scripts/install.sh                 # 交互式（5s 内按 Enter 进入自定义）
bash scripts/install.sh -d              # 默认部署
bash scripts/install.sh --with-monitoring
```

流程：preflight → `.env` 生成 → 镜像准备 → PG/Redis 就绪 → init（迁移+管理员）→ 业务层启动 → 网关健康 → 可选监控 → 全局 `kustos` 命令。

### 3.2 手工等价流程

```bash
docker compose up -d postgres redis
docker compose --profile init run --rm init
docker compose up -d
```

### 3.3 日常运维

| 操作 | 命令 |
| --- | --- |
| 启停 | `bash scripts/mgt.sh start/stop/restart` |
| 状态 | `bash scripts/mgt.sh status` |
| 日志 | `bash scripts/mgt.sh logs [svc]` |
| 备份 | `bash scripts/mgt.sh backup [--with-data]` |
| 恢复 | `bash scripts/mgt.sh restore <file> [--with-data]` |
| 升级 | `bash scripts/mgt.sh upgrade [--tag vX]` |
| 回滚 | `bash scripts/mgt.sh rollback` |
| 重设管理员 | `bash scripts/mgt.sh reset-admin` |
| 体检 | `bash scripts/mgt.sh doctor` |
| 卸载 | `bash scripts/mgt.sh uninstall`（删卷，二次确认） |

> 升级前务必 `backup`；仓库数据（`repos` 卷）与数据库必须成对备份，否则恢复后 Git/DB 不一致。

### 3.4 首次登录与安全

1. 访问 `http://<host>:8000/`（默认网关端口）；
2. 使用 `KUSTOS_ADMIN_USERNAME/PASSWORD` 登录；
3. 立即修改管理员密码；
4. 配置 `KUSTOS_ADMIN_ALLOWED_SOURCES`（否则 Admin API 全部 403）；
5. 生产设置 `KUSTOS_APP_DEBUG=false`、强 JWT 密钥、Sentry DSN（可选）。

---

## 4. 测试

### 4.1 测试架构

- 181 个测试文件、2140 个测试函数（静态统计）；
- `pytest-asyncio` 自动模式（`asyncio_mode=auto`）；
- **统一 PostgreSQL**：每个会话建一次性临时库，结束 `DROP ... FORCE`；
- 异步引擎测试期强制 `NullPool`，规避跨事件循环连接复用；
- 同步/异步 fixture 共享同一临时库；
- 每个用例后清空所有表并清理物理仓库目录。

### 4.2 运行方式

**容器（推荐，环境一致）**：

```bash
cd backend
docker compose --profile test build test
docker compose --profile test run --rm test
docker compose --profile test run --rm test tests/test_search_service.py -q
```

**本地**：

```bash
cd backend
uv sync --extra dev
export DATABASE_URL='postgresql://user:pass@localhost:5432/kustos'
export TEST_DATABASE_URL="$DATABASE_URL"      # 可选
pytest tests/ -q
pytest tests/test_agent_api.py -q
```

要求：

- `DATABASE_URL` 必须是 PostgreSQL；测试会创建/删除临时库，账号需有 `CREATEDB` 权限；
- 需要 `vector` 扩展（测试库显式 `CREATE EXTENSION IF NOT EXISTS vector`）；
- `conftest.py` 会重置 `AppCache`/配置单例，避免跨用例污染。

### 4.3 测试类别

| 类别 | 示例 |
| --- | --- |
| 单元/服务 | `test_*_service_async.py`、`test_agent_*`、`test_search_*` |
| API 契约 | `test_api_contract.py`、`test_error_contract.py`、`test_controller_*` |
| 安全 | `test_permission_matrix.py`、`test_authz_probe.py`、`test_security_audit.py`、`test_lfs_acl.py` |
| 一致性 | `test_schema_drift.py`、`test_index_debt.py`、`test_route_order_guard.py` |
| 实时/协作 | `test_chat_*`、`test_room_*`、`test_presence_*`、`test_collab_*`、`collab-gateway/tests/*` |
| 回归/并发 | `test_bug_regression.py`、`test_hardening_regression.py`、`test_concurrency_pool_alignment.py` |
| 冒烟/压测 | `smoke_test.py`、`stress_test.py`、`scripts/e2e_*.sh` |

### 4.4 静态检查

```bash
cd backend
black app tests
isort app tests
flake8 app
python scripts/security_audit.py
```

---

## 5. 运维排障

### 5.1 启动类

| 症状 | 定位 | 处理 |
| --- | --- | --- |
| 启动即退出，缺 env | `init_app` 报告 | 设置 `DATABASE_URL` / `KUSTOS_SECURITY_SECRET_KEY` |
| schema 未就绪 | `KUSTOS_INIT_DATABASE=false` 且未 init | `mgt.sh init` |
| repo_root 不可写 | 配置校验 errors | 修正权限/路径 |
| 异步引擎创建失败 | URL/驱动 | 检查 `asyncpg`、URL 格式 |
| Admin API 403 | 网关 ACL | 配置 `KUSTOS_ADMIN_ALLOWED_SOURCES` |

### 5.2 运行类

| 症状 | 可能原因 | 处理 |
| --- | --- | --- |
| push 被拒 | 保护分支/强推/文件超限/hook 密钥 | 查看 hook stderr；检查分支保护与 `storage` 上限 |
| push 后列表不更新 | post-receive 回调失败 | 检查 `KUSTOS_GIT_HOOK_SECRET`、app 可达；下次 push 自愈 |
| 代码浏览 404 | 物理仓缺失/ref 不存在 | 检查 `repos` 卷与 `physical_exists` |
| 搜索慢/无结果 | 索引超限/锁占用/表未迁移 | `/search/index-status`、`reindex`、查日志 |
| 语义检索不生效 | 无 key/未启用/维度不符 | 设置 `KUSTOS_AGENT_API_KEY` + `KUSTOS_SEARCH_EMBEDDING_ENABLED=true` |
| 实时消息跨 worker 丢失 | Redis 不可用 | 检查 Redis；查看 degraded 状态 |
| 协作无法连接 | 内部密钥/权限/连接上限 | 检查 `KUSTOS_COLLAB_INTERNAL_SECRET`、collab 日志 |
| 协作保存不落 Git | 仅显式保存才提交 | 客户端发送 `collab-save`；`onStoreDocument` 不提交 |
| Agent 作业一直 queued | arq/Redis/worker 不可用 | 查看 worker 日志；Redis 恢复后自动重试；`reclaim_stale_jobs` 回收 |
| Agent 作业挂起 | 等待写工具审批 | 调用 approve/reject 端点 |
| 配置改了不生效 | 重启键/未轮询 | 查 `SECTION_META`；等待 5s 或重启 |

### 5.3 数据库与迁移

```bash
# 只读校验
docker compose --profile init run --rm init python scripts/init_db.py --check-only

# 查看当前/最新 revision
docker compose exec app python -c "from app.utils.db_migrate import get_applied_revision,get_head_revision;print(get_applied_revision(),get_head_revision())"
```

迁移失败时：不要直接改库，先看 Alembic 日志；用 `mgt.sh rollback` 恢复备份。

### 5.4 Git 数据恢复

- `repos` 卷必须与 DB 一起恢复；
- 物理仓库丢失但 DB 存在：可重新初始化空仓并让用户重新 push；或从备份卷恢复；
- 分支/提交不一致：触发一次 push 或调用 post-receive 对账逻辑修复。

---

## 6. 开发工作流建议

1. **改动前**：先读对应 service 与测试，确认权限矩阵/事务边界。
2. **新增 API**：controller → service → tests；权限用 `require_repo_*` 依赖，错误用 `core.exception`。
3. **新增配置**：`config.py` 字段 + `config_schema.SECTION_META` + `config.example.toml` 播种 + 消费点 `get_config_value`。
4. **新增 Action**：必须在 `ACTION_MATRIX` 登记，补 `test_permission_matrix.py`。
5. **新增表**：ORM + Alembic 迁移 + `models/__init__.py` 导出；跑 `test_schema_drift.py`。
6. **涉及 Git**：同步 pygit2 调用必须 `to_thread`；写分支须过保护裁决。
7. **涉及 Agent 工具**：注册 `ToolSpec`，写工具设 `requires_approval=True`，结果自夹取。
8. **测试**：至少覆盖成功/失败/权限/降级；容器内跑全量。

---

## 7. 常用地址与端点

| 项 | 地址 |
| --- | --- |
| API 文档 | `http://host:8000/docs` |
| 健康检查 | `/health` |
| 指标 | `/metrics` |
| Prometheus | `http://127.0.0.1:9090`（监控栈） |
| Grafana | `http://host:8000/grafana`（SSO）或 `:3000` |
| Git HTTP | `http://host:8000/<owner>/<repo>.git` |
| Git SSH | `ssh://git@host:2222/<owner>/<repo>.git` |
| 协作 WS | `ws://host:8000/ws/collab` |
| 应用 WS | `ws://host:8000/ws/` |
| 管理员日志 WS | `ws://host:8000/ws/logs` |

---

## 8. 相关文件

- `backend/pyproject.toml`、`uv.lock`、`config.example.toml`
- `backend/scripts/install.sh`、`mgt.sh`、`dev-start.*`、`init_db.py`、`generate_env.py`
- `backend/tests/conftest.py`
- `backend/docker-compose*.yml`
- `backend/docker/test/Dockerfile.test`
