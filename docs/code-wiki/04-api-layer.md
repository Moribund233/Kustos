# 04 · API 层

> 目标：说明路由如何注册、请求如何鉴权、控制器如何划分、错误如何表达、WebSocket 如何工作。

---

## 1. 路由装配

### 1.1 前缀常量

`backend/app/api/prefixes.py` 是**无副作用**的前缀定义模块（打破循环导入）：

```python
API_V1_PREFIX = "/api/v1"
ROUTES = {
    "root": "",
    "auth": "/api/v1/auth",
    "users": "/api/v1/users",
    "repositories": "/api/v1/repositories",
    ...
    "websocket": "/ws",
    "error": "/api/v1/errors",
}
```

控制器一律 `prefix=get_route_prefix("xxx")`，不反向 import `api/router.py`。

### 1.2 注册顺序

`backend/app/api/router.py:create_api_router()` 顺序（有冲突风险的路由先注册）：

1. `app_controller`（`/`、`/health`、`/api/app/*`）
2. `agent_admin_controller`、`search_admin_controller`（`/api/app/agent|search/*`）
3. `repository_browser_controller`（`/repositories`，router 级读守卫）
4. `auth_controller` → `git_auth_controller` → `collab_internal_controller` → `git_hook_controller` → `oauth_controller`
5. 用户 / 成员 / Fork / Star / Watch / 协作邀请 / 协作会话 / 标签 / 文件评论 / LFS
6. 分支 / 提交 / Tag / PR / PR Label / Release / Issue
7. SSH Key / Webhook / Stats / Activity / Notification / Room / DM / Chat / Search / Agent / Build
8. `repository_controller`（最后，避免历史通配冲突）+ `path_router`（`/api/v1/repo/{owner}/{repo}`）
9. Debug / Error / WebSocket

> `tests/test_route_order_guard.py` 断言全量路由不被前面的通配路由遮蔽。

### 1.3 路由规模

39 个控制器、约 250+ 条路由声明。完整 OpenAPI 以运行实例 `/docs` / `/openapi.json` 为准。

---

## 2. 认证与权限

### 2.1 JWT 认证

`backend/app/api/deps.py`：

| 依赖 | 行为 |
| --- | --- |
| `get_current_user` | 必须有 `Authorization: Bearer`；校验 access token、撤销、用户存在且 `is_active`；否则 401 |
| `get_optional_user` | 无头 → `None`（匿名）；有头但无效 → 401（不静默降级） |
| `get_current_admin_user` | 在 `get_current_user` 之上要求 `is_admin`，否则 403 |

Token 由 `token_service` 签发：

- access（默认 30min）与 refresh（默认 7d）分离；
- refresh 轮换 + 重用检测：宽限期内重放放行（多标签页），超宽限触发 family 吊销；
- `revoked_tokens` 审计行 + Redis/内存撤销位图（启动回填、正/负缓存）；
- 登出撤销当前 access、可选 refresh，并吊销整个 family。

### 2.2 仓库权限矩阵

`backend/app/core/permissions.py` 是**唯一裁决点**。

**操作（Action）→ 允许角色**

| Action | owner | admin | developer | readonly |
| --- | --- | --- | --- | --- |
| `repo:read` | ✓ | ✓ | ✓ | ✓ |
| `repo:write` | ✓ | ✓ | ✓ | — |
| `repo:admin` | ✓ | ✓ | — | — |
| `repo:owner` | ✓ | — | — | — |
| `member:read` | ✓ | ✓ | ✓ | ✓ |
| `member:manage` | ✓ | ✓ | — | — |
| `label:manage` / `prlabel:manage` | ✓ | ✓ | — | — |
| `release:manage` | ✓ | ✓ | — | — |
| `webhook:read` / `webhook:manage` | ✓ | ✓ | — | — |
| `collab:read` | ✓ | ✓ | ✓ | ✓ |
| `collab:write` | ✓ | ✓ | ✓ | — |
| `collab:manage` / `invite:manage` | ✓ | ✓ | — | — |
| `invite:issue` | ✓ | ✓ | ✓ | ✓ |
| `pr:merge` | ✓ | ✓ | ✓ | — |
| `fork:read` / `file-comment:read` | ✓ | ✓ | ✓ | ✓ |
| `issue:create` / `pr:create` / `comment:create` | ✓* | ✓* | ✓* | ✓* |
| `agent:write` | ✓ | ✓ | ✓ | — |
| `lfs:read` | ✓ | ✓ | ✓ | ✓ |
| `lfs:write` | ✓ | ✓ | ✓ | — |

