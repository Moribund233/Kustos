import { describe, expect, it } from "vitest";

import { anchorLineNumber, collectNewLines } from "./diff-anchor";
import { parseUnifiedDiff } from "./unified-diff";

/** 取第一段 hunk 的行，测试里只需要这一小段。 */
function linesOf(text: string) {
  const parsed = parseUnifiedDiff(text);
  const hunk = parsed.hunks[0];
  if (hunk === undefined) throw new Error("fixture has no hunk");
  return { lines: hunk.lines, newLines: collectNewLines(parsed.hunks) };
}

describe("collectNewLines", () => {
  it("只收集新文件侧的行号", () => {
    const { newLines } = linesOf(
      ["@@ -1,3 +1,5 @@", " ctx", "-old", "+new", "+more", " ctx2"].join("\n"),
    );
    // +1,5 → 新文件 1..5 里的 ctx/new/more/ctx2 覆盖 1,2,3,4,5 中实际出现的行
    expect([...newLines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5].filter((n) => newLines.has(n)));
    expect(newLines.has(1)).toBe(true);
  });

  it("删除行不贡献新行号", () => {
    const { newLines } = linesOf(["@@ -1,1 +1,0 @@", "-only"].join("\n"));
    expect(newLines.size).toBe(0);
  });
});

describe("anchorLineNumber", () => {
  /**
   * 这是截图里发现的回归：整行替换时删除行的旧行号与新增行的新行号同为
   * 第 1 行，锚点必须唯一，否则同一条评论渲染两次。
   */
  it("整行替换时删除行让出与新行同号的锚点", () => {
    const { lines, newLines } = linesOf(["@@ -1,2 +1,2 @@", "-旧标题", "+新标题", " 正文"].join("\n"));
    const removed = lines.find((line) => line.kind === "remove");
    const added = lines.find((line) => line.kind === "add");
    expect(removed?.oldLine).toBe(1);
    expect(added?.newLine).toBe(1);
    expect(anchorLineNumber(removed, newLines)).toBeNull();
    expect(anchorLineNumber(added, newLines)).toBe(1);
  });

  it("纯删除的旧行号在新文件侧不存在时仍可挂意见", () => {
    const { lines, newLines } = linesOf(["@@ -1,3 +1,2 @@", " keep", "-dropped", " tail"].join("\n"));
    const removed = lines.find((line) => line.kind === "remove");
    expect(removed?.oldLine).toBe(2);
    expect(newLines.has(2)).toBe(true); // tail 占用了新行号 2
    expect(anchorLineNumber(removed, newLines)).toBeNull();
  });

  it("同一锚点在整段 diff 里只被一行占用", () => {
    const { lines, newLines } = linesOf(
      ["@@ -1,3 +1,5 @@", "-a", "-b", "+a1", "+b1", "+extra", " ctx"].join("\n"),
    );
    const anchors = lines.map((line) => anchorLineNumber(line, newLines)).filter((n): n is number => n !== null);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("null 与 undefined 行没有锚点", () => {
    const newLines = new Set<number>([1]);
    expect(anchorLineNumber(null, newLines)).toBeNull();
    expect(anchorLineNumber(undefined, newLines)).toBeNull();
  });

  it("上下文行用它的新行号", () => {
    const { lines, newLines } = linesOf(["@@ -1,1 +7,1 @@", " ctx"].join("\n"));
    expect(anchorLineNumber(lines[0], newLines)).toBe(7);
  });
});
