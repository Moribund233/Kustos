# Kustos Desktop 实施状态

记录 [desktop-app-design.md](./desktop-app-design.md) 里各里程碑的落地情况。

这份文档只陈述**代码里已经有什么**，不复述设计理由——设计意图看设计文档。每条状态都对应仓库里可查的实现，新增能力时同步更新本页，避免设计与实现对不上之后没人知道以哪个为准。

最后更新：2026-11-12

## 里程碑总览

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 骨架 | ✅ 完成 | Wails v3 工程、loopback bridge、嵌入产物、单实例、窗口状态持久化、三栏外壳 |
| M1 只读 | ✅ 完成 | 实例连接、登录 + Keychain、Inbox、命令面板、通知、托盘、PR 与 Issue 浏览 |
| M2 工作副本 | 🟡 大部分 | 状态、未提交 diff、暂存（含逐 hunk）、提交、fetch、push、PR 评审窗（含行内评论与投票）已完成；**clone 未做** |
| M3 编辑器 | ✅ 完成 | 写盘、冲突检测、崩溃恢复、标签页布局恢复、`⌘P`/`⌘S`、diff 行标已完成 |
| M4 本地智能 | 🟡 走近 | 进程池、`ws ↔ stdio` 转发、workspace trust、四种语言探测与状态条已完成；编辑器里已接 CodeMirror LSP 客户端（诊断、补全、hover、跳定义、重命名、文档符号）；行级 diff 行标与 blame 已完成 |
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
- 相对 HEAD 的读取有三条：`HeadDiff`（`git diff HEAD --`，含已暂存与未暂存）、`HeadText`（`git show HEAD:<path>`，取原文给编辑器逐行比较）、`Blame`（`git blame --line-porcelain`）。`HeadText` 在路径不在 HEAD 里时返回 `Exists=false` 且不报错——新文件在编辑中是常态。
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
- **diff 行标**：编辑器左侧 4px 色条标出相对 HEAD 的新增（sage）、改动（sky）与删除（rose，挂在删除位置之后那一行）。基准取 HEAD 而不是索引——用户的心智基准是上次提交，不是他刚才 stage 过什么。行标与**当前缓冲区**逐行比较（`HeadText` 取 HEAD 原文，`lib/head-diff.ts` 做 LCS 对齐），因此打字时标记跟着实时移动；换成拿文本 diff 对齐，缓冲区一脏就整体错位。纯逻辑可单测，不依赖编辑器。
- **blame 行**：顶栏「Blame」开关，每行显示作者缩写；未提交的行显示 "uncommitted" 并用琥珀色斜体标出。取 `git blame --line-porcelain`（每行都带完整作者信息），时间统一毫秒跨进程边界。开关打开时工具栏下多一条当前光标行的归属：作者、短哈希、提交标题与相对时间。数据随开关懒加载，关掉就不注入 gutter——挂着一条 84px 的空条看起来像界面漏了一块。
- 行标与 blame 都做成 CodeMirror 扩展、经共享包 `@kustos/editor` 的同一个扩展插槽注入：数据不通过 props 传，而是由 React 侧持有一个数据源、编辑器侧订阅后用 `StateEffect` 推进状态。注入的扩展数组保持稳定，编辑器才不会因为重渲染丢掉内部状态。

### 本地智能

