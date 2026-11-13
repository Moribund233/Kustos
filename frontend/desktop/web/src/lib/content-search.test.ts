import { describe, expect, it } from "vitest";

import {
  CONTENT_SEARCH_LIMIT,
  MIN_CONTENT_QUERY,
  buildContentQuery,
  groupMatchesByFile,
  highlightRanges,
  shouldSearchContent,
} from "./content-search";
import type { ContentMatch } from "@/bindings/github.com/kustos/kustos-desktop/internal/git/models";

// 全文搜索的纯逻辑：查询门槛、按文件分组、命中区间高亮。
// 三者都发生在结果渲染路径上，出错会直接污染整条列表。

function match(path: string, line: number, text = "x"): ContentMatch {
  return { path, line, text };
}

describe("shouldSearchContent", () => {
  it("空与单字符查询不发起扫描", () => {
    expect(shouldSearchContent("")).toBe(false);
    expect(shouldSearchContent("   ")).toBe(false);
    expect(shouldSearchContent("a")).toBe(false);
  });

  it("达到最短长度才搜", () => {
    expect(shouldSearchContent("ab")).toBe(true);
    expect(shouldSearchContent("  ab  ")).toBe(true);
    expect(MIN_CONTENT_QUERY).toBe(2);
  });
});

describe("buildContentQuery", () => {
  it("去空白并把默认上限带给 Go", () => {
    const q = buildContentQuery({ query: "  demo  ", regex: false, caseSensitive: true, scope: " src " });
    expect(q).toEqual({
      query: "demo",
      regex: false,
      caseSensitive: true,
      path: "src",
      limit: CONTENT_SEARCH_LIMIT,
    });
  });

  it("空 scope 归一成空串（全仓库）", () => {
    const q = buildContentQuery({ query: "x", regex: true, caseSensitive: false, scope: "" });
    expect(q.path).toBe("");
    expect(q.regex).toBe(true);
  });
});

describe("groupMatchesByFile", () => {
  it("相邻同路径归到同一组并保持顺序", () => {
    const groups = groupMatchesByFile([
      match("a.ts", 1),
      match("a.ts", 9),
      match("b.md", 2),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["a.ts", "b.md"]);
    expect(groups[0].matches.map((m) => m.line)).toEqual([1, 9]);
  });

  it("跨文件重新出现的同名路径另起一组：并进第一段会让行号跳着显示", () => {
    const groups = groupMatchesByFile([match("a.ts", 1), match("b.md", 2), match("a.ts", 3)]);
    expect(groups.map((g) => g.path)).toEqual(["a.ts", "b.md", "a.ts"]);
  });

  it("空输入给空数组", () => {
    expect(groupMatchesByFile([])).toEqual([]);
  });
});

describe("highlightRanges", () => {
  it("字面量大小写不敏感地找出所有区间", () => {
    expect(highlightRanges("Demo demo D", "demo", { regex: false, caseSensitive: false })).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ]);
  });

  it("字面量区分大小写时只命中同形的", () => {
    expect(highlightRanges("Demo demo", "demo", { regex: false, caseSensitive: true })).toEqual([
      { start: 5, end: 9 },
    ]);
  });

  it("字面量不解释正则元字符", () => {
    // `fn(x)` 里若按正则解释，(x) 是捕获组、匹配不到字面括号。
    expect(highlightRanges("call fn(x) here", "fn(x)", { regex: false, caseSensitive: false })).toEqual([
      { start: 5, end: 10 },
    ]);
  });

  it("正则找出所有匹配（含大小写开关）", () => {
    expect(highlightRanges("fn1 fn2 FN3", "fn\\d", { regex: true, caseSensitive: false })).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
    expect(highlightRanges("fn1 FN2", "fn\\d", { regex: true, caseSensitive: true })).toEqual([
      { start: 0, end: 3 },
    ]);
  });

  it("坏正则返回空而不是抛错：输入过程中的半个表达式不该炸掉整条列表", () => {
    expect(highlightRanges("anything", "([oops", { regex: true, caseSensitive: false })).toEqual([]);
  });

  it("零宽正则不死循环", () => {
    expect(highlightRanges("abc", "x*", { regex: true, caseSensitive: false })).toEqual([]);
  });

  it("空查询或空文本没有区间", () => {
    expect(highlightRanges("abc", "", { regex: false, caseSensitive: false })).toEqual([]);
    expect(highlightRanges("", "abc", { regex: false, caseSensitive: false })).toEqual([]);
  });

  it("不重叠地前进：aaa 里搜 aa 得到两个错位区间的第一个", () => {
    expect(highlightRanges("aaaa", "aa", { regex: false, caseSensitive: false })).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});
