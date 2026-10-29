# Kustos Web

Kustos 的前端。仓库是 bare repo，前端只负责界面与交互，全部业务能力来自后端 API。

它同时是网关镜像的构建输入：`backend/docker-compose.yml` 里 `gateway.build.context`
指向本目录，镜像内用 Node 22 + pnpm 11 构建 `dist`，再交给 OpenResty 托管。

## 技术栈

| 领域        | 选型                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| 基线        | Vite 6 + React 18 + TypeScript（strict）                                  |
| 组件        | shadcn/ui 风格（Radix primitives + CVA + `cn()`），Tailwind CSS v4 做样式 |
| 图标        | lucide-react                                                              |
| 字体        | Fraunces / Inter / JetBrains Mono（自托管 latin 分片）+ MiSans 中文 |
| 路由        | React Router v7（库模式 `createBrowserRouter`，子路由走 `<Outlet/>`）     |
| 服务端状态  | TanStack Query                                                            |
| 客户端状态  | Zustand（仅主题、侧栏折叠这类纯偏好）                                     |
| 国际化      | i18next + react-i18next（zh / en，与后端 `core/i18n.py` 对齐）            |
| 编辑器      | CodeMirror 6（只读浏览、Markdown 编辑、diff），语言包按需加载             |
| 协作        | Yjs + Hocuspocus Provider（对接 `backend/collab-gateway`）                |
| Markdown    | react-markdown + remark-gfm + rehype-sanitize + rehype-highlight          |
| 命令面板    | cmdk（`Ctrl/⌘ + K`）                                                      |
| 表单        | react-hook-form + zod                                                     |
| 图表 / 表格 | recharts / TanStack Table + TanStack Virtual                              |
| 接口类型    | `openapi-typescript` 从后端 OpenAPI 生成 + `openapi-fetch` 运行时         |
| 测试        | Vitest + Testing Library + MSW（单测），Playwright（E2E）                 |

### 字体

西文 webfont 自托管（`@fontsource-variable/*`），只引 latin 片段并带 `unicode-range`。
中文用 MiSans（`misans` 包，小米免费商用授权）：同样是自托管切片，浏览器只下载页面
实际用到的码位区间。中文不用宋体/楷体——那类字体偏古风，和产品的技术感不符；
MiSans 未覆盖的生僻字回退系统黑体（PingFang SC / 微软雅黑 / 思源黑体）。

字体栈定义在 `src/styles/globals.css` 的 `@theme` 里，`src/styles/fonts.css` 声明
`@font-face`。改动时保持「西文在前、中文字体紧随其后」的顺序。

## 目录

```text
frontend/web/
├── components.json          # shadcn CLI 配置（新增组件走 `pnpm dlx shadcn add`）
├── e2e/                     # Playwright 用例（session.ts 桩住认证与读接口）
├── public/brand/            # 品牌 SVG（源自 docs/prototype/assets/brand）
├── scripts/generate-api.mjs # 从后端 OpenAPI 生成类型
├── src/
│   ├── api/schema.d.ts      # 自动生成，勿手改
│   ├── components/
│   │   ├── brand/           # BrandMark：统一取用品牌标记
│   │   ├── layout/          # AppShell / Sidebar / Topbar
│   │   └── ui/              # 基础组件（button/input/dialog/…）
│   ├── features/            # 按后端领域切分，见 features/README.md
│   ├── hooks/               # 跨领域通用 hook
│   ├── lib/
│   │   ├── api/              # openapi client 与查询封装
│   │   ├── query-client.ts
│   │   ├── router.tsx
│   │   └── utils.ts          # cn()
│   ├── pages/               # 路由级页面
│   ├── stores/              # Zustand
│   ├── styles/globals.css   # Tailwind v4 + 设计令牌
│   └── test/                # 测试环境与 MSW
├── package.json
├── pnpm-workspace.yaml      # pnpm 11 的 allowBuilds（esbuild 等必须放行）
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
└── playwright.config.ts
```

## 命令

```bash
pnpm install          # 依赖（pnpm 11；allowBuilds 在 pnpm-workspace.yaml）
pnpm dev              # 开发服务器（默认 5173，/api 代理到后端）
pnpm build            # 类型检查 + 构建，产物在 dist/
pnpm preview          # 预览构建产物
pnpm typecheck        # tsc --noEmit
pnpm lint             # ESLint（flat config）
pnpm format           # Prettier 写回
pnpm test             # Vitest
pnpm test:e2e         # Playwright（需先 `pnpm exec playwright install`）
pnpm api:generate     # 从后端 OpenAPI 重新生成类型
```

## 环境变量

| 变量                  | 作用                                                                          |
| --------------------- | ----------------------------------------------------------------------------- |
| `VITE_API_URL`        | API 基址；**留空 = 与页面同源**（生产经网关访问 `/api/v1`），构建时注入       |
| `VITE_DEV_API_ORIGIN` | 仅开发期：vite 把 `/api` 与 `/ws` 转发到的后端地址（默认 `http://127.0.0.1:8001` 即 `docker-compose.yml` 的 API 直连端口；跑 `docker-compose.dev.yml` 时改为 `8002`） |
| `VITE_DEV_COLLAB_ORIGIN` | 仅开发期：`/ws/collab` 的转发目标，指向 dev nginx（默认 `http://127.0.0.1:8080`） |

## 接口类型

后端契约以 OpenAPI 为准，不手写 DTO：

```bash
# 默认读本地后端
pnpm api:generate
# 或指定地址 / 本地文件
OPENAPI_URL=http://127.0.0.1:8001/openapi.json pnpm api:generate
OPENAPI_FILE=./openapi.json pnpm api:generate
```

