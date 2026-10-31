# 01 · 项目概览与功能全景

> 目标：回答「Kustos 是什么、能做什么、由哪些技术构成、代码放在哪里」。

---

## 1. 产品定位

Kustos 是一个**自托管、Git 原生、带实时协作与 AI 能力**的研发协作平台。它不是简单封装 GitHub API，而是把 Git 对象、关系型元数据、实时通信和异步 Agent 放在同一套 FastAPI 应用中：

- **Git 原生**：仓库是 bare 仓库，代码浏览、搜索、PR diff、协作保存全部直接读/写 Git 对象（pygit2），不维护工作树。
- **平台化**：仓库、成员、PR、Issue、Release、Webhook、通知、聊天、构建状态均落 PostgreSQL。
- **实时协作**：WebSocket 覆盖聊天/房间/通知/日志/进度/同步；文档协同编辑由独立 Hocuspocus 网关承担 CRDT。
- **AI 增强**：内置 Agent 以只读工具检索代码/PR/Issue，写工具需人工审批；语义检索基于 pgvector。
- **可运维**：自带 Admin 控制台 API、审计、Prometheus 指标、Grafana SSO、Docker Compose 一键部署与备份/升级脚本。

---

## 2. 功能全景

### 2.1 仓库与代码

| 能力 | 主要实现 |
| --- | --- |
| 仓库 CRUD、归档、Fork、Star、Watch | `repository_service` / `fork_service` / `star_service` / `watch_service` |
| 代码浏览：文件树、blob、提交历史、diff、blame、提交图、README、语言识别、符号 | `repository_browser_service` |
| 分支管理、分支保护（禁删/禁强推/需评审/需状态检查） | `branch_service`、`git_event_service`、`pull_request_service` |
| 提交 / 标签 / 文件写入（Web 端提交） | `commit_service`、`git_utils`、`repository_browser_service.commit_file` |
| Git HTTP Smart Protocol | Nginx + `git-http-backend`（`docker/git-cgi`）|
| Git over SSH | `openssh-server` + `git-shell-wrapper` + `authorized_keys_query.py` |
| Git LFS | `lfs_controller` / `lfs_service` / `lfs_storage` / `lfs_token` |
| 变更图索引 | `commit_index_service`、`repo_commit_files` |

### 2.2 协作流程

| 能力 | 主要实现 |
| --- | --- |
| Pull Request（含草稿、行内评论、Review、diff、三种合并方式） | `pull_request_service` |
| 分支保护合并裁决 / Admin bypass | `enforce_merge_protection` |
| Issue（标签、指派、批量操作、评论） | `issue_service`、`label_service` |
| Release（草稿、预发布、附件） | `release_service`、`release_asset_service` |
| 文件/行内评论（Discussions） | `file_comment_service` |
| 仓库标签体系 | `repo_label_service`、`pr_label_service` |
| 构建状态（CI 回调） | `build_service`、`build_controller`、`repo.ci_secret` |
| Webhook（事件订阅、HMAC 签名、重试、投递历史） | `webhook_service`、`webhook_trigger` |
| 通知（站内 + 邮件 + WebSocket） | `notification_service`、`notification_preference_service` |

### 2.3 实时与社交

| 能力 | 主要实现 |
| --- | --- |
| 仓库频道、成员、静音、未读 | `realtime/room_service`、`chat_service` |
| 私聊（规范化的用户对 → 唯一 DM 房间） | `realtime_room.DirectMessage`、`dm_controller` |
| 在线状态（Redis 引用计数，多 worker 去重） | `realtime/presence_service` |
| 跨 worker WebSocket 广播 | `utils/realtime_bus`（本地直投 + Redis pub/sub）|
| 协作文档编辑（Yjs CRDT） | `collab-gateway` + `/api/v1/collab/*` 内部回调 |
| 协作邀请链接 / 会话级权限覆盖 / 踢人 | `collab_invite_service`、`collab_session_service` |
| 管理员实时日志 / 进度 / 同步事件 | `api/ws/handlers/*` |

### 2.4 搜索与 AI

