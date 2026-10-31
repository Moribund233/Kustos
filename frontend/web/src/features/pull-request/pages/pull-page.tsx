import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";

import i18n from "@/lib/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Clock3, Eye, GitMerge, Link2, ShieldCheck, Users } from "lucide-react";

import { DiffViewer } from "@/components/editor/diff-viewer";
import { SkeletonCodeLines, SkeletonText } from "@/components/kit/skeletons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NewPullRequestButton } from "@/features/pull-request/components/new-pull-request";
import { SocialDialog } from "@/features/code/components/social-dialog";
import {
  Lamp,
  RailBlock,
  Stage,
  StatusPill,
  ToneAvatar,
  type AvatarTone,
  type DockTab,
} from "@/components/kit/kit";
import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { formatRelative } from "@/lib/datetime/format";
import { Markdown } from "@/lib/markdown/markdown";
import { useAuthStore } from "@/stores/auth-store";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

import { toDiffPayload } from "../lib/diff";
import type {
  BranchRow,
  MergeCond,
  PrDetail,
  PrDiffResponse,
  PrLinkedIssue,
  PrListResponse,
  PrReviewerRequest,
  PrTimelineItem,
  RepoMember,
  ReviewerRow,
} from "../lib/types";

type PullTab = "conversation" | "files";

/** 头部评审决策按钮的样式（批准为琥珀主按钮，请求修改为玫红描边）。 */
const DECISION_BTN =
  "inline-flex h-8 items-center gap-[7px] rounded-md border px-3 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50";

/** PR 状态 → 页头胶囊文案。 */
const STATUS_LABEL: Record<string, string> = { open: "Open", merged: "Merged", closed: "Closed" };

/** 头像色调池：按用户 id 稳定取色，避免每次刷新换色。 */
const AVATAR_TONES: AvatarTone[] = ["amber", "sage", "sky", "rose", "slate"];

/** 后端错误信封 → 可展示的 Error；带上 HTTP 状态供 hooks 决定是否重试。 */
function toApiError(body: unknown, status: number): Error & { status?: number } {
  const detail = (body as { detail?: string } | null | undefined)?.detail;
  const error = new Error(detail || i18n.t("pullRequest.requestFailed", { status })) as Error & {
    status?: number;
  };
  error.status = status;
  return error;
}

/** 非 2xx 一律抛错：查询走 isError，变更走 onError 的 toast 展示后端 detail。 */
function assertOk(res: { error?: unknown; response: { status: number } }): void {
  if (res.error) throw toApiError(res.error, res.response.status);
}

/** 用户显示名：全名优先，其次用户名。 */
function displayName(user: { full_name?: string | null; username?: string } | null | undefined): string {
  return user?.full_name || user?.username || i18n.t("pullRequest.unknownUser");
}

/** 头像字母：取名字前两个词的首字母。 */
function initialsOf(user: { full_name?: string | null; username?: string } | null | undefined): string {
  const source = displayName(user).trim();
  const initials = source
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return initials || "?";
}

/** 按 id 取稳定的头像色调。 */
function toneFor(id: string | undefined): AvatarTone {
  let hash = 0;
  for (const char of id ?? "") hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length] ?? "slate";
}

/**
 * Pull Request 详情页（原型 pull.html）。
 *
 * 会话 / 文件变更两个页签是页面本体；评审人、关联 Issue 与合并控件浮在画布
 * 右缘的 Stage 面板里。PR 编号来自 `?pr=`，缺省时取仓库 PR 列表第一条并跳转，
 * 列表为空渲染空态。检查（CI）与 Kustos 评审发现暂无后端数据来源，对应页签
 * 与卡片隐藏（后端暂无对应数据来源）。
 */
