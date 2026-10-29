import { Outlet } from "react-router";

import { CommandPaletteProvider } from "@/components/command-palette/command-palette-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

/**
 * 应用外壳：侧栏 + 顶栏 + 内容区。
 *
 * 内容区用 `<Outlet/>` 渲染子路由——数据路由（createBrowserRouter）下
 * 子路由元素由 Outlet 承载，不能靠 children prop 传下来。
 */
export function AppShell() {
  return (
    <div className="bg-ink-1000 flex h-full min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="bg-ink-950 min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      <CommandPaletteProvider />
    </div>
  );
}
