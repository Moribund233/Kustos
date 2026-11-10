import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  ISSUE_SEGMENTS,
  IssuesRequestError,
  itemsInSegment,
  issuesKeys,
  segmentCounts,
  segmentOf,
  toIssue,
  toIssueComment,
  toIssuePage,
  toLabelSummary,
  toLinkedPullRequest,
  toUserSummary,
  type Issue,
} from "./issues.ts";

/**
 * Issue 数据层的纯逻辑测试。
 *
 * 收敛函数是这里唯一能脱离网络验证的部分，而它承担了两件事：把后端的
 * snake_case 变成前端 camelCase，以及在字段缺失/类型不符时给出安全默认值。
 * 后者尤其重要——列表里一条脏数据不该让整个面白屏。
 */

/** 造一条最小可用的 Issue（只填判定用得到的字段）。 */
function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "i-1",
    number: 1,
    title: "一个问题",
    description: null,
    status: "open",
    priority: "medium",
    repositoryId: "repo-1",
    author: null,
    assignee: null,
    labels: [],
    comments: [],
    linkedPullRequests: [],
    closedBy: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("toUserSummary", () => {
  it("把 snake_case 的 full_name 收敛成 fullName", () => {
    expect(toUserSummary({ id: "u1", username: "octo", full_name: "Octo Cat" })).toEqual({
      id: "u1",
      username: "octo",
      fullName: "Octo Cat",
    });
  });

  it("full_name 缺失或为 null 时给 null", () => {
    expect(toUserSummary({ id: "u1", username: "octo" })?.fullName).toBeNull();
    expect(toUserSummary({ id: "u1", username: "octo", full_name: null })?.fullName).toBeNull();
  });

  it("非字符串的用户名不参与收敛，按缺失处理", () => {
    // 名字渲染成 "[object Object]" 比留空更迷惑人。
    expect(toUserSummary({ id: "u1", username: { name: "x" } })).toEqual({
      id: "u1",
      username: "",
      fullName: null,
    });
  });

  it("id 与 username 都缺失时返回 null", () => {
    // 这样的条目在界面上既显示不出名字也点不动，留着只会渲染成空白行。
    expect(toUserSummary({})).toBeNull();
    expect(toUserSummary(null)).toBeNull();
    expect(toUserSummary(undefined)).toBeNull();
  });

  it("非对象输入（数组、字符串、数字）返回 null", () => {
    expect(toUserSummary([])).toBeNull();
    expect(toUserSummary("octo")).toBeNull();
    expect(toUserSummary(42)).toBeNull();
  });

  it("数字形式的 id 转成字符串，避免拼进 URL 时变成其他形态", () => {
    expect(toUserSummary({ id: 7, username: "octo" })?.id).toBe("7");
  });
});

describe("toLabelSummary", () => {
  it("收敛 id / name / color / description", () => {
    expect(
      toLabelSummary({ id: "l1", name: "bug", color: "#f00", description: "缺陷" }),
    ).toEqual({ id: "l1", name: "bug", color: "#f00", description: "缺陷" });
  });

  it("可空字段缺失时给 null，空串也算没有值", () => {
    const label = toLabelSummary({ id: "l1", name: "bug", color: "", description: null });
    expect(label?.color).toBeNull();
    expect(label?.description).toBeNull();
  });

  it("id 与 name 都缺失时丢弃", () => {
    expect(toLabelSummary({})).toBeNull();
    expect(toLabelSummary(null)).toBeNull();
  });
});

