import { describe, expect, it } from "vitest";

import { relativePathFromUri, toFileUri } from "@/lib/lsp-uri";

/**
 * 路径与 URI 的互转值得测：写错不会报错，只会让语言服务器"什么都找不到"。
 * 两个方向的边界（盘符、空格、中文、仓库外的文件）都要钉住。
 */
describe("toFileUri", () => {
  it("Windows 盘符路径要写成三段斜杠", () => {
    expect(toFileUri("D:\\proj\\demo")).toBe("file:///D:/proj/demo");
  });

  it("拼上仓库内相对路径", () => {
    expect(toFileUri("D:\\proj\\demo", "src/main.go")).toBe("file:///D:/proj/demo/src/main.go");
  });

  it("POSIX 路径保持单斜杠形态", () => {
    expect(toFileUri("/home/me/demo", "src/a.ts")).toBe("file:///home/me/demo/src/a.ts");
  });

  it("空格与中文要编码", () => {
    expect(toFileUri("/home/me/my repo", "文件 一.ts")).toBe(
      "file:///home/me/my%20repo/%E6%96%87%E4%BB%B6%20%E4%B8%80.ts",
    );
  });

  it("忽略根本身多余的尾斜杠与相对路径的前导斜杠", () => {
    expect(toFileUri("D:\\proj\\demo\\", "/src/a.go")).toBe("file:///D:/proj/demo/src/a.go");
  });
});

describe("relativePathFromUri", () => {
  it("取回仓库内相对路径", () => {
    expect(relativePathFromUri("D:\\proj\\demo", "file:///D:/proj/demo/src/main.go")).toBe(
      "src/main.go",
    );
  });

  it("根目录本身返回空串", () => {
    expect(relativePathFromUri("D:\\proj\\demo", "file:///D:/proj/demo")).toBe("");
  });

  it("盘符大小写不敏感", () => {
    expect(relativePathFromUri("d:\\proj\\demo", "file:///D:/proj/demo/a.go")).toBe("a.go");
  });

  it("仓库外的文件返回 null 而不是抛错", () => {
    expect(relativePathFromUri("D:\\proj\\demo", "file:///C:/Go/src/fmt/print.go")).toBeNull();
  });

  it("前缀相同但并非子目录时不算仓库内", () => {
    expect(relativePathFromUri("/home/me/demo", "file:///home/me/demo-other/a.ts")).toBeNull();
  });

  it("还原被编码的段", () => {
    expect(relativePathFromUri("/home/me/my repo", "file:///home/me/my%20repo/a%20b.ts")).toBe(
      "a b.ts",
    );
  });

  it("非 file URI 返回 null", () => {
    expect(relativePathFromUri("D:\\proj\\demo", "untitled:Untitled-1")).toBeNull();
  });
});
