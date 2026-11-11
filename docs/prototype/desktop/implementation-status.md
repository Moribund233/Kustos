# Kustos Desktop 实施状态

记录 [desktop-app-design.md](./desktop-app-design.md) 里各里程碑的落地情况。

这份文档只陈述**代码里已经有什么**，不复述设计理由——设计意图看设计文档。每条状态都对应仓库里可查的实现，新增能力时同步更新本页，避免设计与实现对不上之后没人知道以哪个为准。

最后更新：2026-11-11

## 里程碑总览

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 骨架 | ✅ 完成 | Wails v3 工程、loopback bridge、嵌入产物、单实例、窗口状态持久化、三栏外壳 |
| M1 只读 | ✅ 完成 | 实例连接、登录 + Keychain、Inbox、命令面板、通知、托盘、PR 与 Issue 浏览 |
| M2 工作副本 | 🟡 大部分 | 状态、未提交 diff、暂存（含逐 hunk）、提交、fetch、push 已完成；**clone、PR 评审窗未做** |
| M3 编辑器 | 🟡 主体 | 写盘、冲突检测、崩溃恢复、标签页布局恢复、`⌘P`/`⌘S` 已完成；**diff 行标未做** |
| M4 本地智能 | ❌ 未开始 | `internal/lsp/` 为空目录 |
| M5 协作 | ❌ 未开始 | bridge 已预留 `/ws/collab` 白名单，无实现 |
| M6 常驻 | 🟡 部分 | 托盘常驻、关窗收起、多窗口已完成；**深链、自启、自动更新未做** |
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
- 提交与推送失败走居中弹窗：git 的原始输出原样放进可滚动的等宽区域，配一个复制按钮。这类输出常常是多行、带缩进的操作提示，塞在按钮下面既挤断布局又没法复制。

### 编辑器（Code 面）

- 文件树逐层列举，目录在前并带变更标记；文件/符号/变更三段；路径过滤走 `SearchFiles` 并做去抖。
- 标签页可关闭并把焦点落到相邻标签，未保存的带圆点标记。圆点只表示"内容与磁盘不同"：编辑器把外部内容摆上去时也走同一条 `docChanged` 通道，因此同步用的 dispatch 带一个标注，监听器据此区分程序化写入与键盘输入——否则切一次标签就会多一个圆点。
- CodeMirror 6 + 按需加载语言包，语法高亮；`@kustos/editor` 包与 Web 端共用。
- `⌘S` 写盘；磁盘在编辑期间被外部改过时拒绝写入并提示，由用户选择是否覆盖。
- 换行符按文件原样保留：CodeMirror 的文档模型只存 `\n`，读入时记下磁盘用的是 LF 还是 CRLF，保存时再还原回去；判断"改没改"也在归一后比较，避免 CRLF 文件一打开就被当成改过。
- 写盘先写临时文件再改名，保留原文件权限位。
- `⌘P` 快速打开，按路径匹配、键盘选择。
- 崩溃恢复：未保存内容按（工作副本，路径）落到 `buffer_recovery` 表，重开后提示「恢复 / 丢弃」，不自动套用。
- 标签页布局恢复：打开的标签（含顺序）、当前文件与展开的目录落 `ui_state` 的 `code.layout` 一条，切回仓库或重开应用时原位复原。只保一份、记录里带工作副本 id，对不上就整份作废——`ui_state` 没有过期清理，按仓库存会留下永远读不到的记录。写入去抖 400ms，窗口隐藏/关闭时立即落盘。切到空仓库不会清掉上一个仓库的记录。
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
- 七个 surface 中已接真实数据：Inbox、Working copy、Code、Pull requests、Issues。Chat 与 Agent 保持骨架空态。
- 中英双语（i18next），资源与 Web 端独立，键一致性有测试。

### 多窗口与托盘

- **多窗口**：窗口按 `Name` 复用（`main` / `review`），`OpenWindow` 对已存在的窗口只唤到前面，不重复创建。每种窗口各自持有一份几何状态（`window.main` / `window.review`），复用的是既有 `windowstate` 包。
- **评审窗是真正的第二个窗口**：它显示单个 PR，且**没有左轨与列表栏**——打开它是"把某个 PR 拎出来单独看"，再放一层列表只会让人以为能在窗口里切换 PR。PR 编号经 URL 片段（`#/review/42`）随窗口自己走，而不是靠全局状态：多窗口下全局状态由最后写入者胜出，两个评审窗会显示同一个 PR。对已存在的评审窗再次打开另一个 PR 会替换内容并重新导航。
- **关窗语义**：主窗口关闭是收进托盘（`RegisterHook` + `Cancel` + `Hide`），不是退出；退出是托盘菜单里的显式动作。评审窗关闭就是真关闭。这一条必须用 `RegisterHook` 而不是 `OnWindowEvent`——前者在 UI 线程同步执行，`Cancel` 才能挡住 Wails 内建的销毁流程；后者在独立 goroutine 里，拦不住。
- **托盘**：内嵌 PNG 图标（非 PNG 会在 Windows 上静默不显示，有测试守着），菜单为「打开 Kustos / 评审窗 / 退出」，单击图标唤出主窗口。Wails 要求托盘在 `app.Run()` 之后创建，早于事件循环创建则托盘根本不出现。
- **入口令牌按窗口发放**：每个窗口导航时各取一个一次性令牌。只留单个令牌时，后开的窗口会把前一个顶掉，表现为「开第二个窗口，第一个白屏」。
- 窗口里放什么仍由服务端裁决；Go 侧只回答「本机有几个窗口、能不能再开一个」。

