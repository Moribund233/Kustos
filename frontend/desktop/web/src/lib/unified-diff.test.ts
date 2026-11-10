import { describe, expect, it } from "vitest";

import { diffStats, parseUnifiedDiff, type DiffLine } from "@/lib/unified-diff";

/**
 * unified diff 解析的纯逻辑测试。
 *
 * 详情区显示哪几行、行号标得对不对，全由这里决定；输入是 `git diff` 的原始
 * 文本，边界情况完全由 git 的输出格式决定，不测就等于把不确定性留给用户。
 */

/** 一段两 hunk 的完整 diff，带齐 git 会输出的各类文件头噪声。 */
const TWO_HUNKS = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 3f9c1a2..b7d4e55 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 22;",
  "+const c = 3;",
  " export {};",
  "@@ -20,2 +21,2 @@ function tail() {",
  "-  return 1;",
  "+  return 2;",
  " }",
].join("\n");

/** 把某个 hunk 里的内容行摊平成便于整体比对的形式。 */
function plain(lines: DiffLine[]): Array<[string, string, number | null, number | null]> {
  return lines.map((l) => [l.kind, l.text, l.oldLine, l.newLine]);
}

describe("parseUnifiedDiff 的空输入", () => {
  it("null / undefined / 空串 / 纯空白都返回带说明的空结果", () => {
    for (const raw of [null, undefined, "", "   ", "\n\n", "  \t \n "]) {
      const parsed = parseUnifiedDiff(raw);
      expect(parsed.hunks).toEqual([]);
      expect(parsed.binary).toBe(false);
      // "这个文件没有差异"是正常状态，不该抛错，也不该让详情区一片空白：
      // note 是个标识，翻译由调用方按语言查表。
      expect(parsed.note).toBe("noDiff");
    }
  });

  it("只有文件头、没有 hunk 时也算没有可显示内容", () => {
    const parsed = parseUnifiedDiff(
      ["diff --git a/tool.sh b/tool.sh", "old mode 100644", "new mode 100755"].join("\n"),
    );
    expect(parsed.hunks).toEqual([]);
    expect(parsed.binary).toBe(false);
    expect(parsed.note).toBe("noDiff");
  });
});

describe("parseUnifiedDiff 的二进制标记", () => {
  it("`Binary files` 标记不当作文本内容解析", () => {
    const parsed = parseUnifiedDiff("Binary files a/logo.png and b/logo.png differ");
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toEqual([]);
    // 二进制要给专门的说明，不能复用 noDiff 的"没有差异"。
    expect(parsed.note).toBe("binary");
  });

  it("`GIT binary patch` 同样识别为二进制", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/icon.bin b/icon.bin",
        "index 000..111 100644",
        "GIT binary patch",
        "literal 12",
        "TcmZ?wbhEHbRA2Nf00000",
      ].join("\n"),
    );
    expect(parsed.binary).toBe(true);
    expect(parsed.note).toBe("binary");
  });
});

describe("parseUnifiedDiff 的文件头噪声", () => {
  it("diff --git / index / --- / +++ 不进内容行", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    expect(parsed.binary).toBe(false);
    expect(parsed.note).toBe("");
    expect(parsed.hunks).toHaveLength(2);

    const texts = parsed.hunks.flatMap((h) => h.lines.map((l) => l.text));
    for (const text of texts) {
      expect(text).not.toMatch(/^diff --git /);
      expect(text).not.toMatch(/^index /);
      expect(text).not.toMatch(/^--- /);
      expect(text).not.toMatch(/^\+\+\+ /);
    }
  });

  it("文件头出现在两个文件之间时，前一个 hunk 不会被后续内容污染", () => {
    const raw = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/b.txt b/b.txt",
      "rename from a/b.txt",
      "rename to b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -3 +3 @@",
      "-p",
      "+q",
    ].join("\n");

    const parsed = parseUnifiedDiff(raw);
    expect(parsed.hunks.map((h) => h.header)).toEqual(["@@ -1 +1 @@", "@@ -3 +3 @@"]);
    expect(plain(parsed.hunks[0].lines)).toEqual([
      ["remove", "x", 1, null],
      ["add", "y", null, 1],
    ]);
    expect(plain(parsed.hunks[1].lines)).toEqual([
      ["remove", "p", 3, null],
      ["add", "q", null, 3],
    ]);
  });

  it("rename / mode / similarity 这类噪声不会单独造出一个 hunk", () => {
    const raw = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");

    const parsed = parseUnifiedDiff(raw);
    expect(parsed.hunks).toHaveLength(1);
    expect(plain(parsed.hunks[0].lines)).toEqual([
      ["remove", "a", 1, null],
      ["add", "b", null, 1],
    ]);
  });
});