> `✓*` = 参与型 Action（`PUBLIC_PARTICIPATE_ACTIONS`）：私仓要求活跃成员（四个角色都算），公开仓只要登录即可，无需成员身份。

**裁决顺序**（`has_repo_action`）：

1. 全局 `User.is_admin` 放行；
2. 公开仓 + 参与型 Action 放行；
3. `repo.owner_id == user_id` 视为 owner；
4. 活跃 `RepositoryMember.role` 命中矩阵（`viewer` → `readonly` 归一）。

**依赖工厂**

| 工厂 | 语义 |
| --- | --- |
| `require_repo_read()` | router 级读守卫：缺仓 404 → 公开放行 → 私仓匿名 401 → 非成员 403 |
| `require_repo_permission(Action.XXX)` | 写操作：缺仓 404 → 匿名 401 → 矩阵 403 |
| `require_repo_action(Action.XXX)` | 路径参数 `repo_id` + 登录用户，缺仓直接 403（兼容旧路径） |

### 2.3 内部回调鉴权

| 端点 | 调用方 | 鉴权 |
| --- | --- | --- |
| `POST /api/v1/git-auth` | Nginx `auth_request` | 解析 Git URI + Bearer/Basic；按 `repo:read/write` 裁决；返回 200/401/403/404 |
| `POST /api/v1/git-internal/pre-receive` | git/ssh hooks | `X-Git-Hook-Secret == KUSTOS_GIT_HOOK_SECRET`（网关封禁公网访问） |
| `POST /api/v1/git-internal/post-receive` | git/ssh hooks | 同上 |
| `POST /api/v1/collab/auth` | collab-gateway | `X-Collab-Internal-Secret` + 用户 token + docKey 权限 |
| `GET /api/v1/collab/doc` | collab-gateway | 内部密钥 |
| `POST /api/v1/collab/save` | collab-gateway | 内部密钥 + 实时写权限 + 邀请/覆盖校验 |

内部密钥未配置时，相关端点整体 503（安全默认）。

---

## 3. 控制器清单

> 前缀均省略 `/api/v1`；`/api/app/*` 为管理面。端点数为路由装饰器静态计数，可能含多个 router。

### 3.1 管理面

| 控制器 | 前缀/范围 | 端点数 | 职责 | 守卫 |
| --- | --- | --- | --- | --- |
| `app_controller` | `/`、`/health`、`/api/app/*`、`/api/v1/stats/platform` | 22 | 配置、debug、状态、指标时序、关机/重启、日志、审计、编排组件、监控、Grafana SSO、Redis | `check_app_permission` / `check_app_danger_permission` / `get_current_admin_user` |
| `agent_admin_controller` | `/api/app/agent/*` | 7 | Agent 启用/配置/凭据/用量/触发器管理 | admin/debug |
| `search_admin_controller` | `/api/app/search/*` | 3 | 搜索状态、索引维护、embedding 凭据 | admin/debug |
| `debug_controller` | `/api/v1/debug` | 3 | 仅 debug 模式可用 | debug |

### 3.2 仓库域

