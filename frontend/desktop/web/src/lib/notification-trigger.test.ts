import { describe, expect, it } from "vitest";

import type { InboxNotification } from "./inbox";
import { approvalTarget, pendingApprovalNotifications } from "./notification-trigger";

/** 一条"什么都对"的待评审通知，各用例只覆盖自己关心的字段。 */
function notification(patch: Partial<InboxNotification> = {}): InboxNotification {
  return {
    id: "n-1",
    type: "review_requested",
    title: "有一个 PR 等你评审",
    message: "改了三个文件",
    repositoryId: "repo-1",
    targetType: "pull_request",
    targetId: "42",
    isRead: false,
    createdAt: null,
    ...patch,
  };
}

describe("approvalTarget", () => {
  it("待评审的未读 PR 通知可以批准", () => {
    expect(approvalTarget(notification())).toEqual({ repoId: "repo-1", number: 42 });
  });

  it("已读的通知不再弹：那是用户刚处理完的事", () => {
    expect(approvalTarget(notification({ isRead: true }))).toBeNull();
  });

  it("目标不是 PR 时不带批准按钮", () => {
    expect(approvalTarget(notification({ targetType: "issue" }))).toBeNull();
    expect(approvalTarget(notification({ targetType: null }))).toBeNull();
  });

  it("缺仓库或编号时不给按钮：定位不到具体那一条", () => {
    expect(approvalTarget(notification({ repositoryId: null }))).toBeNull();
    expect(approvalTarget(notification({ repositoryId: "" }))).toBeNull();
    expect(approvalTarget(notification({ targetId: null }))).toBeNull();
    expect(approvalTarget(notification({ targetId: "" }))).toBeNull();
  });

  it("编号不是正整数时不猜：宁可没有按钮", () => {
    expect(approvalTarget(notification({ targetId: "abc" }))).toBeNull();
    expect(approvalTarget(notification({ targetId: "0" }))).toBeNull();
    expect(approvalTarget(notification({ targetId: "-3" }))).toBeNull();
    expect(approvalTarget(notification({ targetId: "4.5" }))).toBeNull();
  });
});

describe("pendingApprovalNotifications", () => {
  it("挑出本次该弹的，并带上批准所需标识", () => {
    const got = pendingApprovalNotifications([notification()], new Set());
    expect(got).toHaveLength(1);
    expect(got[0].repoId).toBe("repo-1");
    expect(got[0].number).toBe(42);
  });

  it("弹过的同一 id 不再弹：否则每次轮询都会跳一条", () => {
    const got = pendingApprovalNotifications([notification()], new Set(["n-1"]));
    expect(got).toEqual([]);
  });

  it("不可批准的通知被跳过", () => {
    const got = pendingApprovalNotifications(
      [
        notification({ id: "a", targetType: "issue" }),
        notification({ id: "b", isRead: true }),
        notification({ id: "c" }),
      ],
      new Set(),
    );
    expect(got.map((entry) => entry.item.id)).toEqual(["c"]);
  });
});
