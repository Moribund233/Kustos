import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/shell/icon";
import { relativeTime } from "@/lib/relative-time";
import { useRepositories, type Repository } from "@/lib/repos";
import {
  ISSUE_SEGMENTS,
  IssuesRequestError,
  itemsInSegment,
  segmentCounts,
  useIssue,
  useIssues,
  type Issue,
  type IssueSegment,
} from "@/lib/issues";

/**
 * Issues 面：仓库 → 分段列表 → 详情 → 事实面板。
 *
 * 与 Pull requests 面共用同一套布局约定（标题栏 + 分段 + 行 + 详情 + 事实面板），
 * 但**不共用组件**：两者的行内信息、分段语义与事实字段各不相同，抽一个
 * 泛型组件会让两边都为对方的差异付出分支代价。
 *
 * 目标仓库解析：建议仓库 → 手动选择 → 列表首个。不做本地权限推断。
 */

/** 这一面的全部状态；由外层装配进 Shell。 */
export interface IssuesState {
  repos: Repository[];
  reposLoading: boolean;
  reposError: unknown;
  repo: Repository | null;
  manuallySelected: boolean;
  selectRepo: (repoId: string) => void;
  segment: IssueSegment;
  setSegment: (s: IssueSegment) => void;
  items: Issue[];
  segmented: Issue[];
  selected: Issue | null;
  select: (issue: Issue) => void;
  total: number;
  counts: Record<IssueSegment, number>;
  loading: boolean;
  error: unknown;
  detail: ReturnType<typeof useIssue>;
}

/**
 * 汇总 Issues 面的全部状态。
 *
 * Args:
 *
 *	preferredRepoId: 外部建议的仓库 id；为空或对不上任何可见仓库时退回列表首个
 *
 * Returns:
 *
 *	可直接交给列表/详情/检查器三段渲染的状态。
 */
export function useIssuesSurface(preferredRepoId: string | null = null): IssuesState {
  const [manualRepoId, setManualRepoId] = useState<string | null>(null);
  const [segment, setSegment] = useState<IssueSegment>("open");
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);

  const repos = useRepositories();
  const visible = repos.data ?? [];

  // 建议值必须真的在可见仓库里，否则拿它发请求只会换回 403/404。
  const preferred = preferredRepoId
    ? (visible.find((r) => r.id === preferredRepoId) ?? null)
    : null;

  const repo =
    (manualRepoId ? (visible.find((r) => r.id === manualRepoId) ?? null) : null) ??
    preferred ??
    visible[0] ??
    null;

  const list = useIssues(repo?.id ?? null, { status: segment });
  const items = list.data?.items ?? [];
  const segmented = itemsInSegment(items, segment);
  const selected =
    segmented.find((issue) => issue.number === selectedNumber) ?? segmented[0] ?? null;
  const detail = useIssue(repo?.id ?? null, selected?.number ?? null);

  return {
    repos: visible,
    reposLoading: repos.isLoading,
    reposError: repos.error,
    repo,
    manuallySelected: manualRepoId !== null,
    selectRepo: (repoId: string) => {
      setManualRepoId(repoId);
      setSelectedNumber(null);
    },
    segment,
    setSegment: (s: IssueSegment) => {
      setSegment(s);
      setSelectedNumber(null);
    },
    items,
    segmented,
    selected,
    select: (issue: Issue) => setSelectedNumber(issue.number),
    total: list.data?.total ?? 0,
    counts: segmentCounts(items),
    loading: list.isLoading,
    error: list.error,
    detail,
  };
}

type IssuesSurfaceState = ReturnType<typeof useIssuesSurface>;

