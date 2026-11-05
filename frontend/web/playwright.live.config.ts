import { defineConfig, devices } from "@playwright/test";

/**
 * 针对「已部署实例」的端到端配置。
 *
 * 与 `playwright.config.ts` 的区别在于不启 webServer、不桩后端：页面由网关真实提供，
 * 接口、WebSocket 与协作网关都打到实例上，因此用例验证的是整条链路，而不是静态
 * 产物能否渲染。浏览器固定用本机安装的 Edge（无头），不额外下载 Chromium。
 *
 * 实例地址必须通过环境变量提供：`KUSTOS_E2E_BASE_URL=http://<host>:<port>`。
 * 账号与夹具由 `e2e/live/bootstrap.py` 预置。默认无头；调试某台机上的 Edge 定位时，
 * 如果 channel 解析不了安装路径，用 `KUSTOS_EDGE_PATH` 显式指定可执行文件。
 */

const BASE_URL = process.env.KUSTOS_E2E_BASE_URL;
if (!BASE_URL) {
  throw new Error(
    "缺少 KUSTOS_E2E_BASE_URL：请指向已部署实例（例如 http://<host>:8000），夹具见 e2e/live/bootstrap.py",
  );
}

/**
 * Edge 的启动参数。
 *
 * `devices["Desktop Edge"]` 自带 `channel: "msedge"`，交给 Playwright 自己定位本机 Edge。
 * 显式给了 `KUSTOS_EDGE_PATH` 时必须先把 channel 摘掉——它会把启动位置钉回
 * channel 的默认解析结果，显式路径随之失效。
 *
 * @returns Desktop Edge 设备（无头）；给了 KUSTOS_EDGE_PATH 时改用显式可执行文件
 */
function edgeUse(): Record<string, unknown> {
  const device: Record<string, unknown> = { ...devices["Desktop Edge"] };
  const executablePath = process.env.KUSTOS_EDGE_PATH;
  if (executablePath) {
    delete device.channel;
    return { ...device, headless: true, executablePath };
  }
  return { ...device, headless: true };
}

export default defineConfig({
  testDir: "./e2e/live",
  // 用例之间共享同一个仓库文档与同一个房间，并行会互相踩内容
  fullyParallel: false,
  workers: 1,
  // 实时协同依赖网关往返，重试只会掩盖竞态，宁可暴露
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "msedge",
      use: edgeUse(),
    },
  ],
});
