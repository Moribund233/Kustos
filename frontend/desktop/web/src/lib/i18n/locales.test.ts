import { describe, expect, it } from "vitest";

import en from "./locales/en.ts";
import zh from "./locales/zh.ts";

/**
 * 语言一致性检查。
 *
 * 这类测试的价值不是"翻译对"，而是**抓住漏翻的键**：少一个键时 i18next
 * 会回落到中文，界面上突然冒出一句中文——比整页未翻译更像 bug。
 */

/** 把嵌套的资源摊平成点分路径。 */
function flatten(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  );
}

/** 去掉复数后缀，`x_one` / `x_other` 归一到 `x`。 */
function stripPlural(key: string): string {
  return key.replace(/_(one|other|zero|few|many)$/, "");
}

function keySet(resource: unknown): Set<string> {
  return new Set(flatten(resource).map(stripPlural));
}

describe("desktop locales", () => {
  it("中英两份文案的键完全一致", () => {
    const zhKeys = keySet(zh);
    const enKeys = keySet(en);

    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k)).sort();
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k)).sort();

    expect(missingInEn, "英文缺少这些键").toEqual([]);
    expect(missingInZh, "中文缺少这些键").toEqual([]);
  });

  it("没有空字符串文案", () => {
    const empties = flatten(zh).filter((k) => {
      const value = k.split(".").reduce<unknown>((acc, part) => {
        if (acc && typeof acc === "object") {
          return (acc as Record<string, unknown>)[part];
        }
        return undefined;
      }, zh);
      return typeof value === "string" && value.trim() === "";
    });
    expect(empties).toEqual([]);
  });

  it("中文文案里没有残留的英文占位", () => {
    const suspicious = flatten(zh).filter((k) => {
      const value = k.split(".").reduce<unknown>((acc, part) => {
        if (acc && typeof acc === "object") {
          return (acc as Record<string, unknown>)[part];
        }
        return undefined;
      }, zh);
      // 允许少量本身就是英文的术语（git、HTTP 等）。
      return typeof value === "string" && /^\s*(TODO|FIXME|PLACEHOLDER)\b/i.test(value);
    });
    expect(suspicious).toEqual([]);
  });
});


