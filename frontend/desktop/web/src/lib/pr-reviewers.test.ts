import { describe, expect, it } from "vitest";

import {
  PRReviewError,
  prReviewKeys,
  toBranchProtection,
  toReviewerEntries,
} from "@/lib/pr-reviewers";

/**
 * 评审面数据层的纯逻辑测试。
 *
 * 这两个收敛函数决定了评审窗显示什么：谁在等、谁点了通过、目标分支为什么还
 * 不能合并。输入全是**服务端原样返回的** snake_case 脏数据（`unknown`），
 * 而评审窗拿显示结果去给"能不能合并"配解释文案——收敛错了，用户看到的
 * 理由就是错的。因此这里逐条钉住取值规则，尤其是"未知状态往哪边落"。
 */

describe("toReviewerEntries 的字段收敛", () => {
  it("把两条真实形态的评审请求收敛成前端结构", () => {
    // 一条已通过（带总结意见与 reviewed_at），一条还在等（comment 与
    // reviewed_at 均为 null，这正是服务端 pending 时的出参）。
    const raw = [
      {
        reviewer: { id: "u-1", username: "alice", full_name: "Alice Wang" },
        state: "approved",
        comment: "逻辑没问题，只需要补一条测试。",
        requested_by: { id: "u-9", username: "bob" },
        requested_at: "2026-03-01T08:00:00Z",
        reviewed_at: "2026-03-02T09:30:00Z",
      },
      {
        reviewer: { id: "u-2", username: "carol", full_name: null },
        state: "pending",
        comment: null,
        requested_by: null,
        requested_at: "2026-03-01T08:05:00Z",
        reviewed_at: null,
      },
    ];

    const entries = toReviewerEntries(raw);

    expect(entries).toEqual([
      {
        reviewer: { id: "u-1", username: "alice", fullName: "Alice Wang" },
        state: "approved",
        comment: "逻辑没问题，只需要补一条测试。",
        requestedAt: "2026-03-01T08:00:00Z",
        reviewedAt: "2026-03-02T09:30:00Z",
      },
      {
        reviewer: { id: "u-2", username: "carol", fullName: null },
        state: "pending",
        comment: null,
        requestedAt: "2026-03-01T08:05:00Z",
        reviewedAt: null,
      },
    ]);

    // 顺序即服务端顺序（按请求时间升序）：评审窗按它渲染，前端不再排一次。
    expect(entries.map((entry) => entry.reviewer?.username)).toEqual(["alice", "carol"]);
  });

  it("changes_requested 原样保留，不被当成未知状态", () => {
    const entries = toReviewerEntries([
      {
        reviewer: { id: "u-3", username: "dave" },
        state: "changes_requested",
        comment: "这里有个空指针。",
        requested_at: "2026-03-01T08:00:00Z",
        reviewed_at: "2026-03-01T10:00:00Z",
      },
    ]);

    expect(entries[0]?.state).toBe("changes_requested");
    expect(entries[0]?.comment).toBe("这里有个空指针。");
  });
});

