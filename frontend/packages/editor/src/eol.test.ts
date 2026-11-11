import { describe, expect, it } from "vitest";

import { applyEol, detectEol, normalizeEol } from "./eol";

/**
 * 换行符处理值得单独测：CodeMirror 的文档模型只存 `\n`，而磁盘上的文件
 * 可能是 CRLF。两边不做归一，就会有两个用户可见的故障——切一次标签就多
 * 一个"未保存"圆点，以及在 CRLF 仓库里保存一次就把整个文件重写成 LF。
 * 这三条往返关系是修复的核心，回归代价远高于测试成本。
 */
describe("detectEol", () => {
  it("识别 CRLF", () => {
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
  });

  it("识别 LF", () => {
    expect(detectEol("a\nb\n")).toBe("\n");
  });

  it("没有换行符时按 LF 处理", () => {
    expect(detectEol("single line")).toBe("\n");
    expect(detectEol("")).toBe("\n");
  });

  it("混用时按 CRLF 处理：已含 CRLF 的文件保持原判", () => {
    // 混用本身就是异常内容，这里只要求判断稳定，不追求语义正确。
    expect(detectEol("a\r\nb\n")).toBe("\r\n");
  });
});

describe("normalizeEol", () => {
  it("把 CRLF 归一成 LF", () => {
    expect(normalizeEol("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("不动已经是 LF 的内容", () => {
    expect(normalizeEol("a\nb\n")).toBe("a\nb\n");
  });

  it("不动孤立的 CR（老式 Mac 换行不归这里管）", () => {
    expect(normalizeEol("a\rb")).toBe("a\rb");
  });
});

describe("applyEol", () => {
  it("CRLF 文件回写时还原成 CRLF", () => {
    expect(applyEol("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
  });

  it("LF 文件回写时保持 LF", () => {
    expect(applyEol("a\nb\n", "\n")).toBe("a\nb\n");
  });

  it("先归一再应用，避免重复转换出 \\r\\r\\n", () => {
    expect(applyEol("a\r\nb\r\n", "\r\n")).toBe("a\r\nb\r\n");
  });

  it("normalize 后 apply 能还原原文（往返不变）", () => {
    const crlf = "export const extra = 3;\r\n";
    expect(applyEol(normalizeEol(crlf), detectEol(crlf))).toBe(crlf);
  });

  it("LF 文件往返不变", () => {
    const lf = "export const lf = 4;\n";
    expect(applyEol(normalizeEol(lf), detectEol(lf))).toBe(lf);
  });
});
