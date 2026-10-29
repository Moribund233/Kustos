# 11 · 部署与基础设施

> 目标：把容器、端口、卷、网关路由、监控与脚本串成一张可运维的图。

---

## 1. Compose 分层

| 文件 | 作用 | 关系 |
| --- | --- | --- |
| `docker-compose.base.yml` | PostgreSQL + Redis + 共享网络 + `postgres-data` 卷 | 被业务层 `include` |
| `docker-compose.yml` | 业务层：app/agent-worker/collab/git-cgi/gateway/sshd/docker proxies/init/test | include base |
| `docker-compose.dev.yml` | 开发自包含：独立 PG、热重载后端、git-cgi、gateway、collab、proxies | 独立项目 `kustos-dev` |
| `docker-compose.monitoring.yml` | 可选监控栈：Prometheus/Grafana/redis-exporter | 复用业务网络 |

设计意图：**基础设施与业务层分离**，升级业务层不触碰数据库/Redis 卷；监控栈可独立启停。

---

## 2. 生产服务拓扑

| 服务 | 构建 | 端口 | 卷 | 关键环境变量 | 健康检查 |
| --- | --- | --- | --- | --- | --- |
| `postgres` | `pgvector/pgvector:pg16` | 5432 内网 | `postgres-data` | `POSTGRES_USER/PASSWORD/DB` | `pg_isready` |
| `redis` | `redis:7-alpine` | 6379 内网 | 无（`appendonly no`） | `maxmemory 512mb`, `volatile-lru` | `redis-cli ping` |
| `app` | `backend/Dockerfile` | `127.0.0.1:8001→8000` | `repos`, `lfs`, `app-logs` | `DATABASE_URL`, `REDIS_URL`, `KUSTOS_SECURITY_SECRET_KEY`, `KUSTOS_INIT_DATABASE=false`, `KUSTOS_*` | `GET /health` |
| `agent-worker` | 同 app 镜像 | 无 | `repos`, `app-logs` | `DATABASE_URL`, `REDIS_URL`, `KUSTOS_AGENT_*` | 无 |
| `collab` | `docker/collab/Dockerfile`（Node 22 + Hocuspocus） | 4444 / 4445 内网 | 无 | `KUSTOS_APP_URL`, `KUSTOS_COLLAB_INTERNAL_SECRET`, `REDIS_URL` | `GET :4445/` |
| `git-cgi` | `docker/git-cgi/Dockerfile`（Debian + fcgiwrap） | `127.0.0.1:9000` | `repos` | `GIT_PROJECT_ROOT`, `KUSTOS_GIT_HOOK_SECRET` | 无 |
| `sshd` | `docker/ssh/Dockerfile`（Alpine + OpenSSH） | `127.0.0.1:2222` | `repos` | `KUSTOS_GIT_HOOK_SECRET`, `KUSTOS_DB_URL` | 无 |
| `gateway` | `docker/gateway/Dockerfile`（OpenResty + 前端产物） | `${KUSTOS_GATEWAY_PORT:-8000}` | nginx.conf / admin_acl.lua 只读 | `KUSTOS_ADMIN_ALLOWED_SOURCES` | `GET /health` |
| `docker-socket-proxy` | `tecnativa/docker-socket-proxy:0.2.0` | 内网 | `/var/run/docker.sock:ro` | `CONTAINERS=1`, `POST=0` | 无 |
| `docker-write-proxy` | `openresty/openresty` | 内网 | docker.sock:ro + Lua ACL | — | 无 |
| `init`（profile） | app 镜像 | 无 | `app-logs` | `DATABASE_URL`, `KUSTOS_ADMIN_*` | 一次性任务 |
| `test`（profile） | `docker/test/Dockerfile.test` | 无 | 源码/测试/配置挂载只读 | 测试 DB/JWT | 一次性 |
| `prometheus`（可选） | `prom/prometheus:v3.0.1` | `127.0.0.1:9090` | `prometheus-data` | — | 无 |
| `grafana`（可选） | `grafana/grafana:11.4.0` | `127.0.0.1:3000` | `grafana-data` | `GRAFANA_ADMIN_PASSWORD` | 无 |
| `redis-exporter`（可选） | `oliver006/redis_exporter:v1.66.0` | `127.0.0.1:9121` | 无 | `REDIS_ADDR` | 无 |

### 资源限制

| 服务 | limits | reservations |
| --- | --- | --- |
| app | 4 CPU / 2G | 1 CPU / 512M |
| agent-worker | 2 CPU / 1G | 0.5 CPU / 256M |
| collab | 1 CPU / 512M | 0.2 CPU / 128M |
| git-cgi / sshd | 0.5 CPU / 128M / 64M | 0.1 CPU / 32M |
| gateway | 0.5 CPU / 64M | — |
| postgres | 2 CPU / 1G | 0.5 CPU / 256M |
| redis | 0.5 CPU / 640M | — |

