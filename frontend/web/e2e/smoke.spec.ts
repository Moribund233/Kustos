import { expect, test } from "@playwright/test";

import { gotoApp } from "./session";

/**
 * 冒烟用例。
 *
 * 会话与后端由 `session.ts` 桩住，断言只覆盖"前端产物能跑起来"这件事：
 * 外壳、字体、i18n、命令面板、编辑器。业务逻辑由 Vitest 单测覆盖。
 */

test("应用外壳可加载", async ({ page }) => {
  await gotoApp(page, "/");
  await expect(page.getByRole("navigation").first()).toBeVisible();
  // 内容区由 Outlet 渲染
  await expect(page.locator("main")).not.toBeEmpty();
});

test("西文 webfont 实际生效", async ({ page }) => {
  await gotoApp(page, "/");
  await page.waitForLoadState("networkidle");

  const loaded = await page.evaluate(() =>
    ["Fraunces Variable", "Inter Variable"].filter((name) =>
      document.fonts.check(`16px "${name}"`),
    ),
  );

  expect(loaded).toEqual(expect.arrayContaining(["Fraunces Variable", "Inter Variable"]));
});

test("中文字符走系统字体而非西文 webfont", async ({ page }) => {
  await gotoApp(page, "/issues");
  await page.waitForLoadState("networkidle");

  // 中文字体排在西文 webfont 之后，逐字符回退时中文由系统字体承接
  const fontFamily = await page.evaluate(() => {
    const heading = document.querySelector("h1");
    return heading ? getComputedStyle(heading).fontFamily : "";
  });

  expect(fontFamily).toContain("Microsoft YaHei");
});

test("语言切换会改变界面文案", async ({ page }) => {
  await gotoApp(page, "/");
  const nav = page.getByRole("navigation").first();
  const before = await nav.getAttribute("aria-label");

  // 顶栏的语言切换器；浏览器默认语言是 en，这里切到中文看文案是否变化
  await page.getByRole("button", { name: /语言|Language/ }).click();
  await page.getByRole("menuitemradio").filter({ hasText: "简体中文" }).click();

  await expect(nav).not.toHaveAttribute("aria-label", before ?? "");
});

test("命令面板可用快捷键唤起", async ({ page }) => {
  await gotoApp(page, "/");
  await page.keyboard.press("Control+k");
  await expect(page.getByPlaceholder(/搜索页面|Search pages/)).toBeVisible();
});

test("代码页渲染编辑器", async ({ page }) => {
  // 需要选中文件才会拉 blob 并挂载 CodeMirror
  await gotoApp(page, "/code?path=README.md");
  await expect(page.locator(".cm-content")).toBeVisible();
});

test("品牌标记使用原型资产且真实加载", async ({ page }) => {
  await gotoApp(page, "/");

  // 侧栏与登录页都用 /brand/kustos-mark.svg，不是画出来的字母
  const mark = page.locator('img[src="/brand/kustos-mark.svg"]').first();
  await expect(mark).toBeVisible();
  await expect
    .poll(() => mark.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/brand/favicon.svg");
});
