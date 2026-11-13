import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/shell/icon";
import { StatusItem } from "@/shell/shell";
import { relativeTime } from "@/lib/relative-time";
import { InboxRequestError } from "@/lib/inbox";
import {
  SEGMENTS,
  itemsInSegment,
  useMarkAllRead,
  useMarkRead,
  useCachedNotifications,
  useNotifications,
  useUnreadCount,
  type InboxNotification,
  type InboxSegment,
} from "@/lib/inbox";

/**
 * Inbox（首页）：三段队列 + 就地处理。
 *
 * 结构对齐原型 `docs/prototype/desktop/index.html`：
 *
 *   listcol
 *   ├ list-head（标题 + 计数 + 分段 Changes/History/Stashes 的等价物）
 *   ├ list-scroll（group-label 分段 + row 条目）
 *   └ （无 commitbar）
 *   detail（选中项的详情卡片）
 *   insp（事实面板）
 *
 * 桌面端是常驻工作台，因此这一面按"批量、单键、少跳转"设计：
 * 列表常驻在左栏，选中即在右侧看详情，不整页跳转。
 *
 * 三段的划分只有一处依据：服务端给的通知类型。真正的"待我决策"取决于目标
 * 当前状态（PR 是否仍待审），那要等接入 PR/Issue 接口后由服务端字段决定——
 * 现在就在前端猜一个精确判定，等于埋一条与服务端漂移的逻辑。
 */

export interface InboxParts {
  list: React.ReactNode;
  detail: React.ReactNode;
  inspector?: React.ReactNode;
  statusLeft: React.ReactNode;
  statusRight: React.ReactNode;
  badges: { inbox: number };
}

export function useInbox() {
  const [segment, setSegment] = useState<InboxSegment>("decide");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useNotifications(false);
  const unread = useUnreadCount();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  // 在线失败时回落到本地缓存：断网重开也能翻到上次的 Inbox，
  // 但界面必须标明那份数据是什么时候的。
  const cached = useCachedNotifications(false, list.isError);

  const items = list.data?.items ?? [];
  const unreadCount = unread.data ?? 0;
  const segmented = useMemo(() => itemsInSegment(items, segment), [items, segment]);
  const selected = segmented.find((n) => n.id === selectedId) ?? segmented[0] ?? null;

  return {
    segment,
    setSegment,
    items,
    segmented,
    selected,
    total: list.data?.total ?? 0,
    unreadCount,
    loading: list.isLoading,
    error: list.error,
    /** 在线失败时的缓存快照；null 表示没有可用的离线内容。 */
    cached: cached.data ?? null,
    select: (n: InboxNotification) => {
      setSelectedId(n.id);
      // 选中即视为看过：单键处理的桌面习惯，省掉一次显式操作。
      if (!n.isRead) markRead.mutate(n.id);
    },
    markAllRead: () => markAllRead.mutate(),
    markingAll: markAllRead.isPending,
  };
}

type InboxState = ReturnType<typeof useInbox>;