- **进程池**（`internal/lsp`）：每个工作区根一个语言服务器进程，上限 3 个、空闲 10 分钟回收、崩溃按 1s / 2s / 4s 退避重启，三次失败后停在 `failed` 并保留最后一次 stderr 尾部作为原因。进程归 Go，协议归前端：池子只管"拉起来、转发帧、盯着退出"，不认识任何 LSP 方法。
- **帧协议**：按 `Content-Length` 头逐帧读写，不是按行切；头长与帧长都有上限（4 KiB / 64 MiB）。stderr 单独抽干到环形缓冲，否则子进程写满管道会自己卡死。
- **`ws ↔ stdio` 转发**：`/lsp/attach?root=<绝对路径>`，走 bridge 的 `/lsp/` 前缀到进程内处理器，不再是反代目标。准入判断在 WebSocket 升级之前完成——握手一旦成功客户端就能发任意 LSP 请求。客户端发裸 JSON 或带帧头的消息都接受。
- **workspace trust**：语言服务器会执行工作区里的代码（解析 import、加载 `package.json`、跑 `go list`），因此首次打开工作副本要先确认一次。信任记在 SQLite 的 `workspace_trust` 表（键是收敛后的绝对路径），未信任时既不启动服务器，编辑器也退回只读、`⌘S` 与保存按钮禁用；撤销信任会顺手停掉正在跑的进程。
- **语言探测**：按仓库根的 marker 文件判定，TypeScript / Python / Go / Rust 四种；服务器不在 PATH 上时只给出安装命令与"重新探测"，不静默下载二进制。
- **状态条**：信任确认、没探测到语言、服务器未安装、启动中、重启中、已停止重试、运行中各自一句话，不把它们合并成"未就绪"——四种状态用户该做的下一步完全不同。
- **编辑器侧**（`lib/lsp-client.ts`）：用 `@codemirror/lsp-client`，自己实现一个 WebSocket `Transport` 与一个 `Workspace` 子类。只有"连上哪个 client + 打开哪个文件"变化时才重建插件，否则每帧重发 `didOpen`/`didClose`。跨文件跳定义要靠 `displayFile`——它把 LSP 的 `file://` URI 换回仓库相对路径、让 Code 面打开那个标签，等编辑器挂载后再把 `EditorView` 交还给客户端（2 秒超时后退回"跳不过去"）。`symbols` 分段取 `textDocument/documentSymbol`，点条目跳到对应行。共享包 `@kustos/editor` 只开一个扩展插槽，不依赖任何 LSP 包：语言服务器连接是桌面专有的。

### 本地存储

SQLite（`modernc.org/sqlite`，纯 Go，无 CGO），迁移共 5 版：

| 版本 | 表 |
| --- | --- |
| v1 | `instances` |
| v2 | `ui_state` |
| v3 | `working_copies` |
| v4 | `buffer_recovery` |
| v5 | `workspace_trust` |

启动期的失败处理：日志落到数据目录的 `desktop.log`，致命错误弹窗说明原因（`KUSTOS_DESKTOP_NO_DIALOG` 可在自动化里关掉）；本地库打开失败先重试，损坏才改名隔离后重建。

### 界面

- 无边框窗口 + 前端自绘标题栏；拖拽区与窗口控制键按 `--wails-non-client-region` 标注。
- 三栏外壳：标题栏（仓库/分支 chip、ahead/behind）、左轨、可拖拽列表栏、状态条。
- 命令面板 `⌘K`：输入过滤、跨组 ↑↓ 游标、`↵` 执行、`Esc` 关闭；标题栏搜索框同入口。只列当下真能执行的动作（七个 surface 跳转、快速打开文件、在外部编辑器中打开当前文件），协作类动作依赖未实现的协作能力，不放入口。
- 七个 surface 中已接真实数据：Inbox、Working copy、Code、Pull requests、Issues。Chat 与 Agent 保持骨架空态。
- 中英双语（i18next），资源与 Web 端独立，键一致性有测试。

### 多窗口与托盘

