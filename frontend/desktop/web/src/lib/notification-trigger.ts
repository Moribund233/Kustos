/**
 * 系统通知的触发判定。
 *
 * 桌面端只在**服务端已经给出的事实**上弹通知：一条通知是否值得打扰用户，
 * 取决于它是不是"待我决策"，而那个判断的依据是服务端给出的 type 与目标类型，
 * 不是本地猜的。
 *
 * 为什么要有这个模块而不是在界面里随手写 if：判定错了的两个方向都很难受——
 * 漏弹（用户以为没人找他）、乱弹（每次刷新都跳一条）。纯函数才能被单测钉住。
 */
import type { InboxNotification } from "@/lib/inbox";

/** 通知上的动作按钮组：同一类决策复用一组按钮。 */
export const PR_REVIEW_CATEGORY = "pr-review";

/**
 * 一条通知能不能变成"可批准的系统通知"。
 *
 * Args:
 *
 *	item: Inbox 里的一条通知
 *
 * Returns:
 *
 *	能时返回批准它需要的那几个标识；否则为 null。
 *
 * 条件写得很紧：目标必须是 PR、必须带仓库与编号、且这条通知本身未读。
 * 已读的通知不该再弹——那等于把用户刚处理完的事又推一遍。
 */
export function approvalTarget(item: InboxNotification): { repoId: string; number: number } | null {
  if (item.isRead) return null;
  if (item.targetType !== "pull_request") return null;
  if (item.repositoryId == null || item.repositoryId === "") return null;
  // PR 编号只在仓库内唯一，缺了它就无法定位到具体那一条。
  const number = Number(item.targetId ?? "");
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repoId: item.repositoryId, number };
}

/**
 * 从通知列表里挑出"值得弹系统通知"的那几条。
 *
 * Args:
 *
 *	items: Inbox 通知（未读优先）
 *	already: 已经弹过的通知 id
 *
 * Returns:
 *
 *	本次该弹的通知，每条都带批准所需的标识。
 *
 * `already` 由调用方持久持有：没有它的话，每次轮询都会把同一条重新弹一次。
 */
export function pendingApprovalNotifications(
  items: InboxNotification[],
  already: ReadonlySet<string>,
): { item: InboxNotification; repoId: string; number: number }[] {
  const out: { item: InboxNotification; repoId: string; number: number }[] = [];
  for (const item of items) {
    if (already.has(item.id)) continue;
    const target = approvalTarget(item);
    if (target === null) continue;
    out.push({ item, repoId: target.repoId, number: target.number });
  }
  return out;
}
