import { describe, expect, it } from "vitest";

import { parseWindowRoute } from "./window-route.ts";

/**
 * 窗口路由的解析边界。
 *
 * 这一段决定"这个窗口显示哪一个 PR"，解析错了会让评审窗显示错的内容——
 * 而界面上看不出是路由的问题，只会觉得"点错了"。
 */

describe("parseWindowRoute", () => {
  it("空片段表示主窗口", () => {
    expect(parseWindowRoute("")).toEqual({ kind: "main" });
    expect(parseWindowRoute("#")).toEqual({ kind: "main" });
    expect(parseWindowRoute("#/")).toEqual({ kind: "main" });
  });

  it("解析评审窗与 PR 编号", () => {
    expect(parseWindowRoute("#/review/42")).toEqual({ kind: "review", prNumber: 42 });
  });

  it("编号里的转义字符被还原", () => {
    // 生成侧用 PathEscape，解析侧必须解回来：%34%32 就是 "42"。
    expect(parseWindowRoute("#/review/%34%32")).toEqual({ kind: "review", prNumber: 42 });
  });

  it("未知 scope 退回主窗口，不猜", () => {
    expect(parseWindowRoute("#/settings/1")).toEqual({ kind: "main" });
    expect(parseWindowRoute("#/unknown")).toEqual({ kind: "main" });
  });

  it("编号非法时退回主窗口", () => {
    // 显示一个不存在的 PR 比回到主界面更令人困惑。
    expect(parseWindowRoute("#/review/abc")).toEqual({ kind: "main" });
    expect(parseWindowRoute("#/review/0")).toEqual({ kind: "main" });
    expect(parseWindowRoute("#/review/-1")).toEqual({ kind: "main" });
    expect(parseWindowRoute("#/review/1.5")).toEqual({ kind: "main" });
    expect(parseWindowRoute("#/review/")).toEqual({ kind: "main" });
  });

  it("多段片段只取前两段", () => {
    // 编号里混进斜杠时不该被切成多段而解析失败。
    expect(parseWindowRoute("#/review/42/extra")).toEqual({ kind: "review", prNumber: 42 });
  });
});