describe("toIssue", () => {
  it("把 snake_case 收敛成 camelCase", () => {
    const result = toIssue({
      id: "i-1",
      issue_number: 12,
      title: "一个问题",
      description: "说明",
      status: "open",
      priority: "high",
      repository_id: "repo-1",
      author: { id: "u1", username: "octo", full_name: "Octo" },
      assignee: { id: "u2", username: "rex" },
      labels: [{ id: "l1", name: "bug", color: "#f00", description: null }],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    });

    expect(result.number).toBe(12);
    expect(result.priority).toBe("high");
    expect(result.repositoryId).toBe("repo-1");
    expect(result.author?.username).toBe("octo");
    expect(result.assignee?.username).toBe("rex");
    expect(result.labels.map((l) => l.name)).toEqual(["bug"]);
    expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(result.updatedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("空对象不抛错，全部字段给安全默认值", () => {
    expect(toIssue({})).toEqual(
      issue({ id: "", number: 0, title: "", status: "", repositoryId: null }),
    );
  });

  it("null / undefined / 数组都按空对象处理", () => {
    // 后端把某个字段整体省掉时，界面必须还能渲染出骨架，而不是崩溃。
    expect(toIssue(null).number).toBe(0);
    expect(toIssue(undefined).id).toBe("");
    expect(toIssue([]).title).toBe("");
  });

  it("priority 缺失时给 medium，与服务端建 Issue 的默认值一致", () => {
    // critical / high 默认会导致界面把一条普通 Issue 标成紧急。
    expect(toIssue({}).priority).toBe("medium");
    expect(toIssue({ priority: null }).priority).toBe("medium");
    expect(toIssue({ priority: "critical" }).priority).toBe("critical");
  });

  it("数字形式的编号被接受，非数字按 0 处理", () => {
    expect(toIssue({ issue_number: "12" }).number).toBe(12);
    expect(toIssue({ issue_number: "abc" }).number).toBe(0);
    expect(toIssue({ issue_number: null }).number).toBe(0);
  });

  it("描述为空串时收敛成 null，界面据此走「没有描述」分支", () => {
    expect(toIssue({ description: "" }).description).toBeNull();
    expect(toIssue({ description: "有内容" }).description).toBe("有内容");
  });

  it("关联数组不是数组时按空列表处理，空条目被丢弃", () => {
    const result = toIssue({
      labels: "bug",
      comments: [{ id: "c1", content: "hi" }, null, 42],
      pull_requests: [null, { title: "无编号" }, { pr_number: 3, title: "有编号" }],
    });
    expect(result.labels).toEqual([]);
    expect(result.comments.map((c) => c.id)).toEqual(["c1"]);
    expect(result.linkedPullRequests.map((p) => p.number)).toEqual([3]);
  });

  it("closed_by 只在关闭的 Issue 上有值", () => {
    const closed = toIssue({
      status: "closed",
      closed_by: { id: "u2", username: "rex" },
    });
    expect(closed.closedBy?.username).toBe("rex");

    const open = toIssue({ status: "open" });
    expect(open.closedBy).toBeNull();
  });

  it("repository_id 缺失时给 null 而不是空串", () => {
    expect(toIssue({}).repositoryId).toBeNull();
  });
});

describe("toIssueComment", () => {
  it("收敛评论内容、作者与时间", () => {
    const comment = toIssueComment({
      id: "c1",
      content: "我先看一下",
      author: { id: "u1", username: "octo" },
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(comment.content).toBe("我先看一下");
    expect(comment.author?.username).toBe("octo");
    expect(comment.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("内容缺失时给空串而不是抛错", () => {
    expect(toIssueComment({}).content).toBe("");
    expect(toIssueComment(null).content).toBe("");
  });
});

describe("toLinkedPullRequest", () => {
  it("收敛关联 PR 的分支与 closes_on_merge", () => {
    const link = toLinkedPullRequest({
      id: "pr-1",
      pr_number: 9,
      title: "一个 PR",
      status: "open",
      source_branch: "feature/x",
      target_branch: "main",
      closes_on_merge: false,
      linked_at: "2026-01-01T00:00:00Z",
    });
    expect(link?.number).toBe(9);
    expect(link?.sourceBranch).toBe("feature/x");
    expect(link?.targetBranch).toBe("main");
    expect(link?.closesOnMerge).toBe(false);
    expect(link?.linkedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("closes_on_merge 缺失时按 true 处理，与 Fixes #N 的语义一致", () => {
    expect(toLinkedPullRequest({ pr_number: 9 })?.closesOnMerge).toBe(true);
  });

  it("编号缺失或非正时丢弃该条", () => {
    // 编号是跳转的唯一依据；没有编号的关联条目点了没反应。
    expect(toLinkedPullRequest({ title: "无编号" })).toBeNull();
    expect(toLinkedPullRequest({ pr_number: 0 })).toBeNull();
    expect(toLinkedPullRequest(null)).toBeNull();
  });
});

describe("toIssuePage", () => {
  it("收敛分页字段", () => {
    const page = toIssuePage(
      {
        items: [{ issue_number: 1 }, { issue_number: 2 }],
        total: 41,
        page: 2,
        limit: 20,
        pages: 3,
        has_next: true,
        has_prev: true,
      },
      2,
      20,
    );
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(41);
    expect(page.page).toBe(2);
    expect(page.limit).toBe(20);
    expect(page.pages).toBe(3);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrev).toBe(true);
  });

  it("total 缺失时用实际条目数兜底，而不是显示 0", () => {
    // "总数 0 但列表里有内容"比完全不显示计数更糟。
    const page = toIssuePage({ items: [{ issue_number: 1 }, { issue_number: 2 }] }, 1, 20);
    expect(page.total).toBe(2);
  });

  it("pages / has_next / has_prev 缺失时按 total 与 limit 推导", () => {
    const page = toIssuePage({ items: [], total: 45 }, 2, 20);
    expect(page.pages).toBe(3);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrev).toBe(true);
  });

  it("单页时两个方向标志都为 false", () => {
    const single = toIssuePage({ items: [], total: 5, page: 1, limit: 20 }, 1, 20);
    expect(single.pages).toBe(1);
    expect(single.hasNext).toBe(false);
    expect(single.hasPrev).toBe(false);
  });

  it("items 不是数组时给空列表", () => {
    expect(toIssuePage({ items: null, total: 0 }, 1, 20).items).toEqual([]);
    expect(toIssuePage(null, 1, 20).items).toEqual([]);
  });
});

describe("segmentOf", () => {
  it("按服务端状态分段", () => {
    expect(segmentOf(issue({ status: "open" }))).toBe("open");
    expect(segmentOf(issue({ status: "closed" }))).toBe("closed");
  });

  it("大小写不敏感", () => {
    expect(segmentOf(issue({ status: "CLOSED" }))).toBe("closed");
  });

  it("未知状态归入 open，而不是从界面上消失", () => {
    // 服务端将来新增状态时，宁可在默认段里显示，也不要让这条 Issue 静默不见。
    expect(segmentOf(issue({ status: "triage" }))).toBe("open");
    expect(segmentOf(issue({ status: "" }))).toBe("open");
  });
});

describe("itemsInSegment", () => {
  const items = [
    issue({ id: "a", status: "open" }),
    issue({ id: "b", status: "closed" }),
    issue({ id: "c", status: "open" }),
  ];

  it("只取该段的条目，并保持服务端给的顺序", () => {
    expect(itemsInSegment(items, "open").map((i) => i.id)).toEqual(["a", "c"]);
    expect(itemsInSegment(items, "closed").map((i) => i.id)).toEqual(["b"]);
  });

  it("空输入返回空数组", () => {
    expect(itemsInSegment([], "open")).toEqual([]);
  });
});

describe("segmentCounts", () => {
  it("统计各段数量，缺的段给 0", () => {
    expect(
      segmentCounts([issue({ status: "open" }), issue({ status: "closed" }), issue({ status: "open" })]),
    ).toEqual({ open: 2, closed: 1 });
  });

  it("空输入时两段都为 0", () => {
    expect(segmentCounts([])).toEqual({ open: 0, closed: 0 });
  });
});

describe("ISSUE_SEGMENTS", () => {
  it("两段与服务端的 status 取值一致，且只带翻译键不带字面量", () => {
    // 写死文案会让语言切换后出现"一半中文一半英文"的混用状态。
    expect(ISSUE_SEGMENTS.map((s) => s.id)).toEqual(["open", "closed"]);
    for (const segment of ISSUE_SEGMENTS) {
      expect(segment.i18nKey).toBe(`issues.segments.${segment.id}`);
    }
  });
});

describe("issuesKeys", () => {
  it("列表键带上仓库与筛选条件，不同分段各自成槽", () => {
    const base = {
      label: null,
      assignee: null,
      author: null,
      page: 1,
      limit: DEFAULT_PAGE_SIZE,
    };
    const open = issuesKeys.list("repo-1", { ...base, status: "open" });
    const closed = issuesKeys.list("repo-1", { ...base, status: "closed" });
    expect(open).not.toEqual(closed);
    expect(open[0]).toBe("issues");
  });

  it("详情与评论各自独立成键", () => {
    expect(issuesKeys.detail("repo-1", 3)).toEqual(["issues", "repo-1", "detail", 3]);
    expect(issuesKeys.comments("repo-1", 3)).toEqual(["issues", "repo-1", "comments", 3]);
  });
});

describe("IssuesRequestError", () => {
  it("保留操作类型与 HTTP 状态码，供界面查翻译键", () => {
    const error = new IssuesRequestError("comments", 500);
    expect(error.operation).toBe("comments");
    expect(error.status).toBe(500);
    expect(error.name).toBe("IssuesRequestError");
    expect(error.message).toContain("500");
  });

  it("是 Error 实例，能被 instanceof 判定", () => {
    expect(new IssuesRequestError("detail", 404)).toBeInstanceOf(Error);
  });
});
