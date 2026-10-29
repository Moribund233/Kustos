import type { Page } from "@playwright/test";

/**
 * E2E 会话与后端桩。
 *
 * 外壳与所有页面都在登录之后，因此每个用例都要先建立会话；后端不参与
 * E2E（前端产物是静态的，不该为了跑 UI 用例拉起整套 compose），这里把
 * 认证与页面依赖的读接口一并桩掉。断言只针对界面，不验证后端行为。
 */

/** 桩用户：管理员，侧栏与管理台入口都会出现。 */
export const MOCK_USER = {
  id: "user-1",
  username: "lin",
  email: "lin@example.com",
  full_name: "Lin Wei",
  is_active: true,
  is_admin: true,
  avatar_url: null,
};

/** 桩仓库：字段与 GET /api/v1/repositories 的列表项一致。 */
const MOCK_REPO = {
  id: "repo-1",
  name: "atlas",
  path: "lin/atlas",
  description: "示例仓库",
  is_public: true,
  owner_id: "user-1",
  default_branch: "main",
  fork_count: 0,
  star_count: 0,
  watch_count: 0,
  updated_at: "2026-10-29T08:00:00Z",
};

/** 桩文件：代码页据它渲染 CodeMirror。 */
const MOCK_FILE_CONTENT = "# atlas\n\nkustos sample repository\n";
const MOCK_SHA = "9f1c2f7d3a4b5c6d7e8f9012345678abcdef0123";

/** 仪表盘的完整空结构：缺字段会让概览页渲染时读到 undefined。 */
const MOCK_DASHBOARD = {
  repo_count: 1,
  open_prs: 0,
  open_issues: 0,
  recent_activities: [],
  recent_prs: [],
  recent_issues: [],
  contributions_by_day: {},
};

/**
 * 建立登录态并拦截后端请求。
 *
 * 必须在 `page.goto` 之前调用：refresh token 要用 init script 在页面脚本
 * 执行前写进 localStorage。
 *
 * @param page Playwright 页面
 */
export async function signIn(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // 刷新令牌留在 localStorage，access 令牌由 /auth/refresh 换发
    window.localStorage.setItem("kustos.refresh", "e2e-refresh-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());

    // 令牌换发：client.refreshSession 读 access_token，与登录接口的 token 字段不同
    if (pathname === "/api/v1/auth/refresh") {
      await route.fulfill({
        json: { access_token: "e2e-access-token", refresh_token: "e2e-refresh-token" },
      });
      return;
    }
    if (pathname === "/api/v1/users/me") {
      await route.fulfill({ json: MOCK_USER });
      return;
    }
    if (pathname === "/api/v1/users/me/dashboard") {
      await route.fulfill({ json: MOCK_DASHBOARD });
      return;
    }
    if (pathname === "/api/v1/repositories") {
      await route.fulfill({ json: { items: [MOCK_REPO], total: 1, page: 1, limit: 100 } });
      return;
    }
    if (pathname.endsWith("/branches")) {
      await route.fulfill({ json: [{ name: "main", is_default: true }] });
      return;
    }
    if (pathname.endsWith("/tree")) {
      await route.fulfill({
        json: {
          entries: [{ name: "README.md", type: "blob", path: "README.md", size: MOCK_FILE_CONTENT.length }],
          is_empty: false,
        },
      });
      return;
    }
    if (pathname.endsWith("/blob")) {
      await route.fulfill({
        json: {
          content: MOCK_FILE_CONTENT,
          size: MOCK_FILE_CONTENT.length,
          is_binary: false,
          language: "Markdown",
          is_empty: false,
        },
      });
      return;
    }
    if (pathname.endsWith("/commits")) {
      await route.fulfill({
        json: {
          commits: [
            {
              sha: MOCK_SHA,
              message: "init: 示例提交",
              author: { name: "lin", date: "2026-10-29T08:00:00Z" },
            },
          ],
        },
      });
      return;
    }
    if (pathname.endsWith("/symbols")) {
      await route.fulfill({ json: { symbols: [] } });
      return;
    }
    if (pathname.endsWith("/room")) {
      // 仓库频道的按需补建不在 E2E 范围内：404 让页面走空态而不是渲染半截对象
      await route.fulfill({ status: 404, json: { detail: "not found" } });
      return;
    }

    // 其余读接口按空列表兜底：页面普遍写成 `res.data ?? []`
    await route.fulfill({ json: [] });
  });
}

/**
 * 打开需要登录的页面。
 *
 * @param page Playwright 页面
 * @param path 站内路径
 */
export async function gotoApp(page: Page, path: string): Promise<void> {
  await signIn(page);
  await page.goto(path);
  // 会话恢复与仓库列表都是异步的，等侧栏出现再断言，避免拿到跳转瞬间的登录页
  await page.getByRole("navigation").first().waitFor();
}
