# syntax=docker/dockerfile:1
# =============================================================================
# Kustos 网关镜像：OpenResty + 内嵌 Web 构建产物
#
# 多阶段构建，宿主机无需 Node/pnpm（一键部署/升级只依赖 Docker）:
#   1. web-builder : Node 容器内构建 frontend/web（pnpm install + build）
#   2. runtime     : OpenResty 运行时 + 将 dist 复制到 /var/www/kustos-web
#
# 构建上下文是**仓库根**（见 docker-compose.yml gateway.build.context）：
# 前端已改为 pnpm workspace，`pnpm-workspace.yaml` 与 `pnpm-lock.yaml` 在根，
# 共享包 `frontend/packages/*` 也在根下。只把 frontend/web 当上下文会拿不到
# 这些文件，`pnpm install` 直接失败。
#
# 上下文变大后靠 .dockerignore 收敛：根 .dockerignore 已排除 backend/、
# node_modules/、dist/ 等无关目录。
# nginx.conf 仍由 compose 只读挂载，便于按环境调整；镜像本身不内嵌配置。
# =============================================================================

FROM node:22-alpine AS web-builder
WORKDIR /app
# 国内网络：pnpm 会按 package.json 的 packageManager 字段自取指定版本，
# 默认指向 npmjs.org 会直接失败；与其他镜像一致统一走镜像源
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
RUN npm install -g pnpm@11

# 先只复制清单文件，让依赖层可缓存：
# - 根清单：workspace 定义（含 allowBuilds，缺它 pnpm install 会因 esbuild
#   安装脚本被忽略而退出 1）
# - web 与各共享包的清单：workspace 解析需要它们同时存在
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json* ./
COPY frontend/web/package.json ./frontend/web/
COPY frontend/packages/api/package.json ./frontend/packages/api/
COPY frontend/packages/design/package.json ./frontend/packages/design/
COPY frontend/packages/ui/package.json ./frontend/packages/ui/
RUN pnpm install --frozen-lockfile

# 再复制源码并构建
COPY frontend/ ./frontend/
# 空 VITE_API_URL = 与页面同源（走网关），避免构建产物指向 127.0.0.1:8002 造成跨域
ENV VITE_API_URL=
RUN pnpm --filter @kustos/web build

FROM openresty/openresty:1.31.1.1-0-bookworm-fat AS runtime
# 产物路径随 workspace 上移：/app/frontend/web/dist
COPY --from=web-builder /app/frontend/web/dist /var/www/kustos-web
