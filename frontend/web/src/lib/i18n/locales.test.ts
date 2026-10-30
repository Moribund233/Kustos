import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import en from "./locales/en";
import zh from "./locales/zh";

/**
 * 词条完整性。
 *
 * 两类缺陷只有静态比对能拦住，运行时既不报错也不影响构建：
 *
 * 1. 中英文单边漏词条 —— 切到英文时该处会回退成中文，或者干脆空白。
 * 2. `t()` 传了不存在的键 —— i18next 缺键时原样返回键名，界面上直接
 *    显示 `code.collabDisconnected` 这样的原始键。后者真实发生过：
 *    协作状态表改成了「状态 → 词条键」，渲染处却漏了 t() 包裹。
 */

type Resource = { [key: string]: string | Resource };

/** 摊平成 "命名空间.键" 列表。 */
function flatten(node: Resource, prefix = ""): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : flatten(value, path);
  });
}

const ZH_KEYS = flatten(zh as unknown as Resource);
const EN_KEYS = flatten(en as unknown as Resource);

const SRC_DIR = join(process.cwd(), "src");

/** 递归收集源码，跳过词条目录自身与测试文件。 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "locales" ? [] : sourceFiles(full);
    }
    if (!/\.tsx?$/.test(name) || /\.(test|spec)\.tsx?$/.test(name)) return [];
    return [full];
  });
}

describe("i18n 词条", () => {
  it("中英文键集合一致", () => {
    expect([...ZH_KEYS].sort()).toEqual([...EN_KEYS].sort());
  });

  it("所有 t() 字面量键都已定义", () => {
    const known = new Set<string>(ZH_KEYS);
    const missing: string[] = [];

    for (const file of sourceFiles(SRC_DIR)) {
      const text = readFileSync(file, "utf-8");
      // 只检查字面量键；模板字符串与变量键（t(key)）无从静态判定
      for (const match of text.matchAll(/\bt\(\s*"([a-zA-Z]\w*\.[\w]+)"/g)) {
        const key = match[1];
        if (key && !known.has(key)) {
          missing.push(`${relative(SRC_DIR, file).replace(/\\/g, "/")} → ${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