describe("parseUnifiedDiff 的 hunk 与行号", () => {
  it("按 hunk 分组，header 原样保留供折叠标题使用", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    expect(parsed.hunks.map((h) => h.header)).toEqual([
      "@@ -1,3 +1,4 @@",
      "@@ -20,2 +21,2 @@ function tail() {",
    ]);
  });

  it("上下文行两侧行号一起推进，新增行只推右侧，删除行只推左侧", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    expect(plain(parsed.hunks[0].lines)).toEqual([
      ["context", "const a = 1;", 1, 1],
      ["remove", "const b = 2;", 2, null],
      ["add", "const b = 22;", null, 2],
      ["add", "const c = 3;", null, 3],
      ["context", "export {};", 3, 4],
    ]);
  });

  it("起始行号取自 header 的两个数字，而不是从 1 数起", () => {
    const parsed = parseUnifiedDiff(
      ["@@ -5,3 +8,4 @@ fn", " a", "-b", "+c", "+d", " e"].join("\n"),
    );
    expect(plain(parsed.hunks[0].lines)).toEqual([
      ["context", "a", 5, 8],
      ["remove", "b", 6, null],
      ["add", "c", null, 9],
      ["add", "d", null, 10],
      ["context", "e", 7, 11],
    ]);
  });

  it("省略行数的 header（`@@ -1 +1 @@`）按单行处理", () => {
    const parsed = parseUnifiedDiff(["@@ -1 +1 @@", "-旧", "+新"].join("\n"));
    expect(plain(parsed.hunks[0].lines)).toEqual([
      ["remove", "旧", 1, null],
      ["add", "新", null, 1],
    ]);
  });

  it("新文件（`@@ -0,0 +1,2 @@`）只有新增行，左侧行号为空", () => {
    const parsed = parseUnifiedDiff(["@@ -0,0 +1,2 @@", "+x", "+y"].join("\n"));
    expect(plain(parsed.hunks[0].lines)).toEqual([
      ["add", "x", null, 1],
      ["add", "y", null, 2],
    ]);
  });
});

describe("parseUnifiedDiff 对 `\\ No newline at end of file` 的处理", () => {
  it("标记行是 meta 而不是内容行，且不占行号", () => {
    const raw = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "+tail",
      " ctx",
    ].join("\n");

    const parsed = parseUnifiedDiff(raw);
    expect(plain(parsed.hunks[0].lines)).toEqual([
      ["remove", "old", 1, null],
      ["meta", "\\ No newline at end of file", null, null],
      ["add", "new", null, 1],
      ["add", "tail", null, 2],
      ["context", "ctx", 2, 3],
    ]);
  });

  it("删除侧与新增侧各带一条标记时都保留，且顺序不乱", () => {
    const raw = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");

    const kinds = parseUnifiedDiff(raw).hunks[0].lines.map((l) => l.kind);
    expect(kinds).toEqual(["remove", "meta", "add", "meta"]);
  });
});

describe("parseUnifiedDiff 不对内容行套用文件头规则", () => {
  // hunk 的边界必须由 hunk 头里的行数决定，不能由行前缀推断。
  // 这两条都是真实踩过的数据丢失，不是假想边界。

  it("被删除的 `--- 注释` 不会中断 hunk，后续行不丢", () => {
    // 一行被删除的 SQL/Lua/Haskell 注释在 diff 里正是 `--- 旧注释`，
    // 按 `--- ` 前缀判断会被误当成文件头，整段内容随之消失。
    const raw = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,3 +1,2 @@",
      " select 1;",
      "--- 旧注释",
      " select 2;",
    ].join("\n");

    const parsed = parseUnifiedDiff(raw);
    expect(parsed.hunks).toHaveLength(1);
    expect(plain(parsed.hunks[0].lines)).toEqual([
      ["context", "select 1;", 1, 1],
      ["remove", "-- 旧注释", 2, null],
      ["context", "select 2;", 3, 2],
    ]);
  });

  it("内容里出现 `Binary files` 字样不会让整份 diff 变成二进制", () => {
    const raw = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1 +1,2 @@",
      " text",
      "+Binary files are listed below",
    ].join("\n");

    const parsed = parseUnifiedDiff(raw);
    expect(parsed.binary).toBe(false);
    expect(parsed.note).toBe("");
    expect(parsed.hunks[0].lines.map((l) => l.kind)).toEqual(["context", "add"]);
  });

  it("零内容行的 hunk 被丢弃，不留空块", () => {
    // 只剩折叠标题、一行内容都没有的块在详情区看起来像 bug。
    const parsed = parseUnifiedDiff("@@ -1,2 +1,2 @@");
    expect(parsed.hunks).toEqual([]);
    expect(parsed.note).toBe("noDiff");
  });

  it("CRLF 输入的 `\\r` 不会留在 header 与内容行里", () => {
    // Windows 上未规范化的 diff 会带 `\r`；它混进 header 后是不可见字符，
    // 着色看不出问题，但复制出来的文本与按行宽的布局都会带上它。
    const raw = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\r\n");

    const parsed = parseUnifiedDiff(raw);
    expect(parsed.hunks[0].header).toBe("@@ -1 +1 @@");
    expect(parsed.hunks[0].lines.map((l) => l.text)).toEqual(["old", "new"]);
  });
});

describe("diffStats", () => {
  it("只统计新增与删除，上下文行与 meta 行不计入", () => {
    const parsed = parseUnifiedDiff(
      [
        "@@ -1,3 +1,4 @@",
        " ctx",
        "-gone",
        "\\ No newline at end of file",
        "+one",
        "+two",
        " ctx2",
      ].join("\n"),
    );
    expect(diffStats(parsed)).toEqual({ added: 2, removed: 1 });
  });

  it("多个 hunk 累加", () => {
    expect(diffStats(parseUnifiedDiff(TWO_HUNKS))).toEqual({ added: 3, removed: 2 });
  });

  it("没有内容（空 diff / 纯顶栏）时两边都是 0", () => {
    expect(diffStats(parseUnifiedDiff(""))).toEqual({ added: 0, removed: 0 });
    expect(diffStats(parseUnifiedDiff("diff --git a/a b/a"))).toEqual({ added: 0, removed: 0 });
    expect(diffStats(parseUnifiedDiff("Binary files a/x and b/x differ"))).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it("只有新增或只有删除时另一侧为 0", () => {
    expect(diffStats(parseUnifiedDiff("@@ -0,0 +1,2 @@\n+x\n+y"))).toEqual({ added: 2, removed: 0 });
    expect(diffStats(parseUnifiedDiff("@@ -7,2 +6,0 @@\n-a\n-b"))).toEqual({ added: 0, removed: 2 });
  });
});
