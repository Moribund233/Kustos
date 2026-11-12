import { describe, expect, it } from "vitest";

import { compareWithHead, type LineMark } from "@/lib/head-diff";

/**
 * 行标对齐的纯逻辑测试。
 *
 * 这里回答的是"每一行相对 HEAD 是什么状态"，输入是两份文本、输出是逐行标记。
 * 行标错一行的后果是整块标记都错位，比不显示更糟，所以边界要逐条钉住：
 * 新增、删除、改写、CRLF、末尾换行、HEAD 缺失。
 */

/** 把标记数组压成便于断言的短串：`+` 新增、`~` 修改、`-` 删除挂点、`.` 未变。 */
function sig(marks: (LineMark | null)[]): string {
  return marks
    .map((m) => (m === "added" ? "+" : m === "modified" ? "~" : m === "removed" ? "-" : "."))
    .join("");
}

describe("compareWithHead", () => {
  it("内容一致时没有任何标记", () => {
    const out = compareWithHead("a\nb\nc", "a\nb\nc");
    expect(sig(out.marks)).toBe("...");
    expect(out.added).toBe(0);
    expect(out.removed).toBe(0);
  });

  it("FILE 未知时整份算新增", () => {
    const out = compareWithHead(null, "a\nb");
    expect(sig(out.marks)).toBe("++");
    expect(out.added).toBe(2);
  });

  it("中间插入一行只标那一行", () => {
    const out = compareWithHead("a\nb\nc", "a\nx\nb\nc");
    expect(sig(out.marks)).toBe(".+..");
    expect(out.added).toBe(1);
    expect(out.removed).toBe(0);
  });

  it("改写一行标成修改而不是删加", () => {
    const out = compareWithHead("a\nb\nc", "a\nB\nc");
    expect(sig(out.marks)).toBe(".~.");
    expect(out.added).toBe(1);
    expect(out.removed).toBe(1);
  });

  it("纯删除把标记挂在删除位置之后那一行", () => {
    const out = compareWithHead("a\nb\nc", "a\nc");
    expect(sig(out.marks)).toBe(".-");
    expect(out.removed).toBe(1);
  });

  it("删到文件末尾时标记退到最后一行", () => {
    const out = compareWithHead("a\nb\nc", "a\nb");
    // "a\nb" 只有两行，删除锚点落在最后一行。
    expect(sig(out.marks)).toBe(".-");
    expect(out.removed).toBe(1);
  });

  it("新增行数多于改写行数时逐行算新增", () => {
    const out = compareWithHead("a\nb\nz", "a\nx\ny\nz");
    expect(sig(out.marks)).toBe(".~~.");
    expect(out.added).toBe(2);
    expect(out.removed).toBe(1);
  });

  it("末尾换行产生的空行与编辑器行数同口径", () => {
    // "a\nb\n" 在 CodeMirror 里是 3 行（第三行是空行），行标数组也必须是 3 个。
    const out = compareWithHead("a\nb\n", "a\nb\n");
    expect(out.marks).toHaveLength(3);
    expect(sig(out.marks)).toBe("...");
  });

  it("CRLF 与 LF 不算改动", () => {
    const out = compareWithHead("a\r\nb\r\n", "a\nb\n");
    expect(out.added).toBe(0);
    expect(out.removed).toBe(0);
  });

  it("空文件对新文件时逐行新增", () => {
    const out = compareWithHead("", "a\nb");
    expect(sig(out.marks)).toBe("++");
  });

  it("清空文件时标记落在唯一的空行上", () => {
    const out = compareWithHead("a\nb", "");
    // 空文本在 split("\n") 下是 1 个空行，删除只能挂在这唯一一行上。
    expect(out.marks).toHaveLength(1);
    expect(sig(out.marks)).toBe("-");
    expect(out.removed).toBe(2);
  });

  it("两处独立改动各标各的", () => {
    const out = compareWithHead("a\nb\nc\nd\ne", "a\nB\nc\nd\nE");
    expect(sig(out.marks)).toBe(".~..~");
  });

  it("整篇重排时不把每一行都标成修改", () => {
    // 前后公共部分会被剥掉，剩下的是少数几行；这里确认不会退化成全标。
    const head = ["1", "2", "3", "4", "5"].join("\n");
    const cur = ["1", "2", "3", "4", "5", "6"].join("\n");
    const out = compareWithHead(head, cur);
    expect(sig(out.marks)).toBe(".....+");
  });
});
