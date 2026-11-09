import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 静态资源完整性检查。
 *
 * 标题栏的 logo 曾经整个缺失：`public/brand/` 是空目录，图片请求 404，
 * 界面上只显示一个破损图标。这类问题不会被类型检查或单测抓到——
 * 代码里写的是字符串路径，编译期完全合法，只有运行时才暴露。
 */

const publicDir = join(process.cwd(), "public");
const brandDir = join(publicDir, "brand");

describe("brand assets", () => {
  it("标题栏 logo 存在", () => {
    const mark = join(brandDir, "kustos-mark.svg");
    expect(existsSync(mark), `缺少 ${mark}`).toBe(true);
  });

  it("favicon 与 app icon 存在", () => {
    expect(existsSync(join(brandDir, "favicon.svg"))).toBe(true);
    expect(existsSync(join(brandDir, "kustos-app-icon.svg"))).toBe(true);
  });

  it("logo 是有效的 SVG 且有实际内容", () => {
    const svg = readFileSync(join(brandDir, "kustos-mark.svg"), "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("viewBox");
    // 空文件或被截断的文件也会含 "<svg"，用路径元素确认它是完整的图形。
    expect(svg).toContain("<path");
  });

  it("index.html 引用的 brand 资源都真实存在", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
    const refs = [...html.matchAll(/href="\/brand\/([\w.-]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(existsSync(join(brandDir, ref)), `index.html 引用了不存在的 ${ref}`).toBe(true);
    }
  });

  it("代码里引用的 brand 资源都真实存在", () => {
    const shell = readFileSync(
      join(process.cwd(), "src/shell/shell.tsx"),
      "utf8",
    );
    const refs = [...shell.matchAll(/["'](\/brand\/[\w.-]+)["']/g)].map((m) => m[1]);
    for (const ref of refs) {
      const file = join(publicDir, ref.replace(/^\//, ""));
      expect(existsSync(file), `代码引用了不存在的 ${ref}`).toBe(true);
    }
  });
});
