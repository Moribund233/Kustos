# Kustos Desktop 实施状态

记录 [desktop-app-design.md](./desktop-app-design.md) 里各里程碑的落地情况。

这份文档只陈述**代码里已经有什么**，不复述设计理由——设计意图看设计文档。每条状态都对应仓库里可查的实现，新增能力时同步更新本页，避免设计与实现对不上之后没人知道以哪个为准。

最后更新：2026-11-10

## 里程碑总览

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 骨架 | ✅ 完成 | Wails v3 工程、loopback bridge、嵌入产物、单实例、窗口状态持久化、三栏外壳 |
| M1 只读 | 🟡 大部分 | 实例连接、登录 + Keychain、Inbox、命令面板已完成；代码浏览已具备但已是可编辑的（M3）；**通知与托盘未做** |
| M2 工作副本 | 🟡 大部分 | 状态、未提交 diff、暂存（含逐 hunk）、提交、fetch、push 已完成；**clone、PR 评审窗未做** |
| M3 编辑器 | 🟡 主体 | 写盘、冲突检测、崩溃恢复、`⌘P`/`⌘S` 已完成；**标签页布局恢复、diff 行标未做** |
| M4 本地智能 | ❌ 未开始 | `internal/lsp/` 为空目录 |
| M5 协作 | ❌ 未开始 | bridge 已预留 `/ws/collab` 白名单，无实现 |
| M6 常驻 | ❌ 未开始 | 无通知、托盘、深链、自启、更新 |
| M7 深化 | ❌ 未开始 | 按需 |

## 已实现

### 传输与会话

- loopback bridge：只绑回环、nonce cookie（HttpOnly + SameSite=Strict）、Host 校验、前缀白名单、显式拒绝 `/api/app/`、不返回 CORS 头、强制覆写 Origin。七条约束都写成了测试。
- 一次性入口令牌：`EntryURL()` 换 cookie 后立即作废，且只在成功时作废。
- Wails IPC 经资产中间件注入 bridge，`/wails/runtime` 走同源校验；未接线时 501 而非 404。
- 实例连接与探活：以 `GET /api/v1/client-compat` 为主判据，根路径仅对老实例兜底且要求响应非 HTML。
- 登录、refresh（全局 single-flight）、登出、实例切换；refresh token 只进系统钥匙串，`Credentials` 结构里不含该字段。

### 本地 Git

- 只用系统 git 可执行文件，不引入 go-git。
- 读取用 `--porcelain=v1 -z` 与 `--numstat -z`，关闭 `core.quotepath` 以支持非 ASCII 路径。
- 状态（分支 / dirty / ahead / behind / 变更列表）、暂存、取消暂存、提交、fetch、push。
- 逐 hunk 暂存与取消暂存：按 hunk 头从当前 diff 切出"文件头 + 单块"的最小 patch，用 `git apply --cached` 写进 index。hunk 头同时充当陈旧性校验——界面列表是快照，重新读到的 diff 里找不到它就报错让界面刷新，不做"就近猜一块"。未跟踪文件与重命名区段明确拒绝并指向整文件暂存。
- 半暂存状态可表达：同一文件可以一半在 index、一半在工作树（porcelain 的 `MM`），`Change.HasUnstaged` 让它在列表两侧都能出现。
- 强制 push 用 `--force-with-lease`，需二次确认并展示完整命令。
- 同一工作树的 git 调用在进程内串行化，避免用户看到 `index.lock exists`。

### 编辑器（Code 面）

- 文件树逐层列举，目录在前并带变更标记；文件/符号/变更三段；路径过滤走 `SearchFiles` 并做去抖。
- 标签页可关闭并把焦点落到相邻标签，未保存的带圆点标记。
- CodeMirror 6 + 按需加载语言包，语法高亮；`@kustos/editor` 包与 Web 端共用。
- `⌘S` 写盘；磁盘在编辑期间被外部改过时拒绝写入并提示，由用户选择是否覆盖。
- 写盘先写临时文件再改名，保留原文件权限位。
- `⌘P` 快速打开，按路径匹配、键盘选择。
- 崩溃恢复：未保存内容按（工作副本，路径）落到 `buffer_recovery` 表，重开后提示「恢复 / 丢弃」，不自动套用。
- 外部编辑器互跳与在文件管理器中定位。

### 本地存储

