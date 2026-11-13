import { describe, expect, it } from "vitest";

import { cacheKeyFor } from "./offline-cache";

/**
 * 缓存键的选择决定了"断网时能看到什么"。两条都容易错：
 * 选多了会把本机能现算的东西缓存成旧数据，选少了则断网一片空白。
 */
describe("cacheKeyFor", () => {
  it("Inbox 列表按筛选条件区分", () => {
    const all = cacheKeyFor(["inbox", "notifications", { unreadOnly: false }]);
    const unread = cacheKeyFor(["inbox", "notifications", { unreadOnly: true }]);
    expect(all).not.toBeNull();
    expect(unread).not.toBeNull();
    // 两种筛选是不同的内容，共用一个键会让"只看未读"读到全量。
    expect(all).not.toBe(unread);
  });

  it("PR 与 Issue 按仓库与编号区分", () => {
    expect(cacheKeyFor(["pulls", "repo-1", "detail", 42])).toBe(`pulls:${JSON.stringify(["repo-1", "detail", 42])}`);
    expect(cacheKeyFor(["issues", "repo-1", "list"])).not.toBeNull();
  });

  it("同样参数的查询落到同一个键", () => {
    expect(cacheKeyFor(["pulls", "repo-1", "detail", 42])).toBe(
      cacheKeyFor(["pulls", "repo-1", "detail", 42]),
    );
  });

  it("工作副本与代码相关的东西不缓存", () => {
    // 它们要么本机能现算（git 状态），要么来自磁盘；缓存一份会与真实文件打架。
    expect(cacheKeyFor(["working-copy", "list"])).toBeNull();
    expect(cacheKeyFor(["code", "tree", "/src"])).toBeNull();
    expect(cacheKeyFor(["git-status"])).toBeNull();
  });

  it("附带数据不单独缓存", () => {
    expect(cacheKeyFor(["pr-reviewers", "repo-1", 42])).toBeNull();
  });

  it("首段不是字符串时不猜", () => {
    expect(cacheKeyFor([123])).toBeNull();
    expect(cacheKeyFor([])).toBeNull();
  });
});
