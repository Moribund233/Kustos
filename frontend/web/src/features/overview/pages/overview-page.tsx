import { BookOpen, Bot, CircleDot, GitCommitHorizontal, Users, UserRound } from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import {
  FactList,
  Lamp,
  RailBlock,
  RepoGlyph,
  SectionHead,
  Stage,
  StatusPill,
  type AvatarTone,
  type DockTab,
  type Tone,
} from "@/components/kit/kit";
import { api } from "@/lib/api/client";
import { formatRelative } from "@/lib/datetime/format";
import { useApiQuery } from "@/lib/api/hooks";
import i18n from "@/lib/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

/** 问候语按时段切换。 */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return i18n.t("overview.greetLateNight");
  if (hour < 12) return i18n.t("overview.greetMorning");
  if (hour < 18) return i18n.t("overview.greetAfternoon");
  return i18n.t("overview.greetEvening");
}

/** 日期眉题：10月29日 · 21:48 UTC+8。 */
function useNow(): { date: string; clock: string } {
  return useMemo(() => {
    const now = new Date();
    return {
      date: now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }),
      clock: now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
    };
  }, []);
}

/** dashboard 响应里嵌套的用户摘要（后端 build_user_info）。 */
interface DashUser {
  id: string;
  username: string;
  full_name: string | null;
}

/**
 * GET /api/v1/users/me/dashboard 的响应视图。
 *
 * schema 把该响应标为 unknown，按后端 dashboard_service.get_user_dashboard
 * 的实际返回字段断言。
 */
interface DashboardData {
  /** 可访问仓库总数 */
  repo_count: number;
  /** 跨可访问仓库的未关闭 PR 总数 */
  open_prs: number;
  /** 跨可访问仓库的未关闭 Issue 总数 */
  open_issues: number;
  recent_activities: {
    id: string;
    actor_username: string | null;
    entity_type: string;
    action: string;
    details: string | null;
    created_at: string | null;
  }[];
  recent_prs: {
    id: string;
    pr_number: number;
    title: string;
    status: string;
    source_branch: string;
    target_branch: string;
    is_draft: boolean;
    repository_id: string;
    author: DashUser | null;
    created_at: string | null;
  }[];
  recent_issues: {
    id: string;
    issue_number: number;
    title: string;
    status: string;
    priority: string | null;
    repository_id: string;
    author: DashUser | null;
    assignee: DashUser | null;
    created_at: string | null;
  }[];
  /** 近 30 天按日活动数，键为日期 */
  contributions_by_day: Record<string, number>;
}

/** 四项队列速览的单项视图模型。 */
interface WatchStat {
  label: string;
  value: string;
  unit?: string;
  meta: string;
  lamp: Tone;
}

/**
 * 四项统计的映射依据（dashboard_service.get_user_dashboard 的字段语义）：
 * - open_prs / open_issues：跨可访问仓库的未关闭计数，作为前两项主数值；
 * - recent_prs / recent_issues：我创建的 PR、我创建或指派给我的 Issue（各最多 10 条），
 *   其中的未关闭条数作为 meta 副文案；
 * - repo_count：可访问仓库数；contributions_by_day：近 30 天按日活动数之和。
 * dashboard 没有「评审请求 / 提及」数据，故四项全部改为诚实口径，不保留演示标签。
 */
function buildWatchStats(dash: DashboardData): WatchStat[] {
  const myOpenPrs = dash.recent_prs.filter((pr) => pr.status === "open").length;
  const myOpenIssues = dash.recent_issues.filter((issue) => issue.status === "open").length;
  const contributions = Object.values(dash.contributions_by_day).reduce((sum, count) => sum + count, 0);
  const activeDays = Object.keys(dash.contributions_by_day).length;
  return [
    {
      label: i18n.t("overview.openPrs"),
      value: String(dash.open_prs),
      unit: i18n.t("overview.repoUnit"),
      meta: i18n.t("overview.openPrsMeta", { count: myOpenPrs }),
      lamp: dash.open_prs > 0 ? "warn" : "good",
    },
    {
      label: i18n.t("overview.openIssues"),
      value: String(dash.open_issues),
      unit: i18n.t("overview.repoUnit"),
      meta: i18n.t("overview.openIssuesMeta", { count: myOpenIssues }),
      lamp: dash.open_issues > 0 ? "bad" : "good",
    },
    {
      label: i18n.t("overview.accessibleRepos"),
      value: String(dash.repo_count),
      unit: i18n.t("overview.repoUnit"),
      meta: i18n.t("overview.selfHostedInstance"),
      lamp: "info",
    },
    {
      label: i18n.t("overview.activity30d"),
      value: String(contributions),
      unit: i18n.t("overview.timesUnit"),
      meta: i18n.t("overview.activityMeta", { days: activeDays }),
      lamp: "info",
    },
  ];
}

