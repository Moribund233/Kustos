# Kustos Web Prototype

高保真、零构建的 Web 前端原型，用于对齐 Kustos 的产品气质与核心交互。所有页面都是静态 HTML/CSS/JS，不依赖后端，也不引入前端框架。

![Kustos](assets/brand/kustos-lockup.svg)

## 快速查看

```bash
cd docs/prototype
python -m http.server 8765
```

打开 <http://127.0.0.1:8765/index.html>。直接双击 `index.html` 也能看，但建议用 HTTP：剪贴板、`sessionStorage` 和跨页 Agent 创建在 `file://` 下可能被浏览器限制。

演示数据、人名、仓库、构建状态和指标全部是虚构的，仅用于原型；页面不会请求 Kustos API。

## 页面

| 页面 | 对应产品面 | 主要内容 |
| --- | --- | --- |
| `index.html` | Watch / 工作台 | 指标条、按类型分组的待办队列、按 owner 分组的仓库列表、Ask Kustos；动态流、在线值守、账户与访问事实浮在右侧面板 |
| `code.html` | 仓库代码浏览 | 全宽编辑器、文件树、分支切换、行内 Agent 评论；符号树、文件事实、单文件提问浮在右侧面板 |
| `pull.html` | Pull Request | 描述、Kustos 评审发现、时间线、diff、行内讨论、评审人、关联 Issue、Checks、合并保护 |
| `issues.html` | Issue 分诊 | 按优先级分组的列表（粘性分组头）、状态与标签筛选、全宽详情（正文 + 活动）；字段与 Kustos triage 浮在右侧面板 |
| `agent.html` | 内置 Agent | 按“待决策/执行中/历史”分组的作业列表、可折叠工具轨迹、流式回答、写工具审批；作业级用量、工具与权限浮在右侧面板 |
| `chat.html` | 仓库频道 + 实时协作 | 仓库→频道两级频道树、DM、消息、@kustos-agent；在线成员、共享文档与显式保存、Agent 状态浮在右侧面板 |
| `admin.html` | 实例管理面（仅管理员） | 实例概览、组件与监控栈、网关 ACL 与用户、配置（来源/重启语义）、Agent 与索引、审计、日志；右侧浮动检查器附「Backed by」接口清单 |
| `login.html` | 登录 | 品牌展示、邮箱密码、OAuth 入口、自托管标记（未认证页不展示实例健康） |

## 关键交互

- **命令面板**：`Ctrl/⌘ + K` 或 `/`，可搜索页面、仓库、PR、Issue、Agent 运行和命令。
- **浮动面板**：每页右缘的 Dock 打开一层上下文（`code` 符号/事实/Agent、`agent` 运行/安全/会话、`chat` 成员/共享文档/Agent、`issues` 字段/分诊、`pull` Review/Checks/Merge、`home` 动态/在线/账户）。点同一图标或 `Esc` 收起，画布恢复全宽。
- **层级导航**：侧栏分三层（Personal → Repository → Repositories，末尾单列 Instance）。当前仓库作为父级，下面嵌一层“你正在看的内容”（Code → 文件、Pull requests → #142、Issues → #94、Chat → #atlas）。
- **工具轨迹**：`agent.html` 中连续的只读工具调用合并为一个可折叠块，标题给出调用数与总耗时，展开才看到逐条工具参数。
- **PR 合并**：在 `pull.html` 点击 `Approve`，e2e 会模拟通过，`Squash and merge` 解锁；确认合并后状态、时间线和保护提示同步更新。
- **Agent 审批**：在 `agent.html` 点击 `Approve`，`create_issue` 被执行，Run A-1042 以 Succeeded 收尾并保留在 Completed 视图；`Reject` 则记录为未写入。
- **新 Run**：顶栏 `New`、页面 `Start a run` 或 `New run` 打开运行弹窗；提交后创建 A-1043，并模拟从 Queued → Running。
- **Issue**：状态/标签/关键词筛选，新建 Issue，发表评论，关闭/重开 Issue。
- **代码浏览**：点击文件树切换文件；分支菜单、符号跳转、Raw 复制、文件过滤、Agent 快速提问。
- **聊天**：发送消息；包含 `@kustos-agent` 时 Bot 会回复；`Follow Mara` 切换跟随；`Save to branch` 模拟显式保存为 commit。
- **通知 / 账号**：右上角通知面板、New 菜单；账号入口统一放在侧栏底部，避免与顶栏头像重复。
- **管理员面**：侧栏 `Instance → Admin console`（仅管理员可见）进入 `admin.html`。左侧分节（Overview / Runtime / Access / Configuration / Capabilities / Audit log / Logs），右侧 Dock 打开检查器、接口清单与守卫说明。`admin.html?as=member` 可查看非管理员撞到 `403` 时的界面。