SQLite（`modernc.org/sqlite`，纯 Go，无 CGO），迁移共 4 版：

| 版本 | 表 |
| --- | --- |
| v1 | `instances` |
| v2 | `ui_state` |
| v3 | `working_copies` |
| v4 | `buffer_recovery` |

启动期的失败处理：日志落到数据目录的 `desktop.log`，致命错误弹窗说明原因（`KUSTOS_DESKTOP_NO_DIALOG` 可在自动化里关掉）；本地库打开失败先重试，损坏才改名隔离后重建。

### 界面

- 无边框窗口 + 前端自绘标题栏；拖拽区与窗口控制键按 `--wails-non-client-region` 标注。
- 三栏外壳：标题栏（仓库/分支 chip、ahead/behind）、左轨、可拖拽列表栏、状态条。
- 命令面板 `⌘K`：输入过滤、跨组 ↑↓ 游标、`↵` 执行、`Esc` 关闭；标题栏搜索框同入口。只列当下真能执行的动作（七个 surface 跳转、快速打开文件、在外部编辑器中打开当前文件），协作类动作依赖未实现的协作能力，不放入口。
- 七个 surface 中已接真实数据：Inbox、Working copy、Code。其余四个保持骨架空态。
- 中英双语（i18next），资源与 Web 端独立，键一致性有测试。

## 未实现

### 缺口（M1–M3 范围内）

- **通知与托盘**：无系统通知、无托盘菜单、无角标。
- **clone**：只能添加本地已有仓库，不能从远端克隆。
- **PR 评审窗**：独立窗口、行内评论、评审草稿均未做。
- **标签页布局恢复**：崩溃恢复只保内容，不保"当时打开了哪些标签"。
- **diff 行标**：编辑器内相对 HEAD 的增删标记。
- **协作感知的界面部分**：后端端点已就绪，`live` 圆点与在线人数预警未接。

### 未开始的里程碑

- **M4 本地智能**：`internal/lsp/` 是空目录。需要进程池（上限 3、空闲回收、退避重启）、`ws ↔ stdio` 帧转发（注意 LSP 是带 `Content-Length` 的帧协议，不是行协议）、三种语言服务器接入、workspace trust。
- **M5 协作**：文档模式状态机、四步预检、`live` 编辑与远端光标、草稿保存与发布前验证。
- **M6 常驻**：离线缓存、通知动作、深链、开机自启、自动更新。
- **M7 深化**：本地搜索索引、Agent 本地复现、设备执行器。

### 发布

签名、三平台打包、CI 矩阵、Linux WebKitGTK 的样式回退，均未开始。

## 已知取舍

- **服务绑定面按实际需要生长，尚未拆到设计文档 §4 的粒度**。设计文档列了 10 个服务，当前只有 `SessionService` 与 `WorkingCopyService` 两个；`FileDiff`、`ListChanges`、`ReadText`/`WriteText`、`StageHunk`/`UnstageHunk`、`OpenInEditor`、`RevealInFileManager` 都挂在 `WorkingCopyService` 上。后续能力变多时再按"用户能感知的本地能力"拆开。
- **Go 侧不做业务判断**。权限与合并策略一律回服务端，Go 只回答"本机是什么状态"。
- **只读与只写单一真相**。磁盘模式下手动保存，不存在"自动保存到远端"的路径；协作模式（M5）会引入第二条路径，届时必须靠模式互斥保证不双写。
- **管理控制台不做**。网关按来源白名单拦掉 `/api/app/`，桌面端出口地址不可控，结构上过不去。
- **mtime 用毫秒而非纳秒**。纳秒时间戳超出 JS 的安全整数范围（`Number.MAX_SAFE_INTEGER`），经绑定层往返会被舍入，导致冲突检测永远失败。已有测试守住这个单位。

## 验证方式

- Go：`task test`（在 `frontend/desktop/go` 下），覆盖 bridge 安全约束、git 解析与逐 hunk 暂存、写盘冲突、崩溃恢复、窗口状态。
- 前端：`pnpm typecheck` / `pnpm test`（`frontend/desktop/web`、`frontend/packages/editor`）。
- 端到端：设 `KUSTOS_DESKTOP_CDP_PORT` 后用 CDP 驱动真实 WebView，验证编辑、保存、冲突、崩溃恢复等交互。