产物是 `src/api/schema.d.ts`（`paths` / `components`），配合 `src/lib/api/client.ts` 的
`openapi-fetch` 客户端，调用即有类型：

```ts
const { data } = await api.GET("/api/v1/repositories/{repo_id}/pull-requests", {
  params: { path: { repo_id } },
});
```

后端接口变更后重新生成一次，并把它作为接口契约的落点。

## 样式与设计令牌

`src/styles/globals.css` 里的 `@theme` 与 `docs/prototype/assets/css/tokens.css` 同源：
墨蓝底（`ink-*`）、骨白字（`bone`）、琥珀色只用于注意力与行动（`amber`），
辅助色为 `sage` / `sky` / `rose` / `ember`。

新增样式一律走 Tailwind 工具类与主题变量，不要写死颜色值；组件样式用 `cn()` 合并，
避免与 shadcn 变体冲突。

## 与后端联调

- 开发：`pnpm dev` 时 `/api` 与 `/ws` 都由 vite 代理到 `VITE_DEV_API_ORIGIN`
  （默认后端 dev compose 的 `127.0.0.1:8001`）；`/ws` 必须单独代理，实时通道不走 `/api` 前缀。
- 协作编辑走独立网关：`/ws/collab` 由 `VITE_DEV_COLLAB_ORIGIN` 指向 dev nginx
  （默认 `127.0.0.1:8080`），再转发到 collab 容器；这条规则必须排在 `/ws` 之前。
- 生产：与网关同源，浏览器直接请求 `/api/v1/...`；WebSocket 走同源的 `/ws/`，协作走 `/ws/collab`。

## 网关构建的硬约束

改构建配置前先看 `backend/docker/gateway/Dockerfile`，它对工程有三个硬要求：

1. 产物目录必须是 **`dist`**（镜像里 `COPY --from=web-builder /app/dist`）。
2. 根目录必须同时有 **`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`**；
   `pnpm-workspace.yaml` 里的 `allowBuilds` 决定 esbuild 等依赖能否执行安装脚本，缺了 `pnpm install` 会直接失败。
3. 镜像内是 **Node 22 + pnpm 11**，本地锁文件版本要与之一致。

## 测试

- 单测：Vitest + Testing Library，接口用 MSW mock（`src/test/msw/handlers.ts`）。
- E2E：Playwright，默认跑 `pnpm preview` 起的静态产物（`playwright.config.ts` 里的 `webServer`）。

## 当前状态

十个页面全部接上真实后端：Watch（工作台）、Code、Issues、Pull Request、Releases、
Agent、Chat、仓库设置、Admin 与登录页。页面里没有写死的演示数据，空态一律如实说明缺什么。

实时能力：聊天页走 `/ws/`（`Sec-WebSocket-Protocol` 带令牌），收发消息、表情回应、
输入指示、房间在线状态、断线重连都在 `features/chat/use-room-channel.ts` 里，
REST 与实时帧写同一份 React Query 缓存（合并与去重见 `features/chat/lib/messages.ts`）。
消息附件走 `POST /rooms/{id}/attachments`，上传后以 Markdown 链接插入输入框。

检索：Issue 关键词走 `POST /issues/filter` 的 `search`，房间内消息走
`GET /rooms/{id}/messages?q=`——两者都是后端现成的能力，前端按条件切换数据源。

协作编辑：代码页工具栏「协作编辑」按 `repo:branch:path` 连 Hocuspocus 网关，
读写权限由网关回调 `/collab/auth` 裁决；「保存到分支」发 `collab-save` 让后端
落成一次 Git 提交；「邀请」签发 60 分钟有效的只读/可编辑链接。

品牌：提灯标记、favicon 与 app icon 直接使用 `docs/prototype/assets/brand/` 的原始
SVG（复制到 `public/brand/`），由 `components/brand/brand-mark.tsx` 统一取用，不重绘。

已知缺口：

- **扁平路由**：仓库级页面仍是 `/code`、`/issues` 这类扁平路径，`/:owner/:repo/*`
  尚未落地，当前仓库由 `stores/repo-store.ts` 承担。
- **命令面板**：只有页面与仓库两类条目，PR / Issue / Agent 运行的对象级检索还没有来源。
- **消息编辑**：后端 `PATCH /rooms/{id}/messages/{msg_id}` 已就绪，前端还没有入口。

## 约定

- **路由**：数据路由的子路由由 `<Outlet/>` 承载，`AppShell` 不接 `children`。
- **编辑器**：用 CodeMirror 6 而不是 Monaco——后端 `collab-gateway` 已约定
  `yCollab(ydoc.getText("content"), provider.awareness)`，与 `y-codemirror.next` 对得上。
  共享文本名必须与网关一致（见 `src/lib/collab/client.ts`）。
- **鉴权**：WebSocket 的 token 走 `Sec-WebSocket-Protocol` 握手头，不放 URL query
  （query 会被网关 access_log 记录）。HTTP 请求通过客户端中间件带 `Accept-Language`，
  与后端 `core/i18n.py` 的双语约定对齐。
- **diff**：后端已把 diff 序列化成 `files → hunks → lines` 结构，前端直接消费，
  不自己解析 unified diff 文本。
- **新增 UI 组件**：`pnpm dlx shadcn add <name>` 拉取后需改写为主题令牌
  （`ink-*` / `amber` / `bone`）与 `@/lib/utils` 的 `cn` 导入——CLI 默认模板用的是
  通用 `primary`/`accent` 变量与 `radix-ui` 聚合包，与本项目不兼容。
