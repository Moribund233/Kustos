# Kustos

自托管、Git 原生、带实时协作与内置 Agent 的研发协作平台。

Kustos 不是对 GitHub API 的封装：仓库是 bare repo，代码浏览、搜索、PR diff、协作保存全部直接读写 Git 对象；元数据落在 PostgreSQL，实时通信走 WebSocket，Agent 以只读工具检索代码、写工具需人工审批。整套系统用一个 FastAPI 应用 + 一组 Compose 服务交付。

## 功能概览

| 领域 | 能力 |
| --- | --- |
| 仓库与代码 | 仓库 CRUD、归档、Fork/Star/Watch；文件树、blob、提交历史、diff、blame、提交图、符号；分支与分支保护；Web 端提交；Git Smart HTTP / SSH / LFS |
| 协作流程 | Pull Request（草稿、行内评论、Review、三种合并方式、保护规则与 admin bypass）；Issue（标签、指派、批量操作）；Release 与附件；Webhook（HMAC 签名、重试、投递历史）；通知（站内 / 邮件 / WebSocket） |
| 实时与社交 | 仓库频道、私聊、在线状态、跨 worker 广播；Yjs CRDT 协作文档（Hocuspocus 网关）；协作邀请与会话级权限覆盖 |
| 搜索与 AI | 代码全文检索（块级索引 + `ILIKE` 子串匹配，暂未建 `pg_trgm` GIN 索引）、符号定义/引用、embedding 混合排序；Agent 作业（工具循环、流式、审批）、触发器（push / CI 失败 / 定时） |
| 平台与运维 | JWT 轮换与吊销、OAuth、仓库权限矩阵；动态配置（库表 + 热生效 + 密文密钥）；审计与 Activity；Prometheus 指标、Grafana SSO；Admin 控制台 API |

## 技术栈

| 层 | 选型 |
| --- | --- |
| 应用 | Python 3.12、FastAPI、SQLAlchemy 2（async）、Alembic、pydantic |
| 数据 | PostgreSQL 16 + pgvector（唯一数据库）、Redis 7（缓存 / pub-sub / Agent 队列） |
| Git | pygit2（libgit2）、`git-http-backend`、OpenSSH + 自定义 wrapper、LFS |
| 接入 | OpenResty 网关（静态资源 / API / WS / Git / 协作反代）、Hocuspocus（Node 22） |

## 目录结构

```text
backend/
├── app/
│   ├── api/          # 路由装配 + v1 控制器 + WebSocket
│   ├── core/         # 配置、初始化、生命周期、权限、异常
│   ├── middleware/   # 并发、审计、观测、指标
│   ├── models/       # SQLAlchemy 模型 + 同步/异步引擎
│   ├── services/     # 业务逻辑（含 agent / indexing / realtime）
│   └── utils/        # Git、Redis、安全、响应、邮件、Webhook
├── alembic/          # 数据库迁移
├── collab-gateway/   # Hocuspocus / Yjs 网关
├── docker/           # 网关、git-cgi、sshd、监控等配置
├── scripts/          # 安装、初始化、运维、审计脚本
├── tests/            # pytest
└── docker-compose*.yml
frontend/
└── web/              # Web 前端（Vite + React + TS），网关镜像的构建输入
docs/
├── code-wiki/        # 架构与实现文档（见下方索引）
└── prototype/        # 静态 Web 原型（设计说明与交互稿）
```

## 快速开始

前置：Docker + Compose V2、Python 3.12（`uv`）、PostgreSQL 16 + pgvector。数据库与 Redis 默认由 Compose 提供，宿主机不必单独安装。

```bash
cd backend
python3 scripts/generate_env.py          # 生成 compose 需要的密钥类变量（幂等，可重复执行）
docker compose -p kustos up -d --build   # 构建并启动整套服务
```

启动后：

| 入口 | 地址 |
| --- | --- |
| 网关（推荐入口） | http://127.0.0.1:8000 |
| API 直连 | http://127.0.0.1:8001 |
| Git HTTP | http://127.0.0.1:9000 |
| Git SSH | `ssh://git@127.0.0.1:2222/<owner>/<repo>.git` |

初始管理员账号在 `backend/.env`（`KUSTOS_ADMIN_USERNAME` / `KUSTOS_ADMIN_PASSWORD`），首次登录后请立即修改密码。生产部署前请阅读 `docs/code-wiki/11-infrastructure.md` 的网关、Admin ACL（`KUSTOS_ADMIN_ALLOWED_SOURCES`，留空即拒绝全部来源）与备份升级说明。

### 常用 profile

