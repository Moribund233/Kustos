import { describe, expect, it } from "vitest";

import {
  REVIEW_DRAFTS_KEY,
  addDraft,
  clearDrafts,
  draftScope,
  readDrafts,
  removeDraft,
  updateDraft,
  writeDrafts,
  type DraftStorage,
  type ReviewDraft,
} from "@/lib/pr-drafts";

/**
 * 本地评审草稿的存储测试。
 *
 * 这里全部用内存假 Storage，不碰浏览器全局：草稿层的全部价值就是"关窗以后
 * 还在"，而它唯一可能出错的地方是把存储里的数据读坏、或者写的时候把别人踩掉。
 * 这两件事都只在存储层能验证，交给界面测试看不出区别。
 */

/** 一个只有三件事的内存 Storage（`Map` 本身就够用）。 */
function fakeStorage(initial?: Record<string, string>): DraftStorage {
  const cells = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key) => cells.get(key) ?? null,
    setItem: (key, value) => {
      cells.set(key, value);
    },
    removeItem: (key) => {
      cells.delete(key);
    },
  };
}

/** 直接读回键的原文，用于断言"键还在不在"。 */
function rawValue(storage: DraftStorage): string | null {
  return storage.getItem(REVIEW_DRAFTS_KEY);
}

/** 直接把一份任意 payload 写进键里，模拟存储被外部写坏。 */
function seed(storage: DraftStorage, value: string): void {
  storage.setItem(REVIEW_DRAFTS_KEY, value);
}

/** 造一条完整的草稿，供需要"好数据旁边混着坏数据"的用例使用。 */
function goodDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    id: "d-1",
    lineNumber: 12,
    filePath: "src/app.ts",
    content: "这里为什么要重试两次？",
    createdAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("addDraft / readDrafts 的往返", () => {
  it("写进去的草稿能原样读回来", () => {
    // 往返是这一层最基本的承诺：字段少一个，界面上就有一条意见挂不上行或没有时间。
    const storage = fakeStorage();
    const scope = draftScope("i1", "repo-1", 42);
    const now = new Date("2026-05-20T12:00:00.000Z");

    const written = addDraft(
      storage,
      scope,
      { filePath: "src/app.ts", lineNumber: 12, content: "这里为什么要重试两次？" },
      now,
    );
    expect(written).toHaveLength(1);

    const read = readDrafts(storage, scope);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({
      filePath: "src/app.ts",
      lineNumber: 12,
      content: "这里为什么要重试两次？",
      createdAt: "2026-05-20T12:00:00.000Z",
    });
    // id 由 addDraft 生成，必须是可区分的字符串，否则删改会误伤另一条。
    expect(read[0].id).not.toBe("");
    expect(read[0].id).toBe(written[0].id);
  });

  it("会话级评论（不挂行）的 lineNumber 是 null，且两条草稿的 id 不同", () => {
    // 走文件级的整体评价是正常用法，不该被"必须有行号"卡住。
    const storage = fakeStorage();
    const scope = draftScope("i1", "repo-1", 42);

    const list = addDraft(storage, scope, { filePath: "", lineNumber: null, content: "整体看没问题" });
    const after = addDraft(storage, scope, { filePath: "", lineNumber: null, content: "但测试少了" });

    expect(list).toHaveLength(1);
    expect(after).toHaveLength(2);
    expect(after[0].lineNumber).toBeNull();
    expect(after[0].id).not.toBe(after[1].id);
  });

  it("没有键时读出来是空数组，不是 null", () => {
    // 界面直接 map 这个返回值，null 会让首次打开评审窗口就崩。
    expect(readDrafts(fakeStorage(), draftScope("i1", "repo-1", 1))).toEqual([]);
  });
});

describe("作用域隔离", () => {
  it("A 的草稿对 B 不可见", () => {
    const storage = fakeStorage();
    const a = draftScope("i1", "repo-1", 1);
    const b = draftScope("i1", "repo-1", 2);

    addDraft(storage, a, { filePath: "a.ts", lineNumber: 1, content: "只属于 A" });
    expect(readDrafts(storage, b)).toEqual([]);
  });

  it("写 B 不会抹掉 A：整张表一起改，而不是整键覆盖", () => {
    // 这一条专门咬住"换个 PR 就把上一个 PR 的草稿写没了"的偷懒实现：
    // 所有作用域共用同一个键，写 B 时如果直接 setItem(JSON.stringify(B))，
    // A 会静默消失，而用户只会发现自己的意见没了、也复现不出来。
    const storage = fakeStorage();
    const a = draftScope("i1", "repo-1", 1);
    const b = draftScope("i1", "repo-1", 2);

    addDraft(storage, a, { filePath: "a.ts", lineNumber: 1, content: "属于 A" });
    addDraft(storage, b, { filePath: "b.ts", lineNumber: 2, content: "属于 B" });

    expect(readDrafts(storage, a).map((d) => d.content)).toEqual(["属于 A"]);
    expect(readDrafts(storage, b).map((d) => d.content)).toEqual(["属于 B"]);

    // 清空 B 也只清 B。
    clearDrafts(storage, b);
    expect(readDrafts(storage, b)).toEqual([]);
    expect(readDrafts(storage, a).map((d) => d.content)).toEqual(["属于 A"]);
  });

  it("不同实例即使用同一个仓库/编号也不共享草稿", () => {
    // 桌面端可以同时连多个实例，PR 编号是仓库内序号，撞号是常态。
    const storage = fakeStorage();
    const one = draftScope("i1", "repo-1", 42);
    const two = draftScope("i2", "repo-1", 42);

    addDraft(storage, one, { filePath: "a.ts", lineNumber: 1, content: "实例一" });
    expect(readDrafts(storage, two)).toEqual([]);
  });
});