| 能力 | 主要实现 |
| --- | --- |
| 代码全文检索（块级索引 + `ILIKE` 子串匹配） | `search_service.search_code` |
| 符号定义 / 引用查找 | `search_service.find_definition/find_usages` |
| 语义检索（embedding + RRF 混合排序） | `indexing/embeddings.py`、`_rrf_fuse` |
| 索引重建 / 增量维护 / 状态查询 | `rebuild_index`、`update_files`、`search_controller` |
| AI Agent 作业（工具循环、流式、审批） | `agent_service`、`agent/runtime` |
| Agent 只读/写工具 | `agent/tools_server.py`、`agent/tools_write.py` |
| Agent 触发器（push / CI 失败 / 定时巡航） | `agent/triggers.py`、`agent_trigger*` 表 |
| 聊天 @bot 唤醒 Agent | `agent/chat_bridge.py` |

### 2.5 平台与运维

| 能力 | 主要实现 |
| --- | --- |
| 认证：JWT access/refresh 轮换、family 吊销、撤销黑名单 | `token_service`、`auth_controller` |
| OAuth（GitHub / GitLab） | `auth/oauth.py`、`oauth_service` |
| 仓库权限矩阵（唯一裁决点） | `core/permissions.py` |
| 动态配置（库表存储、热生效、密文密钥） | `config.py`、`config_store.py`、`config_service.py` |
| 审计日志 + Activity 审计表 | `middleware/audit_logger.py`、`activity_service` |
| 请求指标 / Prometheus / 进程指标 / 自动保留 | `middleware/*`、`metrics_service`、`process_metrics`、`retention_service` |
| 编排状态 / 监控栈开关 / Grafana SSO | `orchestration_service`、`monitoring_service`、`grafana_service` |
| Admin 应用控制（重启/关机/日志/Redis 状态） | `app_controller`、`app_service`、`redis_admin_service` |

---

## 3. 技术栈

### 3.1 核心依赖（`backend/pyproject.toml`）

| 类别 | 依赖 | 用途 |
| --- | --- | --- |
| Web | `fastapi`, `uvicorn[standard]`, `gunicorn`(非 Windows) | HTTP/ASGI |
| 配置 | `pydantic[email]`, `pydantic-settings`, `toml` | 强类型配置 |
| 数据库 | `sqlalchemy>=2`, `asyncpg`, `psycopg2`, `alembic`, `greenlet` | ORM/迁移/异步 |
| Git | `pygit2>=1.19` | libgit2 绑定 |
| 认证 | `python-jose[cryptography]`, `passlib[bcrypt]`, `bcrypt==4.0.0` | JWT/密码 |
| 缓存/队列 | `redis`, `arq` | 缓存、pub/sub、Agent 队列 |
| 网络/IO | `httpx`, `aiofiles`, `aiosmtplib`, `python-multipart` | 外部调用/上传/邮件 |
| 检索 | `tree-sitter` + Python/JS/TS/Go/Rust/Java/C/C++/Ruby/PHP 语法包 | 代码切块与符号识别 |
| 监控 | `sentry-sdk[fastapi]`, `psutil` | 错误/进程指标 |
| 模板/加密 | `jinja2`, `cryptography` | 邮件模板、AES-GCM 密钥 |

开发依赖：`pytest`, `pytest-asyncio`, `respx`, `black`, `isort`, `flake8`。

### 3.2 基础设施

| 组件 | 版本/镜像 | 说明 |
| --- | --- | --- |
| PostgreSQL | `pgvector/pgvector:pg16` | 唯一数据库，启用 `vector` 扩展 |
| Redis | `redis:7-alpine` | `volatile-lru`，无 AOF |
| 协作网关 | Node 22 + `@hocuspocus/server` + `ioredis` | Yjs CRDT |
| Git HTTP | Debian + `fcgiwrap` + `git-http-backend` | Smart Protocol |
| SSH | OpenSSH + 自定义 wrapper | Git over SSH |
| 网关 | OpenResty | 静态前端 + API/WS/Git/协作/Grafana 反代 |
| 监控 | Prometheus v3 + Grafana 11 + redis_exporter | 可选 stack |