export function InboxList({ state }: { state: InboxState }) {
  const { t } = useTranslation();
  const { segment, setSegment, segmented, total, unreadCount, loading, error } = state;

  return (
    <section className="flex h-full flex-col" aria-label={t("inbox.title")}>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <h1 className="text-[13px] font-medium text-[var(--color-bone)]">{t("inbox.title")}</h1>
          {unreadCount > 0 && (
            <span className="text-[11px] text-[var(--color-amber)] tabular-nums">
              {unreadCount}
            </span>
          )}
          <span className="ml-auto text-[10.5px] text-[var(--color-faint)]">
            {t("inbox.total", { count: total })}
          </span>
        </div>
        <div className="mt-2 flex gap-0.5 rounded-[7px] border border-[var(--color-edge-1)] bg-[rgba(8,13,16,0.55)] p-0.5">
          {SEGMENTS.map((s) => {
            const on = s.id === segment;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSegment(s.id)}
                className={[
                  "h-[22px] flex-1 rounded-[5px] text-[11px] whitespace-nowrap",
                  on
                    ? "bg-[var(--color-ink-750)] text-[var(--color-bone)] shadow-[inset_0_1px_0_rgba(240,231,216,0.045)]"
                    : "text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]",
                ].join(" ")}
              >
                {t(s.i18nKey)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && <Hint>{t("inbox.loading")}</Hint>}
        {/* 离线兜底：在线失败但本地有缓存时，不能只报一句"加载失败"——
            用户断网时最需要看的正是上次那份清单。 */}
        {!loading && error != null && state.cached != null && (
          <div className="border-b border-[var(--color-edge-1)] bg-[rgba(242,174,91,0.08)] px-3 py-1.5 text-[10.5px] leading-relaxed text-[var(--color-amber-3)]">
            {t("inbox.offlineCached", { when: cachedWhen(state.cached.fetchedAt, t) })}
          </div>
        )}
        {!loading && error != null && state.cached == null && (
          <Hint tone="rose">{errorText(error, t, "inbox.loadFailed")}</Hint>
        )}
        {!loading && error == null && segmented.length === 0 && (
          <Hint>{t("inbox.emptySegment")}</Hint>
        )}

        {segmented.length > 0 && (
          <p className="flex items-center gap-1.5 px-3 pt-[11px] pb-[5px] text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase">
            {segmentLabel(segment, t)}
            <span className="tracking-normal text-[var(--color-muted-2)]">{segmented.length}</span>
          </p>
        )}

        {segmented.map((n) => {
          const on = n.id === state.selected?.id;
          return (
            <div
              key={n.id}
              role="button"
              tabIndex={0}
              onClick={() => state.select(n)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  state.select(n);
                }
              }}
              className={[
                "flex cursor-pointer items-start gap-2 border-l-2 py-1.5 pr-3 pl-2.5",
                on
                  ? "border-l-[var(--color-amber)] bg-[var(--color-ink-800)]"
                  : "border-l-transparent hover:bg-[var(--color-ink-850)]",
              ].join(" ")}
            >
              <span
                aria-hidden
                className={[
                  "mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full",
                  n.isRead ? "bg-[var(--color-faint)]" : "bg-[var(--color-amber)]",
                ].join(" ")}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-[var(--color-bone-2)]">
                  {n.title}
                </span>
                <span className="mt-0.5 block truncate text-[10.5px] text-[var(--color-muted-2)]">
                  {n.message} · {relativeTime(n.createdAt, t)}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-edge-1)] px-3 py-1.5">
        <span className="text-[10px] text-[var(--color-faint)]">
          {t("inbox.total", { count: total })} · {t("inbox.segmentCount", { count: segmented.length })}
        </span>
        <button
          type="button"
          disabled={state.markingAll || unreadCount === 0}
          onClick={state.markAllRead}
          className="ml-auto rounded-[7px] px-2 py-0.5 text-[11px] text-[var(--color-muted-2)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-bone-2)] disabled:opacity-40"
        >{t("inbox.markAllRead")}</button>
      </div>
    </section>
  );
}

export function InboxDetail({ state }: { state: InboxState }) {
  const { t } = useTranslation();
  const item = state.selected;

  if (state.loading) {
    return <p className="p-5 text-[12px] text-[var(--color-muted)]">{t("inbox.loading")}</p>;
  }

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[15px] text-[var(--color-bone)]">{t("inbox.emptyAll")}</p>
        <p className="max-w-[42ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
          {t("inbox.emptyAllHint")}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-5 pt-[13px] pb-[11px]">
        <div className="flex items-center gap-[7px] text-[10px] tracking-[0.14em] text-[var(--color-faint)] uppercase">
          <span>{segmentLabel(segmentOfType(item), t)}</span>
          <span className="text-[var(--color-faint)]">·</span>
          <span>{item.type}</span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] tracking-normal normal-case">
            <span>{relativeTime(item.createdAt, t)}</span>
            {item.isRead && <span className="text-[var(--color-muted-2)]">· {t("inbox.read")}</span>}
          </span>
        </div>
        <h2 className="mt-1 text-[15px] font-medium tracking-[-0.01em] text-[var(--color-bone)]">
          {item.title}
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-[74ch]">
          <div className="mb-3.5 flex items-start gap-[9px] rounded-[7px] border border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(19,32,39,0.5),rgba(12,21,26,0.62))] px-3 py-2">
            <Icon name="lock" size={13} className="mt-px shrink-0 text-[var(--color-muted-2)]" />
            <span className="text-[11px] leading-relaxed text-[var(--color-muted)]">
              {t("inbox.inspector.banner")}
            </span>
          </div>

          <p className="mt-0.5 text-[12.5px] leading-[1.6] whitespace-pre-wrap text-[var(--color-bone-2)]">
            {item.message}
          </p>

          {item.targetType && item.targetId && (
            <p className="mt-4 text-[11px] text-[var(--color-faint)]">
              {t("inbox.related", { type: item.targetType })} · <span className="font-mono">{item.targetId.slice(0, 8)}</span>
            </p>
          )}
        </div>
      </div>
    </>
  );
}