- **多窗口**：窗口按 `Name` 复用（`main` / `review`），`OpenWindow` 对已存在的窗口只唤到前面，不重复创建。每种窗口各自持有一份几何状态（`window.main` / `window.review`），复用的是既有 `windowstate` 包。
- **评审窗是真正的第二个窗口**：它显示单个 PR，且**没有左轨与列表栏**——打开它是"把某个 PR 拎出来单独看"，再放一层列表只会让人以为能在窗口里切换 PR。PR 定位经 URL 片段（`#/review/<仓库 id>|<编号>`）随窗口自己走，而不是靠全局状态：多窗口下全局状态由最后写入者胜出，两个评审窗会显示同一个 PR。片段里带仓库 id 是因为 PR 编号只在仓库内唯一，只带编号会把 A 仓库的 #3 打开成 B 仓库的 #3；分隔符用 `|` 而非 `/`，因为片段本身按 `/` 切分。对已存在的评审窗再次打开另一个 PR 会替换内容并重新导航。
- **窗口内容由片段决定，且每种窗口都带着自己的片段**：`window-route.ts` 解析片段得到这一屏该渲染什么，`app.tsx` 在会话就绪后按它分流（评审窗不进主界面外壳）。评审窗即使还没有 PR 也带 `#/review`——托盘菜单直接唤出的就是这个状态，缺了片段前端无法把它和主窗口区分开，只会渲染出第二个 Inbox。空态给出"回主窗口选一个 PR"的指引。同窗口内改片段靠 `hashchange` 跟进。
- **评审窗照原型 `docs/prototype/desktop/review.html` 还原**：左侧是 PR 头 + 整份 diff + 草稿条，右侧是 340px 的对话/检查面板，底部是合并闸口。逐文件头带 `+N`/`−N`、状态字母与"已查看"开关（只看本机，不回传）；单栏/双栏可切换，双栏按块把删除行与新增行配对。文件级 `+N`/`−N` 由整份 diff 文本按文件切开后逐段统计——服务端 `files[]` 只给 `{status, path, old_path, status_code}`，没有计数。
- **行内意见挂在"新文件侧行号"上**：提交时后端拿到的就是这个行号。删除行没有新行号，而它的旧行号可能与某个新增行同号（把第 1 行整行替换掉时，`-旧` 的 old = 1、`+新` 的 new = 1），此时锚点归新文件侧那一行，删除行让出——否则一条意见会在两行下面各渲染一次、草稿开出两个输入框。判定在 `diff-anchor.ts`，有回归用例。
- **草稿先落本机再提交**：`POST /reviews` 只收一条 `comment`，多条评审意见无法原子提交，所以草稿攒在本地（localStorage，按实例 + 仓库 + PR 分域），提交时逐条发 `POST /comments`。原型底部那排是"保存草稿 / 提交评审"，这里换成"丢弃草稿 / 提交意见"——草稿产生时就已经落盘，不需要再存一次。投票是独立动作，走 `POST /reviews`；对自己的 PR 投会被服务端以 `pr_self_approve_forbidden` 拒绝。
- **检查面板不编造**：本平台没有 CI，`evaluate_status_checks` 恒真，所以"检查"页只显示"这个实例没有接入 CI"与真实的分支保护规则（是否受保护、是否需要代码评审、是否需要状态检查）。原型里那三行 `build` / `pytest` / `web e2e` 没有数据来源，不照着画。
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
- **协作感知的界面部分**：后端端点已就绪，`live` 圆点与在线人数预警未接。
- **PR / Issue 的动作**：两个列表面当前只读，评论、关闭、合并等写操作仍在 Web。评审窗已有"行内评论 + 投票"两条写路径，见下。
- **通知的自动触发**：发送通道已通，但"什么事件值得弹"要等后端给出待决策语义。

### 未开始的里程碑

- **M4 本地智能（余下部分）**：跨文件跳定义依赖 Code 面能打开目标文件，指向仓库外的位置会安静地不跳。协作模式下的文档同步（`version` 单调、最小 diff 只发变更区间、切模式 `didClose`+`didOpen`）也要等 M5。
- **M5 协作**：文档模式状态机、四步预检、`live` 编辑与远端光标、草稿保存与发布前验证。
- **M6 剩余部分**：离线缓存、通知动作（通知里直接批准）、深链、开机自启、自动更新。托盘常驻与多窗口已完成。
- **M7 深化**：本地搜索索引、Agent 本地复现、设备执行器。

### 发布

签名、三平台打包、CI 矩阵、Linux WebKitGTK 的样式回退，均未开始。

## 已知取舍