export function PullPage() {
  const { t } = useTranslation();
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const queryClient = useQueryClient();
  const repo = useRepoStore((state) => state.current);
  const me = useAuthStore((state) => state.user);
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<PullTab>("conversation");
  const [comment, setComment] = useState("");
  const [watchOpen, setWatchOpen] = useState(false);

  const repoId = repo?.id ?? null;
  const rawPr = searchParams.get("pr");
  const prNumber = rawPr !== null && /^\d+$/.test(rawPr) ? Number(rawPr) : null;
  const prLabel = prNumber !== null ? `#${prNumber}` : "";

  // PR 列表：仅在没有 ?pr= 时用来取第一条
  const listQuery = useApiQuery<PrListResponse>({
    queryKey: ["pull-requests", repoId],
    enabled: !!repoId && prNumber === null,
    queryFn: async () => {
      if (!repoId) throw new Error(i18n.t("pullRequest.noRepo"));
      const res = await api.GET("/api/v1/repositories/{repo_id}/pull-requests", {
        params: { path: { repo_id: repoId }, query: { page: 1, limit: 20 } },
      });
      assertOk(res);
      return (res.data ?? {}) as PrListResponse;
    },
  });

  const detailQuery = useApiQuery<PrDetail>({
    queryKey: ["pull-request", repoId, prNumber],
    enabled: !!repoId && prNumber !== null,
    queryFn: async () => {
      if (!repoId || prNumber === null) throw new Error(t("pullRequest.missingPr"));
      const res = await api.GET("/api/v1/repositories/{repo_id}/pull-requests/{pr_number}", {
        params: { path: { repo_id: repoId, pr_number: prNumber } },
      });
      assertOk(res);
      return res.data as PrDetail;
    },
  });

  // diff 同时喂页头的文件/增删统计与文件变更页签
  const diffQuery = useApiQuery<PrDiffResponse>({
    queryKey: ["pull-request-diff", repoId, prNumber],
    enabled: !!repoId && prNumber !== null,
    queryFn: async () => {
      if (!repoId || prNumber === null) throw new Error(t("pullRequest.missingPr"));
      const res = await api.GET("/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/diff", {
        params: { path: { repo_id: repoId, pr_number: prNumber } },
      });
      assertOk(res);
      return (res.data ?? {}) as PrDiffResponse;
    },
  });

  const reviewersQuery = useApiQuery<PrReviewerRequest[]>({
    queryKey: ["pull-request-reviewers", repoId, prNumber],
    enabled: !!repoId && prNumber !== null,
    queryFn: async () => {
      if (!repoId || prNumber === null) throw new Error(t("pullRequest.missingPr"));
      const res = await api.GET("/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/reviewers", {
        params: { path: { repo_id: repoId, pr_number: prNumber } },
      });
      assertOk(res);
      return (Array.isArray(res.data) ? res.data : []) as PrReviewerRequest[];
    },
  });

  const issuesQuery = useApiQuery<PrLinkedIssue[]>({
    queryKey: ["pull-request-issues", repoId, prNumber],
    enabled: !!repoId && prNumber !== null,
    queryFn: async () => {
      if (!repoId || prNumber === null) throw new Error(t("pullRequest.missingPr"));
      const res = await api.GET("/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/issues", {
        params: { path: { repo_id: repoId, pr_number: prNumber } },
      });
      assertOk(res);
      return (Array.isArray(res.data) ? res.data : []) as PrLinkedIssue[];
    },
  });

  // 分支保护标志（合并条件）：按目标分支名在分支列表里取那一行
  const branchesQuery = useApiQuery<BranchRow[]>({
    queryKey: ["branches", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      if (!repoId) throw new Error(i18n.t("pullRequest.noRepo"));
      const res = await api.GET("/api/v1/repositories/{repo_id}/branches", {
        params: { path: { repo_id: repoId } },
      });
      assertOk(res);
      return (Array.isArray(res.data) ? res.data : []) as BranchRow[];
    },
  });

  const pr = detailQuery.data;
  const reviews = useMemo(() => pr?.reviews ?? [], [pr]);
  const diffPayload = useMemo(() => (diffQuery.data ? toDiffPayload(diffQuery.data) : null), [diffQuery.data]);

  // 我的评审状态（详情里的 reviews 按 reviewer 匹配当前登录用户）
  const myState = useMemo(
    () => reviews.find((review) => review.reviewer?.id && review.reviewer.id === me?.id)?.status ?? null,
    [reviews, me],
  );

  // 评审请求 ∪ 已提交评审 → 面板行
  const reviewerRows = useMemo<ReviewerRow[]>(() => {
    const rows = new Map<string, ReviewerRow>();
    for (const request of reviewersQuery.data ?? []) {
      if (request.reviewer) rows.set(request.reviewer.id, { user: request.reviewer, state: request.state });
    }
    for (const review of reviews) {
      if (!review.reviewer) continue;
      const existing = rows.get(review.reviewer.id);
      if (existing) existing.state = review.status;
      else rows.set(review.reviewer.id, { user: review.reviewer, state: review.status });
    }
    return [...rows.values()];
  }, [reviewersQuery.data, reviews]);

  // 时间线：评审与评论合并后按时间排序
  const timeline = useMemo<PrTimelineItem[]>(() => {
    const events: PrTimelineItem[] = [];
    for (const review of reviews) {
      events.push({
        id: `review-${review.id}`,
        initials: initialsOf(review.reviewer),
        tone: toneFor(review.reviewer?.id),
        name: displayName(review.reviewer),
        badge: i18n.t("pullRequest.reviewBadge"),
        action:
          review.status === "approved"
            ? i18n.t("pullRequest.justApproved")
            : i18n.t("pullRequest.justRequestedChanges"),
        body: review.comment ?? undefined,
        at: review.created_at,
      });
    }
    for (const comment of pr?.comments ?? []) {
      events.push({
        id: `comment-${comment.id}`,
        initials: initialsOf(comment.author),
        tone: toneFor(comment.author?.id),
        name: displayName(comment.author),
        action: i18n.t("pullRequest.commented"),
        body: comment.content,
        at: comment.created_at,
      });
    }
    return events.sort((a, b) => a.at.localeCompare(b.at));
  }, [reviews, pr]);

  // 合并条件：enforce_merge_protection 的两条裁决（非作者批准 / 状态检查）
  const hasApproval = useMemo(
    () => reviews.some((review) => review.status === "approved" && review.reviewer?.id !== pr?.author?.id),
    [reviews, pr],
  );
  const protection = useMemo(
    () => (branchesQuery.data ?? []).find((row) => row.name === pr?.target_branch) ?? null,
    [branchesQuery.data, pr],
  );
  const mergeConditions = useMemo<MergeCond[]>(() => {
    const conditions: MergeCond[] = [];
    if (protection?.require_code_review) {
      conditions.push({
        done: hasApproval,
        label: hasApproval
            ? i18n.t("pullRequest.approvedOnce")
            : i18n.t("pullRequest.awaitingOne"),
      });
    }
    // shortcut: 后端 strict_status_checks 开关无接口可读，这里按「无 CI 即通过」渲染；
    // 真正裁决以服务端合并请求为准，失败 detail 会经 toast 展示
    if (protection?.require_status_checks) {
      conditions.push({ done: true, label: i18n.t("pullRequest.checksPassed") });
    }
    return conditions;
  }, [protection, hasApproval]);
  const mergeBlocked = !pr || pr.status !== "open" || mergeConditions.some((cond) => !cond.done);

  const invalidatePr = () => {
    if (!repoId || prNumber === null) return;
    void queryClient.invalidateQueries({ queryKey: ["pull-request", repoId, prNumber] });
    void queryClient.invalidateQueries({ queryKey: ["pull-request-reviewers", repoId, prNumber] });
    void queryClient.invalidateQueries({ queryKey: ["pull-request-issues", repoId, prNumber] });
    void queryClient.invalidateQueries({ queryKey: ["pull-requests", repoId] });
  };

  // 评审提交：approve / request_changes（后端 status 字段，评论暂不附带）
  const reviewMutation = useApiMutation<unknown, "approved" | "changes_requested">(
    async (status) => {
      if (!repoId || prNumber === null) throw new Error(t("pullRequest.missingPr"));
      const res = await api.POST("/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/reviews", {
        params: { path: { repo_id: repoId, pr_number: prNumber } },
        body: { status },
      });
      assertOk(res);
      return res.data;
    },
    {
      onSuccess: (_data, status) => {
        invalidatePr();
        toast.success(
          status === "approved"
            ? t("pullRequest.reviewSubmitted")
            : t("pullRequest.changesRequestedToast"),
        );
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const mergeMutation = useApiMutation<unknown, void>(
    async () => {
      if (!repoId || prNumber === null) throw new Error(t("pullRequest.missingPr"));
      const res = await api.POST("/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/merge", {
        params: { path: { repo_id: repoId, pr_number: prNumber } },
        // 合并方式走后端默认 merge；squash/rebase 的选择器待后续再接
        body: { merge_method: "merge", override: false },
      });
      assertOk(res);
      return res.data;
    },
    {
      onSuccess: () => {
        invalidatePr();
        toast.success(t("pullRequest.mergedToast"));
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const commentMutation = useApiMutation<unknown, void>(
    async () => {
      if (!repoId || prNumber === null) throw new Error(t("pullRequest.missingPr"));
      const res = await api.POST("/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/comments", {
        params: { path: { repo_id: repoId, pr_number: prNumber } },
        body: { content: comment.trim() },
      });
      assertOk(res);
      return res.data;
    },
    {
      onSuccess: () => {
        invalidatePr();
        setComment("");
        toast.success(t("pullRequest.commentPublished"));
      },
      onError: (error) => toast.error(error.message),
    },
  );

  // 没带 ?pr= 时落到第一条并替换地址栏
  useEffect(() => {
    if (prNumber !== null || !listQuery.data) return;
    const first = listQuery.data.items?.[0];
    if (first) setSearchParams({ pr: String(first.pr_number) }, { replace: true });
  }, [prNumber, listQuery.data, setSearchParams]);

  useEffect(() => {
    setCrumbs([{ label: t("nav.pullRequests") }, ...(prLabel ? [{ label: prLabel }] : [])]);
  }, [setCrumbs, t, prLabel]);

  if (!repo) {
    return <PullEmpty title={t("pullRequest.noRepo")} hint={t("pullRequest.noRepoHint")} />;
  }

  if (prNumber === null) {
    const items = listQuery.data?.items ?? [];
    if (listQuery.isPending) return <PullEmpty title={t("pullRequest.loadingPr")} />;
    if (items.length === 0) {
      return (
        <PullEmpty title={t("pullRequest.noPrTitle")} hint={t("pullRequest.noPrHint")}>
          <NewPullRequestButton repoId={repo.id} defaultBranch={repo.default_branch} />
        </PullEmpty>
      );
    }
    return <PullEmpty title={t("pullRequest.openingPr")} />;
  }

  if (detailQuery.isPending) return <PullDetailSkeleton />;
  if (!pr) {
    return <PullEmpty title={t("pullRequest.prNotFound")} hint={detailQuery.error?.message ?? t("pullRequest.checkNumber")} />;
  }

  // 提前收窄：面板闭包里只认这两个确定值
  const activeRepoId = repo.id;
  const activePrNumber = prNumber;

  const authorName = displayName(pr.author);
  const stateLabel = STATUS_LABEL[pr.status] ?? pr.status;
  const changesRequested = reviews.some((review) => review.status === "changes_requested");
  const approvals = reviews.filter((review) => review.status === "approved").length;
  const reviewLabel = changesRequested
    ? t("pullRequest.requestChangesLabel")
    : approvals > 0
      ? t("pullRequest.approvedLabel")
      : t("pullRequest.awaitingReviewLabel");
  const canReview = pr.status === "open" && !reviewMutation.isPending;

  const dock: DockTab[] = [
    { id: "reviewers", icon: Users, label: t("pullRequest.reviewers"), kicker: prLabel },
    { id: "issues", icon: Link2, label: t("pullRequest.linkedIssues"), kicker: prLabel },
    { id: "merge", icon: GitMerge, label: t("pullRequest.merge"), kicker: prLabel },
  ];

  return (
    <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px] pb-20">
      {/* 页头 */}
      <header className="mb-[22px] flex items-end justify-between gap-7">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusPill tone={pr.status === "open" ? "good" : "neutral"} lamp>
              {stateLabel}
            </StatusPill>
            <span className="text-muted font-mono text-sm">{prLabel}</span>
            <StatusPill tone={changesRequested ? "bad" : approvals > 0 ? "good" : "warn"}>{reviewLabel}</StatusPill>
          </div>
          <h1 className="font-display text-bone mt-2 text-[clamp(1.6rem,2.4vw,2.2rem)] font-medium tracking-[-0.028em] leading-tight">
            {pr.title}
          </h1>
          <p className="text-muted-2 mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-relaxed">
            <span className="text-muted font-mono">{pr.source_branch}</span>
            <span className="text-faint">→</span>
            <span className="text-muted font-mono">{pr.target_branch}</span>
            <span className="text-faint">·</span>
            <span>
              {t("pullRequest.byAuthor", { time: formatRelative(pr.created_at), author: authorName })}
            </span>
            {/* 后端没有 PR 提交数字段，提交数展示待 commits 接口对接 */}
            {diffPayload ? (
              <>
                <span className="text-faint">·</span>
                <span className="font-mono">{diffPayload.stats.files_changed}</span>
                <span>{t("pullRequest.filesUnit")}</span>
                <span className="text-sage font-mono">+{diffPayload.stats.additions}</span>
                <span className="text-rose font-mono">−{diffPayload.stats.deletions}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2 pb-0.5">
          <button
            type="button"
            onClick={() => reviewMutation.mutate("approved")}
            disabled={!canReview || myState === "approved"}
            className={`${DECISION_BTN} bg-amber border-amber hover:bg-amber-2 hover:border-amber-2 text-ink-950`}
          >
            <Check className="size-[15px]" aria-hidden="true" />
            {myState === "approved" ? t("pullRequest.approvedLabel") : t("pullRequest.approve")}
          </button>
          <button
            type="button"
            onClick={() => reviewMutation.mutate("changes_requested")}
            disabled={!canReview || myState === "changes_requested"}
            className={`${DECISION_BTN} border-rose/30 bg-rose/5 text-rose-2 hover:bg-rose/12 hover:border-rose/40`}
          >
            {myState === "changes_requested" ? t("pullRequest.requestChangesLabel") : t("pullRequest.requestChanges")}
          </button>
          <button
            type="button"
            onClick={() => setWatchOpen(true)}
            className="border-edge-2 text-muted hover:border-edge-3 hover:text-bone-2 inline-flex h-8 items-center gap-[7px] rounded-md border px-2.5 text-xs font-medium transition-colors"
          >
            <Eye className="size-[14px]" aria-hidden="true" />
            {t("pullRequest.watchRepo")}
          </button>
        </div>
      </header>

      {/* 页签（检查/CI 无后端数据源，页签隐藏待 CI/builds 对接） */}
      <nav className="border-edge-2 mb-[18px] flex items-end gap-5 border-b" role="tablist" aria-label="Pull Request">
        <TabButton
          active={tab === "conversation"}
          label={t("pullRequest.reviews")}
          onClick={() => setTab("conversation")}
        />
        <TabButton
          active={tab === "files"}
          label={t("pullRequest.tabFiles")}
          count={diffPayload?.stats.files_changed}
          onClick={() => setTab("files")}
        />
      </nav>

      <Stage
        dock={dock}
        defaultPane="reviewers"
        panel={(pane) => (
          <PullPanel
            pane={pane}
            pr={pr}
            reviewerRows={reviewerRows}
            issues={issuesQuery.data ?? []}
            reviewersLoading={reviewersQuery.isPending}
            issuesLoading={issuesQuery.isPending}
            myState={myState}
            mergeConditions={mergeConditions}
            mergeBlocked={mergeBlocked}
            repoId={activeRepoId}
            prNumber={activePrNumber}
            reviewPending={reviewMutation.isPending}
            mergePending={mergeMutation.isPending}
            onApprove={() => reviewMutation.mutate("approved")}
            onRequestChanges={() => reviewMutation.mutate("changes_requested")}
            onMerge={() => mergeMutation.mutate()}
          />
        )}
      >
      {tab === "conversation" && (
        <div className="min-w-0">
          {/* 描述区 */}
          <article className="border-edge-2 bg-ink-850/50 rounded-[10px] border px-[17px] pt-4 pb-[17px] shadow-[inset_0_1px_0_rgba(240,231,216,0.04)]">
            <div className="border-edge-1 flex items-center gap-2.5 border-b pb-3">
              <ToneAvatar initials={initialsOf(pr.author)} tone={toneFor(pr.author?.id)} />
              <div className="min-w-0">
                <strong className="text-bone block text-sm font-semibold">{authorName}</strong>
                <span className="text-muted-2 block text-2xs">{t("pullRequest.startedAt", { time: formatRelative(pr.created_at) })}</span>
              </div>
              <StatusPill className="ml-auto h-[19px] px-2 text-2xs">{t("pullRequest.authorChip")}</StatusPill>
            </div>
            {pr.description ? (
              <Markdown content={pr.description} className="pt-3.5" />
            ) : (
              <p className="text-faint pt-3.5 text-xs">{t("pullRequest.noDescription")}</p>
            )}
          </article>

          {/* Kustos 评审发现卡片隐藏：agent jobs/steps 目前没有可读的 PR 评审发现，待对接后恢复 */}

          {/* 评审时间线（详情里的评审 + 评论） */}
          <ol aria-label={t("pullRequest.timeline")} className="mt-[22px]">
            {timeline.length === 0 ? (
              <li className="text-faint py-2 text-xs">{t("pullRequest.noReviewsYet")}</li>
            ) : (
              timeline.map((event, index, all) => (
                <li key={event.id} className="relative grid grid-cols-[30px_minmax(0,1fr)] gap-[11px] pb-[18px] last:pb-0">
                  {index < all.length - 1 ? (
                    <span aria-hidden="true" className="bg-edge-1 absolute top-[30px] bottom-0 left-[14px] w-px" />
                  ) : null}
                  <ToneAvatar
                    initials={event.initials}
                    tone={event.tone}
                    size="sm"
                    className="border-ink-950 z-[1] border-2"
                  />
                  <div className="min-w-0 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-bone-2 text-xs font-semibold">{event.name}</strong>
                      <span className="text-muted-2 text-2xs">{event.action}</span>
                      <span className="text-faint font-mono text-2xs">{formatRelative(event.at)}</span>
                      {event.badge ? (
                        <StatusPill className="h-[17px] px-[7px] text-2xs">{event.badge}</StatusPill>
                      ) : null}
                    </div>
                    {event.body ? (
                      <div className="border-edge-1 bg-ink-850/50 mt-1.5 rounded-md border px-3 py-2.5">
                        <Markdown content={event.body} className="text-muted text-xs" />
                      </div>
                    ) : null}
                  </div>
                </li>
              ))
            )}
          </ol>

          <div className="border-edge-1 mt-5 border-t pt-4">
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              rows={3}
              placeholder={t("pullRequest.commentPlaceholder")}
              aria-label={t("pullRequest.commentPlaceholder")}
              className="border-edge-2 bg-ink-950/60 text-bone placeholder:text-muted-2 focus:border-amber/40 min-h-[76px] w-full resize-none rounded-md border px-2.5 py-2 text-xs focus-visible:outline-none transition-colors"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-faint text-2xs">{t("pullRequest.commentHint")}</span>
              <Button
                size="sm"
                onClick={() => commentMutation.mutate()}
                disabled={!comment.trim() || commentMutation.isPending}
              >
                {commentMutation.isPending ? t("pullRequest.publishing") : t("pullRequest.publishComment")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {repo ? (
        <SocialDialog
          mode="watch"
          repoId={repo.id}
          repoName={repo.path}
          open={watchOpen}
          onOpenChange={setWatchOpen}
        />
      ) : null}

      {tab === "files" && (
        <div className="min-w-0">
          <div className="text-muted-2 border-edge-1 flex items-center gap-2.5 border-b pb-2.5 text-xs">
            <span>
              <span className="font-mono">{diffPayload?.stats.files_changed ?? "—"}</span> {t("pullRequest.filesChangedUnit")}
            </span>
            <span className="text-sage font-mono">+{diffPayload?.stats.additions ?? 0}</span>
            <span className="text-rose font-mono">−{diffPayload?.stats.deletions ?? 0}</span>
            <span className="text-faint ml-auto">{t("pullRequest.diffHint")}</span>
          </div>
          {diffQuery.isPending ? (
            <div aria-hidden="true" className="flex flex-col gap-3 pt-4">
              {[0, 1, 2].map((block) => (
                <div key={block} className="border-edge-1 rounded-md border p-3">
                  <Skeleton className="h-2.5 w-40" />
                  <SkeletonCodeLines lines={4} className="mt-3" />
                </div>
              ))}
            </div>
          ) : diffQuery.isError ? (
            <p className="text-rose-2 py-6 text-center text-base">{diffQuery.error?.message ?? t("pullRequest.diffLoadFailed")}</p>
          ) : diffPayload ? (
            <DiffViewer payload={diffPayload} className="pt-3" />
          ) : null}
        </div>
      )}
      </Stage>
    </div>
  );
}

/** 页签按钮：激活态琥珀下划线 + 右侧计数。 */
function TabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        "relative -mb-px flex items-center gap-1.5 pb-2.5 text-sm transition-colors " +
        (active ? "text-bone" : "text-muted hover:text-bone-2")
      }
    >
      {label}
      {count !== undefined ? (
        <span className="rounded-full bg-bone/[0.06] px-1.5 font-mono text-2xs leading-[15px] text-muted-2">{count}</span>
      ) : null}
      <span
        aria-hidden="true"
        className={
          "absolute right-0 bottom-0 left-0 h-[2px] rounded-full transition-colors " +
          (active ? "bg-amber" : "bg-transparent")
        }
      />
    </button>
  );
}

/**
 * 详情骨架：页头徽标与决策按钮 + 页签 + 描述卡。
 *
 * 宽度对齐真实页头（决策按钮右对齐、标题约 62% 宽），
 * 让「骨架 → 内容」的切换只发生在内容层，不牵动整页布局。
 */
function PullDetailSkeleton() {
  return (
    <div aria-hidden="true" className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px] pb-20">
      <div className="mb-[22px] flex items-end justify-between gap-7">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-[66px] rounded-full" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-[88px] rounded-full" />
          </div>
          <Skeleton className="mt-3 h-8 w-[62%]" />
          <div className="mt-3 flex items-center gap-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-2.5 w-28" />
          </div>
        </div>
        <div className="flex flex-none items-center gap-2 pb-0.5">
          <Skeleton className="h-8 w-[84px] rounded-md" />
          <Skeleton className="h-8 w-[92px] rounded-md" />
          <Skeleton className="h-8 w-[80px] rounded-md" />
        </div>
      </div>
      <div className="border-edge-2 mb-[18px] flex items-end gap-5 border-b pb-2.5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-14" />
      </div>
      <div className="border-edge-2 bg-ink-850/50 rounded-[10px] border px-[17px] pt-4 pb-[17px]">
        <div className="border-edge-1 flex items-center gap-2.5 border-b pb-3">
          <Skeleton className="size-7 rounded-full" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-2 w-28" />
          </div>
        </div>
        <SkeletonText lines={4} className="pt-4" />
      </div>
    </div>
  );
}

/** 页面空态：无当前仓库 / 暂无 PR / 加载中 / 详情缺失。 */
function PullEmpty({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-[520px] flex-col items-center gap-2 pt-[120px] text-center">
      <GitMerge className="text-faint size-[26px]" aria-hidden="true" />
      <h1 className="font-display text-bone text-2xl font-medium tracking-tight">{title}</h1>
      {hint ? <p className="text-muted-2 text-sm leading-relaxed">{hint}</p> : null}
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

interface PullPanelProps {
  pane: DockTab;
  pr: PrDetail;
  reviewerRows: ReviewerRow[];
  issues: PrLinkedIssue[];
  /** 评审人 / 关联 Issue 仍在取数：面板渲染占位，而不是「暂无」。 */
  reviewersLoading: boolean;
  issuesLoading: boolean;
  /** 当前用户的评审状态（approved / changes_requested / null）。 */
  myState: string | null;
  mergeConditions: MergeCond[];
  mergeBlocked: boolean;
  repoId: string;
  prNumber: number;
  reviewPending: boolean;
  mergePending: boolean;
  onApprove: () => void;
  onRequestChanges: () => void;
  onMerge: () => void;
}

/** 评审状态 → 胶囊色与文案。 */
function reviewStateStyle(state: string): { tone: "good" | "bad" | "warn"; label: string } {
  if (state === "approved") return { tone: "good", label: i18n.t("pullRequest.approvedLabel") };
  if (state === "changes_requested") return { tone: "bad", label: i18n.t("pullRequest.requestChangesLabel") };
  return { tone: "warn", label: i18n.t("pullRequest.waitingReview") };
}

/** 右缘悬浮面板：评审人 / 关联 Issue / 合并控件三个 pane。 */
function PullPanel({
  pane,
  pr,
  reviewerRows,
  issues,
  reviewersLoading,
  issuesLoading,
  myState,
  mergeConditions,
  mergeBlocked,
  repoId,
  prNumber,
  reviewPending,
  mergePending,
  onApprove,
  onRequestChanges,
  onMerge,
}: PullPanelProps) {
  const { t } = useTranslation();
  const me = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);

  // 评审邀请的成员候选：点击「邀请评审」后才拉仓库成员
  const membersQuery = useApiQuery<RepoMember[]>({
    queryKey: ["repo-members", repoId],
    enabled: inviteOpen && !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/members", {
        params: { path: { repo_id: repoId } },
      });
      assertOk(res);
      return (Array.isArray(res.data) ? res.data : []) as RepoMember[];
    },
  });

  const inviteMutation = useApiMutation<unknown, string>(
    async (username) => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/reviewers", {
        params: { path: { repo_id: repoId, pr_number: prNumber } },
        body: { usernames: [username] },
      });
      assertOk(res);
      return res.data;
    },
    {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["pull-request-reviewers", repoId, prNumber] });
        void queryClient.invalidateQueries({ queryKey: ["pull-request", repoId, prNumber] });
        setInviteOpen(false);
        toast.success(t("pullRequest.reviewRequestedToast"));
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const requestedIds = new Set(reviewerRows.map((row) => row.user.id));
  const inviteCandidates = (membersQuery.data ?? []).flatMap((member) => {
    const user = member.user;
    if (!user || !member.is_active || user.id === pr.author?.id || requestedIds.has(user.id)) return [];
    return [{ id: user.id, username: user.username, name: user.full_name || user.username }];
  });

  if (pane.id === "issues") {
    return (
      <RailBlock title={t("pullRequest.linkedIssues")}>
        {issuesLoading ? (
          <div className="flex flex-col gap-2 py-1">
            {[0, 1].map((row) => (
              <div key={row} className="flex flex-col gap-1.5">
                <Skeleton className="h-2.5" style={{ width: `${62 - row * 14}%` }} />
                <Skeleton className="h-2 w-16" />
              </div>
            ))}
          </div>
        ) : issues.length === 0 ? (
          <p className="text-faint py-2.5 text-xs">{t("pullRequest.noLinkedIssue")}</p>
        ) : (
          issues.map((issue) => (
            <div key={issue.id} className="border-edge-1 flex items-start gap-2 border-t py-2.5 first:border-t-0">
              <Link2 className="text-muted-2 mt-0.5 size-[15px] shrink-0" aria-hidden="true" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-bone-2 text-xs leading-snug">{issue.title}</span>
                <span className="text-faint text-2xs">
                  <span className="font-mono">#{issue.issue_number}</span> · {issue.status}
                  {issue.closes_on_merge ? t("pullRequest.closesOnMergeShort") : ""}
                </span>
              </div>
            </div>
          ))
        )}
        <button
          type="button"
          onClick={() => toast.info(t("pullRequest.linkIssueInfo"))}
          className="text-amber-2 hover:text-amber mt-2.5 text-xs transition-colors"
        >
          {t("pullRequest.linkIssue")}
        </button>
      </RailBlock>
    );
  }

  if (pane.id === "merge") {
    const merged = pr.status === "merged";
    const closed = pr.status === "closed";
    const ready = !mergeBlocked;
    const conditions: MergeCond[] =
      mergeConditions.length > 0 ? mergeConditions : [{ done: true, label: t("pullRequest.noProtection") }];
    const mergeTitle = merged
      ? t("pullRequest.mergedState")
      : closed
        ? t("pullRequest.closedState")
        : ready
          ? t("pullRequest.canMerge")
          : t("pullRequest.mergeBlocked");
    const mergeDesc = merged
      ? t("pullRequest.mergedBy", { user: displayName(pr.merged_by), branch: pr.target_branch })
      : closed
        ? t("pullRequest.closedCannotMerge")
        : ready
          ? t("pullRequest.conditionsMet")
          : t("pullRequest.conditionsPending");

    return (
      <RailBlock title={t("pullRequest.merge")}>
        <div className="rounded-[10px] border border-amber/25 bg-[radial-gradient(280px_120px_at_10%_0%,rgba(242,174,91,0.08),transparent_70%),rgba(21,35,42,0.54)] p-3.5">
          <div className="flex items-start gap-2">
            <Lamp tone={merged || ready ? "good" : closed ? "neutral" : "warn"} className="mt-1.5" />
            <div className="min-w-0">
              <strong className="text-bone block text-sm font-semibold leading-snug">{mergeTitle}</strong>
              <p className="text-muted-2 mt-[3px] text-2xs leading-[1.5]">{mergeDesc}</p>
            </div>
          </div>
          <ul className="my-2.5 flex flex-col gap-1">
            {conditions.map((cond) => (
              <MergeCondition key={cond.label} done={cond.done} label={cond.label} />
            ))}
          </ul>
          <button
            type="button"
            onClick={onMerge}
            disabled={!ready || mergePending}
            className="bg-amber border-amber text-ink-950 inline-flex h-8 w-full items-center justify-center gap-[7px] rounded-md border text-sm font-semibold opacity-50 disabled:pointer-events-none"
          >
            <GitMerge className="size-[15px]" aria-hidden="true" />
            {merged ? t("pullRequest.mergedState") : t("pullRequest.mergeAction")}
          </button>
          <p className="text-faint mt-2.5 flex items-start gap-[5px] text-2xs leading-[1.45]">
            <ShieldCheck className="mt-px size-[11px] shrink-0" aria-hidden="true" />
            <span>
              <span className="font-mono">{pr.target_branch}</span> {t("pullRequest.mergePolicyHint", { branch: "" })}
            </span>
          </p>
        </div>
      </RailBlock>
    );
  }

  return (
    <RailBlock title={t("pullRequest.reviewers")}>
      <ul>
        {pr.author ? (
          <li
            className={
              "border-edge-1 flex items-center gap-2 border-b py-2 last:border-b-0 " +
              (pr.author.id === me?.id ? "bg-amber/[0.045] rounded-md px-1.5" : "")
            }
          >
            <ToneAvatar initials={initialsOf(pr.author)} tone={toneFor(pr.author.id)} size="sm" />
            <span className="text-bone-2 truncate text-xs">
              {displayName(pr.author)}
              {pr.author.id === me?.id ? <span className="text-faint">{t("pullRequest.youSuffix")}</span> : null}
            </span>
            <StatusPill className="ml-auto h-[19px] flex-none px-2 text-2xs">{t("pullRequest.authorChip")}</StatusPill>
          </li>
        ) : null}
        {reviewerRows.map((row) => {
          const style = reviewStateStyle(row.state);
          const isYou = row.user.id === me?.id;
          return (
            <li
              key={row.user.id}
              className={
                "border-edge-1 flex items-center gap-2 border-b py-2 last:border-b-0 " +
                (isYou ? "bg-amber/[0.045] rounded-md px-1.5" : "")
              }
            >
              <ToneAvatar initials={initialsOf(row.user)} tone={toneFor(row.user.id)} size="sm" />
              <span className="text-bone-2 truncate text-xs">
                {displayName(row.user)}
                {isYou ? <span className="text-faint">{t("pullRequest.youSuffix")}</span> : null}
              </span>
              <StatusPill tone={style.tone} className="ml-auto h-[19px] flex-none px-2 text-2xs">
                {style.label}
              </StatusPill>
            </li>
          );
        })}
        {reviewerRows.length === 0 ? (
          reviewersLoading ? (
            <li className="flex flex-col gap-2 py-2">
              {[0, 1].map((row) => (
                <span key={row} className="flex items-center gap-2">
                  <Skeleton className="size-[23px] flex-none rounded-full" />
                  <Skeleton className="h-2.5" style={{ width: `${52 - row * 12}%` }} />
                  <Skeleton className="ml-auto h-[19px] w-[54px] rounded-full" />
                </span>
              ))}
            </li>
          ) : (
            <li className="text-faint py-2 text-xs">{t("pullRequest.noReviewersYet")}</li>
          )
        ) : null}
      </ul>
      <button
        type="button"
        onClick={() => setInviteOpen((open) => !open)}
        className="text-amber-2 hover:text-amber mt-2.5 text-xs transition-colors"
      >
        {inviteOpen ? t("pullRequest.collapseCandidates") : t("pullRequest.inviteReviewer")}
      </button>
      {inviteOpen ? (
        <ul className="border-edge-1 mt-1.5 flex flex-col gap-1 border-t pt-2">
          {membersQuery.isPending
            ? [0, 1, 2].map((row) => (
                <li key={row} className="px-1.5 py-1">
                  <Skeleton className="h-2.5" style={{ width: `${52 + row * 12}%` }} />
                </li>
              ))
            : null}
          {membersQuery.isError ? (
            <li className="text-rose-2 text-xs">{t("pullRequest.membersLoadFailed", { error: membersQuery.error?.message ?? "" })}</li>
          ) : null}
          {inviteCandidates.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                disabled={inviteMutation.isPending}
                onClick={() => inviteMutation.mutate(member.username)}
                className="text-muted-2 hover:text-bone-2 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="truncate">{member.name}</span>
                <span className="text-amber-2 ml-auto flex-none text-2xs">{t("pullRequest.requestReview")}</span>
              </button>
            </li>
          ))}
          {membersQuery.isSuccess && inviteCandidates.length === 0 ? (
            <li className="text-faint text-xs">{t("pullRequest.noInvitable")}</li>
          ) : null}
        </ul>
      ) : null}
      <div className="mt-2.5 flex flex-col gap-[5px]">
        <button
          type="button"
          onClick={onApprove}
          disabled={pr.status !== "open" || reviewPending || myState === "approved"}
          className="border-edge-2 text-bone-2 hover:border-edge-3 hover:bg-ink-750 inline-flex h-8 items-center justify-start gap-[7px] rounded-md border px-2.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50"
        >
          <Check className="size-[14px]" aria-hidden="true" />
          {myState === "approved" ? t("pullRequest.approvedLabel") : t("pullRequest.approve")}
        </button>
        <button
          type="button"
          onClick={onRequestChanges}
          disabled={pr.status !== "open" || reviewPending || myState === "changes_requested"}
          className="border-rose/25 bg-rose/5 text-rose-2 hover:bg-rose/12 hover:border-rose/40 inline-flex h-8 items-center justify-start rounded-md border px-2.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50"
        >
          {myState === "changes_requested" ? t("pullRequest.requestChangesLabel") : t("pullRequest.requestChanges")}
        </button>
      </div>
    </RailBlock>
  );
}

/** 合并条件列表的一行：满足为勾，未满足为等待。 */
function MergeCondition({ done, label }: { done: boolean; label: string }) {
  return (
    <li className={"flex items-center gap-1.5 text-2xs " + (done ? "text-sage" : "text-muted-2")}>
      {done ? <Check className="size-[11px]" aria-hidden="true" /> : <Clock3 className="size-[11px] text-amber" aria-hidden="true" />}
      {label}
    </li>
  );
}
