import { describe, expect, it } from "vitest";

import { splitHunk } from "./diff-split";
import { parseUnifiedDiff, type DiffHunk } from "./unified-diff";

/**
 * 取一段 diff 文本里第一个 hunk，避免每个用例都手写 DiffLine 对象。
 */
function firstHunk(text: string): DiffHunk {
  const parsed = parseUnifiedDiff(text);
  const hunk = parsed.hunks[0];
  if (hunk === undefined) throw new Error("fixture has no hunk");
  return hunk;
}

describe("splitHunk", () => {
  it("纯上下文行两侧内容相同", () => {
    const rows = splitHunk(
      firstHunk(["@@ -1,2 +1,2 @@", " a", " b"].join("\n")),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].left?.text).toBe("a");
    expect(rows[0].right?.text).toBe("a");
    expect(rows[1].left?.text).toBe("b");
    expect(rows[1].right?.text).toBe("b");
  });

  it("同一块内的删除与新增配对成一行", () => {
    // 一个 -a +b 的替换：配对后是**一行**，不是两行。
    const rows = splitHunk(
      firstHunk(["@@ -1,1 +1,1 @@", "-a", "+b"].join("\n")),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].left?.text).toBe("a");
    expect(rows[0].left?.kind).toBe("remove");
    expect(rows[0].right?.text).toBe("b");
    expect(rows[0].right?.kind).toBe("add");
  });

  it("配对后左右两侧各自保留自己的行号", () => {
    const rows = splitHunk(
      firstHunk(["@@ -7,1 +7,1 @@", "-old", "+new"].join("\n")),
    );

    expect(rows[0].left?.oldLine).toBe(7);
    expect(rows[0].right?.newLine).toBe(7);
  });

  it("删除多于新增时多出来的行只有左侧", () => {
    const rows = splitHunk(
      firstHunk(["@@ -1,3 +1,1 @@", "-a", "-b", "-c", "+x"].join("\n")),
    );

    expect(rows).toHaveLength(3);
    expect(rows[0].left?.text).toBe("a");
    expect(rows[0].right?.text).toBe("x");
    expect(rows[1].left?.text).toBe("b");
    expect(rows[1].right).toBeNull();
    expect(rows[2].left?.text).toBe("c");
    expect(rows[2].right).toBeNull();
  });

  it("新增多于删除时多出来的行只有右侧", () => {
    const rows = splitHunk(
      firstHunk(["@@ -1,1 +1,3 @@", "-a", "+x", "+y", "+z"].join("\n")),
    );

    expect(rows).toHaveLength(3);
    expect(rows[0].left?.text).toBe("a");
    expect(rows[0].right?.text).toBe("x");
    expect(rows[1].left).toBeNull();
    expect(rows[1].right?.text).toBe("y");
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.text).toBe("z");
  });

  it("上下文行打断块，后面的删除不会被配到前面的新增上", () => {
    // 关键回归：如果实现不在上下文行处 flush，-c 会被配到 +b 上，
    // 把 +b 顶到 c 的位置，两栏整体错位。
    const rows = splitHunk(
      firstHunk(
        ["@@ -1,3 +1,3 @@", "-a", "+b", " ctx", "-c", "+d"].join("\n"),
      ),
    );

    expect(rows).toHaveLength(3);
    expect(rows[0].left?.text).toBe("a");
    expect(rows[0].right?.text).toBe("b");
    expect(rows[1].left?.text).toBe("ctx");
    expect(rows[1].right?.text).toBe("ctx");
    expect(rows[2].left?.text).toBe("c");
    expect(rows[2].right?.text).toBe("d");
  });

  it("标记行横跨两栏", () => {
    // 标记行说的是"上一行没有结尾换行"，因此它出现在配对之后；渲染成横跨
    // 两栏的一整行，而不是塞进左或右某一侧。
    const rows = splitHunk(
      firstHunk(
        ["@@ -1,1 +1,1 @@", "-a", "+b", "\\ No newline at end of file"].join("\n"),
      ),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].left?.text).toBe("a");
    expect(rows[0].right?.text).toBe("b");
    expect(rows[1].meta?.kind).toBe("meta");
    expect(rows[1].left).toBeNull();
    expect(rows[1].right).toBeNull();
  });

  it("空 hunk 得到空数组", () => {
    expect(splitHunk({ header: "@@ -0,0 +0,0 @@", lines: [] })).toEqual([]);
  });

  it("行顺序与原始 hunk 一致", () => {
    const hunk = firstHunk(
      ["@@ -1,4 +1,4 @@", " keep", "-a", "+b", " tail"].join("\n"),
    );
    const rows = splitHunk(hunk);

    expect(rows.map((r) => r.left?.text ?? null)).toEqual(["keep", "a", "tail"]);
    expect(rows.map((r) => r.right?.text ?? null)).toEqual(["keep", "b", "tail"]);
  });
});