- **服务绑定面按实际需要生长，尚未拆到设计文档 §4 的粒度**。设计文档列了 10 个服务，当前有 `SessionService`、`WorkingCopyService`、`WindowService`、`NotificationService` 与 `LSPService` 五个；`FileDiff`、`ListChanges`、`ReadText`/`WriteText`、`StageHunk`/`UnstageHunk`、`RemoteInfo`、`OpenInEditor`、`RevealInFileManager`、`LoadCodeLayout`/`SaveCodeLayout` 都挂在 `WorkingCopyService` 上。后续能力变多时再按"用户能感知的本地能力"拆开。
- **窗口后端的接线用包级函数而非服务方法**。绑定生成器会把服务上所有导出方法都变成前端可调用的接口，接线函数一旦是方法，前端就能改写本机的窗口后端。因此 `BindWindowBackend` 是包级函数。
- **Go 侧不做业务判断**。权限与合并策略一律回服务端，Go 只回答"本机是什么状态"。
- **只读与只写单一真相**。磁盘模式下手动保存，不存在"自动保存到远端"的路径；协作模式（M5）会引入第二条路径，届时必须靠模式互斥保证不双写。
- **workspace trust 只按路径记**。设计文档要求"路径变化、切仓库、远端 origin 变化都要重新确认"，当前只做了路径这一维：信任的主键是收敛后的绝对路径，远端 origin 改了不会让已有信任失效。补这一维需要把 origin 一并存进 `workspace_trust`，属 M4 余下部分。
- **管理控制台不做**。网关按来源白名单拦掉 `/api/app/`，桌面端出口地址不可控，结构上过不去。
- **mtime 用毫秒而非纳秒**。纳秒时间戳超出 JS 的安全整数范围（`Number.MAX_SAFE_INTEGER`），经绑定层往返会被舍入，导致冲突检测永远失败。已有测试守住这个单位。
- **拉子进程一律隐藏控制台窗口**（`internal/platform/noconsole`）。桌面端是 GUI 子系统进程，每次 `exec` 控制台程序都会新建一个窗口；状态轮询与行标刷新频率很高，不隐藏就是连续闪黑框。git、`git apply`、语言服务器、外部编辑器与文件管理器打开都走这一个助手。

## 验证方式

- Go：`go test ./...`（在 `frontend/desktop/go` 下），覆盖 bridge 安全约束（含多窗口入口令牌并存与 `/lsp/` 不外发）、git 解析与逐 hunk 暂存、远端关联、相对 HEAD 的 diff 与文件内容、blame 的 porcelain 解析、写盘冲突、崩溃恢复、标签页布局归一化、窗口状态、窗口种类与托盘语义、评审窗路由、通知校验、LSP 帧编解码与进程池生命周期（含崩溃退避与重试用尽）、子进程隐藏控制台窗口的进程属性。
- 前端：`pnpm typecheck` / `pnpm test`（`frontend/desktop/web`、`frontend/packages/editor`）。当前 web 285 个、编辑器包 18 个用例，含 diff 解析与按文件切分、相对 HEAD 的行标对齐（新增 / 改动 / 删除三态与退化分支）、行内意见锚点、草稿存取、PR 评审数据层、相对时间、PR/Issue 数据层、remote 地址解析、窗口路由（含未选中 PR 的评审窗与旧片段兼容）、布局还原、换行符归一与 `file://` URI 往返。
- CI：`.github/workflows/ci.yml` 的 `desktop` job 跑前端 typecheck/单测与 Go 侧不依赖 cgo 的包（`internal/bridge`、`internal/codestate`、`internal/git`、`internal/lsp`、`internal/services`、`internal/store`、`internal/windowstate`、`internal/platform/*`）。Wails 的 `pkg/application` 在 Linux 上需要 GTK/WebKitGTK 头文件，因此 `main`、`internal/app` 与 `singleinstance` 不在 CI 的 Go 覆盖范围内，workflow 注释里写明了原因。
- 端到端：设 `KUSTOS_DESKTOP_CDP_PORT` 后用 CDP 驱动真实 WebView，验证编辑、保存、冲突、崩溃恢复、信任确认、语言服务器启停与编辑器内的补全 / 跳定义 / 诊断、diff 行标与 blame（含点「允许」后行标不丢），以及评审窗的 diff 渲染、单栏/双栏切换、已查看标记、行内草稿、草稿提交、对话回复与投票拒绝。
