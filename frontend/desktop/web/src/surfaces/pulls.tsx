import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/shell/icon";
import { relativeTime } from "@/lib/relative-time";
import { useRepositories, type Repository } from "@/lib/repos";
import { openReviewWindow } from "@/lib/window";
import {
  PULL_SEGMENTS,
  PullsRequestError,
  itemsInSegment,
  segmentCounts,
  usePullRequest,
  usePullRequests,
  type PullRequest,
  type PullRequestSegment,
} from "@/lib/pulls";

/**
 * Pull requests 面：仓库 → 分段列表 → 详情 → 事实面板。
 *
 * 结构与其他面一致（三栏由 Shell 摆放），这一面只提供列表/详情/检查器三段。
 *
 * 目标仓库的解析顺序：
 *   1. 调用方给的建议仓库（`preferredRepoId`）——由装配层从"当前工作副本的
 *      git remote"推导而来，表达"我在这个仓库里改代码，PR 自然是它的 PR"；
 *   2. 用户手动选择的仓库；
 *   3. 可见仓库列表的第一个。
 *
 * 建议值为空就不猜：宁可退回列表首个 + 显示仓库选择器，也不猜一个错的仓库
 * 去拉一堆无关的 PR。
 *
 * 不做本地权限推断：能看到哪些仓库、哪些 PR 都由服务端裁决，
 * 列表接口本身已经按查看者过滤过了。
 */

/** 这一面的全部状态；由外层装配进 Shell。 */
export interface PullsState {
  repos: Repository[];
  reposLoading: boolean;
  reposError: unknown;
  /** 当前关联的仓库；没有任何可见仓库时为 null。 */
  repo: Repository | null;
  /** 用户是否手动选过仓库（为 false 时界面不显示选中态提示）。 */
  manuallySelected: boolean;
  selectRepo: (repoId: string) => void;
  segment: PullRequestSegment;
  setSegment: (s: PullRequestSegment) => void;
  items: PullRequest[];
  segmented: PullRequest[];
  selected: PullRequest | null;
  select: (pr: PullRequest) => void;
  total: number;
  counts: Record<PullRequestSegment, number>;
  loading: boolean;
  error: unknown;
  detail: ReturnType<typeof usePullRequest>;
}

/**
 * 汇总 Pull requests 面的全部状态。
 *
 * Args:
 *
 *	preferredRepoId: 外部建议的仓库 id（如由当前工作副本的 remote 推出）；
 *	                 为空或对不上任何可见仓库时退回列表首个
 *
 * Returns:
 *
 *	可直接交给列表/详情/检查器三段渲染的状态。
 */
export function usePullsSurface(preferredRepoId: string | null = null): PullsState {
  const [manualRepoId, setManualRepoId] = useState<string | null>(null);
  const [segment, setSegment] = useState<PullRequestSegment>("open");
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);

  const repos = useRepositories();
  const visible = repos.data ?? [];

  // 建议值必须真的在可见仓库里：对不上时不能拿它去发请求，
  // 那会得到一个必然 403/404 的结果，而界面上只会显示"加载失败"。
  const preferred = preferredRepoId
    ? (visible.find((r) => r.id === preferredRepoId) ?? null)
    : null;

  const repo =
    (manualRepoId ? (visible.find((r) => r.id === manualRepoId) ?? null) : null) ??
    preferred ??
    visible[0] ??
    null;

  const list = usePullRequests(repo?.id ?? null, { status: segment });
  const items = list.data?.items ?? [];
  // 服务端已按 status 过滤过，这里再分一次段只为让"分段切换时的行高不跳"，
  // 同时兜住服务端把 is_draft 之类的边界情况放进来的情形。
  const segmented = itemsInSegment(items, segment);
  const selected =
    segmented.find((pr) => pr.number === selectedNumber) ?? segmented[0] ?? null;
  const detail = usePullRequest(repo?.id ?? null, selected?.number ?? null);

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
    setSegment: (s: PullRequestSegment) => {
      setSegment(s);
      setSelectedNumber(null);
    },
    items,
    segmented,
    selected,
    select: (pr: PullRequest) => setSelectedNumber(pr.number),
    total: list.data?.total ?? 0,
    counts: segmentCounts(items),
    loading: list.isLoading,
    error: list.error,
    detail,
  };
}

