# Kustos Desktop Prototype

Wails 桌面端的静态原型。和 [`../web`](../web/README.md) 共用同一套设计语言，但导航、密度与窗口模型按"常驻应用"重做。

![Kustos](../web/assets/brand/kustos-lockup.svg)

## 快速查看

```bash
cd docs/prototype
python -m http.server 8765   # http://127.0.0.1:8765/desktop/index.html
```

零构建、零依赖、不请求后端。所有数据是虚构的。

## 页面

| 页面 | 桌面产品面 | 它想说明什么 |
| --- | --- | --- |
| `index.html` | **Inbox**（主窗口） | 三栏常驻：图标轨、按紧急度分组的队列、详情 + 可折叠检查器。左侧一列是"待我决策"，不是指标仪表盘；右侧详情里直接给出「本地已 checkout、领先 2 个提交」这种 Web 看不到的事实 |
| `working-copy.html` | **Working copy** | Web 完全没有的面：分支与 ahead/behind、暂存/未暂存分组、逐 hunk 暂存、提交框、"这些改动只在本机"的明示 |
| `editor.html` | **Code / 编辑器** | 文件树 + 标签页 + 编辑器 + 检查器（Problems/People）；顶部一枚模式徽标，可在 **Local / Live / Read-only** 之间切换，保存按钮的文案随之改变 |
| `review.html` | **Review**（独立窗口） | 评审窗是第二个窗口，不是主窗口里的一页：左 diff 右讨论，行内评论先落本地草稿，底部常驻"3 条待提交" |
| `windows.html` | **Windows & overlays** | 快速聊天小窗、托盘菜单、全局命令面板。三者都在应用失焦时可用 |

## 可交互的部分

静态原型，但下面几处是真的能点：

- **`⌘K` / `Ctrl+K` 或点标题栏搜索框**：命令面板打开、可输入过滤、`Esc` 关闭
- **editor.html 的模式切换**（Local / Live / Read-only）：徽标文案、保存按钮、模式说明条、按钮禁用态一起变；切到 Live 会提示"预检通过：分支已对齐、本地改动已提交、3 人在线"
- **working-copy.html 的 Stage hunk**：hunk 在已暂存/未暂存之间移动，左侧计数与提交按钮可用态同步更新
- **列表选择、分段控件、标签页、窗口控制按钮**（最小化/关闭会说明"关窗只是收进托盘"）

其余按钮会弹一条说明，指向设计文档里的对应章节——它们是在标注设计意图，不是在模拟功能。

## 和 Web 原型的差异（刻意的）

| 维度 | `web/` | `desktop/` |
| --- | --- | --- |
| 导航 | 侧栏三层 + 顶栏，整页跳转 | 56px 图标轨 + 列表栏 + 详情，选中即换右栏 |
| 上下文面板 | 右缘浮动 Dock，覆盖画布 | 内联可拖拽检查器，宽度记住 |
| 行高 | 44–56px | 28–32px（列表行 30px） |
| 正文字号 | 13.5–15px | 13px |
| 圆角 | 10–14px | 8–10px |
| 装饰 | 全屏径向渐变 + 噪点层 | 只在窗口外桌面上留氛围，窗口内部是干净的表面 |
| 展示字体 | 页面大标题 | 几乎不用（只在窗口外的展示页出现一次） |
| 状态 | 散落在页面里的徽章 | 常驻 24px 状态条：分支、LSP、索引、待发、同步时间 |
| 独有 | — | 工作副本、编辑器模式、多窗口、托盘、命令面板跨应用唤起 |
| 管理面 | `admin.html`（`is_admin` + 网关 ACL） | **没有**，也不做 `is_admin` 分支（见下） |

## 为什么没有管理台

实例级接口 `/api/app/*` 在网关层按 `KUSTOS_ADMIN_ALLOWED_SOURCES` 做来源白名单，后端再过一遍 `get_current_admin_user`。桌面端跑在用户机器上，出口地址不受控，第一层就过不去。

所以图标轨只有七个成员面：Inbox、Working copy、Code、Pull requests、Issues、Chat、Agent。没有第八个，也不做"管理员才显示"的半截入口——按钮在、点了 403，比没有按钮更糟。管理员继续用浏览器在受信网络里访问。设计推理见 `docs/desktop-app-design.md` §6.3.1。

## 三个窗口，一个真相

`editor.html` 顶部那枚徽标是整个原型里最重要的一个控件：

- **Local**：绑定磁盘文件，`⌘S` 写盘，团队看不见
- **Live**：绑定 CRDT 文档，`⌘S` 保存到 `collab/draft-*` 分支，实时可见
- **Read-only**：只观察，别人在改你看得到，但你不能动

同一个文件同一时刻只能处于一种模式。切换要过四步预检（分支对齐、本地改动、草稿领先、在线人数），预检的说明放在检查器底部，而不是弹一个没人读的模态框。完整推理见设计文档 §8。

## 结构

```text
desktop/
├── index.html            # Inbox
├── working-copy.html     # 工作副本与提交
├── editor.html           # 编辑器 + 本地 LSP + 模式切换
├── review.html           # 评审窗（独立窗口）
├── windows.html          # 浮窗 / 托盘 / 命令面板
└── assets/
    ├── brand/            # 标识（与 web 同一套文件）
    ├── css/
    │   ├── tokens.css    # 配色、字体、间距（取自 web，逐字一致）
    │   └── desktop.css   # 窗口壳、图标轨、列表/详情、组件、各 surface
    └── js/
        ├── icons.js      # 内联 SVG sprite（共享）
        ├── util.js       # 转义、复制、时间（共享）
        └── desktop.js    # 标题栏 / 图标轨 / 状态条 / 命令面板 + 交互
```

窗口外壳（标题栏、图标轨、状态条）由 `desktop.js` 注入，页面 HTML 只写内容区，避免五份标题栏各自漂移。页面通过 `body` 上的 `data-*` 描述自己的上下文：

```html
<body data-surface="code" data-mode="local"
      data-branch="feat/collab-cursors" data-ahead="2"
      data-conn="online 46ms" data-lsp="tsserver ready"
      data-outbox="0 pending" data-sync="synced 12s ago">
```

## 不做的部分

原型不模拟：真实 diff 计算、CRDT 同步、LSP 请求、窗口拖拽与吸附、系统通知、托盘徽标。这些在真实实现里有对应的本地服务（见设计文档 §4、§7、§8），在这里只保留它们的**界面语法**——位置、密度、状态表达、失败时说什么。
