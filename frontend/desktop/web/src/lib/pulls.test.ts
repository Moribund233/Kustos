import { describe, expect, it } from "vitest";

import {
  PULL_SEGMENTS,
  PullsRequestError,
  itemsInSegment,
  pullsKeys,
  segmentCounts,
  segmentOf,
  toLabelSummary,
  toLinkedIssue,
  toPullRequest,
  toPullRequestComment,
  toPullRequestPage,
  toPullRequestReview,
  toReviewRequest,
  toUserSummary,
  type PullRequest,
} from "./pulls.ts";

/**
 * PR 数据层的纯逻辑测试。
 *
 * 收敛函数是这里唯一能脱离网络验证的部分，而它承担了两件事：把后端的
 * snake_case 变成前端 camelCase，以及在字段缺失/类型不符时给出安全默认值。
 * 后者尤其重要——列表里一条脏数据不该让整个面白屏。
 */

/** 造一条最小可用的 PR（只填判定用得到的字段）。 */
function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "pr-1",
    number: 1,
    title: "改动",
    description: null,
    status: "open",
    sourceBranch: "feature",
    targetBranch: "main",
    repositoryId: "repo-1",
    isDraft: false,
    author: null,
    labels: [],
    reviewers: [],
    reviewCount: 0,
    reviewRequests: [],
    linkedIssues: [],
    comments: [],
    reviews: [],
    mergedBy: null,
    mergedCommitHash: null,
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