/** 「等你过目」队列行视图模型（对齐后端 build_pr_response / build_issue_response 的可用字段）。 */
interface QueueRow {
  id: string;
  lamp: Tone;
  live?: boolean;
  title: string;
  href: string;
  number: string;
  repo: string;
  author: string;
  /** 分支 → 目标；Issue 行没有 ref。 */
  ref?: { from: string; to: string };
  /** 元信息尾部的徽标（Issue 用优先级，PR 用 draft）。 */
  badge?: { label: string; tone: "warn" | "bad" | "info" };
  age: string;
  action: string;
}

/** PR 状态 → 行首状态灯。 */
const PR_STATUS_TONE: Record<string, Tone> = { open: "warn", merged: "good", closed: "bad" };

/**
 * recent_prs → PR 队列行。
 *
 * 后端无 CI/AI 评审检查数据，检查片区块已删除；仓库名用 repository_id
 * 在 repo-store 里换 path（build_pr_response 不带仓库路径）。
 */
function toPrRows(dash: DashboardData, repoPathOf: (id: string) => string): QueueRow[] {
  return dash.recent_prs.map((pr) => ({
    id: pr.id,
    lamp: PR_STATUS_TONE[pr.status] ?? "neutral",
    live: pr.status === "open",
    title: pr.title,
    href: "/pull-requests",
    number: `#${pr.pr_number}`,
    repo: repoPathOf(pr.repository_id),
    author: pr.author?.full_name || pr.author?.username || "—",
    ref: { from: pr.source_branch, to: pr.target_branch },
    badge: pr.is_draft ? { label: "draft", tone: "info" } : undefined,
    age: formatRelative(pr.created_at),
    action: i18n.t("overview.view"),
  }));
}

/** recent_issues → Issue 队列行；lamp 按状态与优先级组合。 */
function toIssueRows(dash: DashboardData, repoPathOf: (id: string) => string): QueueRow[] {
  return dash.recent_issues.map((issue) => ({
    id: issue.id,
    lamp: issue.status === "closed" ? "good" : issue.priority === "high" ? "bad" : "warn",
    title: issue.title,
    href: "/issues",
    number: `#${issue.issue_number}`,
    repo: repoPathOf(issue.repository_id),
    author: i18n.t("overview.createdByShort", { author: issue.author?.username ?? "—" }),
    badge: issue.priority ? { label: issue.priority, tone: issue.priority === "high" ? "warn" : "info" } : undefined,
    age: formatRelative(issue.created_at),
    action: i18n.t("overview.openAction"),
  }));
}

/** 仓库字形的轮换色调。 */
const GLYPH_TONES: AvatarTone[] = ["amber", "sage", "sky", "rose", "slate"];

function panelDock(): DockTab[] {
  return [
    {
      id: "watch",
      icon: Bot,
      label: i18n.t("overview.watchFeed"),
      kicker: "meridian",
      ariaLabel: i18n.t("overview.watchFeedAria"),
    },
    {
      id: "presence",
      icon: Users,
      label: i18n.t("overview.presence"),
      kicker: i18n.t("overview.onlineCount", { count: 4 }),
      ariaLabel: i18n.t("overview.presenceAria"),
    },
    {
      id: "account",
      icon: UserRound,
      label: i18n.t("overview.accountTab"),
      kicker: i18n.t("overview.accountTab"),
      ariaLabel: i18n.t("overview.accountAria"),
    },
  ];
}