describe("readDrafts 对损坏数据的收敛", () => {
  it("非 JSON 垃圾返回空数组，不抛错", () => {
    // 存储是外部可写的（别的版本、手工改、写了一半断电），解析失败必须
    // 收敛成"没有草稿"，而不是让整个评审窗口读不出东西。
    const storage = fakeStorage();
    seed(storage, "{ this is not json");

    expect(() => readDrafts(storage, "any")).not.toThrow();
    expect(readDrafts(storage, "any")).toEqual([]);
  });

  it("JSON 合法但不是对象（数组 / 字符串 / 数字 / null）一律返回空", () => {
    // `'[]'` 与 `'null'` 都能过 JSON.parse，套对象处理会在取字段时炸。
    for (const payload of ["[]", '"drafts"', "42", "null", "true"]) {
      const storage = fakeStorage();
      seed(storage, payload);
      expect(readDrafts(storage, "a|r|1")).toEqual([]);
    }
  });

  it("作用域条目不是数组时返回空", () => {
    const storage = fakeStorage();
    seed(storage, '{"a|r|1":{"b":1}}');
    expect(readDrafts(storage, "a|r|1")).toEqual([]);
  });

  it("好坏混杂时只保留成形的条目", () => {
    // 存储里有一条坏数据不该连累同作用域里写好的意见——那是用户的劳动成果。
    const storage = fakeStorage();
    const good = goodDraft();
    seed(
      storage,
      JSON.stringify({
        "a|r|1": [
          good,
          { id: "d-2", lineNumber: 3, filePath: "b.ts", createdAt: "" }, // 缺 content
          { id: "d-3", lineNumber: "3", filePath: "c.ts", content: "行号是字符串" },
          "不是对象",
          42,
          null,
        ],
      }),
    );

    const read = readDrafts(storage, "a|r|1");
    expect(read).toHaveLength(2);
    expect(read[0].id).toBe("d-1");
    // 正文好的条目保留，坏的行号降级为 null（会话级），而不是整条丢弃。
    expect(read[1]).toMatchObject({ id: "d-3", lineNumber: null });
  });

  it("正文是空串或纯空白的条目被丢弃", () => {
    // 空笔记在 diff 上只是一个看不见的标记，点开一片空白。
    const storage = fakeStorage();
    seed(
      storage,
      JSON.stringify({
        "a|r|1": [
          goodDraft({ id: "ok" }),
          goodDraft({ id: "empty", content: "" }),
          goodDraft({ id: "blank", content: "   \n\t " }),
        ],
      }),
    );

    expect(readDrafts(storage, "a|r|1").map((d) => d.id)).toEqual(["ok"]);
  });
});

describe("lineNumber 的收敛", () => {
  it("0 / 负数 / 小数 / 字符串数字都降级为 null，正整数保留", () => {
    // 行号是服务端定位用的：把 0 或 1.5 原样发上去，评论要么挂不上，要么
    // 落到别人那行下面，比不定位更糟。
    const cases: Array<[unknown, number | null]> = [
      [0, null],
      [-3, null],
      [1.5, null],
      ["7", null],
      [7, 7],
      [null, null],
    ];

    for (const [raw, expected] of cases) {
      const storage = fakeStorage();
      seed(
        storage,
        JSON.stringify({
          "a|r|1": [{ id: "d-1", lineNumber: raw, filePath: "a.ts", content: "x", createdAt: "" }],
        }),
      );
      expect(readDrafts(storage, "a|r|1")[0]?.lineNumber).toBe(expected);
    }
  });

  it("addDraft 写入时也做同样的降级，不把坏行号存进去", () => {
    const storage = fakeStorage();
    const scope = "a|r|1";
    const stringy = "7" as unknown as number;

    addDraft(storage, scope, { filePath: "a.ts", lineNumber: 0, content: "零" });
    addDraft(storage, scope, { filePath: "a.ts", lineNumber: 1.5, content: "小数" });
    addDraft(storage, scope, { filePath: "a.ts", lineNumber: stringy, content: "字符串" });

    expect(readDrafts(storage, scope).map((d) => d.lineNumber)).toEqual([null, null, null]);
  });
});

