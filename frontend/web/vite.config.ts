import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 前端构建配置。
 *
 * 产物必须落在 `dist`：网关镜像的 Dockerfile 用 `COPY --from=web-builder /app/dist`
 * 把它塞进 OpenResty 的站点根目录，改目录名会直接让镜像构建失败。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 开发期把 API 打到本地后端；生产走网关同源，不需要代理。
      // 默认指向 API 直连端口：网关会按 KUSTOS_ADMIN_ALLOWED_SOURCES 在
      // nginx 层拦掉 /api/app/*，直连端口没有这一层，管理台接口也能通。
      "/api": {
        target: process.env.VITE_DEV_API_ORIGIN ?? "http://127.0.0.1:8001",
        changeOrigin: true,
        ws: true,
      },
      // 协作编辑走独立的 Hocuspocus 网关，不在 app 上；dev 里由 dev nginx
      // （docker-compose.dev.yml 的 gateway，127.0.0.1:8080）转发到 collab 容器。
      // 必须排在下方 /ws 之前，否则会被 app 的通用规则吃掉、握手直接失败。
      "/ws/collab": {
        target: process.env.VITE_DEV_COLLAB_ORIGIN ?? "http://127.0.0.1:8080",
        changeOrigin: true,
        ws: true,
      },
      // 实时通道走 /ws 前缀（不经 /api/v1）；生产由网关整段反代到应用，
      // 开发期同样要转发，否则聊天与 presence 一点就连不上。
      "/ws": {
        target: process.env.VITE_DEV_API_ORIGIN ?? "http://127.0.0.1:8001",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 编辑器、Markdown 渲染与图表体积可观且只在对应页面用到。
        // 这些页面本身是路由级懒加载，依赖跟随页面 chunk 一起按需拉取，
        // 这里不再强行聚合——聚合反而会让懒加载失效。
        manualChunks: (id) => {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("recharts") || id.includes("d3-") || id.includes("victory-vendor")) {
            return "vendor-chart";
          }
          return undefined;
        },
      },
    },
  },
});
