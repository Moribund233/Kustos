import { describe, expect, it } from "vitest";

import {
  clampCursor,
  filterPaletteGroups,
  flattenPalette,
  type PaletteGroup,
} from "@/shell/command-palette";

/**
 * 命令面板的纯逻辑测试。
 *
 * 这些函数决定了"输入什么会看到什么、回车会执行哪个"，是面板里唯一
 * 能用单测覆盖的部分——组件本身只负责把它们接到键盘与 DOM 上。
 */

/** 造一组最小可用的动作。 */
function group(key: string, labels: string[]): PaletteGroup {
  return {
    key,
    label: key,
    actions: labels.map((label) => ({
      id: `${key}-${label}`,
      group: key,
      label,
      icon: "search" as const,
      run: () => undefined,
    })),
  };
}

describe("filterPaletteGroups", () => {
  const groups = [
    group("goto", ["Inbox", "Working copy", "Code"]),
    group("local", ["Quick open file", "Open in external editor"]),
  ];

  it("查询为空时原样返回，保持声明顺序", () => {
    expect(filterPaletteGroups(groups, "")).toEqual(groups);
    expect(filterPaletteGroups(groups, "   ")).toEqual(groups);
  });

  it("按子串匹配且大小写无关", () => {
    const hit = filterPaletteGroups(groups, "CODE");
    expect(hit).toHaveLength(1);
    expect(hit[0].actions.map((a) => a.label)).toEqual(["Code"]);
  });

  it("整组无命中时隐藏该组，而不是留下空标题", () => {
    const hit = filterPaletteGroups(groups, "editor");
    expect(hit.map((g) => g.key)).toEqual(["local"]);
    expect(hit[0].actions.map((a) => a.label)).toEqual(["Open in external editor"]);
  });

  it("全都不匹配时返回空数组", () => {
    expect(filterPaletteGroups(groups, "zzzz")).toEqual([]);
  });

  it("保留命中的组顺序", () => {
    const hit = filterPaletteGroups(groups, "o");
    // goto 的 "Inbox"、"Working copy"、"Code" 与 local 的两条都含 o 或 O。
    expect(hit.map((g) => g.key)).toEqual(["goto", "local"]);
  });
});

describe("flattenPalette", () => {
  it("按组顺序压平，供跨组键盘游标使用", () => {
    const flat = flattenPalette([
      group("a", ["x", "y"]),
      group("b", ["z"]),
    ]);
    expect(flat.map((a) => a.label)).toEqual(["x", "y", "z"]);
  });

  it("空输入返回空列表", () => {
    expect(flattenPalette([])).toEqual([]);
  });
});

describe("clampCursor", () => {
  it("把越界游标夹回最后一项", () => {
    // 过滤收窄结果时用户通常正在往下浏览，回落到末尾比回到 0 更可预期。
    expect(clampCursor(9, 3)).toBe(2);
  });

  it("负数游标回到 0", () => {
    expect(clampCursor(-1, 3)).toBe(0);
  });

  it("空列表时恒为 0，避免取到不存在的项", () => {
    expect(clampCursor(5, 0)).toBe(0);
  });

  it("合法游标原样返回", () => {
    expect(clampCursor(1, 3)).toBe(1);
  });
});