describe("空正文的拒绝", () => {
  it("addDraft 收到空串或纯空白时抛错，且不留下半条草稿", () => {
    // 空意见提交上去只会变成一条别人看不到内容的评论；在入口就挡住，
    // 界面上才可能给出"意见不能为空"的提示。
    const storage = fakeStorage();
    const scope = "a|r|1";

    expect(() => addDraft(storage, scope, { filePath: "a.ts", lineNumber: 1, content: "" })).toThrow(
      Error,
    );
    expect(() =>
      addDraft(storage, scope, { filePath: "a.ts", lineNumber: 1, content: " \n\t " }),
    ).toThrow(Error);
    expect(readDrafts(storage, scope)).toEqual([]);
  });

  it("updateDraft 改成空白时抛错，已存的草稿原样不动", () => {
    // 改一个字改成空白，多半是误删了全文；此时把草稿清空等于替用户做了
    // 一个他没表达的删除决定。
    const storage = fakeStorage();
    const scope = "a|r|1";
    const [draft] = addDraft(storage, scope, {
      filePath: "a.ts",
      lineNumber: 1,
      content: "原正文",
    });

    expect(() => updateDraft(storage, scope, draft.id, "   ")).toThrow(Error);
    expect(readDrafts(storage, scope).map((d) => d.content)).toEqual(["原正文"]);
  });
});

describe("updateDraft / removeDraft 的边界", () => {
  it("updateDraft 改正文后列表与存储都更新，其他字段不动", () => {
    const storage = fakeStorage();
    const scope = "a|r|1";
    const [draft] = addDraft(storage, scope, {
      filePath: "a.ts",
      lineNumber: 7,
      content: "旧",
    });

    const next = updateDraft(storage, scope, draft.id, "新");
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: draft.id,
      content: "新",
      filePath: "a.ts",
      lineNumber: 7,
      createdAt: draft.createdAt,
    });
    expect(readDrafts(storage, scope)[0].content).toBe("新");
  });

  it("删不存在的 id 返回原列表，不抛错", () => {
    // 双击删除、两个窗口同时删都会走到这里；为一次陈旧的 UI 事件抛错
    // 会把整个评审窗口带崩。
    const storage = fakeStorage();
    const scope = "a|r|1";
    addDraft(storage, scope, { filePath: "a.ts", lineNumber: 1, content: "留着" });

    const before = readDrafts(storage, scope);
    const after = removeDraft(storage, scope, "does-not-exist");

    expect(after).toEqual(before);
    expect(readDrafts(storage, scope)).toEqual(before);
  });

  it("updateDraft 改不存在的 id 也不抛错", () => {
    const storage = fakeStorage();
    const scope = "a|r|1";
    expect(updateDraft(storage, scope, "missing", "随便写点")).toEqual([]);
  });

  it("删掉最后一条后作用域消失，再读是空数组", () => {
    const storage = fakeStorage();
    const scope = "a|r|1";
    const [draft] = addDraft(storage, scope, { filePath: "a.ts", lineNumber: 1, content: "x" });

    expect(removeDraft(storage, scope, draft.id)).toEqual([]);
    expect(readDrafts(storage, scope)).toEqual([]);
  });
});

describe("writeDrafts 的空列表", () => {
  it("写空数组时把键整个删掉，不留 `{}` 空壳", () => {
    // 空壳会让"本机到底有没有草稿"这个问题永远答不上来，也让每次启动都
    // 多写一次存储。
    const storage = fakeStorage();
    const scope = "a|r|1";
    addDraft(storage, scope, { filePath: "a.ts", lineNumber: 1, content: "x" });
    expect(rawValue(storage)).not.toBeNull();

    writeDrafts(storage, scope, []);
    expect(rawValue(storage)).toBeNull();
  });

  it("一个作用域空但别的作用域还有草稿时，键保留且只剩别的作用域", () => {
    const storage = fakeStorage();
    const a = "i1|r1|1";
    const b = "i1|r1|2";
    writeDrafts(storage, a, [goodDraft({ id: "a-1" })]);
    writeDrafts(storage, b, [goodDraft({ id: "b-1" })]);

    writeDrafts(storage, a, []);

    expect(readDrafts(storage, a)).toEqual([]);
    expect(readDrafts(storage, b).map((d) => d.id)).toEqual(["b-1"]);
    expect(rawValue(storage)).not.toBeNull();
  });
});

describe("draftScope", () => {
  it("没有实例时用短横线占位，有实例时原样拼进去", () => {
    // 三段各自有意义：实例、仓库、仓库内编号。少写一段就会让不同实例的
    // 同名 PR 共享同一份草稿，用户会看到别人评审窗里的意见。
    expect(draftScope(null, "r1", 42)).toBe("-|r1|42");
    expect(draftScope("i1", "r1", 42)).toBe("i1|r1|42");
  });

  it("空白实例 ID 也按没有实例处理，编号取整", () => {
    // 空白串拼出的 ` |r1|42` 看不出缺了哪一段，排查时无从下手。
    expect(draftScope("  ", "r1", 42)).toBe("-|r1|42");
    expect(draftScope("i1", "r1", 42.9)).toBe("i1|r1|42");
  });
});