describe("toPullRequest", () => {
  it("把 snake_case 收敛成 camelCase", () => {
    const result = toPullRequest({
      id: "pr-1",
      pr_number: 12,
      title: "修一个 bug",
      description: "说明",
      status: "open",
      source_branch: "feature/x",
      target_branch: "main",
      repository_id: "repo-1",
      is_draft: true,
      author: { id: "u1", username: "octo", full_name: "Octo" },
      labels: [{ id: "l1", name: "bug", color: "#f00", description: null }],
      reviewers: [{ id: "u2", username: "rex" }],
      review_count: 3,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    });

    expect(result.number).toBe(12);
    expect(result.sourceBranch).toBe("feature/x");
    expect(result.targetBranch).toBe("main");
    expect(result.repositoryId).toBe("repo-1");
    expect(result.isDraft).toBe(true);
    expect(result.author?.username).toBe("octo");
    expect(result.labels.map((l) => l.name)).toEqual(["bug"]);
    expect(result.reviewers.map((r) => r.username)).toEqual(["rex"]);
    expect(result.reviewCount).toBe(3);
    expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(result.updatedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("空对象不抛错，全部字段给安全默认值", () => {
    expect(toPullRequest({})).toEqual(pr({ id: "", number: 0, title: "", status: "", sourceBranch: "", targetBranch: "", repositoryId: null }));
  });

  it("null / undefined / 数组都按空对象处理", () => {
    // 后端把某个字段整体省掉时，界面必须还能渲染出骨架，而不是崩溃。
    expect(toPullRequest(null).number).toBe(0);
    expect(toPullRequest(undefined).id).toBe("");
    expect(toPullRequest([]).title).toBe("");
  });

  it("数字形式的计数被接受，非数字按默认值处理", () => {
    expect(toPullRequest({ pr_number: "12", review_count: "5" }).number).toBe(12);
    expect(toPullRequest({ pr_number: "12", review_count: "5" }).reviewCount).toBe(5);
    expect(toPullRequest({ pr_number: "abc" }).number).toBe(0);
    expect(toPullRequest({ pr_number: null }).number).toBe(0);
  });

  it("is_draft 非布尔时按 false 处理，不做 truthy 猜测", () => {
    // "0" 与 "false" 都是 truthy 字符串；把草稿误判成正式 PR 会让它悄悄进入待合并段。
    expect(toPullRequest({ is_draft: "true" }).isDraft).toBe(false);
    expect(toPullRequest({ is_draft: 1 }).isDraft).toBe(false);
    expect(toPullRequest({}).isDraft).toBe(false);
  });

  it("描述为空串时收敛成 null，界面据此走「没有描述」分支", () => {
    expect(toPullRequest({ description: "" }).description).toBeNull();
    expect(toPullRequest({ description: "有内容" }).description).toBe("有内容");
  });

  it("关联数组不是数组时按空列表处理，空条目被丢弃", () => {
    const result = toPullRequest({
      labels: "bug",
      reviewers: null,
      review_requests: [null, 42, { state: "pending" }],
      linked_issues: [null, { title: "无编号" }, { issue_number: 3, title: "有编号" }],
      comments: { not: "an array" },
      reviews: undefined,
    });
    expect(result.labels).toEqual([]);
    expect(result.reviewers).toEqual([]);
    expect(result.reviewRequests).toHaveLength(1);
    expect(result.reviewRequests[0].state).toBe("pending");
    expect(result.linkedIssues.map((i) => i.number)).toEqual([3]);
    expect(result.comments).toEqual([]);
    expect(result.reviews).toEqual([]);
  });

  it("只有已合并的 PR 才带 merged_by 与合并提交", () => {
    const merged = toPullRequest({
      status: "merged",
      merged_by: { id: "u2", username: "rex" },
      merged_commit_hash: "abc123",
    });
    expect(merged.mergedBy?.username).toBe("rex");
    expect(merged.mergedCommitHash).toBe("abc123");

    const open = toPullRequest({ status: "open" });
    expect(open.mergedBy).toBeNull();
    expect(open.mergedCommitHash).toBeNull();
  });

  it("repository_id 缺失时给 null 而不是空串", () => {
    expect(toPullRequest({}).repositoryId).toBeNull();
  });
});

describe("toPullRequestComment", () => {
  it("收敛行级评论的文件与行号", () => {
    const comment = toPullRequestComment({
      id: "c1",
      content: "这一行有问题",
      file_path: "src/a.ts",
      line_number: 42,
      commit_hash: "abc",
      parent_id: "c0",
      author: { id: "u1", username: "octo" },
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(comment.filePath).toBe("src/a.ts");
    expect(comment.lineNumber).toBe(42);
    expect(comment.commitHash).toBe("abc");
    expect(comment.parentId).toBe("c0");
    expect(comment.author?.username).toBe("octo");
  });

  it("非行级评论的行号缺失或为 0 时给 null", () => {
    // 行号从 1 开始；0 是"没有行"而不是"第零行"。
    expect(toPullRequestComment({ id: "c1" }).lineNumber).toBeNull();
    expect(toPullRequestComment({ id: "c1", line_number: 0 }).lineNumber).toBeNull();
    expect(toPullRequestComment({ id: "c1", line_number: null }).lineNumber).toBeNull();
  });

  it("内容缺失时给空串而不是抛错", () => {
    expect(toPullRequestComment({}).content).toBe("");
    expect(toPullRequestComment(null).content).toBe("");
  });
});

describe("toPullRequestReview", () => {
  it("收敛评审状态与评审人", () => {
    const review = toPullRequestReview({
      id: "r1",
      status: "approved",
      comment: "看起来不错",
      reviewer: { id: "u2", username: "rex" },
      created_at: "2026-01-03T00:00:00Z",
    });
    expect(review.status).toBe("approved");
    expect(review.comment).toBe("看起来不错");
    expect(review.reviewer?.username).toBe("rex");
  });

  it("状态原样透传，不在数据层做白名单", () => {
    // 服务端将来新增评审状态时，界面应能自己决定怎么显示，而不是被前端筛掉。
    expect(toPullRequestReview({ status: "dismissed" }).status).toBe("dismissed");
  });
});

describe("toReviewRequest", () => {
  it("未提交的评审请求按 pending 处理", () => {
    // pending 表示"还没有结论"；误判成 approved 会让用户以为已经可以合并。
    expect(toReviewRequest({ reviewer: { id: "u2", username: "rex" } })?.state).toBe("pending");
  });

  it("已提交的评审请求带出结论与时间", () => {
    const request = toReviewRequest({
      reviewer: { id: "u2", username: "rex" },
      state: "changes_requested",
      comment: "这里要改",
      requested_at: "2026-01-01T00:00:00Z",
      reviewed_at: "2026-01-02T00:00:00Z",
    });
    expect(request?.state).toBe("changes_requested");
    expect(request?.comment).toBe("这里要改");
    expect(request?.requestedAt).toBe("2026-01-01T00:00:00Z");
    expect(request?.reviewedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("非对象条目直接丢弃", () => {
    expect(toReviewRequest(null)).toBeNull();
    expect(toReviewRequest(42)).toBeNull();
  });
});

describe("toLinkedIssue", () => {
  it("收敛关联 Issue 的 closes_on_merge", () => {
    const link = toLinkedIssue({
      id: "i1",
      issue_number: 9,
      title: "一个议题",
      status: "open",
      closes_on_merge: false,
      linked_at: "2026-01-01T00:00:00Z",
    });
    expect(link?.number).toBe(9);
    expect(link?.closesOnMerge).toBe(false);
    expect(link?.linkedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("closes_on_merge 缺失时按 true 处理，与 Fixes #N 的语义一致", () => {
    expect(toLinkedIssue({ issue_number: 9 })?.closesOnMerge).toBe(true);
  });

  it("编号缺失或非正时丢弃该条", () => {
    // 编号是跳转的唯一依据；没有编号的关联条目点了没反应。
    expect(toLinkedIssue({ title: "无编号" })).toBeNull();
    expect(toLinkedIssue({ issue_number: 0 })).toBeNull();
    expect(toLinkedIssue(null)).toBeNull();
  });
});

describe("toPullRequestPage", () => {
  it("收敛分页字段", () => {
    const page = toPullRequestPage(
      {
        items: [{ pr_number: 1 }, { pr_number: 2 }],
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
    const page = toPullRequestPage({ items: [{ pr_number: 1 }, { pr_number: 2 }] }, 1, 20);
    expect(page.total).toBe(2);
    expect(page.page).toBe(1);
    expect(page.limit).toBe(20);
  });

  it("pages / has_next / has_prev 缺失时按 total 与 limit 推导", () => {
    const page = toPullRequestPage({ items: [], total: 45 }, 2, 20);
    expect(page.pages).toBe(3);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrev).toBe(true);
  });

  it("首页的 has_prev 为 false，末页的 has_next 为 false", () => {
    const single = toPullRequestPage({ items: [], total: 5, page: 1, limit: 20 }, 1, 20);
    expect(single.pages).toBe(1);
    expect(single.hasNext).toBe(false);
    expect(single.hasPrev).toBe(false);
  });

  it("items 不是数组时给空列表", () => {
    expect(toPullRequestPage({ items: null, total: 0 }, 1, 20).items).toEqual([]);
    expect(toPullRequestPage(null, 1, 20).items).toEqual([]);
  });
});

describe("segmentOf", () => {
  it("按服务端状态分段", () => {
    expect(segmentOf(pr({ status: "open" }))).toBe("open");
    expect(segmentOf(pr({ status: "merged" }))).toBe("merged");
    expect(segmentOf(pr({ status: "closed" }))).toBe("closed");
  });

  it("大小写不敏感", () => {
    expect(segmentOf(pr({ status: "MERGED" }))).toBe("merged");
  });

  it("未知状态归入 open，而不是从界面上消失", () => {
    // 服务端将来新增状态时，宁可在默认段里显示，也不要让这条 PR 静默不见。
    expect(segmentOf(pr({ status: "locked" }))).toBe("open");
    expect(segmentOf(pr({ status: "" }))).toBe("open");
  });
});

describe("itemsInSegment", () => {
  const items = [
    pr({ id: "a", status: "open" }),
    pr({ id: "b", status: "merged" }),
    pr({ id: "c", status: "open" }),
    pr({ id: "d", status: "closed" }),
  ];

  it("只取该段的条目，并保持服务端给的顺序", () => {
    expect(itemsInSegment(items, "open").map((p) => p.id)).toEqual(["a", "c"]);
    expect(itemsInSegment(items, "merged").map((p) => p.id)).toEqual(["b"]);
  });

  it("空输入返回空数组", () => {
    expect(itemsInSegment([], "open")).toEqual([]);
  });
});

describe("segmentCounts", () => {
  it("统计各段数量，缺的段给 0", () => {
    expect(
      segmentCounts([
        pr({ status: "open" }),
        pr({ status: "open" }),
        pr({ status: "merged" }),
      ]),
    ).toEqual({ open: 2, merged: 1, closed: 0 });
  });

  it("空输入时三段都为 0", () => {
    expect(segmentCounts([])).toEqual({ open: 0, merged: 0, closed: 0 });
  });
});

describe("PULL_SEGMENTS", () => {
  it("三段与服务端的 status 取值一致，且只带翻译键不带字面量", () => {
    // 写死文案会让语言切换后出现"一半中文一半英文"的混用状态。
    expect(PULL_SEGMENTS.map((s) => s.id)).toEqual(["open", "merged", "closed"]);
    for (const segment of PULL_SEGMENTS) {
      expect(segment.i18nKey).toBe(`pulls.segments.${segment.id}`);
    }
  });
});

describe("pullsKeys", () => {
  it("列表键带上仓库与筛选条件，不同分段各自成槽", () => {
    const open = pullsKeys.list("repo-1", { status: "open", author: null, page: 1, limit: 20 });
    const merged = pullsKeys.list("repo-1", { status: "merged", author: null, page: 1, limit: 20 });
    expect(open).not.toEqual(merged);
    expect(open[0]).toBe("pulls");
  });

  it("详情与评论各自独立成键", () => {
    expect(pullsKeys.detail("repo-1", 3)).toEqual(["pulls", "repo-1", "detail", 3]);
    expect(pullsKeys.comments("repo-1", 3)).toEqual(["pulls", "repo-1", "comments", 3]);
  });
});

describe("PullsRequestError", () => {
  it("保留操作类型与 HTTP 状态码，供界面查翻译键", () => {
    const error = new PullsRequestError("list", 403);
    expect(error.operation).toBe("list");
    expect(error.status).toBe(403);
    expect(error.name).toBe("PullsRequestError");
    expect(error.message).toContain("403");
  });

  it("是 Error 实例，能被 instanceof 判定", () => {
    expect(new PullsRequestError("detail", 404)).toBeInstanceOf(Error);
  });
});
