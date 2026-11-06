import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 桌面端前端构建配置。
 *
 * 产物落在 `web/dist`：Go 侧用 `//go:embed all:web/dist` 把它嵌进二进制。
 * 改目录名会直接让 `go build` 失败。
 *
 * 与 Web 的关键差异：
 * - 没有 dev 代理：开发期同样经 bridge 走同源，避免"开发能跑、打包跨域"；
 * - 端口固定 9245（Wails dev 的约定），strictPort 防止静默换端口导致
 *   Wails 连不上。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
