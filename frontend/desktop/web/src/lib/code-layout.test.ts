import { describe, expect, it } from "vitest";

import { buildLayout, layoutAppliesTo, restoreLayout, tabName } from "@/lib/code-layout";

/**
 * 布局恢复的纯逻辑。
 *
 * 值得单独测的原因是这里的判断都关乎"要不要用这份数据"：套错了仓库会打开
 * 一堆不相干的文件，接受一个空布局会让用户以为恢复坏了。这些分支在界面里
 * 很难通过点击复现，但都是纯粹的输入输出。
 */

describe("tabName", () => {
  it("取斜杠路径的最后一段", () => {
    expect(tabName("src/lib/client.ts")).toBe("client.ts");
  });

  it("也能处理反斜杠路径", () => {
    expect(tabName("src\\lib\\client.ts")).toBe("client.ts");
  });

  it("没有分隔符时原样返回", () => {
    expect(tabName("README.md")).toBe("README.md");
  });
});

describe("layoutAppliesTo", () => {
  it("仓库 id 一致时适用", () => {
    expect(layoutAppliesTo({ workingCopyId: "abc", tabs: [], activePath: "", expanded: [] }, "abc")).toBe(true);
  });

  it("仓库 id 不同时不适用", () => {
    expect(layoutAppliesTo({ workingCopyId: "abc", tabs: [], activePath: "", expanded: [] }, "def")).toBe(false);
  });

  it("没有当前仓库时不适用", () => {
    expect(layoutAppliesTo({ workingCopyId: "abc", tabs: [], activePath: "", expanded: [] }, null)).toBe(false);
  });

  it("没有布局时不适用", () => {
    expect(layoutAppliesTo(null, "abc")).toBe(false);
    expect(layoutAppliesTo(undefined, "abc")).toBe(false);
  });
});

describe("restoreLayout", () => {
  const layout = {
    workingCopyId: "abc",
    tabs: ["src/lib/client.ts", "README.md"],
    activePath: "README.md",
    expanded: ["src", "src/lib"],
  };

  it("套用时同时还原标签名、当前文件与展开目录", () => {
    const got = restoreLayout(layout, "abc");

    expect(got).not.toBeNull();
    expect(got?.tabs).toEqual([
      { path: "src/lib/client.ts", name: "client.ts" },
      { path: "README.md", name: "README.md" },
    ]);
    expect(got?.activePath).toBe("README.md");
    expect(got?.expanded).toEqual(new Set(["src", "src/lib"]));
  });

  it("换仓库后不恢复", () => {
    expect(restoreLayout(layout, "def")).toBeNull();
  });

  it("没有标签时不恢复", () => {
    expect(restoreLayout({ ...layout, tabs: [], activePath: "" }, "abc")).toBeNull();
  });

  it("当前文件不在标签里时退到第一个", () => {
    const got = restoreLayout({ ...layout, activePath: "gone.ts" }, "abc");

    expect(got?.activePath).toBe("src/lib/client.ts");
  });

  it("当前文件为空时退到第一个", () => {
    const got = restoreLayout({ ...layout, activePath: "" }, "abc");

    expect(got?.activePath).toBe("src/lib/client.ts");
  });

  it("没有展开目录时给出空集合而不是 undefined", () => {
    const got = restoreLayout({ ...layout, expanded: null }, "abc");

    expect(got?.expanded).toEqual(new Set());
  });
});

describe("buildLayout", () => {
  it("把界面状态翻译成待存布局", () => {
    const got = buildLayout(
      "abc",
      [
        { path: "src/lib/client.ts", name: "client.ts" },
        { path: "README.md", name: "README.md" },
      ],
      "README.md",
      new Set(["src"]),
    );

    expect(got).toEqual({
      workingCopyId: "abc",
      tabs: ["src/lib/client.ts", "README.md"],
      activePath: "README.md",
      expanded: ["src"],
    });
  });

  it("没有当前文件时存空串", () => {
    const got = buildLayout("abc", [{ path: "a.ts", name: "a.ts" }], null, new Set());

    expect(got?.activePath).toBe("");
  });

  it("没有工作副本时不产出布局", () => {
    expect(buildLayout(null, [{ path: "a.ts", name: "a.ts" }], "a.ts", new Set())).toBeNull();
  });

  it("标签为空时仍产出一份空布局，用来覆盖掉旧记录", () => {
    // 用户把标签全关了再退出，下次打开不该又把它们恢复出来。
    const got = buildLayout("abc", [], null, new Set());

    expect(got).toEqual({ workingCopyId: "abc", tabs: [], activePath: "", expanded: [] });
  });
});
