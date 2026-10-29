import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router";

import { AppShell } from "@/components/layout/app-shell";
import { PageFallback } from "@/components/layout/page-fallback";
import { AnonOnly, RequireAuth } from "@/components/auth/require-auth";
import { OverviewPage } from "@/features/overview/pages/overview-page";

/**
 * 页面级懒加载。
 *
 * 编辑器与 Markdown 渲染栈体积可观且只在对应页面用到，
 * 按路由切分可避免首屏为它们买单。
 */
const CodePage = lazy(() =>
  import("@/features/code/pages/code-page").then((m) => ({ default: m.CodePage })),
);
const IssuesPage = lazy(() =>
  import("@/features/issue/pages/issues-page").then((m) => ({ default: m.IssuesPage })),
);
const PullPage = lazy(() =>
  import("@/features/pull-request/pages/pull-page").then((m) => ({ default: m.PullPage })),
);
const ReleasesPage = lazy(() =>
  import("@/features/release/pages/releases-page").then((m) => ({ default: m.ReleasesPage })),
);
const RepositorySettingsPage = lazy(() =>
  import("@/features/settings/pages/repository-settings-page").then((m) => ({
    default: m.RepositorySettingsPage,
  })),
);
const AgentPage = lazy(() =>
  import("@/features/agent/pages/agent-page").then((m) => ({ default: m.AgentPage })),
);
const ChatPage = lazy(() =>
  import("@/features/chat/pages/chat-page").then((m) => ({ default: m.ChatPage })),
);
const AdminPage = lazy(() =>
  import("@/features/admin/pages/admin-page").then((m) => ({ default: m.AdminPage })),
);
const LoginPage = lazy(() =>
  import("@/features/auth/pages/login-page").then((m) => ({ default: m.LoginPage })),
);

/**
 * 路由表。nginx 用 `try_files $uri $uri/ /index.html` 兜底，因此直接用 history 模式。
 *
 * 仓库级页面按 `/:owner/:repo/...` 组织是后续接真实数据时的事；当前还原
 * 阶段保持扁平路由。实例级页面挂在 `/admin` 下，是否可达由后端裁决。
 * 登录页独立于 AppShell（无侧栏顶栏）。
 */
export const router = createBrowserRouter([
  {
    path: "/login",
    element: (
      <AnonOnly>
        <Suspense fallback={<PageFallback />}>
          <LoginPage />
        </Suspense>
      </AnonOnly>
    ),
  },
  {
    path: "/",
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      {
        index: true,
        element: <OverviewPage />,
      },
      {
        path: "code",
        element: (
          <Suspense fallback={<PageFallback />}>
            <CodePage />
          </Suspense>
        ),
      },
      {
        path: "issues",
        element: (
          <Suspense fallback={<PageFallback />}>
            <IssuesPage />
          </Suspense>
        ),
      },
      {
        path: "pull-requests",
        element: (
          <Suspense fallback={<PageFallback />}>
            <PullPage />
          </Suspense>
        ),
      },
      {
        path: "settings",
        element: (
          <Suspense fallback={<PageFallback />}>
            <RepositorySettingsPage />
          </Suspense>
        ),
      },
      {
        path: "releases",
        element: (
          <Suspense fallback={<PageFallback />}>
            <ReleasesPage />
          </Suspense>
        ),
      },
      {
        path: "agent",
        element: (
          <Suspense fallback={<PageFallback />}>
            <AgentPage />
          </Suspense>
        ),
      },
      {
        path: "chat",
        element: (
          <Suspense fallback={<PageFallback />}>
            <ChatPage />
          </Suspense>
        ),
      },
      {
        path: "admin",
        element: (
          <Suspense fallback={<PageFallback />}>
            <AdminPage />
          </Suspense>
        ),
      },
    ],
  },
]);