桌面端优先。900px 以下保留基本可用布局，不追求完整的移动端信息架构。

## 浮动层级

原型的主结构是「一层画布 + 浮在其上的面板」，而不是把页面切成若干并排的列。

1. **画布（L0/L1）占满可用宽度**：代码编辑器、运行时间线、消息流、Issue 正文、PR 讨论、待办队列都是画布本身，不再因为右侧栏而变窄。
2. **面板浮在画布上（L2）**：符号大纲、文件事实、运行上下文、房间成员、Issue 字段、Review/Merge 都收进右侧浮动面板。面板有独立圆角、描边、投影、模糊与顶部高光，视觉上明确高于画布；关闭时画布恢复全宽。
3. **Dock 是入口**：画布右缘有一条 34px 的竖向 Dock，每个图标是一层上下文。点开即浮出面板，再点同一图标或按 `Esc` 收起。窄屏（≤900px）时面板变成底部抽屉，Dock 变成右下角横排。
4. **真覆盖，不重排**：开关面板不改变任何容器宽度，画布元素一格不动（`code/agent/chat/issues/pull/home` 实测宽度变化为 0）。面板直接盖在画布右侧，内容从下方穿过；边缘用渐隐 + 投影区分层次，关闭后画布原样。对话类正文限宽 580–600px，被覆盖的部分只是一行末尾，不影响整段阅读。
5. **局部仍保留分组与层级**：待办按类型、Issue 按优先级、仓库按 owner、活动流按时间段、频道按仓库、Agent 作业按「待决策 / 执行中 / 历史」分组；长文（消息、评论、PR 描述、Agent 回答）统一限制在 68–78ch。

## 管理员面（admin-only）

实例级能力在 Kustos 里是**双层门禁**：网关 `^~ /api/app/` 先按 `KUSTOS_ADMIN_ALLOWED_SOURCES` 做来源白名单（留空即全部拒绝），后端再由 `get_current_admin_user` 校验 `User.is_admin`。因此这些界面不能出现在普通工作台里。

原型按这个口径做了两件事：

1. **从普通页面移除实例级信息**。Overview 原先的「All systems lit 9/9」「Redis 1.2 ms」「索引覆盖率」属于 `app_controller` / `search_admin_controller` 的返回，已替换为个人队列指标（待评审、你的 PR、指派给你的 Issue、未读提及）；页头状态胶囊改为仓库级的 `atlas · 1 check failing`；侧栏不再常驻「服务健康」卡片。
2. **新增管理员控制台**，只放管理员面真正拥有的数据：

