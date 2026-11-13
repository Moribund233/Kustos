/**
 * 把"待我评审"的 Inbox 通知推成系统通知，并带上批准按钮。
 *
 * 触发时机由 Inbox 查询驱动：每次拉到新的一批通知时挑出没弹过的那些。
 *
 * 两个刻意的克制：
 *
 *  1. **不主动轮询**——Inbox 自己已经在轮询通知列表（那是它的本职），这里挂在
 *     同一份数据上，不另开一条定时器；
 *  2. **弹过就记下**——记录只在内存里（一次会话内有效）。重启之后重新弹一遍
 *     是合理的：用户换了会话，那些 PR 可能仍然等着他。
 */
import { useEffect, useRef } from "react";

import type { InboxNotification } from "@/lib/inbox";
import { PR_REVIEW_CATEGORY } from "@/lib/notification-trigger";
import { pendingApprovalNotifications } from "@/lib/notification-trigger";
import { useNotifyWithActions } from "@/lib/notifications";

/** 通知里的按钮标识；与 app.tsx 里的处理分支约定一致。 */
export const APPROVE_ACTION = "approve";

/**
 * 订阅 Inbox 数据并在出现新的待评审通知时弹系统通知。
 *
 * Args:
 *
 *	items:       Inbox 通知列表
 *	enabled:     通知权限已授予、且会话就绪时为 true
 */
export function useReviewNotifications(items: InboxNotification[], enabled: boolean): void {
  const notify = useNotifyWithActions();
  // 已弹过的 id：没有它的话，每次列表重取都会重弹同一条。
  const shown = useRef<Set<string>>(new Set());

  // mutate 的引用在渲染之间会变，放进 ref 免得它成为 effect 的依赖——
  // 那会让每次渲染都重跑一遍判定。
  const notifyRef = useRef(notify.mutate);
  notifyRef.current = notify.mutate;

  useEffect(() => {
    if (!enabled) return;
    const pending = pendingApprovalNotifications(items, shown.current);
    for (const { item, repoId, number } of pending) {
      // 先记账再发：发送失败时也不该在下一轮重试成"一直弹"。
      shown.current.add(item.id);
      notifyRef.current({
        id: `review-${item.id}`,
        title: item.title,
        body: item.message,
        threadId: `pr-${repoId}-${String(number)}`,
        categoryId: PR_REVIEW_CATEGORY,
        actions: [{ id: APPROVE_ACTION, title: "批准" }],
        // 附加数据随通知走一圈回来：用户点批准时，界面才知道是哪一条 PR。
        data: { repoId, number: String(number) },
      });
    }
  }, [items, enabled]);
}