### 卷与网络

| 卷 | 内容 | 备份要点 |
| --- | --- | --- |
| `repos` | bare Git 仓库 | 必须与 DB 一起备份（`mgt.sh backup --with-data`） |
| `lfs` | LFS 对象 | 可单独备份 |
| `app-logs` | 按日期 app/error/audit 日志 | 可选 |
| `postgres-data` | 数据库 | `pg_dump` |
| `prometheus-data` / `grafana-data` | 监控数据 | 可选 |

网络：默认 `kustos-network`（`KUSTOS_NETWORK_NAME` 可改）；Docker 内置 DNS，网关用变量 + `resolver 127.0.0.11` 动态解析服务名，容器重启/IP 变化不缓存旧地址。

---

## 3. 网关路由（`docker/gateway/nginx.conf`）

按正则/前缀顺序（**首配即停**）：

| 顺序 | location | 上游 | 说明 |
| --- | --- | --- | --- |
| 1 | `~ ^/api/v1/repositories/[^/]+/lfs/` | app | LFS 对象传输，`2g`，排在通用 API 前 |
| 2 | `~ ^/(owner)/(repo)\.git/info/lfs(/objects)?/batch$` | app `/api/v1/lfs/.../batch` | git-lfs batch；`auth_request off`，由应用按 lfs 动作裁决 |
| 3 | `~ ^/(owner)/(repo)\.git(/.*)?$` | git-cgi FastCGI | Smart HTTP；`auth_request /git-auth`；`2g` |
| 4 | `= /git-auth`（internal） | app `/api/v1/git-auth` | 保留原始 URI/Authorization |
| 5 | `~ ^/ws/collab` | collab:4444 | WS upgrade，读写超时 3600s |
| 6 | `^~ /api/app/` | app | `access_by_lua_file admin_acl.lua` 来源白名单 |
| 7 | `= /grafana` / `^~ /grafana/` | grafana | 子路径 SSO，同 ACL |
| 8 | `^~ /api/v1/git-internal/` | — | 直接 404，封禁公网 |
| 9 | `~ ^/(api\|health\|docs\|openapi.json\|redoc\|ws)` | app | 通用 API/WS |
| 10 | `/assets/` | 静态 | 30d 缓存 |
| 11 | `/` | SPA | `try_files $uri $uri/ /index.html` |

其他：

- CORS 由 `more_set_headers` 统一下发；OPTIONS 直接 204。
- `client_max_body_size`：LFS/Git 2g；其余默认 1m。
- Admin ACL（`admin_acl.lua`）：`KUSTOS_ADMIN_ALLOWED_SOURCES` 支持 IP/IPv4 CIDR，**留空=拒绝一切**。

> 现状提示：gateway 镜像构建上下文为 `../frontend/web`（相对 `backend/`），Dockerfile 位于 `backend/docker/gateway/Dockerfile`；镜像内用 Node 22 + pnpm 11 构建 `dist`，宿主机无需 Node/pnpm。

---

## 4. 镜像构建

### 4.1 后端（`backend/Dockerfile`）

- 多阶段：`python:3.12-slim` builder → runtime；
- 使用 UV + `uv.lock` 导出依赖，不构建项目本身；
- 运行时安装 `git`、`libpq5`；
- 非 root 用户 `kustos`（uid 1000），与 git-cgi/sshd 卷属主对齐；
- 默认 `uvicorn app.main:app --workers 4 --proxy-headers`。

### 4.2 协作网关（`docker/collab/Dockerfile`）

- `node:22-alpine`，`npm ci --omit=dev`；
- 只复制 4 个 `.mjs` 文件；
- `USER node`，暴露 4444/4445，HEALTHCHECK 访问 4445。

### 4.3 Git CGI（`docker/git-cgi/Dockerfile`）

- Debian + `git`、`fcgiwrap`、`spawn-fcgi`；
- entrypoint 生成 `hook.conf`（0600）并启动 4 个 fcgi 子进程绑定 9000。

### 4.4 SSH（`docker/ssh/Dockerfile`）

- Alpine + OpenSSH + git + psycopg2 + curl；
- 创建 uid 1000 `git` 用户；仅公钥认证；`AuthorizedKeysCommand` 查库；`core.hooksPath=/opt/kustos/hooks`。

### 4.5 测试镜像（`docker/test/Dockerfile.test`）

- 基于 `kustos-app:latest`，安装 pytest 栈；
- 源码通过 compose 卷挂载，无需重建。

---

## 5. 监控与可观测性

### 5.1 指标链路

```
app 中间件 → RequestStats / PrometheusMetrics → Redis pipeline（跨 worker 聚合）
/ metrics 端点 → Prometheus 抓取（app:8000/metrics）
redis-exporter → Redis 服务端指标
Grafana → 数据源自动注入（docker/grafana/provisioning）
```

