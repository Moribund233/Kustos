import { useMemo, useState } from "react";

import { Button, Tabs, TabsList, TabsTrigger } from "@kustos/ui";

import {
  SEGMENTS,
  itemsInSegment,
  useMarkAllRead,
  useMarkRead,
  useNotifications,
  useUnreadCount,
  type InboxNotification,
  type InboxSegment,
} from "@/lib/inbox";

/**
 * Inbox（首页）：三段队列 + 就地处理。
 *
 * 桌面端是常驻工作台，因此这一面按"批量、单键、少跳转"设计：
 * 列表常驻在左栏，选中即在右侧看详情，不整页跳转。
 *
 * 空状态给可执行动作而不是产品介绍——用户要的是"接下来干什么"。
 */

interface InboxProps {
  /** 状态条右侧需要未读数，由外层读取以免重复请求。 */
  onUnreadCount?: (count: number) => void;
  /**
   * 由外层 Shell 决定两栏如何摆放：Inbox 自己管理选中态，
   * 因此渲染成 list/detail 两个片段而不是一整个页面。
   */
  children: (parts: { list: React.ReactNode; detail: React.ReactNode }) => React.ReactNode;
}

export function Inbox({ onUnreadCount, children }: InboxProps) {
  const [segment, setSegment] = useState<InboxSegment>("decide");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useNotifications(false);
  const unread = useUnreadCount();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  const items = list.data?.items ?? [];
  const unreadCount = unread.data ?? 0;
  onUnreadCount?.(unreadCount);

  const segmented = useMemo(() => itemsInSegment(items, segment), [items, segment]);
  const selected =
    segmented.find((n) => n.id === selectedId) ?? segmented[0] ?? null;

  return (
    <>
      {children({
        list: (
          <ListPane
            segment={segment}
            onSegment={setSegment}
            items={segmented}
            total={list.data?.total ?? 0}
            selectedId={selected?.id ?? null}
            onSelect={(n) => {
              setSelectedId(n.id);
              // 选中即视为看过：单键处理的桌面习惯，省掉一次显式操作。
              if (!n.isRead) markRead.mutate(n.id);
            }}
            loading={list.isLoading}
            error={list.error}
            unreadCount={unreadCount}
            onMarkAllRead={() => markAllRead.mutate()}
            markingAll={markAllRead.isPending}
          />
        ),
        detail: <DetailPane item={selected} loading={list.isLoading} />,
      })}
    </>
  );
}

/** 左栏：分段 + 条目列表。 */
function ListPane({
  segment,
  onSegment,
  items,
  total,
  selectedId,
  onSelect,
  loading,
  error,
  unreadCount,
  onMarkAllRead,
  markingAll,
}: {
  segment: InboxSegment;
  onSegment: (s: InboxSegment) => void;
  items: InboxNotification[];
  total: number;
  selectedId: string | null;
  onSelect: (n: InboxNotification) => void;
  loading: boolean;
  error: unknown;
  unreadCount: number;
  onMarkAllRead: () => void;
  markingAll: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-3 py-2">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[11px] font-medium tracking-wide text-faint uppercase">
            收件箱
          </h2>
          {unreadCount > 0 && (
            <span className="rounded bg-[var(--color-amber-600)] px-1 text-[10px] text-ink-900">
              {unreadCount}
            </span>
          )}
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={markingAll || unreadCount === 0}
            onClick={onMarkAllRead}
            className="h-6 px-2 text-[11px]"
          >
            全部已读
          </Button>
        </div>
        <Tabs value={segment} onValueChange={(v) => onSegment(v as InboxSegment)}>
          <TabsList className="h-7 w-full">
            {SEGMENTS.map((s) => (
              <TabsTrigger key={s.id} value={s.id} className="text-[11px]">
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && <EmptyHint>正在读取通知…</EmptyHint>}
        {!loading && error != null && (
          <EmptyHint tone="error">{errorText(error)}</EmptyHint>
        )}
        {!loading && error == null && items.length === 0 && (
          <EmptyHint>这一段没有待处理项。按 ⌘1 回到收件箱总览。</EmptyHint>
        )}
        {items.map((n) => (
          <NotificationRow
            key={n.id}
            notification={n}
            active={n.id === selectedId}
            onClick={() => onSelect(n)}
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-[var(--color-edge-1)] px-3 py-1.5 text-[11px] text-faint">
        共 {total} 条 · 本段 {items.length} 条
      </div>
    </div>
  );
}

/** 单条通知行：未读点在左，标题一行，摘要一行。 */
function NotificationRow({
  notification,
  active,
  onClick,
}: {
  notification: InboxNotification;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={[
        "flex w-full items-start gap-2 border-b border-[var(--color-edge-1)] px-3 py-2 text-left",
        active ? "bg-[var(--color-ink-800)]" : "hover:bg-[var(--color-ink-850)]",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
          notification.isRead ? "bg-transparent" : "bg-[var(--color-amber-500)]",
        ].join(" ")}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-bone">{notification.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted">
          {notification.message}
        </span>
      </span>
      <span className="shrink-0 text-[10px] text-faint">{relativeTime(notification.createdAt)}</span>
    </button>
  );
}

/** 右栏：详情。 */
function DetailPane({ item, loading }: { item: InboxNotification | null; loading: boolean }) {
  if (loading) {
    return <div className="p-6 text-[12px] text-muted">正在读取…</div>;
  }
  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-display text-lg text-bone">收件箱已清空</p>
        <p className="max-w-[42ch] text-[12px] leading-relaxed text-muted">
          没有待你决策的条目。新的评审请求与指派会出现在这里。
        </p>
      </div>
    );
  }

  return (
    <article className="mx-auto max-w-[68ch] p-6">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-faint">
        <span className="rounded border border-[var(--color-edge-2)] px-1.5 py-0.5">
          {item.type}
        </span>
        <span>{relativeTime(item.createdAt)}</span>
        {item.isRead && <span className="text-muted">· 已读</span>}
      </div>
      <h1 className="font-display mb-3 text-lg text-bone">{item.title}</h1>
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-bone-2">
        {item.message}
      </p>
      {item.targetType && item.targetId && (
        <p className="mt-4 text-[11px] text-faint">
          关联 {item.targetType} · {item.targetId.slice(0, 8)}
        </p>
      )}
    </article>
  );
}

function EmptyHint({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <p
      className={[
        "px-3 py-4 text-[12px] leading-relaxed",
        tone === "error" ? "text-[var(--color-rose)]" : "text-muted",
      ].join(" ")}
    >
      {children}
    </p>
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "加载失败，请检查实例连接";
}

/**
 * 相对时间。
 *
 * 通知列表的信息密度优先，绝对时间在这一层是噪声；详情区同样用相对时间，
 * 但悬停可看到完整时间（由调用方补充）。
 */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}