```bash
docker compose -p kustos --profile init run --rm init     # 迁移 + 管理员引导
docker compose -p kustos --profile test run --rm test     # pytest（容器内）
docker compose -p kustos -f docker-compose.monitoring.yml up -d   # Prometheus + Grafana（可选）
```

## 前端

Web 前端在 `frontend/web`：Vite + React + TypeScript，Tailwind v4 + shadcn/ui 风格组件，
接口类型由后端 OpenAPI 生成。它同时是网关镜像的构建输入——镜像内用 Node 22 + pnpm 11 构建
`dist` 再交给 OpenResty 托管，因此宿主机无需装 Node。

```bash
cd frontend/web
pnpm install     # pnpm 11；allowBuilds 在 pnpm-workspace.yaml，缺了 esbuild 装不上
pnpm dev         # 开发服务器（/api 代理到后端）
pnpm build       # 产物在 dist/，网关镜像取的就是这个目录
pnpm api:generate   # 后端契约变了就重新生成类型
```

详见 `frontend/web/README.md`。

## 本地开发

**方式 A：Compose（推荐，环境一致）**

```bash
cd backend
docker compose -f docker-compose.dev.yml -p kustos-dev up -d --build
```

源码挂载热重载；网关在 `127.0.0.1:8080`，API 直连 `127.0.0.1:8002`（避免与生产网关 8000 冲突）。改完代码跑测试：

```bash
docker compose -f docker-compose.dev.yml -p kustos-dev run --rm test
docker compose -f docker-compose.dev.yml -p kustos-dev run --rm test tests/test_pull_request_service_async.py -q
```

**方式 B：裸进程 + 外部依赖**

```bash
cd backend
uv sync --extra dev
export DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/kustos'
export KUSTOS_SECURITY_SECRET_KEY="$(openssl rand -hex 32)"
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

> Windows 上直接在 `D:\` 盘跑 Compose 会因跨文件系统（9p）导致构建与测试明显变慢；把仓库放到 WSL 原生盘（如 `~/<repo>`）或在容器内运行即可。这属于个人开发习惯，仓库不附带同步脚本。

测试要求：PostgreSQL 16 + `vector` 扩展，账号需有 `CREATEDB`（每个会话建临时库、结束删除）。

静态检查（在本机装好 dev 依赖的环境里执行）：

```bash
black app tests && isort app tests && flake8 app
python scripts/security_audit.py
```

Web 原型（`docs/prototype`）是纯静态页面，无需构建：

```bash
cd docs/prototype && python -m http.server 8765   # http://127.0.0.1:8765/index.html
```

## 文档

| 分册 | 内容 |
| --- | --- |
| `01-project-overview` | 产品定位、功能全景、技术栈 |
| `02-architecture` | 分层架构、请求链路、进程模型 |
| `03-bootstrap-and-config` | 启动流程、配置系统与优先级 |
| `04-api-layer` | 路由装配、认证与权限矩阵、控制器清单 |
| `05-data-model` | 数据表、关系、约束 |
| `06-service-layer` | 服务边界与调用方向 |
| `07-git-and-repository` | Git 存储、Smart HTTP/SSH、LFS |
| `08-collaboration-realtime` | WebSocket、房间、协作文档 |
| `09-search-and-indexing` | 切块、符号、embedding、增量索引 |
| `10-agent-subsystem` | Agent 运行时、工具、审批、触发器 |
| `11-infrastructure` | 网关、Compose、监控、部署 |
| `12-development-and-operations` | 本地开发、测试、排障 |
| `13-dependencies` | 模块依赖与 import 规则 |

设计稿与交互说明见 `docs/prototype/README.md`。

## 开发约定

- **分层**：`controller → service → model`。控制器只做参数与依赖编排，不写 SQL；服务层不解析 HTTP。层间依赖白名单由 `backend/tests/test_layer_boundary.py` 用 AST 强制（含函数体内的延迟导入），并带一条只收不放的「延迟导入棘轮」。
- **权限唯一裁决点**：`app/core/permissions.py`（纯策略）。全局管理员（`User.is_admin`）与仓库角色（owner/admin/developer/readonly）是两套授权，互不推导。组装成 FastAPI 依赖的工厂在 `app/api/guards.py`。
- **迁移**：模型改动必须配 Alembic 版本（`alembic/versions/`），`tests/test_schema_drift.py` 会比对模型与实际 schema。
- **注释**：模块与函数使用中文 docstring（用途 / `Args` / `Returns` / `Raises`）；行内注释解释“为什么”，不转述实现。错误码与标识符保持英文。
- **提交**：Conventional Commits，一个逻辑变更一个提交，subject 说清改了什么，body 说明原因与影响。

## License

[MIT](LICENSE)
