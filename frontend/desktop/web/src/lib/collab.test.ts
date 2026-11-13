import { describe, expect, it } from "vitest";

import {
  collabDocumentKey,
  collabDraftBranch,
  collabKickReason,
  collabPeerCount,
  collabSocketUrl,
  collabUserColor,
  parseCollabDocumentKey,
  saveErrorIsKick,
} from "./collab";
import { activePathCounts, collabActiveUrl, connectionsFor } from "./collab-active";

describe("collabDocumentKey", () => {
  it("按 repositoryId:branch:path 拼装", () => {
    expect(collabDocumentKey("repo-1", "main", "src/app.tsx")).toBe("repo-1:main:src/app.tsx");
  });

  it("路径里的冒号不参与切分", () => {
    const key = collabDocumentKey("repo-1", "main", "docs/a:b.md");
    expect(parseCollabDocumentKey(key)).toEqual({
      repositoryId: "repo-1",
      branch: "main",
      path: "docs/a:b.md",
    });
  });
});

describe("parseCollabDocumentKey", () => {
  it("拆出三段", () => {
    expect(parseCollabDocumentKey("r:b:p")).toEqual({ repositoryId: "r", branch: "b", path: "p" });
  });

  it("缺段时返回 null", () => {
    expect(parseCollabDocumentKey("rp")).toBeNull();
    expect(parseCollabDocumentKey(":b:p")).toBeNull();
    expect(parseCollabDocumentKey("r::p")).toBeNull();
    expect(parseCollabDocumentKey("r:b:")).toBeNull();
  });
});

describe("collabSocketUrl", () => {
  it("同源改协议并指向网关路径", () => {
    expect(collabSocketUrl("http://127.0.0.1:4173")).toBe("ws://127.0.0.1:4173/ws/collab");
    expect(collabSocketUrl("https://kustos.example.com")).toBe("wss://kustos.example.com/ws/collab");
  });
});

describe("collabUserColor", () => {
  it("同名稳定、不同名分散", () => {
    expect(collabUserColor("e2e_editor")).toBe(collabUserColor("e2e_editor"));
    const colors = new Set(["a", "b", "c", "d", "e", "f"].map(collabUserColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("collabDraftBranch", () => {
  it("草稿分支与网关约定一致", () => {
    expect(collabDraftBranch("main")).toBe("collab/draft-main");
  });
});

describe("collabPeerCount", () => {
  it("感知不可用时为 0，不假装有人在线", () => {
    expect(collabPeerCount(null)).toBe(0);
    expect(collabPeerCount(undefined)).toBe(0);
    expect(collabPeerCount({ getStates: () => new Map() })).toBe(0);
    expect(collabPeerCount({ getStates: () => new Map([[1, {}], [2, {}]]) })).toBe(2);
  });
});

describe("collabActiveUrl", () => {
  it("按仓库 id 组装感知端点", () => {
    expect(collabActiveUrl("01a1a921")).toBe("/api/v1/repositories/01a1a921/collab/active");
  });
});

describe("activePathCounts", () => {
  const docs = [
    { docKey: "repo:main:src/a.ts", connections: 2 },
    { docKey: "repo:main:src/b.ts", connections: 1 },
    { docKey: "repo:dev:src/a.ts", connections: 5 },
    { docKey: "broken", connections: 3 },
  ];

  it("只统计当前分支并按路径求和", () => {
    const counts = activePathCounts(docs, "main");
    expect(counts.get("src/a.ts")).toBe(2);
    expect(counts.get("src/b.ts")).toBe(1);
  });

  it("别的分支不混进当前树", () => {
    expect(activePathCounts(docs, "main").has("src/c.ts")).toBe(false);
    expect(activePathCounts(docs, "dev").get("src/a.ts")).toBe(5);
  });

  it("结构不对的文档键被忽略", () => {
    expect([...activePathCounts(docs, "main").keys()].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("connectionsFor", () => {
  const docs = [{ docKey: "repo:main:a.ts", connections: 3 }];

  it("命中时给连接数", () => {
    expect(connectionsFor(docs, "repo:main:a.ts")).toBe(3);
  });

  it("不在清单里给 0", () => {
    expect(connectionsFor(docs, "repo:main:b.ts")).toBe(0);
  });
});

describe("collabKickReason", () => {
  it("网关的吊销 reason 命中，即使状态码被合成成 1000", () => {
    expect(collabKickReason({ code: 1000, reason: "写入权限已吊销, 请重新连接" })).not.toBeNull();
  });

  it("被移出会话也算被踢", () => {
    expect(collabKickReason({ code: 1000, reason: "已被移出协作会话" })).not.toBeNull();
  });

  it("4403 即使没有文案也认", () => {
    expect(collabKickReason({ code: 4403, reason: "" })).toBe("");
  });

  it("普通断线不是被踢", () => {
    expect(collabKickReason({ code: 1006, reason: "" })).toBeNull();
    expect(collabKickReason({ code: 1000, reason: "going away" })).toBeNull();
    expect(collabKickReason(null)).toBeNull();
  });

  it("连接数超限（4429）不是权限问题", () => {
    expect(collabKickReason({ code: 4429, reason: "该文档连接数已达上限 (50)" })).toBeNull();
  });
});

describe("saveErrorIsKick", () => {
  it("保存失败里说权限没了才转观察态", () => {
    expect(saveErrorIsKick("已被移出协作会话")).toBe(true);
    expect(saveErrorIsKick("没有该仓库的写入权限")).toBe(false);
    expect(saveErrorIsKick("文档内容过大, 拒绝保存")).toBe(false);
    expect(saveErrorIsKick(null)).toBe(false);
  });
});