### 通知

- 系统通知走 Wails 的 `notifications` 服务：`NotificationService` 暴露申请授权、查询授权与发送三条路径，全部在 Go 侧就位并有单测（含"未接线时明确失败"与"校验不通过不触碰系统通知中心"）。
- 授权只在用户显式点击左轨的通知开关时申请。启动就弹授权请求时，用户还不知道会收到什么，拒绝一次之后系统就很难再让他改回来。
- **通知目前不自动弹**：哪些事件值得打扰用户取决于服务端给出的事实（PR 是否仍待审、Issue 是否指派给我），在本地猜一套判定等于埋一条与服务端漂移的逻辑。发送通道是一条待接通的竖线。

## 未实现

### 缺口（M1–M3 范围内）

- **clone**：只能添加本地已有仓库，不能从远端克隆。
- **PR 评审窗的行内评论**：窗口骨架与单 PR 视图已就绪；行内评论、评审草稿与提交评审未做（动作由服务端裁决，入口仍在 Web）。
- **diff 行标**：编辑器内相对 HEAD 的增删标记。
- **协作感知的界面部分**：后端端点已就绪，`live` 圆点与在线人数预警未接。
- **PR / Issue 的动作**：两个面当前只读。评论、评审、关闭、合并等写操作由服务端权限裁决，入口仍在 Web。
- **通知的自动触发**：发送通道已通，但"什么事件值得弹"要等后端给出待决策语义。

### 未开始的里程碑

- **M4 本地智能**：`internal/lsp/` 是空目录。需要进程池（上限 3、空闲回收、退避重启）、`ws ↔ stdio` 帧转发（注意 LSP 是带 `Content-Length` 的帧协议，不是行协议）、三种语言服务器接入、workspace trust。
- **M5 协作**：文档模式状态机、四步预检、`live` 编辑与远端光标、草稿保存与发布前验证。
- **M6 剩余部分**：离线缓存、通知动作（通知里直接批准）、深链、开机自启、自动更新。托盘常驻与多窗口已完成。
- **M7 深化**：本地搜索索引、Agent 本地复现、设备执行器。

### 发布

签名、三平台打包、CI 矩阵、Linux WebKitGTK 的样式回退，均未开始。

## 已知取舍

- **服务绑定面按实际需要生长，尚未拆到设计文档 §4 的粒度**。设计文档列了 10 个服务，当前有 `SessionService`、`WorkingCopyService`、`WindowService` 与 `NotificationService` 四个；`FileDiff`、`ListChanges`、`ReadText`/`WriteText`、`StageHunk`/`UnstageHunk`、`RemoteInfo`、`OpenInEditor`、`RevealInFileManager`、`LoadCodeLayout`/`SaveCodeLayout` 都挂在 `WorkingCopyService` 上。后续能力变多时再按"用户能感知的本地能力"拆开。
- **窗口后端的接线用包级函数而非服务方法**。绑定生成器会把服务上所有导出方法都变成前端可调用的接口，接线函数一旦是方法，前端就能改写本机的窗口后端。因此 `BindWindowBackend` 是包级函数。
- **Go 侧不做业务判断**。权限与合并策略一律回服务端，Go 只回答"本机是什么状态"。
- **只读与只写单一真相**。磁盘模式下手动保存，不存在"自动保存到远端"的路径；协作模式（M5）会引入第二条路径，届时必须靠模式互斥保证不双写。
- **管理控制台不做**。网关按来源白名单拦掉 `/api/app/`，桌面端出口地址不可控，结构上过不去。
- **mtime 用毫秒而非纳秒**。纳秒时间戳超出 JS 的安全整数范围（`Number.MAX_SAFE_INTEGER`），经绑定层往返会被舍入，导致冲突检测永远失败。已有测试守住这个单位。

## 验证方式

- Go：`go test ./...`（在 `frontend/desktop/go` 下），覆盖 bridge 安全约束（含多窗口入口令牌并存）、git 解析与逐 hunk 暂存、远端关联、写盘冲突、崩溃恢复、标签页布局归一化、窗口状态、窗口种类与托盘语义、评审窗路由与通知校验。
- 前端：`pnpm typecheck` / `pnpm test`（`frontend/desktop/web`、`frontend/packages/editor`）。当前 web 176 个、编辑器包 18 个用例，含 diff 解析、相对时间、PR/Issue 数据层、remote 地址解析、窗口路由、布局还原与换行符归一。
- CI：`.github/workflows/ci.yml` 的 `desktop` job 跑前端 typecheck/单测与 Go 侧不依赖 cgo 的包（`internal/bridge`、`internal/codestate`、`git`、`services`、`store`、`windowstate`、`platform/*`）。Wails 的 `pkg/application` 在 Linux 上需要 GTK/WebKitGTK 头文件，因此 `main`、`internal/app` 与 `singleinstance` 不在 CI 的 Go 覆盖范围内，workflow 注释里写明了原因。
- 端到端：设 `KUSTOS_DESKTOP_CDP_PORT` 后用 CDP 驱动真实 WebView，验证编辑、保存、冲突、崩溃恢复等交互。
