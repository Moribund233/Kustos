import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@kustos/api";

/**
 * Inbox 的数据层。
 *
 * 只打真实接口，不做任何本地猜测：通知的已读状态、归属与可见性都由服务端
 * 裁决（`app/core/permissions.py` 是唯一权限裁决点）。桌面端在这里只负责
 * 取数与失效，不在本地重算。
 */

export const inboxKeys = {
  list: (unreadOnly: boolean) => ["inbox", "notifications", { unreadOnly }] as const,
  unreadCount: ["inbox", "unread-count"] as const,
};

/** 单条通知（与服务端 `build_notification_response` 的字段一一对应）。 */
export interface InboxNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  repositoryId: string | null;
  targetType: string | null;
  targetId: string | null;
  isRead: boolean;
  createdAt: string | null;
}

interface RawNotification {
  id?: string;
  type?: string;
  title?: string;
  message?: string;
  repository_id?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  is_read?: boolean;
  created_at?: string | null;
}

/** 把服务端的 snake_case 响应收敛成前端结构。 */
function toNotification(raw: RawNotification): InboxNotification {
  return {
    id: raw.id ?? "",
    type: raw.type ?? "",
    title: raw.title ?? "",
    message: raw.message ?? "",
    repositoryId: raw.repository_id ?? null,
    targetType: raw.target_type ?? null,
    targetId: raw.target_id ?? null,
    isRead: raw.is_read ?? false,
    createdAt: raw.created_at ?? null,
  };
}

/** 拉取通知列表。 */
export function useNotifications(unreadOnly = false, limit = 50) {
  return useQuery({
    queryKey: inboxKeys.list(unreadOnly),
    queryFn: async () => {
      const { data, error, response } = await api.GET("/api/v1/notifications", {
        params: { query: { unread_only: unreadOnly, limit } },
      });
      if (error || !response.ok) {
        throw new Error(`获取通知失败（HTTP ${response.status}）`);
      }
      const payload = data as { notifications?: RawNotification[]; total?: number } | undefined;
      return {
        items: (payload?.notifications ?? []).map(toNotification),
        total: payload?.total ?? 0,
      };
    },
    // 常驻应用：切 surface 不该重新拉；但通知会变，留一个不长的过期时间。
    staleTime: 15_000,
  });
}

/** 未读数（状态条用）。 */
export function useUnreadCount() {
  return useQuery({
    queryKey: inboxKeys.unreadCount,
    queryFn: async () => {
      const { data, error, response } = await api.GET("/api/v1/notifications/unread-count", {});
      if (error || !response.ok) {
        throw new Error(`获取未读数失败（HTTP ${response.status}）`);
      }
      return (data as { count?: number } | undefined)?.count ?? 0;
    },
    staleTime: 15_000,
  });
}

/** 标记单条已读。 */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error, response } = await api.PATCH("/api/v1/notifications/{notification_id}/read", {
        params: { path: { notification_id: id } },
      });
      if (error || !response.ok) {
        throw new Error(`标记已读失败（HTTP ${response.status}）`);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inbox"] });
    },
  });
}

/** 全部标记已读。 */
export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error, response } = await api.POST("/api/v1/notifications/read-all", {});
      if (error || !response.ok) {
        throw new Error(`全部已读失败（HTTP ${response.status}）`);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inbox"] });
    },
  });
}

/** 按类型归入设计里的三段：待我决策 / 我发起的 / 动态。 */
export type InboxSegment = "decide" | "authored" | "activity";

/**
 * 收件箱的分段。
 *
 * 只存 id 与翻译键，不存字面量：语言切换时这些标签必须跟着变，
 * 写死的文案会让界面出现"一半英文一半中文"的混用状态。
 */
export const SEGMENTS: { id: InboxSegment; i18nKey: string }[] = [
  { id: "decide", i18nKey: "inbox.segments.decide" },
  { id: "authored", i18nKey: "inbox.segments.authored" },
  { id: "activity", i18nKey: "inbox.segments.activity" },
];

/**
 * 判断一条通知落在哪一段。
 *
 * 服务端只给 `type`，没有"待我决策"这种动作语义——它取决于目标当前的状态
 * （例如 PR 是否仍待审）。桌面端不在本地推断动作语义（那会与服务端漂移），
 * 因此这里只按类型做**粗分**，真正的动作可用性等接入 PR/Issue 接口后
 * 由服务端字段决定。
 */
export function segmentOf(n: InboxNotification): InboxSegment {
  switch (n.type) {
    case "review":
    case "pull_request":
      return n.isRead ? "activity" : "decide";
    case "issue":
      return "authored";
    default:
      return "activity";
  }
}

/** 取某一段的条目。 */
export function itemsInSegment(items: InboxNotification[], segment: InboxSegment) {
  return items.filter((n) => segmentOf(n) === segment);
}