| 分节 | 内容 | 对应接口 |
| --- | --- | --- |
| Overview | uptime/版本/schema、RPM·错误率·P95·内存、请求时序、组件汇总、近期特权动作 | `GET /api/app/status`、`/metrics/timeseries`、`/components`、`/audit` |
| Runtime | 13 个 compose 组件的 state/health/镜像/重启、监控栈启停与 Grafana SSO、Redis 探活与降级计数 | `GET /api/app/components`、`/monitoring`、`POST /monitoring/enabled`、`/monitoring/grafana/sso`、`/redis/status`、`/redis/config`、`POST /restart` |
| Access | 网关来源白名单、用户表（全局角色/状态）、授权与禁用 | `GET/PUT /api/v1/users`、`POST /users/{id}/password`、`DELETE /users/{id}`；ACL 为环境变量，无写入 API |
| Configuration | 分节键值、`env > db > default` 来源、hot/restart 语义、受保护键 | `GET/POST /api/app/config`、`/config/validate`、`/config/reset`；Agent / Search 走各自的 versioned PUT |
| Capabilities | Agent 开关·模型·密钥状态·用量·工具调用；索引逐仓同步状态 | `GET /api/app/agent/config` · `key-status` · `usage`、`POST /test-connection`、`GET /api/app/search/index-overview` |
| Audit log | HTTP 审计 + `activities` 合并，按来源/方法/敏感/关键词过滤 | `GET /api/app/audit` |
| Logs | app / error / audit 文件、级别过滤、实时 tail、清理保留期 | `GET /api/app/logs`、`/logs/content`、`POST /logs/cleanup`、`WS /ws/logs` |

设计上刻意保留的边界：

- **全局管理员 ≠ 仓库角色**。`User.is_admin` 只决定实例面；`owner / admin / developer / readonly` 是仓库侧的角色（owner 由 `Repository.owner_id` 决定，其余在成员行），两者互不推导。用户面板里明确写了这一点。
- **env 锁定的键不给输入框**。`env` 覆盖数据库行，所以这类键只显示锁和值；假装可编辑会让人以为保存后就生效。
- **危险操作要过确认**。重启/关机/监控启停/删除用户都走确认弹窗，并说明影响面（所有 worker、会话中断、只影响监控栈等）。
- **降级要写出来**：Docker socket 不可用时 `available=false`、监控栈从未部署时启停返回 `409`、索引落后时标 `in sync` 还是 `2 commits behind`，都不隐藏。
- **面板不盖页头**：管理台的浮动检查器从页头下方开始（`--admin-panel-top` 随页头高度计算），Dock 仍在画布右缘；画布内部滚动，底部渐隐提示还有内容。

## 设计方向

**夜巡提灯（Night Watch）**：深墨蓝黑的工作台，骨白文字，琥珀色只用于注意力和行动。不是“紫色渐变 SaaS”，也不是终端复刻；它更像夜间值守者的桌面：安静、精确、有温度。

| 角色 | Token / 选择 |
| --- | --- |
| 页面底色 | `#080d10` / `#0a1115` |
| 抬升表面 | `#111c22` / `#15232a` |
| 正文 | `#f0e7d8`（bone） |
| 次要文字 | `#9aa5a7` / `#758185` |
| 注意力 / 行动 | `#f2ae5b`（lantern amber） |
| 成功 / 健康 | `#86b79e`（sage） |
| 危险 / 阻塞 | `#d98282`（rose） |
| 信息 / 链接 | `#83a9c4`（slate sky） |
| 展示字体 | Fraunces |
| 界面字体 | Inter |
| 代码字体 | JetBrains Mono |

排版用衬线展示字体承担“人的温度”，界面和代码保持工具感；琥珀色不铺满，只出现在活动导航、Agent、审批门禁和主行动上。交互上只保留一个明确的加载/展开节奏和少量状态动效，尊重 `prefers-reduced-motion`。

## Logo

`assets/brand/`：

- `kustos-mark.svg` — 深色背景用透明标识。
- `kustos-mark-ink.svg` — 浅色背景用深色描边版本。
- `kustos-app-icon.svg` — 512×512 应用图标。
- `favicon.svg` — 浏览器图标。
- `kustos-lockup.svg` — 深色品牌锁版，含字标和副标题。

图形是一盏**提灯/拱门**：拱形框架同时像守夜人的门，内部火焰是光源，底部两个小节点暗合 Git 提交图。整体在 24px 下仍能读出“灯”的轮廓，不需要依赖字标。

使用建议：保留至少 1/4 图形高度的留白；火焰保持琥珀渐变，不改成纯色；深色底用 `kustos-mark.svg`，浅色底用 `kustos-mark-ink.svg`；不要拉伸、描边加粗或给整个标识加投影。