---

## 4. 仓库结构

```text
Kustos/
├── backend/
│   ├── app/
│   │   ├── main.py                # create_app / 模块级 app
│   │   ├── api/                   # 路由装配 + v1 控制器 + WebSocket
│   │   ├── core/                  # 配置、初始化、生命周期、权限、异常、i18n
│   │   ├── middleware/            # 并发、审计、观测、指标、范围
│   │   ├── models/                # SQLAlchemy 模型 + 同步/异步引擎
│   │   ├── services/              # 业务服务（含 agent/indexing/realtime/auth 子包）
│   │   └── utils/                 # Git、日志、Redis、安全、响应、邮件、Webhook 等
│   ├── alembic/                   # 数据库迁移（0001_initial 51 张 + 0002 补 2 张）
│   ├── scripts/                   # 初始化、迁移、E2E、审计脚本（容器内）
│   ├── tests/                     # 188 个测试文件
│   ├── config.example.toml        # 配置播种模板（运行期不读）
│   ├── Dockerfile                 # 多阶段构建（uv）
│   └── pyproject.toml / uv.lock
├── frontend/
│   └── web/                       # Vite + React + TS 前端（gateway 镜像构建上下文）
├── services/
│   └── collab/                    # Hocuspocus/Yjs Node 网关
├── docker/                        # gateway/git-cgi/ssh/collab/监控/写代理配置
├── deploy/                        # 宿主机部署入口（install / mgt / kustos / dev-start / generate_env）
├── docker-compose*.yml            # 基础设施/业务/开发/监控
├── docs/
│   ├── code-wiki/                 # 本文档集
│   └── prototype/                 # 静态 Web 原型（设计稿）
├── README.md
├── LICENSE                        # MIT
└── .gitignore / .gitattributes
```

---

## 5. 关键约束与已知边界

| 项 | 说明 |
| --- | --- |
| 仅 PostgreSQL | `DatabaseSettings` 校验与 `parse_db_url` 均拒绝非 PostgreSQL；测试也要求真实 PG |
| 前端在 `frontend/web` | 网关镜像构建上下文为 `frontend/web`（Node 22 + pnpm 11 容器内构建），未构建前端时 `gateway` 服务起不来 |
| LFS S3 未实现 | `lfs.storage_backend=s3` 时 `lfs_controller` 返回 501；实际仅 local 存储 |
| CI 状态检查为占位 | 平台暂无 CI 检查来源；`security.strict_status_checks=true` 时“零检查记录=未通过” |
| `config.toml` 已弃用 | 运行期只读环境变量 + `app_config`；`config.example.toml` 仅播种/文档 |
| Redis 可选 | 多处组件在 Redis 不可用时降级（进程内广播、内联 Agent、关键词检索、presence 本进程视图） |
| 多 worker | 生产默认 `uvicorn --workers 4`；跨进程一致性依赖 Redis / 数据库轮询 |
| 虚拟环境 | `requires-python = ">=3.12,<3.13"` |

---

## 6. 术语表

| 术语 | 含义 |
| --- | --- |
| bare 仓库 | 无工作树的 Git 仓库，物理目录以 `.git` 结尾 |
| repo_path | 逻辑仓库路径（`owner/repo`），唯一约束 |
| 分支保护 | `Branch.require_code_review` / `require_status_checks` + pre-receive 禁删/禁强推 |
| Action 矩阵 | 仓库域「角色 × 操作」权限表，唯一裁决于 `core/permissions.py` |
| 块级索引 | 每符号块一行 `(path, symbol, start_line, end_line)` 的搜索索引 |
| RRF | Reciprocal Rank Fusion，关键词/语义结果融合 |
| Agent 作业 | `queued → running → awaiting_approval → … → succeeded/failed/cancelled` |
| 审批门禁 | 写工具未获用户显式批准时挂起作业并持久化消息快照 |
| docKey | `repository_id:branch:path`，协作文档唯一标识 |
| 降级（degraded） | Redis/外部依赖不可用时的显式回退，登记到 `utils.degraded` 供 Admin 展示 |
