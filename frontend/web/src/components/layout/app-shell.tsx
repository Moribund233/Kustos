import { Outlet } from "react-router";

import { CommandPaletteProvider } from "@/components/command-palette/command-palette-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

/**
 * 应用外壳：氛围底色 + 侧栏 + 顶栏 + 内容区。
 *
 * 氛围层复刻原型 body 的两团径向渐变与噪点（pointer-events: none，
 * 纯装饰）。内容区用 `<Outlet/>` 渲染子路由——数据路由下子路由元素
 * 由 Outlet 承载，不能靠 children prop 传下来。
 */
export function AppShell() {
  return (
    <div className="bg-ink-1000 flex h-full min-h-screen">
      {/* 跳过导航：键盘用户从侧栏起步时不必逐个穿过几十个链接，
          按下 Tab 即可直达内容区（WCAG 2.4.1 绕过区块）。 */}
      <a
        href="#main-content"
        className="bg-amber text-ink-1000 sr-only rounded-md px-3 py-2 text-sm font-semibold focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[100]"
      >
        跳到主内容
      </a>

      {/* 氛围：左上琥珀提灯 + 右上冷光，覆一层软噪点 */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-[1] bg-[radial-gradient(1100px_720px_at_12%_-14%,rgba(242,174,91,0.075),transparent_62%),radial-gradient(900px_620px_at_94%_-4%,rgba(131,169,196,0.045),transparent_58%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-[1] opacity-[0.032] mix-blend-soft-light bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%27180%27%20height=%27180%27%3E%3Cfilter%20id=%27n%27%3E%3CfeTurbulence%20type=%27fractalNoise%27%20baseFrequency=%27.86%27%20numOctaves=%273%27%20stitchTiles=%27stitch%27/%3E%3C/filter%3E%3Crect%20width=%27100%25%27%20height=%27100%25%27%20filter=%27url(%23n)%27/%3E%3C/svg%3E')]"
      />

      <Sidebar />
      <div className="relative z-[2] flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-auto focus:outline-none">
          <Outlet />
        </main>
      </div>
      <CommandPaletteProvider />
    </div>
  );
}