## 文件结构

```text
docs/prototype/
├── index.html / code.html / pull.html / issues.html / agent.html / chat.html / admin.html / login.html
├── README.md
└── assets/
    ├── brand/                 # SVG 标识、图标、锁版
    ├── css/
    │   ├── tokens.css         # 颜色、字体、间距、圆角、动效
    │   ├── base.css           # reset、排版、应用壳、侧栏、顶栏
    │   ├── components.css     # 按钮、表单、徽章、popover、palette、modal、toast
    │   ├── home.css / code.css / pull.css / issues.css / agent.css / chat.css / admin.css / login.css
    │   └── responsive.css     # 结构性断点
    └── js/
        ├── icons.js           # 内联 SVG sprite
        ├── util.js            # 转义、Python 高亮、复制、时间
        ├── shell.js           # 侧栏/顶栏、命令面板、通知、弹窗、toast、新 Run
        ├── home.js / code.js / pull.js / issues.js / agent.js / chat.js / admin.js / login.js
        └── *-data.js          # 页面级虚构数据（代码、Issue、Agent Run、管理面）
```

## 与后端能力对照

原型中的界面动作对应 Kustos 现有领域，而不是发明新能力：

| 原型动作 | 对应领域 / 控制器 |
| --- | --- |
| 代码树、文件、分支、符号 | `repository_browser_controller`、`branch_controller`、`search_controller` |
| PR diff、Review、Checks、合并 | `pull_request_controller`、`build_controller`、`enforce_merge_protection` |
| Issue 列表/详情/评论/标签 | `issue_controller`、`label_controller` |
| Agent 运行、步骤、审批、取消 | `agent_controller`、`agent_service`、`agent/runtime` |
| 聊天、频道、在线、@bot | `room_controller`、`chat_controller`、`realtime/presence_service`、`agent/chat_bridge` |
| 共享文档、邀请、显式保存 | `collab-gateway`、`collab_internal_controller`、`collab_invite_controller` |
| 登录、OAuth、账号 | `auth_controller`、`oauth_controller`、`user_controller` |
| 实例状态、组件、监控、Redis | `app_controller`、`orchestration_service`、`monitoring_service`、`grafana_service`、`redis_admin_service` |
| 配置、审计、日志 | `app_controller`（`/api/app/config`、`/audit`、`/logs`）、`core/config_schema` |
| Agent / 索引管理 | `agent_admin_controller`、`search_admin_controller` |

原型刻意保留了几个产品事实：Agent 写工具必须人工审批；触发器和只读运行没有写权限；协作编辑只有显式保存才落 Git；PR 合并不绕过分支保护；搜索索引不足时界面应明确降级，而不是假装语义检索成功。

## 已验证

- Chromium 实渲染：1440 / 1100 / 900 px 三档视口逐页检查（8 个页面），无横向溢出。
- 面板高度随视口收敛：`code / issues / agent / chat` 均为“视口高 - 顶栏/头部”的单屏工作区，页面本身不产生多余滚动。
- Lighthouse：Accessibility 100 / Best Practices 100 / SEO 100。
- 交互跑通：命令面板跳转、PR 审批→合并、Agent 审批、Issue 评论/新建、代码文件切换/分支菜单、Chat 发送与 @bot、登录跳转、通知/账号菜单。
- 无控制台错误；命令面板、PR 审批→合并、Agent 审批（含只读 trigger 运行）、Issue 筛选/切换、代码文件切换与符号树、Chat 发送、管理台分节切换/配置保存/审计过滤/监控启停/角色变更均有自动化回归脚本跑过（脚本本身不随产物保留）。

## 不在本次范围

完整 Release/Settings 页、真实代码编辑器、真实 WebSocket/CRDT、后端联调、生产级移动端布局。管理台里的重启、关机、日志清理、监控启停、用户删除只做到「确认 + 反馈」，不会真的改变运行状态；ACL 编辑也只改内存并提示需要网关 reload。这些入口以 toast 或占位说明处理，避免伪装成已实现功能。