type PullsSurfaceState = ReturnType<typeof usePullsSurface>;

/** 列表栏：仓库选择 + 分段 + PR 行。 */
export function PullsList({ state }: { state: PullsSurfaceState }) {
  const { t } = useTranslation();

  return (
    <section className="flex h-full flex-col" aria-label={t("pulls.title")}>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <h1 className="text-[13px] font-medium text-[var(--color-bone)]">{t("pulls.title")}</h1>
          <span className="ml-auto text-[10.5px] text-[var(--color-faint)]">
            {t("pulls.total", { count: state.total })}
          </span>
        </div>

        <RepoPicker state={state} />

        <div className="mt-2 flex gap-0.5 rounded-[7px] border border-[var(--color-edge-1)] bg-[rgba(8,13,16,0.55)] p-0.5">
          {PULL_SEGMENTS.map((s) => {
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
        {state.loading && <Hint>{t("pulls.loading")}</Hint>}
        {!state.loading && state.error != null && (
          <Hint tone="rose">{errorText(state.error, t, "pulls.listFailed")}</Hint>
        )}
        {!state.loading && state.error == null && state.repo && state.segmented.length === 0 && (
          <Hint>{t("pulls.emptySegment")}</Hint>
        )}

        {state.segmented.map((pr) => {
          const on = pr.number === state.selected?.number;
          return (
            <div
              key={pr.id}
              role="button"
              tabIndex={0}
              onClick={() => state.select(pr)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  state.select(pr);
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
                name="pr"
                size={13}
                className={[
                  "mt-[3px] shrink-0",
                  pr.isDraft ? "text-[var(--color-muted-2)]" : "text-[var(--color-sage)]",
                ].join(" ")}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate text-[12px] text-[var(--color-bone-2)]">{pr.title}</span>
                  {pr.isDraft && (
                    <span className="shrink-0 rounded border border-[var(--color-edge-2)] px-1 text-[9.5px] text-[var(--color-muted-2)]">
                      {t("pulls.draft")}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[10.5px] text-[var(--color-muted-2)]">
                  #{pr.number} · {pr.sourceBranch} → {pr.targetBranch} ·{" "}
                  {relativeTime(pr.createdAt, t)}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-edge-1)] px-3 py-1.5">
        <span className="text-[10px] text-[var(--color-faint)]">
          {t("pulls.total", { count: state.total })}
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

/** 详情区：标题 + 分支 + 描述 + 评论。 */
export function PullsDetail({ state }: { state: PullsSurfaceState }) {
  const { t } = useTranslation();

  if (!state.repo) {
    return <EmptyAll title={t("pulls.emptyAll")} hint={t("pulls.noRepo")} />;
  }

  const pr = state.detail.data ?? state.selected;
  if (!pr) {
    if (state.loading) {
      return <p className="p-5 text-[12px] text-[var(--color-muted)]">{t("pulls.loading")}</p>;
    }
    return <EmptyAll title={t("pulls.emptyAll")} hint={t("pulls.emptyAllHint")} />;
  }

  // 上面的 `!state.repo` 已保证存在；先取出来，闭包里就不用再判空。
  const repoId = state.repo.id;

  // 详情接口才带 comments；列表快照里是空数组，两者取其有。
  const comments = pr.comments ?? [];

  return (
    <>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-5 pt-[13px] pb-[11px]">
        <div className="flex items-center gap-[7px] text-[10px] tracking-[0.14em] text-[var(--color-faint)] uppercase">
          <span>#{pr.number}</span>
          <span>·</span>
          <span>{pr.status}</span>
          <span className="ml-auto tracking-normal normal-case">
            {relativeTime(pr.createdAt, t)}
          </span>
          <button
            type="button"
            onClick={() => openReviewWindow(repoId, pr.number)}
            aria-label={t("pulls.openInWindow")}
            title={t("pulls.openInWindow")}
            className="ml-1 grid h-[20px] w-[20px] place-items-center rounded-[5px] tracking-normal text-[var(--color-muted-2)] normal-case hover:bg-[var(--color-ink-800)] hover:text-[var(--color-bone-2)]"
          >
            <Icon name="external" size={11} />
          </button>
        </div>
        <h2 className="mt-1 text-[15px] font-medium tracking-[-0.01em] text-[var(--color-bone)]">
          {pr.title}
        </h2>
        <p className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--color-muted-2)]">
          <span className="truncate">{pr.sourceBranch}</span>
          <Icon name="chevron-right" size={10} className="shrink-0" />
          <span className="truncate">{pr.targetBranch}</span>
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-[74ch]">
          <div className="mb-3.5 flex items-start gap-[9px] rounded-[7px] border border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(19,32,39,0.5),rgba(12,21,26,0.62))] px-3 py-2">
            <Icon name="lock" size={13} className="mt-px shrink-0 text-[var(--color-muted-2)]" />
            <span className="text-[11px] leading-relaxed text-[var(--color-muted)]">
              {t("pulls.readOnlyHint")}
            </span>
          </div>

          {pr.description ? (
            <p className="text-[12.5px] leading-[1.6] whitespace-pre-wrap text-[var(--color-bone-2)]">
              {pr.description}
            </p>
          ) : (
            <p className="text-[11.5px] text-[var(--color-faint)]">{t("pulls.noBody")}</p>
          )}

          <p className="mt-5 mb-1 text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase">
            {t("pulls.sectionComments")}
            {comments.length > 0 && <span className="ml-1.5 tracking-normal">{comments.length}</span>}
          </p>

          {state.detail.error != null && (
            <p className="text-[11.5px] text-[var(--color-rose)]">
              {errorText(state.detail.error, t, "pulls.commentsFailed")}
            </p>
          )}
          {comments.length === 0 ? (
            <p className="py-1 text-[11.5px] text-[var(--color-faint)]">{t("pulls.noComments")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-[7px] border border-[var(--color-edge-1)] bg-[rgba(12,21,26,0.5)] px-3 py-2"
                >
                  <p className="flex items-center gap-2 text-[10.5px] text-[var(--color-muted-2)]">
                    <span>{c.author?.username ?? "—"}</span>
                    {c.filePath && (
                      <span className="truncate font-mono text-[10px]">
                        {c.filePath}
                        {c.lineNumber ? `:${c.lineNumber}` : ""}
                      </span>
                    )}
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
export function PullsInspector({ state }: { state: PullsSurfaceState }) {
  const { t } = useTranslation();
  const pr = state.detail.data ?? state.selected;

  return (
    <aside
      aria-label={t("pulls.inspector.title")}
      className="flex w-[292px] shrink-0 flex-col border-l border-[var(--color-edge-1)] bg-[var(--color-ink-900)]"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-edge-1)] px-3 py-2.5">
        <span className="text-[11px] text-[var(--color-bone-2)]">{t("pulls.inspector.title")}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pt-2.5 pb-6">
        <SectionLabel>{t("pulls.inspector.sectionPull")}</SectionLabel>
        <dl>
          <KV k={t("pulls.inspector.number")} v={pr ? `#${pr.number}` : "—"} mono />
          <KV k={t("pulls.inspector.state")} v={pr?.status ?? "—"} />
          <KV k={t("pulls.inspector.author")} v={pr?.author?.username ?? "—"} />
          <KV k={t("pulls.source")} v={pr?.sourceBranch ?? "—"} mono />
          <KV k={t("pulls.target")} v={pr?.targetBranch ?? "—"} mono />
          <KV k={t("pulls.createdAt")} v={pr ? relativeTime(pr.createdAt, t) : "—"} />
        </dl>

        <SectionLabel>{t("pulls.inspector.sectionNext")}</SectionLabel>
        <p className="text-[11px] leading-relaxed text-[var(--color-muted-2)]">
          {t("pulls.inspector.nextHint")}
        </p>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* 共用片段                                                            */
/* ------------------------------------------------------------------ */

/** 仓库选择器：仓库多于一间时才渲染，避免只有一个选项时占一行。 */
function RepoPicker({ state }: { state: PullsSurfaceState }) {
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
  if (error instanceof PullsRequestError) {
    return t(`pulls.errors.${error.operation}`, { status: error.status });
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return t(fallbackKey);
}
