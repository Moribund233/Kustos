import { describe, expect, it } from "vitest";

import { parseWindowRoute, reviewRouteValue } from "./window-route.ts";

/**
 * 窗口路由的解析边界。
 *
 * 这一段决定"这个窗口显示哪一个 PR"，解析错了会让评审窗显示错的内容——
 * 而界面上看不出是路由的问题，只会觉得"点错了"。
 */

const REPO = "01a1a921-6c3a-76b8-b6c3-0633e74e90ae";

describe("parseWindowRoute", () => {
  it("空片段表示主窗口", () => {
    expect(parseWindowRoute("")).toEqual({ kind: "main" });
    expect(parseWindowRoute("#")).toEqual({ kind: "main" });
    expect(parseWindowRoute("#/")).toEqual({ kind: "main" });
  });

  it("解析评审窗、仓库与 PR 编号", () => {
    expect(parseWindowRoute(`#/review/${REPO}|42`)).toEqual({
      kind: "review",
      prNumber: 42,
      repoId: REPO,
    });
  });

  it("旧片段只有编号、没有仓库时仍能解析", () => {
    // 已经开着的窗口、或托盘唤出的窗口可能带着旧格式的片段；
    // 让它们解析失败会把一个可用的窗口变成错误页。
    expect(parseWindowRoute("#/review/42")).toEqual({ kind: "review", prNumber: 42, repoId: null });
  });

  it("评审窗可以还没有 PR", () => {
    // 托盘菜单直接唤出的评审窗没有编号。它仍是评审窗，不能退化成主窗口——
    // 否则用户在第二个窗口里看到的是又一个 Inbox。
    expect(parseWindowRoute("#/review")).toEqual({ kind: "review", prNumber: null, repoId: null });
    expect(parseWindowRoute("#/review/")).toEqual({ kind: "review", prNumber: null, repoId: null });
  });

  it("编号里的转义字符被还原", () => {
    // 生成侧用 PathEscape，解析侧必须解回来：%34%32 就是 "42"。
    expect(parseWindowRoute("#/review/%34%32")).toEqual({
      kind: "review",
      prNumber: 42,
      repoId: null,
    });
  });

  it("仓库里的分隔符被转义后仍能还原", () => {
    // Go 侧对整段路由值做 PathEscape，`|` 落地成 %7C；这里必须还原回 `|`
    // 而不是把它当成路径的一部分。
    expect(parseWindowRoute(`#/review/${REPO}%7C42`)).toEqual({
      kind: "review",
      prNumber: 42,
      repoId: REPO,
    });
  });

  it("分段用的斜杠被转义后不会被当成路径分隔", () => {
    // 仓库 id 恰好含斜杠（不该发生，但片段是外部可写的）时，转义后
    // 不能把这一段切成两段、从而丢掉编号。
    expect(parseWindowRoute("#/review/a%2Fb%7C7")).toEqual({
      kind: "review",
      prNumber: 7,
      repoId: "a/b",
    });
  });

  it("未知 scope 退回主窗口，不猜", () => {
    expect(parseWindowRoute("#/settings/1")).toEqual({ kind: "main" });
    expect(parseWindowRoute("#/unknown")).toEqual({ kind: "main" });
  });

  it("编号非法时退回未选中 PR", () => {
    // 显示一个不存在的 PR 比让用户重新选一个更令人困惑；但窗口仍应是评审窗。
    for (const hash of ["#/review/abc", "#/review/0", "#/review/-1", "#/review/1.5"]) {
      expect(parseWindowRoute(hash)).toEqual({ kind: "review", prNumber: null, repoId: null });
    }
  });

  it("孤立的百分号不抛错", () => {
    // decodeURIComponent 对 "%" 会抛 URIError；片段可以被用户手写，
    // 解析器抛错会让整个窗口白屏。
    expect(parseWindowRoute("#/review/%")).toEqual({ kind: "review", prNumber: null, repoId: null });
  });

  it("多段片段只取前两段", () => {
    // 编号里混进斜杠时不该被切成多段而解析失败。
    expect(parseWindowRoute("#/review/42/extra")).toEqual({
      kind: "review",
      prNumber: 42,
      repoId: null,
    });
  });
});

describe("reviewRouteValue", () => {
  it("与 parseWindowRoute 互为逆运算", () => {
    const value = reviewRouteValue(REPO, 42);
    expect(parseWindowRoute(`#/review/${value}`)).toEqual({
      kind: "review",
      prNumber: 42,
      repoId: REPO,
    });
  });

  it("仓库 id 自带的连字符不影响分割", () => {
    // 分隔符选 `|` 而不是 `-`，正是因为仓库 id 是 UUID 形态、天然含连字符。
    expect(reviewRouteValue(REPO, 7)).toBe(`${REPO}|7`);
  });
});