| 控制器 | 端点数 | 主要端点 | 守卫 |
| --- | --- | --- | --- |
| `repository_controller` | 11 + 1 | `GET/POST /repositories`、`GET /public`、`GET /user/{id}`、`GET/PUT/DELETE /{repo_id}`、`/access`、`/archive`、`/unarchive`、`GET /repo/{owner}/{repo}` | 读守卫 + Action |
| `repository_browser_controller` | 13 | 文件树/blob/commits/diff/blame/commit-graph/compare/readme/symbols/language/文件写入/删除/移动 | router 级 `require_repo_read()` + 写 Action |
| `repository_member_controller` | 9 | 成员列表/添加/更新/移除/转移所有权 | `MEMBER_READ/MANAGE` |
| `fork_controller` | 4 | Fork、Fork 列表、源仓库 | `FORK_SOURCE_READ` |
| `star_controller` / `watch_controller` | 4 / 4 | Star/取消、Watch/取消、列表 | 登录 |
| `collab_invite_controller` | 2 | 创建/撤销协作邀请 | `INVITE_MANAGE` |
| `collab_session_controller` | 2 | 会话权限覆盖/踢人 | `COLLAB_MANAGE` |
| `label_controller` | 6 | 仓库标签 CRUD | `LABEL_MANAGE` |
| `file_comment_controller` | 4 | 行内评论 CRUD/回复 | 读/作者或管理员 |
| `lfs_controller` | 6 + 1 | batch、upload、download、verify、delete | batch 用户凭证 + transfer token |
| `branch_controller` | 10 | 分支 CRUD、保护设置、合并检查 | 读 + `repo:write/admin` |
| `commit_controller` | 9 | 提交列表/详情/diff/文件/评论 | 读 |
| `tag_controller` | 4 | 标签列表/创建/删除/详情 | 写 |
| `pull_request_controller` | 17 | CRUD、close、merge、comments、reviews、diff、关联 Issue、评审请求 | 读/写 + `PR_MERGE`；关联/请求限作者或仓库管理员 |
| `pr_label_controller` | 7 | PR 标签定义/绑定 | `PRLABEL_MANAGE` |
| `release_controller` | 10 | Release CRUD、发布、附件上传/下载 | `RELEASE_MANAGE` |
| `issue_controller` | 17 | CRUD、批量关闭/重开/更新/加/移标签、评论、关联 PR | 参与型/写 |
| `build_controller` | 5 | 构建列表/详情/日志/状态回调（CI secret） | 读 + CI secret/用户 token |
| `webhook_controller` | 8 | CRUD、测试投递、投递历史 | `WEBHOOK_READ/MANAGE` |
| `stats_controller` | 1 | 仓库统计 | 读 |
| `activity_controller` | 1 | Activity 列表 | 读 |
| `search_controller` | 5 + 2 | 代码搜索、定义/引用、索引状态、重建；跨仓全局搜索 | 读 |
| `agent_controller` | 7 | 作业创建/列表/详情/步骤/取消/批准/拒绝 | 仓库读 + Agent 开关/配额 |

### 3.3 用户与实时

| 控制器 | 端点数 | 职责 |
| --- | --- | --- |
| `user_controller` | 16 | 注册、当前用户、用户列表/详情、资料/头像/密码、管理员用户管理 |
| `auth_controller` | 3 | 登录、刷新、登出 |
| `oauth_controller` | 4 + 账号路由 | GitHub/GitLab 授权、回调、账号列表/解绑 |
| `key_controller` | 3 | SSH Key 列表/添加/删除 |
| `notification_controller` | 8 | 列表、未读数、已读、全部已读、删除、偏好 |
| `room_controller` | 7 | 房间列表/详情/成员/加入/静音/未读 |
| `dm_controller` | 2 | 私聊会话创建/列表 |
| `chat_controller` | 7 | 消息列表/发送/搜索/编辑/删除/反应 |
| `error` | 3 | 错误契约演示/诊断 |
| `git_auth_controller` | 1 | Nginx Git 鉴权子请求 |
| `git_hook_controller` | 2 | pre/post-receive 内部回调 |
| `collab_internal_controller` | 3 | 协作网关内部回调 |

---

## 4. 中间件链

`create_app` 中 `add_middleware` 的添加顺序 = **由内到外**：

| 顺序 | 中间件 | 职责 | 失败语义 |
| --- | --- | --- | --- |
| 1（最内） | `ConcurrencyMiddleware` | 进程内信号量准入 + 可选 Redis 全局并发；超时返回有界 503 | 保护 DB/内存 |
| 2 | `AuditLoggerMiddleware` | 请求审计、敏感路径/方法标记、敏感字段过滤 | 记录失败不影响请求 |
| 3（最外） | `ObservabilityMiddleware` | 安全响应头（HSTS 等）+ 慢请求告警 + 统计/Prometheus 单一记录点 | 记录失败仅告警 |
| 4（ASGI 最外） | `sentry_middleware` | 捕获所有请求异常 | DSN 为空时零开销 |

补充：

- **并发上限** `ConcurrencySettings.from_database()` 保证 `max_concurrent ≤ pool_size + max_overflow`，避免先触发 `pool_timeout`。
- **记录范围** 由 `middleware/scope.should_record` 统一裁决，`/metrics` 与请求统计同口径。
- **指标记录有 0.5s 隔离上限**（`RECORD_TIMEOUT_SECONDS`），指标面卡死不影响响应。
- **在途计数在 `finally` 归还**，避免取消路径泄漏。

---

## 5. 错误契约与国际化

### 5.1 响应结构

```json
{
  "detail": "Repository not found",
  "error": {
    "code": 404,
    "message": "Repository not found",
    "type": "NotFoundException",   // 非 debug 时为 "Error"
    "error_code": "repository_not_found"
  }
}
```

- `detail` 为人类可读消息；`error.error_code` 为稳定业务码，前端按码分支。
- `Accept-Language` 命中时，`error_code` 经 `core/i18n` 翻译 `detail`；无翻译则回退原 `detail`。
- 401 自动携带 `WWW-Authenticate: Bearer`；429 可带 `Retry-After`。