- Prometheus 抓取间隔 15s；目标 `app:8000` 与 `redis-exporter:9121`。
- 应用指标排除 `/health`、`/docs`、`/redoc`、`/openapi.json`、`/metrics`（`scope.should_record`）。
- Admin 概览趋势：`metrics_service` 分钟桶 + `process_metrics` 采样（默认 15s，保留 24h，单次最多 120 点）。

### 5.2 告警规则（`docker/prometheus/alerts.yml`）

| 告警 | 表达式 | 阈值 |
| --- | --- | --- |
| `KustosTargetDown` | `up{job="kustos"} == 0` | 2m, critical |
| `KustosMetricsAbsent` | `absent(kustos_http_requests_total)` | 5m, warning |
| `KustosErrorRateHigh` | 5xx 占比 > 1% | 5m, critical |
| `KustosRequestLatencyHigh` | P95 > 2s | 10m, warning |

### 5.3 错误追踪

Sentry（`KUSTOS_SENTRY_DSN`）：未配置零开销；ASGI 中间件包最外层；`environment` 为空时按 debug 推导。

### 5.4 日志

- 容器日志：json-file，`max-size=50m`，`max-file=3`；
- 应用日志：`app-logs` 卷，按日期分目录，`app.log`/`error.log`/`audit.log`；
- 管理员可通过 `/api/app/logs/*` 与 `/ws/logs` 查看/订阅。

---

## 6. 运维脚本

| 脚本 | 用途 |
| --- | --- |
| `scripts/install.sh` | 一键安装/升级：preflight → `.env` → 镜像 → 基础设施 → init → 业务层 → 可选监控 → 全局 CLI |
| `scripts/mgt.sh` | `start/stop/restart/status/logs/init/backup/restore/upgrade/rollback/reset-admin/doctor/uninstall` |
| `scripts/kustos.sh` | 全局 `kustos` 命令包装（指向 mgt.sh） |
| `scripts/dev-start.sh/.ps1` | 开发环境启动（Docker Compose dev） |
| `scripts/generate_env.py` | 生成/补全 `.env`，随机密钥（URL/shell 安全字符集） |
| `scripts/init_db.py` | 迁移 + 管理员引导（`--check-only` 只读） |
| `scripts/reset_admin.py` | 重设管理员密码 |
| `scripts/security_audit.py` | 安全巡检（依赖/配置/端点） |
| `scripts/validate_pgvector.py` | 校验 pgvector 扩展/列 |
| `scripts/migrate_lfs_layout.py` | LFS 目录布局迁移 |
| `scripts/e2e_git_hook.sh` / `e2e_lfs.sh` | Git hook / LFS 端到端验证 |
| `scripts/smoke_collab.py` / `smoke_init_app.py` | 协作/初始化冒烟 |
| `scripts/verify_api_contract.py` | API 契约校验 |
| `scripts/verify_migration_scratch.py` | 迁移在临时库验证 |

### 备份/升级流程（`mgt.sh`）

```text
backup:  pg_dump → .env/config/version → 可选 repos.tar.gz → tar.gz，保留最近 7 份
restore: 停业务 → 起 PG → psql 恢复 → 可选 .env/repos → 重启
upgrade: 备份 → 构建/拉取 → init 迁移 → 重启
rollback: restore 最近备份 + 重启
```

---

## 7. 安全加固清单

| 面 | 措施 |
| --- | --- |
| 容器 | 非 root（app/collab）、只读 socket proxy、最小镜像 |
| 网关 | Admin IP 白名单（空=拒绝）、内部 hook 路径 404、CORS 统一、HSTS/安全头 |
| 内部回调 | 共享密钥；未配置时端点 503；密钥 0600 |
| Git hook | fail-closed；应用不可达拒绝推送 |
| LFS | 短效 transfer token、oid 白名单、仓库维度存储 |
| 配置 | 引导层键只走 env；密钥 AES-GCM 密文；脱敏返回 |
| 认证 | refresh 轮换/重用检测/family 吊销；撤销位图 |
| Agent | key 不入库；SSRF 白名单；写审批；触发器只读 |
| 数据库 | 仅 PG；SSL 模式可配；连接池上限对齐 |

> 建议修复（现状）：`docker/ssh/authorized_keys_query.py` 硬编码 DSN；`git-shell-wrapper` 使用 `eval`。生产前应改为环境变量读取 + 命令白名单。

---

## 8. 相关文件

- `backend/docker-compose.base.yml`、`docker-compose.yml`、`docker-compose.dev.yml`、`docker-compose.monitoring.yml`
- `backend/Dockerfile`、`backend/docker/**`
- `backend/scripts/**`
- `backend/app/middleware/**`、`services/monitoring_service.py`、`orchestration_service.py`、`grafana_service.py`