describe("toReviewerEntries 的未知状态", () => {
  it("`dismissed` 这类服务端取值一律归到 pending", () => {
    // 服务端在撤回评审等路径上会给出 dismissed，界面只认识三态。归到 pending
    // 是安全方向：它表示"还没有有效结论"，最坏结果是用户多点一次评审；
    // 若误归成 approved，界面会暗示"已有一位通过"，可能让人以为可以合并。
    const entries = toReviewerEntries([
      {
        reviewer: { id: "u-1", username: "alice" },
        state: "dismissed",
        comment: "撤回前写的意见",
        requested_at: "2026-03-01T08:00:00Z",
        reviewed_at: "2026-03-02T09:30:00Z",
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.state).toBe("pending");
    // 状态被降级，但别的字段照旧透传：用户仍需要看到当时的意见内容。
    expect(entries[0]?.comment).toBe("撤回前写的意见");
  });

  it("state 缺失、非字符串或大小写不符时也不猜", () => {
    for (const state of [undefined, null, 42, "", "APPROVED", "approved "]) {
      const entries = toReviewerEntries([{ reviewer: { id: "u-1", username: "alice" }, state }]);
      expect(entries[0]?.state).toBe("pending");
    }
  });
});

describe("toReviewerEntries 的坏条目", () => {
  it("没有 reviewer 对象的条目被丢掉", () => {
    // 一条显示不出名字、也点不动的记录在评审窗里只会渲染出一行空白，
    // 还会把"待评审人数"抬高，让用户去找一个不存在的人。
    const raw = [
      { reviewer: null, state: "pending", requested_at: "2026-03-01T08:00:00Z" },
      { state: "approved", comment: "匿名通过" },
      { reviewer: "alice", state: "pending" },
      { reviewer: { id: "u-1", username: "alice" }, state: "approved", reviewed_at: "2026-03-02T09:30:00Z" },
    ];

    const entries = toReviewerEntries(raw);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.reviewer?.username).toBe("alice");
    expect(entries[0]?.state).toBe("approved");
  });

  it("非对象条目（字符串 / 数组 / 数字）被跳过而不是抛错", () => {
    const entries = toReviewerEntries([
      "nope",
      42,
      [],
      null,
      { reviewer: { id: "u-1", username: "alice" }, state: "pending" },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.reviewer?.id).toBe("u-1");
  });
});

describe("toReviewerEntries 的垃圾输入", () => {
  it("null / 普通对象 / 字符串 / 空数组都返回空数组且不抛", () => {
    // 这个端点返回**裸数组**；契约漂移成 {items: [...]} 时不该白屏——
    // 评审窗显示"还没有请求评审人"是可读的状态，抛错会让整个窗口挂掉。
    const cases: unknown[] = [null, undefined, {}, "nope", [], 0, true];
    for (const raw of cases) {
      expect(() => toReviewerEntries(raw)).not.toThrow();
      expect(toReviewerEntries(raw)).toEqual([]);
    }
  });
});

describe("toBranchProtection", () => {
  it("完整对象把三个开关都读出来", () => {
    const protection = toBranchProtection({
      is_protected: true,
      require_code_review: true,
      require_status_checks: true,
    });

    expect(protection).toEqual({
      isProtected: true,
      requireCodeReview: true,
      requireStatusChecks: true,
    });
  });

  it("垃圾输入回落成全 false（默认的语义就是'没有保护'）", () => {
    // 接口对未保护分支就是三个 false，因此"字段全缺"与"没有保护"在界面上
    // 应当看起来一样。宁可显示没有锁也不要凭猜测加锁：服务端才是唯一的合并
    // 裁决点，界面多画一把锁只会让用户反复确认一个不存在的限制。
    const expected = {
      isProtected: false,
      requireCodeReview: false,
      requireStatusChecks: false,
    };

    for (const raw of [null, undefined, {}, "nope", [], 7]) {
      expect(toBranchProtection(raw)).toEqual(expected);
    }
  });

  it("缺 require_status_checks 时只降级这一项，不动 is_protected", () => {
    // 三个开关互相独立：一个字段缺失不该把整条保护记录当成坏数据丢掉。
    // 受保护的分支仍是受保护的分支，只是"要状态检查"这一条没有依据。
    const protection = toBranchProtection({
      is_protected: true,
      require_code_review: true,
    });

    expect(protection.isProtected).toBe(true);
    expect(protection.requireCodeReview).toBe(true);
    expect(protection.requireStatusChecks).toBe(false);
  });

  it("非布尔的开关值不做 truthy 猜测", () => {
    // 服务端偶尔把布尔序列化成 "true" / 1：把它们当真会让界面显示一个
    // 服务端实际不认的锁，因此一律按 fallback（false）处理。
    const protection = toBranchProtection({
      is_protected: "true",
      require_code_review: 1,
      require_status_checks: false,
    });

    expect(protection).toEqual({
      isProtected: false,
      requireCodeReview: false,
      requireStatusChecks: false,
    });
  });
});

describe("prReviewKeys", () => {
  it("同一组参数算出同一个键，不同 PR / 分支互不命中", () => {
    expect(prReviewKeys.reviewers("r1", 42)).toEqual(prReviewKeys.reviewers("r1", 42));
    expect(prReviewKeys.reviewers("r1", 42)).not.toEqual(prReviewKeys.reviewers("r1", 43));

    // 分支名带斜杠也是普通字符串，不需要额外归一化。
    expect(prReviewKeys.protection("r1", "feature/x")).not.toEqual(
      prReviewKeys.protection("r1", "feature/y"),
    );
  });

  it("null 参数收敛成稳定的空值，不让键在两次渲染间抖动", () => {
    // hook 在拿到仓库 id 之前也会算键；若 null 与 "" 算出不同的键，
    // 缓存会在每次渲染后失效一次。
    expect(prReviewKeys.reviewers(null, null)).toEqual(prReviewKeys.reviewers("", 0));
    expect(prReviewKeys.protection(null, null)).toEqual(prReviewKeys.protection("", ""));
  });

  it("评审人键与分支保护键分属不同命名空间", () => {
    const key = prReviewKeys.protection("r1", "main");
    expect(key[0]).toBe("branch-protection");
    expect(prReviewKeys.reviewers("r1", 1)[0]).toBe("pr-reviewers");
  });
});

describe("PRReviewError", () => {
  it("保留动作、状态码与机器可读错误码", () => {
    // 界面按 operation 查翻译键、按 code 区分"不能批准自己的 PR"这类具体原因；
    // 只留一句 message 会让 400 与 403 在提示里长得一模一样。
    const err = new PRReviewError("review", 400, "pr_self_approve_forbidden");

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PRReviewError");
    expect(err.operation).toBe("review");
    expect(err.status).toBe(400);
    expect(err.code).toBe("pr_self_approve_forbidden");
    expect(err.message).toContain("400");
    expect(err.message).toContain("pr_self_approve_forbidden");
  });

  it("没有错误码时 code 为 null，message 里也不带空括号", () => {
    const err = new PRReviewError("protection", 500);

    expect(err.code).toBeNull();
    expect(err.message).toBe("protection failed with HTTP 500");
  });
});