### 5.2 异常类

`core/exception.py` 中所有自定义异常继承 `fastapi.HTTPException`：

| 异常 | 状态码 |
| --- | --- |
| `ValidationException` | 400 |
| `AuthenticationException` | 401 + WWW-Authenticate |
| `AuthorizationException` | 403 |
| `NotFoundException` | 404 |
| `ConflictException` | 409 |
| `RateLimitException` | 429 + Retry-After |
| `HttpStatusException` | 任意（413/415/501/503 等） |
| `DatabaseException` / `FileException` | 500 |
| 仓库浏览子类 | 404/400 |

日志分级：4xx 为预期业务拒绝 → WARNING 单行无堆栈；5xx → ERROR + 完整堆栈。

---

## 6. WebSocket

### 6.1 端点与认证

| 端点 | 认证 | 说明 |
| --- | --- | --- |
| `/ws/` | JWT（握手头 `Sec-WebSocket-Protocol: kustos-bearer, <jwt>`） | 主通道：仓库/房间订阅、聊天、通知、进度、同步 |
| `/ws/logs` | JWT + `is_admin` | 实时日志；非管理员 1008 关闭 |
| `/ws/collab`（Nginx） | `collab-gateway` 认证 | Yjs 协作，不经过 FastAPI WS |

> Token 不放 URL query（避免被 access_log 记录）；query token 仅兼容已废弃行为。

### 6.2 连接管理

`api/ws/manager.py`：

- `Connection`：websocket、user_id/username、`repository_ids`、`rooms`、last_ping、metadata。
- `ConnectionManager`（单例）：连接表 + 用户/仓库/房间三类索引；心跳超时清理；`send_to_user` / `send_to_room` / `broadcast`。
- 心跳超时读 `[realtime] ws_heartbeat_timeout_seconds`（默认 120s；0 关闭）。
- 单条消息上限 `[realtime] ws_max_message_bytes`（默认 256KB）。
- **跨 worker**：`utils/realtime_bus` 采用本地直投 + Redis publish，订阅端跳过 `origin`，保证每连接恰好一次；Redis 不可用退化为进程内。

### 6.3 事件类型（常见）

| 方向 | type | 说明 |
| --- | --- | --- |
| C→S | `subscribe` / `unsubscribe` | 订阅仓库/房间/通知 |
| C→S | `room_join` / `room_leave` / `presence_list` | 房间与在线状态 |
| C→S | `chat_message` / `chat_typing` / `chat_reaction` | 聊天 |
| C→S | `progress_update` / `progress_query` | 长任务进度 |
| C→S | `sync_request` / `sync_status` | 仓库同步 |
| C→S | `subscribe_logs` / `unsubscribe_logs` / `get_log_stats` | 管理员日志 |
| S→C | `connected` / `pong` / `system` | 连接与心跳 |
| S→C | `notification` / `unread_count` | 通知 |
| S→C | `chat_message` / `chat_typing` / `presence_list` | 聊天与在线 |
| S→C | `agent_step` / `agent_stream` | Agent 步骤/打字机 |
| S→C | `progress` / `operation_completed` / `operation_failed` | 进度 |
| S→C | `log` | 日志流 |

---

## 7. 分页与列表契约

`core/constants.py` 定义跨控制器统一口径：

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `DEFAULT_PAGE` | 1 | 页码 |
| `DEFAULT_PAGE_SIZE` | 20 | 通用列表 |
| `MAX_PAGE_SIZE` | 100 | 通用上限 |
| `DEFAULT_PAGE_SIZE_LARGE` | 50 | 提交/消息/构建 |
| `MAX_PAGE_SIZE_MAX` | 1000 | 宽上限批量 |
| `AUDIT_DEFAULT/MAX_PAGE_SIZE` | 20 / 200 | 审计 |
| `LOG_DEFAULT/MAX_LINES` | 100 / 5000 | 日志 |

`utils/db_utils.paginate` 与 `response_builder.build_pagination_response` 返回 `items/total/page/limit/pages/has_next/has_prev`。

---

## 8. 相关源码

- `backend/app/api/router.py`、`api/prefixes.py`、`api/deps.py`
- `backend/app/core/permissions.py`
- `backend/app/core/exception.py`、`utils/exception_handler.py`、`core/i18n.py`
- `backend/app/middleware/*`
- `backend/app/api/ws/*`
- `backend/app/api/v1/*_controller.py`
- `backend/tests/test_route_order_guard.py`、`test_controller_auth.py`、`test_permission_matrix.py`
