import { describe, expect, it } from "vitest";

import { isWritable, precheck, saveSemantics, transition, type PrecheckInput } from "./doc-mode";

/** 一份"什么都对"的预检输入，各用例只覆盖自己关心的字段。 */
function input(patch: Partial<PrecheckInput> = {}): PrecheckInput {
  return {
    localBranch: "main",
    docBranch: "main",
    changed: false,
    draftAhead: 0,
    peers: 0,
    peersKnown: true,
    ...patch,
  };
}

/** 把发现压成短串，便于一眼看出顺序与阻塞性。 */
function sig(result: ReturnType<typeof precheck>): string {
  return result.issues.map((i) => `${i.step}${i.blocking ? "!" : ""}`).join(",");
}

describe("precheck", () => {
  it("分支一致、文件干净、无人在线时以本地内容开新会话", () => {
    const result = precheck(input());
    expect(result.action).toBe("seed");
    expect(result.issues).toEqual([]);
  });

  it("有人在线只能加入，不能拿本地内容覆盖别人", () => {
    const result = precheck(input({ peers: 2 }));
    expect(result.action).toBe("join");
    expect(result.issues).toEqual([]);
  });

  it("分支对不上时阻塞，并可选择切分支或只读观察", () => {
    const result = precheck(input({ localBranch: "feature", docBranch: "main" }));
    expect(result.action).toBe("blocked");
    expect(sig(result)).toBe("branch!");
    expect(result.issues[0].resolutions).toEqual(["checkout", "observe"]);
  });

  it("本地有未提交改动时阻塞，处置默认提交", () => {
    const result = precheck(input({ changed: true }));
    expect(result.action).toBe("blocked");
    expect(result.issues[0].resolutions).toEqual(["commit", "stash", "discard", "seed"]);
  });

  it("有人在线时不给「以本地为准」：那会把别人的内容顶掉", () => {
    const result = precheck(input({ changed: true, peers: 2 }));
    expect(result.issues[0].resolutions).toEqual(["commit", "stash", "discard"]);
  });

  it("感知不可用时也不给「以本地为准」", () => {
    // 空清单既可能"真没人"也可能"感知坏了"，后者下 seed 会顶掉别人的内容。
    const result = precheck(input({ changed: true, peersKnown: false }));
    expect(result.issues[0].resolutions).not.toContain("seed");
  });

  it("缓冲区还有没写盘的改动时也阻塞，只能先保存或只读观察", () => {
    const result = precheck(input({ unsaved: true }));
    expect(result.action).toBe("blocked");
    expect(sig(result)).toBe("local!");
    expect(result.issues[0].code).toBe("unsaved-buffer");
    expect(result.issues[0].resolutions).toEqual(["save", "observe", "seed"]);
  });

  it("有人在线时未保存缓冲区也不给「以本地为准」", () => {
    const result = precheck(input({ unsaved: true, peers: 1 }));
    expect(result.issues[0].resolutions).toEqual(["save", "observe"]);
  });

  it("磁盘改动与未保存改动同时存在时排在同一个步骤里", () => {
    const result = precheck(input({ changed: true, unsaved: true }));
    expect(sig(result)).toBe("local!,local!");
    expect(result.issues.map((i) => i.code)).toEqual(["local-changes", "unsaved-buffer"]);
  });

  it("两个阻塞项同时存在时按步骤顺序都列出来", () => {
    const result = precheck(input({ localBranch: "feature", changed: true, peers: 1 }));
    expect(sig(result)).toBe("branch!,local!");
  });

  it("线上草稿领先只是提示，不阻塞", () => {
    const result = precheck(input({ draftAhead: 3 }));
    expect(result.action).toBe("seed");
    expect(sig(result)).toBe("draft");
    expect(result.issues[0].count).toBe(3);
  });

  it("感知不可用时按有人在线处理，绝不 seed", () => {
    const result = precheck(input({ peersKnown: false }));
    expect(result.action).toBe("join");
    expect(sig(result)).toBe("peers");
    expect(result.issues[0].blocking).toBe(false);
  });

  it("感知不可用又没人看到连接时仍然不给 seed", () => {
    // 空清单既可能"真没人"也可能"感知坏了"，后者下 seed 会顶掉别人的内容。
    const result = precheck(input({ peers: 0, peersKnown: false }));
    expect(result.action).not.toBe("seed");
  });

  it("阻塞项的优先级高于在线人数：本地改动没处理就不进会话", () => {
    const result = precheck(input({ changed: true, peers: 5, draftAhead: 1 }));
    expect(result.action).toBe("blocked");
    expect(sig(result)).toBe("local!,draft");
  });
});

describe("transition", () => {
  it("从磁盘进入协作", () => {
    expect(transition("disk", "enter")).toBe("live");
  });

  it("退出协作回到磁盘", () => {
    expect(transition("live", "leave")).toBe("disk");
  });

  it("被踢只降级成观察，不回到磁盘", () => {
    expect(transition("live", "kick")).toBe("observe");
  });

  it("断线不改变模式：离线仍可编辑、重连自动合并", () => {
    expect(transition("live", "disconnect")).toBe("live");
    expect(transition("live", "reconnect")).toBe("live");
  });

  it("磁盘模式下的无关事件不改变状态", () => {
    expect(transition("disk", "leave")).toBe("disk");
    expect(transition("disk", "kick")).toBe("disk");
    expect(transition("observe", "enter")).toBe("observe");
  });

  it("观察模式不能再被踢成别的状态", () => {
    expect(transition("observe", "kick")).toBe("observe");
  });
});

describe("saveSemantics", () => {
  it("三种模式的保存语义各不相同", () => {
    expect(saveSemantics("disk")).toBe("disk");
    expect(saveSemantics("live")).toBe("draft");
    expect(saveSemantics("observe")).toBe("none");
  });

  it("只有协作与磁盘模式可写", () => {
    expect(isWritable("disk")).toBe(true);
    expect(isWritable("live")).toBe(true);
    expect(isWritable("observe")).toBe(false);
  });
});