/**
 * 值守工作台。
 *
 * 队列是页面本体；动态流、在线状态与账号事实浮在画布右缘的面板里，
 * 不挤占画布宽度。数据来自 /users/me/dashboard 与 repo-store；
 * 在线状态待 WebSocket 通道接入。
 */
export function OverviewPage() {
  const { t } = useTranslation();
  const now = useNow();
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const user = useAuthStore((state) => state.user);
  const repos = useRepoStore((state) => state.repos);
  const selectRepo = useRepoStore((state) => state.select);
  const navigate = useNavigate();

  useEffect(() => {
    setCrumbs([{ label: t("nav.watch") }, { label: t("overview.title") }]);
  }, [setCrumbs, t]);

  const { data: dash, error, refetch, isPending } = useApiQuery<DashboardData>({
    queryKey: ["overview", "dashboard"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/users/me/dashboard");
      // schema 只建模了 200，错误体未知；无数据一律按失败处理，由 useApiQuery 重试
      if (!res.data) throw new Error(i18n.t("overview.dashboardFailed"));
      return res.data as DashboardData;
    },
  });

  // 账号面板显示真实用户名，而不是演示里的「Lin Wei」
  const dock = panelDock().map((tab) =>
    tab.id === "account" ? { ...tab, kicker: user?.username ?? t("overview.accountTab") } : tab,
  );

  /** repository_id → 仓库 path（如 lin/atlas），列表里查不到时回落。 */
  const repoPathOf = (id: string) => repos.find((repo) => repo.id === id)?.path ?? i18n.t("overview.unknownRepo");

  const prRows = dash ? toPrRows(dash, repoPathOf) : [];
  const issueRows = dash ? toIssueRows(dash, repoPathOf) : [];
  const openPrCount = dash?.recent_prs.filter((pr) => pr.status === "open").length ?? 0;
  const assignedCount = dash && user ? dash.recent_issues.filter((issue) => issue.assignee?.id === user.id).length : 0;
  const queueCount = prRows.length + issueRows.length;
  const displayName = user?.full_name || user?.username || "";

  return (
    <Stage dock={dock} panel={(tab) => <OverviewPanel tab={tab} dash={dash ?? null} user={user} repoCount={repos.length} onRetry={() => void refetch()} />} className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px] pb-20">
      {/* 页头 */}
      <header className="mb-[30px] flex items-end justify-between gap-8">
        <div className="min-w-0">
          <p className="text-faint text-xs font-semibold tracking-[0.16em] uppercase">
            {now.date} · <span className="font-mono">{now.clock}</span>{" "}
            <span className="text-faint font-normal tracking-normal">UTC+8</span>
          </p>
          <h1 className="font-display text-bone mt-2.5 text-[clamp(2rem,3vw,2.9rem)] font-medium tracking-[-0.028em] leading-none">
            {greeting()}，{displayName}。
          </h1>
          <p className="text-muted mt-2.5 max-w-[64ch] text-md leading-relaxed">
            {dash
              ? t("overview.greetingQueue", { prs: dash.open_prs, issues: dash.open_issues })
              : isPending
                ? t("overview.summarizing")
                : t("overview.queueFailed")}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2.5 pb-1">
          <Link to="/pull-requests">
            <StatusPill tone={dash && dash.open_prs > 0 ? "warn" : "good"} lamp live>
              {dash ? t("overview.prsOpen", { count: dash.open_prs }) : t("overview.prQueue")}
            </StatusPill>
          </Link>
          <button
            type="button"
            onClick={() => navigate("/agent")}
            className="bg-amber border-amber hover:bg-amber-2 hover:border-amber-2 inline-flex h-8 items-center gap-[7px] rounded-md border px-3 text-sm font-semibold text-ink-950 transition-colors"
          >
            <Bot className="size-[15px]" aria-hidden="true" />
            {t("overview.startRun")}
          </button>
        </div>
      </header>

      {isPending ? (
        <p className="text-muted-2 border-edge-2 border-y py-10 text-center text-sm">{t("overview.loadingWatch")}</p>
      ) : error ? (
        <div role="alert" className="border-edge-2 border-y flex flex-col items-center gap-3 py-10">
          <p className="text-muted text-sm">{t("overview.watchFailed", { error: error.message })}</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="border-edge-2 bg-ink-750/55 hover:border-edge-3 hover:bg-ink-750 text-bone-2 inline-flex h-[27px] items-center rounded-md border px-2.5 text-xs font-medium transition-colors"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : dash ? (
        <>
          {/* 队列速览 */}
          <dl aria-label={t("overview.yourQueue")} className="border-edge-2 border-y mb-11 grid grid-cols-4">
            {buildWatchStats(dash).map((stat, index, stats) => (
              <div
                key={stat.label}
                className={
                  "min-w-0 py-4 pr-[22px]" +
                  (index < stats.length - 1 ? " border-edge-1 border-r" : " pr-0") +
                  (index > 0 ? " pl-[22px]" : "")
                }
              >
                <dt className="text-muted-2 text-2xs font-semibold tracking-[0.14em] uppercase">{stat.label}</dt>
                <dd className="font-display text-bone mt-[7px] text-4xl font-medium tabular-nums tracking-[-0.03em] leading-none">
                  {stat.value}
                  {stat.unit ? <span className="text-muted-2 font-sans ml-1 text-xs font-medium tracking-normal">{stat.unit}</span> : null}
                </dd>
                <dd className="text-muted-2 mt-2 flex items-center gap-1.5 text-2xs leading-[1.35]">
                  <Lamp tone={stat.lamp} />
                  {stat.meta}
                </dd>
              </div>
            ))}
          </dl>

          {/* 待办队列 */}
          <section aria-label={t("overview.awaitingReviewAria")}>
            <SectionHead
              title={t("overview.awaitingReviewAria")}
              count={queueCount}
              meta={
                <Link to="/pull-requests" className="text-muted-2 hover:text-amber transition-colors">
                  {t("overview.allPullRequests")}
                </Link>
              }
            />

            {queueCount === 0 ? (
              <p className="text-muted-2 py-7 text-center text-sm">{t("overview.noTodo")}</p>
            ) : (
              <div className="flex flex-col gap-2 pt-1">
                {prRows.length ? (
                  <QueueGroup title="Pull requests" count={prRows.length} note={t("overview.notClosed", { count: openPrCount })}>
                    {prRows.map((row) => (
                      <ReviewRow key={row.id} row={row} />
                    ))}
                  </QueueGroup>
                ) : null}
                {issueRows.length ? (
                  <QueueGroup title="Issues" count={issueRows.length} note={t("overview.assignedToYou", { count: assignedCount })}>
                    {issueRows.map((row) => (
                      <ReviewRow key={row.id} row={row} />
                    ))}
                  </QueueGroup>
                ) : null}
              </div>
            )}
          </section>

          {/* 活跃仓库 */}
          <section aria-label={t("overview.activeRepos")} className="mt-10">
            <SectionHead title={t("overview.activeRepos")} meta={t("overview.byRecentUpdate")} />
            <div className="pt-0.5">
              <div className="border-edge-1 flex items-center gap-2 border-b py-3.5 pb-2">
                <span className="text-muted text-2xs font-semibold tracking-[0.13em] uppercase">{user?.username ?? t("overview.all")}</span>
                <span className="rounded-full bg-bone/[0.06] px-1.5 font-mono text-2xs leading-[15px] text-muted-2">{repos.length}</span>
                <span className="text-faint ml-auto text-2xs">{t("overview.allAccessibleRepos")}</span>
              </div>
              {repos.length === 0 ? (
                <p className="text-muted-2 py-7 text-center text-sm">{t("overview.noRepos")}</p>
              ) : (
                repos.map((repo, index) => (
                  <button
                    key={repo.id}
                    type="button"
                    className="border-edge-1 hover:bg-ink-750/35 grid w-full grid-cols-[26px_minmax(0,1fr)_auto_92px] items-center gap-3.5 border-b py-3 pl-0 rounded-md text-left transition-colors last:border-b-0"
                    onClick={() => {
                      selectRepo(repo.id);
                      void navigate("/code");
                    }}
                  >
                    <RepoGlyph letter={(repo.name[0] ?? "?").toLowerCase()} tone={GLYPH_TONES[index % GLYPH_TONES.length]} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-bone flex items-center gap-[7px] text-sm font-medium leading-snug">
                        {repo.name}
                        <span className="border-edge-2 inline-flex h-[17px] items-center rounded-full border px-[7px] text-2xs font-medium text-muted">
                          {repo.is_public ? "Public" : "Private"}
                        </span>
                      </span>
                      <span className="text-muted-2 text-2xs leading-snug">
                        {t("overview.defaultBranch")} <span className="font-mono">{repo.default_branch}</span>
                      </span>
                    </span>
                    <span className="grid grid-cols-3">
                      {[
                        { value: repo.star_count, label: "stars" },
                        { value: repo.fork_count, label: "forks" },
                        { value: repo.watch_count, label: "watch" },
                      ].map((metric) => (
                        <span key={metric.label} className="text-faint flex items-baseline gap-1 text-2xs tracking-[0.06em] whitespace-nowrap uppercase">
                          <span className="text-bone-2 font-mono text-sm tracking-normal">{metric.value}</span>
                          {metric.label}
                        </span>
                      ))}
                    </span>
                    <span className="text-muted-2 inline-flex items-center justify-end gap-1.5 text-2xs whitespace-nowrap">
                      <Lamp tone="info" />
                      {t("overview.updatedAtShort", { time: formatRelative(repo.updated_at) })}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>
        </>
      ) : null}

      {/* 问 Kustos：作业创建在 Agent 控制台（POST /agent/jobs 已就绪），这里直达入口 */}
      <section aria-label={t("overview.askKustos")} className="mt-10">
        <SectionHead title={t("overview.askKustos")} meta={t("overview.askKustosMeta")} />
        <form
          className="border-edge-2 bg-ink-850/50 mt-3.5 flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5 shadow-[inset_0_1px_0_rgba(240,231,216,0.045)] transition-colors focus-within:border-amber/45 focus-within:shadow-[0_0_0_3px_rgba(242,174,91,0.06)]"
          onSubmit={(event) => {
            event.preventDefault();
            // shortcut: 后续可把这里的 prompt 经路由 state 预填进 Agent 新建表单
            navigate("/agent");
          }}
        >
          <span
            aria-hidden="true"
            className="border-amber/20 bg-amber/10 text-amber grid size-[26px] shrink-0 place-items-center rounded-full border"
          >
            <Bot className="size-[14px]" />
          </span>
          <input
            type="text"
            autoComplete="off"
            aria-label={t("overview.askKustos")}
            placeholder={t("overview.askPlaceholder")}
            className="text-bone min-w-0 flex-1 border-0 bg-transparent text-sm focus-visible:outline-none placeholder:text-muted-2"
          />
          <button
            type="submit"
            className="bg-amber border-amber hover:bg-amber-2 hover:border-amber-2 inline-flex h-[27px] items-center gap-[7px] whitespace-nowrap rounded-md border px-2.5 text-xs font-semibold text-ink-950 transition-colors"
          >
            {t("overview.run")}
          </button>
        </form>
      </section>
    </Stage>
  );
}

function QueueGroup({ title, count, note, children }: { title: string; count: number; note: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 pt-3.5 pb-2">
        <span className="text-muted text-2xs font-semibold tracking-[0.13em] uppercase">{title}</span>
        <span className="rounded-full bg-bone/[0.06] px-1.5 font-mono text-2xs leading-[15px] text-muted-2">{count}</span>
        <span className="text-faint ml-auto text-2xs">{note}</span>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** 队列行：状态灯 + 标题 + 元信息 + 操作。后端无 CI/评审检查数据，检查片区块不渲染。 */
function ReviewRow({ row }: { row: QueueRow }) {
  return (
    <article className="border-edge-1 hover:bg-[linear-gradient(90deg,rgba(242,174,91,0.05),rgba(242,174,91,0.01))] grid grid-cols-[20px_minmax(0,1fr)_auto] gap-3.5 -mx-2.5 border-b px-2.5 py-3 transition-colors last:border-b-transparent">
      <div className="pt-1.5">
        <Lamp tone={row.lamp} live={row.live} className="mt-0.5" />
      </div>
      <div className="min-w-0">
        <div className="text-bone flex items-baseline gap-2 text-md font-medium leading-snug">
          <Link to={row.href} className="hover:text-amber-2 truncate underline-offset-[3px] hover:underline">
            {row.title}
          </Link>
          <span className="text-faint flex-none font-mono text-2xs">{row.number}</span>
        </div>
        <p className="text-muted-2 mt-1.5 flex flex-wrap items-center gap-[5px] text-2xs leading-relaxed">
          <span className="text-muted">{row.repo}</span>
          <span className="text-faint">·</span>
          <span>{row.author}</span>
          {row.ref ? (
            <>
              <span className="text-faint">·</span>
              <span className="font-mono">{row.ref.from}</span>
              <span className="text-faint font-mono">→</span>
              <span className="font-mono">{row.ref.to}</span>
            </>
          ) : null}
          {row.badge ? (
            <span
              className={
                "inline-flex h-[19px] items-center rounded-full px-[7px] text-2xs font-medium " +
                (row.badge.tone === "warn"
                  ? "bg-amber/10 text-amber-2"
                  : row.badge.tone === "bad"
                    ? "bg-rose/10 text-rose-2"
                    : "border-edge-2 bg-bone/[0.05] text-muted border")
              }
            >
              {row.badge.label}
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex min-w-[58px] flex-col items-end gap-2 pt-px">
        <span className="text-faint font-mono text-2xs">{row.age}</span>
        <Link
          to={row.href}
          className="border-edge-2 bg-ink-750/55 hover:border-edge-3 hover:bg-ink-750 text-bone-2 inline-flex h-[27px] items-center rounded-md border px-2.5 text-xs font-medium transition-colors"
        >
          {row.action}
        </Link>
      </div>
    </article>
  );
}

/** 活动流条目的图标与基础色调（按 entity_type；后端 activity_service 落库的类型集合）。 */
const ACTIVITY_STYLE: Record<string, { icon: typeof Bot; tone: "neutral" | "warn" | "good" | "bad" }> = {
  pull_request: { icon: BookOpen, tone: "warn" },
  issue: { icon: CircleDot, tone: "neutral" },
  agent_job: { icon: Bot, tone: "warn" },
  agent_tool: { icon: Bot, tone: "neutral" },
};

/** 活动动作 → 文案键（后端各 service 写入 Activity.action 的取值）。 */
const ACTIVITY_VERB_KEY: Record<string, string> = {
  created: "overview.verbCreated",
  opened: "overview.verbOpened",
  closed: "overview.verbClosed",
  merged: "overview.verbMerged",
  approved: "overview.verbApproved",
  rejected: "overview.verbRejected",
  cancelled: "overview.verbCancelled",
  review_requested: "overview.verbReviewRequested",
  review_request_removed: "overview.verbReviewRequestRemoved",
  linked_issue: "overview.verbLinkedIssue",
  unlinked_issue: "overview.verbUnlinkedIssue",
  merge_override: "overview.verbMergeOverride",
};

/** 实体类型的兜底文案键。 */
const ENTITY_LABEL_KEY: Record<string, string> = {
  pull_request: "overview.entityPr",
  issue: "overview.entityIssue",
  agent_job: "overview.entityAgentJob",
  agent_tool: "overview.entityAgentTool",
};

/** 收尾动作（合并/批准 → good，关闭/拒绝/取消 → bad），其余沿用实体默认色调。 */
const TONE_BY_ACTION: Record<string, "good" | "bad"> = {
  merged: "good",
  approved: "good",
  closed: "bad",
  rejected: "bad",
  cancelled: "bad",
};

function OverviewPanel({ tab, dash, user, repoCount, onRetry }: { tab: DockTab; dash: DashboardData | null; user: ReturnType<typeof useAuthStore.getState>["user"]; repoCount: number; onRetry: () => void }) {
  const { t } = useTranslation();
  if (tab.id === "presence") {
    // presence 在服务端按房间聚合，没有全局在线名单端点：这里不做假名单
    return (
      <RailBlock title={t("overview.presenceTitle")}>
        <p className="text-muted-2 py-6 text-center text-xs leading-relaxed">
          {t("overview.presenceHint1")}
          <br />
          {t("overview.presenceHint2")}
        </p>
      </RailBlock>
    );
  }

  if (tab.id === "account") {
    return (
      <RailBlock title={t("overview.accountTitle")}>
        <FactList
          items={[
            { key: t("overview.fieldUsername"), value: <span className="font-mono">{user?.username ?? "—"}</span> },
            { key: t("overview.fieldEmail"), value: user?.email ?? t("overview.notSet") },
            { key: t("overview.fieldRole"), value: user?.is_admin ? t("overview.roleAdmin") : t("overview.roleMember") },
            { key: t("overview.fieldRepos"), value: <span className="font-mono">{t("overview.accessibleCount", { count: repoCount })}</span> },
          ]}
        />
        <p className="text-muted-2 mt-3 text-xs leading-[1.45]">
          {t("overview.quotaHint")}
        </p>
      </RailBlock>
    );
  }

  const activities = dash?.recent_activities ?? [];

  return (
    <RailBlock>
      <div className="mb-2.5 flex items-center">
        <h3 className="text-muted-2 text-2xs font-semibold tracking-[0.15em] uppercase">{t("overview.liveFeed")}</h3>
        <span className="text-amber ml-auto inline-flex items-center gap-1.5 text-2xs font-semibold tracking-[0.14em] uppercase">
          <Lamp tone="warn" live />
          Live
        </span>
      </div>
      {!dash ? (
        <p className="text-muted-2 py-3.5 text-xs">
          {t("overview.feedLoadFailed")}
          <button type="button" onClick={onRetry} className="text-amber hover:text-amber-2 ml-1.5 transition-colors">
            {t("common.retry")}
          </button>
        </p>
      ) : activities.length === 0 ? (
        <p className="text-muted-2 py-3.5 text-xs">{t("overview.noActivity")}</p>
      ) : (
        <div className="pt-0.5">
          <p className="text-faint block py-[15px] pb-1 text-2xs font-semibold tracking-[0.13em] uppercase">{t("overview.recentActivity")}</p>
          {activities.map((activity) => {
            const style = ACTIVITY_STYLE[activity.entity_type] ?? { icon: GitCommitHorizontal, tone: "neutral" as const };
            const tone = TONE_BY_ACTION[activity.action] ?? style.tone;
            const verbKey = ACTIVITY_VERB_KEY[activity.action];
            const entityKey = ENTITY_LABEL_KEY[activity.entity_type];
            return (
              <div key={activity.id} className="relative grid grid-cols-[26px_minmax(0,1fr)] gap-[11px] pb-[15px] last:pb-0">
                <span
                  className={
                    "border-edge-2 bg-ink-850 relative z-[1] grid size-[26px] place-items-center rounded-full border " +
                    (tone === "warn"
                      ? "border-amber/30 bg-amber/[0.08] text-amber"
                      : tone === "good"
                        ? "border-sage/25 bg-sage/[0.07] text-sage"
                        : tone === "bad"
                          ? "border-rose/30 bg-rose/[0.07] text-rose"
                          : "text-muted-2")
                  }
                >
                  <style.icon className="size-3" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-muted text-xs leading-[1.5]">
                    <span className="text-bone-2">{activity.actor_username ?? t("overview.systemActor")}</span>{" "}
                    {verbKey ? t(verbKey) : activity.action}
                    {activity.details
                      ? ` ${activity.details}`
                      : ` ${entityKey ? t(entityKey) : activity.entity_type}`}
                  </p>
                  <time className="text-faint mt-[3px] block font-mono text-2xs">{formatRelative(activity.created_at)}</time>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </RailBlock>
  );
}