/** 详情右侧的事实面板。 */
export function InboxInspector({ state }: { state: InboxState }) {
  const { t } = useTranslation();
  const item = state.selected;
  return (
    <aside
      aria-label={t("inbox.inspector.title")}
      className="flex w-[292px] shrink-0 flex-col border-l border-[var(--color-edge-1)] bg-[var(--color-ink-900)]"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-edge-1)] px-3 py-2.5">
        <div className="flex gap-0.5">
          <button
            type="button"
            className="h-[22px] rounded-[5px] bg-[var(--color-ink-750)] px-[7px] text-[11px] text-[var(--color-bone)]"
          >{t("inbox.inspector.tabFacts")}</button>
          <button
            type="button"
            className="h-[22px] rounded-[5px] px-[7px] text-[11px] text-[var(--color-muted-2)]"
          >{t("inbox.inspector.tabSource")}</button>
        </div>
        <button
          type="button"
          aria-label={t("inbox.inspector.close")}
          className="ml-auto text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]"
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pt-2.5 pb-6">
        <SectionLabel>{t("inbox.inspector.sectionNotification")}</SectionLabel>
        <dl>
          <KV k={t("inbox.inspector.type")} v={item?.type ?? "—"} />
          <KV k={t("inbox.inspector.segment")} v={item ? segmentLabel(segmentOfType(item), t) : "—"} />
          <KV k={t("inbox.inspector.state")} v={item?.isRead ? t("inbox.read") : t("inbox.unread")} />
          <KV k={t("inbox.inspector.time")} v={item ? relativeTime(item.createdAt, t) : "—"} />
        </dl>

        <SectionLabel>{t("inbox.inspector.sectionRelated")}</SectionLabel>
        <dl>
          <KV k={t("inbox.inspector.targetType")} v={item?.targetType ?? "—"} mono={Boolean(item?.targetType)} />
          <KV
            k={t("inbox.inspector.targetId")}
            v={item?.targetId ? item.targetId.slice(0, 8) : "—"}
            mono={Boolean(item?.targetId)}
          />
        </dl>

        <SectionLabel>{t("inbox.inspector.sectionNext")}</SectionLabel>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] leading-relaxed text-[var(--color-muted-2)]">
            {t("inbox.inspector.nextHint")}
          </span>
        </div>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 mb-1 text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase first:mt-0">
      {children}
    </p>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-[11px]">
      <dt className="text-[var(--color-muted-2)]">{k}</dt>
      <dd className={`text-right text-[var(--color-bone-2)] ${mono ? "font-mono" : ""}`}>{v}</dd>
    </div>
  );
}

function Hint({ children, tone }: { children: React.ReactNode; tone?: "rose" }) {
  return (
    <p
      className={[
        "px-3 py-4 text-[11.5px] leading-relaxed",
        tone === "rose" ? "text-[var(--color-rose)]" : "text-[var(--color-muted)]",
      ].join(" ")}
    >
      {children}
    </p>
  );
}

/**
 * 把请求错误渲染成可读文案。
 *
 * 结构化错误按操作类型查翻译键，并保留 HTTP 状态码——"HTTP 401" 对
 * 排查很关键，而一句"加载失败"没有信息量。其余错误直接用 message。
 */
/**
 * 把缓存的取回时刻说成人话。
 *
 * 缺了这句"什么时候的"，用户会把几天前的 Inbox 当作现在的状态——
 * 而断网时这正是最容易发生的误判。
 */
function cachedWhen(fetchedAt: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (fetchedAt <= 0) return t("inbox.cachedUnknown");
  return relativeTime(new Date(fetchedAt).toISOString(), t);
}

function errorText(
  error: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
  fallbackKey: string,
): string {
  if (error instanceof InboxRequestError) {
    const key = `inbox.errors.${error.operation}`;
    return t(key, { status: error.status });
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return t(fallbackKey);
}

function segmentLabel(seg: InboxSegment, t: (k: string) => string): string {
  return t(`inbox.segments.${seg}`);
}

/** 按类型粗分段（与服务端仅在类型层面一致，见文件头说明）。 */

function segmentOfType(n: InboxNotification): InboxSegment {
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

export { StatusItem };












