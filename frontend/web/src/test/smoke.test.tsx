import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { AppShell } from "@/components/layout/app-shell";
import { currentLocale, setLocale } from "@/lib/i18n";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";

/** 每个用例独立 QueryClient，避免缓存与重试跨用例污染。 */
function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppShell", () => {
  it("渲染出品牌与导航骨架", () => {
    renderShell();
    // 品牌字标在侧栏渲染（原型字标为全大写 KUSTOS）
    expect(screen.getAllByText("KUSTOS").length).toBeGreaterThan(0);
    // 侧栏分组导航（Personal/Repository/...）各是一个 nav landmark
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
  });

  it("语言切换后侧栏文案随之改变", () => {
    const original = currentLocale();
    setLocale(DEFAULT_LOCALE === "zh" ? "en" : "zh");

    renderShell();

    const nav = screen.getAllByRole("navigation")[0];
    // aria-label 取自 i18n，切换语言后应随之变化
    expect(nav?.getAttribute("aria-label")).toBeTruthy();

    setLocale(original);
  });
});
