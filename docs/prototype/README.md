# Kustos 原型

两套零构建的静态原型，共用同一套设计语言（夜巡提灯：墨蓝底、骨白字、琥珀只用于注意力与行动），分别对应两种介质：

| 目录 | 介质 | 入口 | 说明 |
| --- | --- | --- | --- |
| [`web/`](web/README.md) | 浏览器 | `web/index.html` | 站点式导航、整页跳转、右缘浮动 Dock。产品面：Watch / Code / Pull / Issues / Agent / Chat / Admin / Login |
| [`desktop/`](desktop/README.md) | Wails 桌面端 | `desktop/index.html` | 三栏常驻、多窗口、状态条、可编辑代码与本地/协作双模式。产品面：Inbox / Working copy / Editor / Review / Windows |

设计依据见 [`docs/desktop-app-design.md`](../desktop-app-design.md)。

## 打开方式

```bash
cd docs/prototype
python -m http.server 8765
```

- Web 原型：<http://127.0.0.1:8765/web/index.html>
- 桌面原型：<http://127.0.0.1:8765/desktop/index.html>

两端都不请求后端，数据全部是虚构的。直接双击 HTML 也能打开；用 HTTP 只是为了避开 `file://` 对剪贴板与 `sessionStorage` 的限制。

## 关系

桌面端**不是** Web 的换皮：字体、色板、圆角、干练的琥珀用法一致，但导航从「站点三层」变成「图标轨 + 列表 + 详情」，行高从 44–56px 压到 28–32px，Dock 面板变成可拖拽内联侧栏，并新增 Web 上不存在的两样东西——本地工作副本与编辑器模式（本地 / 协作 / 只读）。

两套原型各自带一份 `assets/css/tokens.css`。这是刻意的重复：每个目录都要能单独打开，token 的取值以 `web/assets/css/tokens.css` 为准，桌面端只在此基础上追加密度变量。
