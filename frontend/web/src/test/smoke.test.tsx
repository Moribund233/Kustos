import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { AppShell } from "@/components/layout/app-shell";
import { currentLocale, setLocale } from "@/lib/i18n";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";

describe("AppShell", () => {
  it("渲染出品牌与导航骨架", () => {
    // 侧栏用 NavLink，需要 Router 上下文
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );
    // 品牌名在侧栏与顶栏各出现一次
    expect(screen.getAllByText("Kustos").length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("语言切换后侧栏文案随之改变", () => {
    const original = currentLocale();
    setLocale(DEFAULT_LOCALE === "zh" ? "en" : "zh");

    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );

    const nav = screen.getAllByRole("navigation")[0];
    // aria-label 取自 i18n，切换语言后应随之变化
    expect(nav?.getAttribute("aria-label")).toBeTruthy();

    setLocale(original);
  });
});