/** 列表栏：仓库选择 + 分段 + Issue 行。 */
export function IssuesList({ state }: { state: IssuesSurfaceState }) {
  const { t } = useTranslation();

  return (
    <section className="flex h-full flex-col" aria-label={t("issues.title")}>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <h1 className="text-[13px] font-medium text-[var(--color-bone)]">{t("issues.title")}</h1>
          <span className="ml-auto text-[10.5px] text-[var(--color-faint)]">
            {t("issues.total", { count: state.total })}
          </span>
        </div>

        <RepoPicker state={state} />

        <div className="mt-2 flex gap-0.5 rounded-[7px] border border-[var(--color-edge-1)] bg-[rgba(8,13,16,0.55)] p-0.5">
          {ISSUE_SEGMENTS.map((s) => {
            const on = s.id === state.segment;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => state.setSegment(s.id)}
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
        {state.reposLoading && <Hint>{t("common.loading")}</Hint>}
        {!state.reposLoading && state.repos.length === 0 && <Hint>{t("pulls.noRepo")}</Hint>}
        {state.loading && <Hint>{t("issues.loading")}</Hint>}
        {!state.loading && state.error != null && (
          <Hint tone="rose">{errorText(state.error, t, "issues.listFailed")}</Hint>
        )}
        {!state.loading && state.error == null && state.repo && state.segmented.length === 0 && (
          <Hint>{t("issues.emptySegment")}</Hint>
        )}

        {state.segmented.map((issue) => {
          const on = issue.number === state.selected?.number;
          return (
            <div
              key={issue.id}
              role="button"
              tabIndex={0}
              onClick={() => state.select(issue)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  state.select(issue);
                }
              }}
              className={[
                "flex cursor-pointer items-start gap-2 border-l-2 py-1.5 pr-3 pl-2.5",
                on
                  ? "border-l-[var(--color-amber)] bg-[var(--color-ink-800)]"
                  : "border-l-transparent hover:bg-[var(--color-ink-850)]",
              ].join(" ")}
            >
              <Icon
                name="issue"
                size={13}
                className={[
                  "mt-[3px] shrink-0",
                  issue.status === "closed"
                    ? "text-[var(--color-muted-2)]"
                    : "text-[var(--color-sage)]",
                ].join(" ")}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-[var(--color-bone-2)]">
                  {issue.title}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[var(--color-muted-2)]">
                  <span className="shrink-0">#{issue.number}</span>
                  {issue.priority && (
                    <span className="shrink-0 rounded border border-[var(--color-edge-2)] px-1 text-[9.5px]">
                      {issue.priority}
                    </span>
                  )}
                  <span className="truncate">{relativeTime(issue.createdAt, t)}</span>
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-edge-1)] px-3 py-1.5">
        <span className="text-[10px] text-[var(--color-faint)]">
          {t("issues.total", { count: state.total })}
        </span>
        {state.repo && (
          <span className="ml-auto truncate font-mono text-[10px] text-[var(--color-muted-2)]">
            {state.repo.path}
          </span>
        )}
      </div>
    </section>
  );
}

/** 详情区：标题 + 状态 + 描述 + 评论。 */
export function IssuesDetail({ state }: { state: IssuesSurfaceState }) {
  const { t } = useTranslation();

  if (!state.repo) {
    return <EmptyAll title={t("issues.emptyAll")} hint={t("pulls.noRepo")} />;
  }

  const issue = state.detail.data ?? state.selected;
  if (!issue) {
    if (state.loading) {
      return <p className="p-5 text-[12px] text-[var(--color-muted)]">{t("issues.loading")}</p>;
    }
    return <EmptyAll title={t("issues.emptyAll")} hint={t("issues.emptyAllHint")} />;
  }

  // 详情接口才带 comments。
  const comments = issue.comments ?? [];

  return (
    <>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-5 pt-[13px] pb-[11px]">
        <div className="flex items-center gap-[7px] text-[10px] tracking-[0.14em] text-[var(--color-faint)] uppercase">
          <span>#{issue.number}</span>
          <span>·</span>
          <span>{issue.status}</span>
          {issue.priority && (
            <>
              <span>·</span>
              <span>{issue.priority}</span>
            </>
          )}
          <span className="ml-auto tracking-normal normal-case">
            {relativeTime(issue.createdAt, t)}
          </span>
        </div>
        <h2 className="mt-1 text-[15px] font-medium tracking-[-0.01em] text-[var(--color-bone)]">
          {issue.title}
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-[74ch]">
          <div className="mb-3.5 flex items-start gap-[9px] rounded-[7px] border border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(19,32,39,0.5),rgba(12,21,26,0.62))] px-3 py-2">
            <Icon name="lock" size={13} className="mt-px shrink-0 text-[var(--color-muted-2)]" />
            <span className="text-[11px] leading-relaxed text-[var(--color-muted)]">
              {t("issues.readOnlyHint")}
            </span>
          </div>

          {issue.description ? (
            <p className="text-[12.5px] leading-[1.6] whitespace-pre-wrap text-[var(--color-bone-2)]">
              {issue.description}
            </p>
          ) : (
            <p className="text-[11.5px] text-[var(--color-faint)]">{t("issues.noBody")}</p>
          )}

          <p className="mt-5 mb-1 text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase">
            {t("issues.sectionComments")}
            {comments.length > 0 && <span className="ml-1.5 tracking-normal">{comments.length}</span>}
          </p>

          {state.detail.error != null && (
            <p className="text-[11.5px] text-[var(--color-rose)]">
              {errorText(state.detail.error, t, "issues.commentsFailed")}
            </p>
          )}
          {comments.length === 0 ? (
            <p className="py-1 text-[11.5px] text-[var(--color-faint)]">{t("issues.noComments")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-[7px] border border-[var(--color-edge-1)] bg-[rgba(12,21,26,0.5)] px-3 py-2"
                >
                  <p className="flex items-center gap-2 text-[10.5px] text-[var(--color-muted-2)]">
                    <span>{c.author?.username ?? "—"}</span>
                    <span className="ml-auto shrink-0">{relativeTime(c.createdAt, t)}</span>
                  </p>
                  <p className="mt-1 text-[12px] leading-[1.55] whitespace-pre-wrap text-[var(--color-bone-2)]">
                    {c.content}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

/** 右侧事实面板。 */
export function IssuesInspector({ state }: { state: IssuesSurfaceState }) {
  const { t } = useTranslation();
  const issue = state.detail.data ?? state.selected;

  return (
    <aside
      aria-label={t("issues.inspector.title")}
      className="flex w-[292px] shrink-0 flex-col border-l border-[var(--color-edge-1)] bg-[var(--color-ink-900)]"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-edge-1)] px-3 py-2.5">
        <span className="text-[11px] text-[var(--color-bone-2)]">{t("issues.inspector.title")}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pt-2.5 pb-6">
        <SectionLabel>{t("issues.inspector.sectionIssue")}</SectionLabel>
        <dl>
          <KV k={t("issues.inspector.number")} v={issue ? `#${issue.number}` : "—"} mono />
          <KV k={t("issues.inspector.state")} v={issue?.status ?? "—"} />
          <KV k={t("issues.inspector.author")} v={issue?.author?.username ?? "—"} />
          <KV k={t("issues.state")} v={issue?.priority ?? "—"} />
          <KV k={t("issues.createdAt")} v={issue ? relativeTime(issue.createdAt, t) : "—"} />
        </dl>

        <SectionLabel>{t("issues.inspector.sectionNext")}</SectionLabel>
        <p className="text-[11px] leading-relaxed text-[var(--color-muted-2)]">
          {t("issues.inspector.nextHint")}
        </p>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* 共用片段                                                            */
/* ------------------------------------------------------------------ */

/** 仓库选择器：仓库多于一间时才渲染，避免只有一个选项时占一行。 */
function RepoPicker({ state }: { state: IssuesSurfaceState }) {
  const { t } = useTranslation();
  if (state.repos.length <= 1) return null;

  return (
    <label className="mt-2 flex items-center gap-1.5 text-[10.5px] text-[var(--color-faint)]">
      <span className="shrink-0">{t("pulls.repoPicker")}</span>
      <select
        value={state.repo?.id ?? ""}
        onChange={(e) => state.selectRepo(e.target.value)}
        className="min-w-0 flex-1 truncate rounded-[5px] border border-[var(--color-edge-1)] bg-[rgba(8,13,16,0.6)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-bone-2)]"
      >
        {state.repos.map((r) => (
          <option key={r.id} value={r.id}>
            {r.path || r.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmptyAll({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-[15px] text-[var(--color-bone)]">{title}</p>
      <p className="max-w-[46ch] text-[12px] leading-relaxed text-[var(--color-muted)]">{hint}</p>
    </div>
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
      <dt className="shrink-0 text-[var(--color-muted-2)]">{k}</dt>
      <dd className={`truncate text-right text-[var(--color-bone-2)] ${mono ? "font-mono" : ""}`}>
        {v}
      </dd>
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
 * 结构化错误按操作类型查翻译键，并保留 HTTP 状态码——"HTTP 403" 对排查
 * 很关键，而一句"加载失败"没有信息量。
 */
function errorText(
  error: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
  fallbackKey: string,
): string {
  if (error instanceof IssuesRequestError) {
    return t(`issues.errors.${error.operation}`, { status: error.status });
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return t(fallbackKey);
}
