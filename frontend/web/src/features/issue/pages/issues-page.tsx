import { ChevronLeft, ChevronRight, Plus, Search, SlidersHorizontal, Tag } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";

import { MarkdownEditor } from "@/components/editor/markdown-editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Chip, Lamp, RailBlock, Stage, StatusPill, ToneAvatar, type DockTab } from "@/components/kit/kit";
import {
  closeIssue,
  createIssue,
  fetchIssueComments,
  fetchIssueDetail,
  fetchIssueLabels,
  fetchFilteredIssues,
  fetchIssues,
  fetchIssueTotal,
  fetchRepoMembers,
  postIssueComment,
  reopenIssue,
  updateIssue,
  type ApiLabel,
  type ApiRepoMember,
  type IssueListResult,
} from "@/features/issue/api";
import { IssueLabel } from "@/features/issue/components/issue-label";
import type { Issue, Person } from "@/features/issue/types";
import { IssueDetail } from "@/features/issue/pages/issue-detail";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { useAuthStore } from "@/stores/auth-store";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";
import { cn } from "@/lib/utils";

/** 优先级分组：列表按带吸顶组头的优先级带排列，回答「先看哪个」；critical 并入高优先级带。 */
const PRIORITY_GROUPS: { key: Issue["priority"]; label: string; match: (priority: Issue["priority"]) => boolean }[] = [
  { key: "high", label: "高优先级", match: (priority) => priority === "high" || priority === "critical" },
  { key: "medium", label: "中优先级", match: (priority) => priority === "medium" },
  { key: "low", label: "低优先级", match: (priority) => priority === "low" },
];

// Kustos 分诊 pane 暂时隐藏：后端暂无对应数据，待 Agent 分诊接口落地后恢复
const PANEL_DOCK: DockTab[] = [{ id: "details", icon: Tag, label: "字段", kicker: "Issue", ariaLabel: "Issue 字段" }];

/** 分页小按钮：列表超过一页时翻页。 */
const PAGE_BTN =
  "border-edge-2 text-muted-2 hover:border-edge-3 hover:text-bone-2 grid size-[21px] shrink-0 place-items-center rounded border transition-colors disabled:pointer-events-none disabled:opacity-40";

/** 头像；未指派时显示占位。 */
function PersonAvatar({ person, size = "sm" }: { person: Person | null; size?: "sm" | "md" }) {
  if (!person) {
    return (
      <span
        aria-hidden="true"
        className="bg-ink-800 text-muted-2 border-edge-1 inline-grid size-[23px] shrink-0 place-items-center rounded-full border text-[9px]"
      >
        —
      </span>
    );
  }
  return <ToneAvatar initials={person.initials} tone={person.bot ? "amber" : person.tone} size={size} bot={person.bot} />;
}

/**
 * Issue 页（原型 issues.html）：列表 + 详情一体。
 *
 * 左列是筛选与按优先级分带的 Issue 列表，右列是选中 Issue 的详情区；
 * 字段面板浮在画布右缘。数据来自仓库 Issue 接口，选中项由 ?issue=<编号>
 * 驱动，刷新后保留。
 */
export function IssuesPage() {
  const { t } = useTranslation();
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const repo = useRepoStore((state) => state.current);
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [statusFilter, setStatusFilter] = useState<"open" | "closed">("open");
  const [labelFilter, setLabelFilter] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  /** 正在编辑的 Issue；null 表示弹窗关闭。 */
  const [editTarget, setEditTarget] = useState<Issue | null>(null);
  /** 输入框原文；防抖后再进查询，避免每敲一个字打一次接口。 */
  const [keyword, setKeyword] = useState("");
  const [search, setSearch] = useState("");

  const repoId = repo?.id ?? "";
  // 选中项由 ?issue=<编号> 驱动；无效或缺失时列表自愈回落到首条
  const selectedNumber = Number(searchParams.get("issue")) || null;

  useEffect(() => {
    setCrumbs([{ label: repo?.name ?? "—" }, { label: t("nav.issues") }]);
  }, [setCrumbs, t, repo?.name]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  // 筛选条件变化后回到第一页
  useEffect(() => {
    setPage(1);
  }, [statusFilter, labelFilter, repoId, search]);

  const labelsQuery = useApiQuery<ApiLabel[]>({
    queryKey: ["issue-labels", repoId],
    enabled: !!repoId,
    queryFn: () => fetchIssueLabels(repoId),
  });

  const listQuery = useApiQuery<IssueListResult>({
    queryKey: ["issues", repoId, "list", { status: statusFilter, label: labelFilter, page, search }],
    enabled: !!repoId,
    queryFn: () => {
      // 有检索词时走 filter 端点（唯一支持 search 的入口），其余条件原样带上
      if (search) {
        const labelId = labelsQuery.data?.find((item) => item.name === labelFilter)?.id;
        return fetchFilteredIssues(repoId, {
          search,
          statuses: [statusFilter],
          labelIds: labelId ? [labelId] : undefined,
          page,
        });
      }
      return fetchIssues(repoId, { status: statusFilter, label: labelFilter || undefined, page });
    },
  });

  const openCountQuery = useApiQuery<number>({
    queryKey: ["issues", repoId, "count", "open"],
    enabled: !!repoId,
    queryFn: () => fetchIssueTotal(repoId, { status: "open" }),
  });

  const closedCountQuery = useApiQuery<number>({
    queryKey: ["issues", repoId, "count", "closed"],
    enabled: !!repoId,
    queryFn: () => fetchIssueTotal(repoId, { status: "closed" }),
  });

  const assignedCountQuery = useApiQuery<number>({
    queryKey: ["issues", repoId, "count", "assigned"],
    enabled: !!repoId && !!user,
    queryFn: () => fetchIssueTotal(repoId, { status: "open", assignee: user?.id }),
  });

  const items = useMemo(() => listQuery.data?.items ?? [], [listQuery.data]);
  const total = listQuery.data?.total ?? 0;
  const hasNext = listQuery.data?.hasNext ?? false;
  const hasPrev = listQuery.data?.hasPrev ?? false;

  // 选中项被筛掉时回落到首条，与原型的列表自愈行为一致
  const active = useMemo(
    () => items.find((issue) => issue.id === selectedNumber) ?? items[0] ?? null,
    [items, selectedNumber],
  );
  const activeNumber = active?.id ?? null;

  const detailQuery = useApiQuery<Issue>({
    queryKey: ["issues", repoId, "detail", activeNumber],
    enabled: !!repoId && activeNumber !== null,
    queryFn: async () => {
      if (activeNumber === null) throw new Error("未选择 Issue");
      return fetchIssueDetail(repoId, activeNumber);
    },
  });

  const commentsQuery = useApiQuery<Issue["comments"]>({
    queryKey: ["issue-comments", repoId, activeNumber],
    enabled: !!repoId && activeNumber !== null,
    queryFn: async () => {
      if (activeNumber === null) throw new Error("未选择 Issue");
      return fetchIssueComments(repoId, activeNumber);
    },
  });

  const toggleStatusMutation = useApiMutation<Issue, Issue>(
    (issue) => (issue.status === "open" ? closeIssue(repoId, issue.id) : reopenIssue(repoId, issue.id)),
    {
      onSuccess: (updated) => {
        toast.success(updated.status === "closed" ? `Issue #${updated.id} 已关闭。` : `Issue #${updated.id} 已重新打开。`);
        void queryClient.invalidateQueries({ queryKey: ["issues", repoId] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const commentMutation = useApiMutation<Issue["comments"][number], { issueNumber: number; content: string }>(
    ({ issueNumber, content }) => postIssueComment(repoId, issueNumber, content),
    {
      onSuccess: (_data, variables) => {
        toast.success("评论已提交。");
        void queryClient.invalidateQueries({ queryKey: ["issues", repoId, "detail", variables.issueNumber] });
        void queryClient.invalidateQueries({ queryKey: ["issue-comments", repoId, variables.issueNumber] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const createMutation = useApiMutation<Issue, { title: string; description: string; labelIds: string[] }>(
    (input) => createIssue(repoId, input),
    {
      onSuccess: (issue) => {
        toast.success(`Issue #${issue.id} 已创建。`);
        void queryClient.invalidateQueries({ queryKey: ["issues", repoId] });
        setCreateOpen(false);
        setSearchParams({ issue: String(issue.id) }, { replace: true });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  // 编辑弹窗：指派候选按需拉取，避免每次进页面都为下拉框付一次请求
  const membersQuery = useApiQuery<ApiRepoMember[]>({
    queryKey: ["repo-members", repoId],
    enabled: !!repoId && editTarget !== null,
    queryFn: () => fetchRepoMembers(repoId),
  });

  const editMutation = useApiMutation<
    Issue,
    {
      issueNumber: number;
      title: string;
      description: string;
      priority: string;
      assigneeId: string | null;
      labelIds: string[];
    }
  >((input) => updateIssue(repoId, input.issueNumber, input), {
    onSuccess: (issue) => {
      toast.success(`Issue #${issue.id} 已更新。`);
      void queryClient.invalidateQueries({ queryKey: ["issues", repoId] });
      void queryClient.invalidateQueries({ queryKey: ["issue-comments", repoId, issue.id] });
      setEditTarget(null);
    },
    onError: (error) => toast.error(error.message),
  });

  /** 未选择仓库时渲染空态，不回落到演示数据。 */
  if (!repo) {
    return (
      <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px]">
        <h1 className="font-display text-bone text-[clamp(1.7rem,2.6vw,2.3rem)] font-medium tracking-[-0.028em] leading-none">
          {t("issue.title")}
        </h1>
        <p className="text-muted-2 mt-4 text-[12px]">未选择仓库。请先在侧栏选择一个仓库，再查看它的 Issue。</p>
      </div>
    );
  }

  const openCount = openCountQuery.data ?? 0;
  const closedCount = closedCountQuery.data ?? 0;
  const assignedCount = assignedCountQuery.data ?? 0;

  return (
    <Stage
      dock={PANEL_DOCK}
      panel={() => <IssuePanel issue={detailQuery.data ?? active} />}
      className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px] pb-20"
    >
      {/* 页头 */}
      <header className="mb-[22px] flex items-end justify-between gap-8">
        <div className="min-w-0">
          <p className="text-faint text-[10.5px] font-semibold tracking-[0.16em] uppercase">{repo.name}</p>
          <h1 className="font-display text-bone mt-1.5 text-[clamp(1.7rem,2.6vw,2.3rem)] font-medium tracking-[-0.028em] leading-none">
            {t("issue.title")}
          </h1>
          <p className="text-muted-2 mt-2 flex flex-wrap items-center gap-[7px] text-[11px]">
            <span>
              <strong className="text-bone-2 font-mono text-[11px] font-medium">{openCount}</strong> 打开
            </span>
            <span className="text-faint">·</span>
            <span>
              <strong className="text-bone-2 font-mono text-[11px] font-medium">{closedCount}</strong> 已关闭
            </span>
            <span className="text-faint">·</span>
            <span className="border-amber/30 bg-amber/10 text-amber-2 inline-flex h-[19px] items-center rounded-full border px-[7px] text-[10px] font-medium">
              {assignedCount} 个指派给你
            </span>
          </p>
        </div>
        <div className="flex flex-none items-center gap-2.5 pb-1">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" />
            {t("issue.newIssue")}
          </Button>
        </div>
      </header>

      {/* 画布：列表 + 详情 */}
      <div className="border-edge-2 bg-ink-900/55 grid h-[calc(100vh-272px)] min-h-[540px] grid-cols-[392px_minmax(0,1fr)] overflow-hidden rounded-[14px] border">
        <aside aria-label="Issue 列表" className="border-edge-1 bg-ink-950/55 flex min-h-0 min-w-0 flex-col overflow-hidden border-r">
          {/* 筛选区 */}
          <div className="border-edge-2 flex flex-none flex-col gap-[9px] border-b p-3">
            <div className="border-edge-2 bg-ink-950/60 inline-flex rounded-md border p-0.5">
              {(["open", "closed"] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={cn(
                    "flex-1 rounded-[5px] px-2.5 py-1 text-[11px] font-medium transition-colors",
                    statusFilter === status ? "bg-amber/15 text-amber-2" : "text-muted hover:text-bone-2",
                  )}
                >
                  {status === "open" ? t("issue.open") : t("issue.closed")}{" "}
                  <span className="font-mono text-[10px] opacity-80">
                    {status === "open" ? openCount : closedCount}
                  </span>
                </button>
              ))}
            </div>

            {/* 关键词检索走 POST /issues/filter（GET 列表没有 q 参数） */}
            <div className="flex items-center gap-1.5">
              <div className="border-edge-2 bg-ink-900/70 focus-within:border-amber/40 flex h-[31px] min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 transition-colors">
                <Search className="text-faint size-3 shrink-0" aria-hidden="true" />
                <input
                  type="search"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="搜索标题与描述…"
                  aria-label="搜索 Issue"
                  className="text-bone placeholder:text-muted-2 min-w-0 flex-1 bg-transparent text-[11px] outline-none"
                />
              </div>
              <button
                type="button"
                aria-label="排序"
                onClick={() => toast.info("Issue 列表固定按最近创建排序。")}
                className="border-edge-2 text-muted-2 hover:border-edge-3 hover:text-bone grid size-[31px] shrink-0 place-items-center rounded-md border transition-colors"
              >
                <SlidersHorizontal className="size-[14px]" aria-hidden="true" />
              </button>
            </div>

            <div className="flex flex-wrap gap-1" aria-label="按标签筛选">
              <Chip active={!labelFilter} onClick={() => setLabelFilter("")}>
                {t("common.all")}
              </Chip>
              {(labelsQuery.data ?? []).map((label) => (
                <Chip key={label.id} active={labelFilter === label.name} onClick={() => setLabelFilter(label.name)}>
                  {label.name}
                </Chip>
              ))}
            </div>
          </div>

          {/* 列表：按优先级分带 */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {listQuery.isError ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <p className="text-bone-2 text-[12px] font-medium">Issue 列表加载失败。</p>
                <p className="text-muted-2 text-[10.5px]">{listQuery.error?.message}</p>
                <Button size="sm" variant="secondary" onClick={() => listQuery.refetch()}>
                  重试
                </Button>
              </div>
            ) : listQuery.isLoading ? (
              <p className="text-muted-2 px-4 py-7 text-center text-[11px]">加载中…</p>
            ) : items.length ? (
              PRIORITY_GROUPS.map((group) => {
                const groupItems = items.filter((issue) => group.match(issue.priority));
                if (!groupItems.length) return null;
                return (
                  <section key={group.key} aria-label={group.label} className="min-w-0">
                    <div className="border-edge-1 bg-ink-950/94 sticky top-0 z-[3] flex items-center gap-[7px] border-b px-3 pt-2 pb-[7px] shadow-[0_1px_0_rgba(0,0,0,0.35)] backdrop-blur-[6px]">
                      <span className="text-muted-2 text-[9.5px] font-semibold tracking-[0.13em] uppercase">{group.label}</span>
                      <span className="rounded-full bg-bone/[0.06] px-1.5 font-mono text-[10px] leading-[14px] text-muted-2">{groupItems.length}</span>
                      <span className="from-edge-1 h-px flex-1 bg-gradient-to-r to-transparent" aria-hidden="true" />
                    </div>
                    {groupItems.map((issue) => (
                      <IssueRow
                        key={issue.id}
                        issue={issue}
                        active={issue.id === active?.id}
                        onClick={() => setSearchParams({ issue: String(issue.id) }, { replace: true })}
                      />
                    ))}
                  </section>
                );
              })
            ) : (
              <p className="text-muted-2 px-4 py-7 text-center text-[11px]">{t("issue.noResults")}</p>
            )}
          </div>

          {/* 列表脚注：总数 + 翻页 */}
          <div className="border-edge-2 text-faint flex flex-none items-center gap-1.5 border-t px-3 py-[9px] text-[10px]">
            <Lamp tone={items.length ? "good" : "warn"} />
            <span>
              显示 {items.length} / 共 {total} 条
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <span>最近创建</span>
              <button
                type="button"
                aria-label="上一页"
                disabled={!hasPrev || listQuery.isFetching}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                className={PAGE_BTN}
              >
                <ChevronLeft className="size-[12px]" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="下一页"
                disabled={!hasNext || listQuery.isFetching}
                onClick={() => setPage((current) => current + 1)}
                className={PAGE_BTN}
              >
                <ChevronRight className="size-[12px]" aria-hidden="true" />
              </button>
            </span>
          </div>
        </aside>

        <IssueDetail
          issue={detailQuery.data ?? active}
          comments={commentsQuery.data}
          error={detailQuery.error?.message ?? commentsQuery.error?.message ?? null}
          onRetry={() => {
            void detailQuery.refetch();
            void commentsQuery.refetch();
          }}
          onToggleStatus={(issue) => toggleStatusMutation.mutate(issue)}
          onComment={(_issue, text) => {
            if (activeNumber !== null) commentMutation.mutate({ issueNumber: activeNumber, content: text });
          }}
          onEdit={setEditTarget}
        />
      </div>

      <CreateIssueDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        labels={labelsQuery.data ?? []}
        pending={createMutation.isPending}
        onSubmit={(input) => createMutation.mutate(input)}
      />

      <EditIssueDialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        issue={editTarget}
        labels={labelsQuery.data ?? []}
        members={membersQuery.data ?? []}
        pending={editMutation.isPending}
        onSubmit={(input) => {
          if (!editTarget) return;
          editMutation.mutate({ issueNumber: editTarget.id, ...input });
        }}
      />
    </Stage>
  );
}

/** 列表行：状态灯 + 标题 + 元信息 + 标签 + 指派人头像。 */
function IssueRow({ issue, active, onClick }: { issue: Issue; active: boolean; onClick: () => void }) {
  const closed = issue.status === "closed";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "border-edge-1 grid w-full grid-cols-[17px_minmax(0,1fr)_auto] gap-2.5 border-b px-3 py-3 text-left transition-colors",
        active
          ? "bg-[linear-gradient(90deg,rgba(242,174,91,0.1),rgba(242,174,91,0.02))] shadow-[inset_2px_0_0_rgba(242,174,91,1)]"
          : "hover:bg-ink-750/45",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid size-[15px] place-items-center rounded-full border",
          closed ? "border-muted-2 text-muted-2" : "border-sage text-sage",
        )}
      >
        <span className="size-1 rounded-full bg-current" />
      </span>
      <span className="min-w-0">
        <span className={cn("block truncate text-[12.5px] font-medium leading-snug", active ? "text-bone" : "text-bone-2")}>
          {issue.title}
        </span>
        <span className="text-muted-2 mt-1 flex flex-wrap items-center gap-[5px] font-mono text-[10px]">
          <span>#{issue.id}</span>
          <span className="text-faint">·</span>
          <span>{issue.opened}</span>
          {/* 列表接口不返回评论数，仅有值时展示 */}
          {issue.commentCount != null ? (
            <>
              <span className="text-faint">·</span>
              <span>{issue.commentCount} 条评论</span>
            </>
          ) : null}
        </span>
        <span className="mt-1.5 flex flex-wrap gap-1">
          {issue.labels.map((label) => (
            <IssueLabel key={label} label={label} />
          ))}
        </span>
      </span>
      <span className="flex flex-col items-end">
        <PersonAvatar person={issue.assignee} />
      </span>
    </button>
  );
}

/** 右缘面板：详情字段（分诊 pane 待 Agent 分诊接口落地后恢复）。 */
function IssuePanel({ issue }: { issue: Issue | null }) {
  const { t } = useTranslation();

  if (!issue) {
    return <p className="text-muted-2 px-[15px] py-3.5 text-[11.5px]">未选择 Issue。</p>;
  }

  return (
    <RailBlock title="字段">
      <MetaGroup label={t("issue.assignee")}>
        {issue.assignee ? (
          <span className="text-bone-2 flex items-center gap-[7px] text-[11px]">
            <PersonAvatar person={issue.assignee} />
            {issue.assignee.name}
          </span>
        ) : (
          <span className="text-muted-2 text-[11px]">未指派</span>
        )}
      </MetaGroup>
      <MetaGroup label={t("issue.labels")}>
        <span className="flex flex-wrap gap-1">
          {issue.labels.map((label) => (
            <IssueLabel key={label} label={label} />
          ))}
        </span>
      </MetaGroup>
      <MetaGroup label={t("issue.priority")}>
        <StatusPill tone={issue.priority === "high" || issue.priority === "critical" ? "bad" : issue.priority === "medium" ? "warn" : "default"}>
          {issue.priority}
        </StatusPill>
      </MetaGroup>
      <MetaGroup label="关联 Pull Request">
        {issue.linkedPrs?.length ? (
          <span className="flex flex-col gap-1">
            {issue.linkedPrs.map((pr) => (
              <Link
                key={pr.number}
                to={`/pull-requests?pr=${pr.number}`}
                className="text-bone-2 hover:text-amber-2 text-left text-[11px] leading-snug transition-colors hover:underline underline-offset-[3px]"
              >
                #{pr.number} · {pr.title}
                <span className="text-muted-2 mt-px block text-[9.5px]">
                  {pr.status}
                  {pr.closesOnMerge ? " · 合并即关闭" : ""}
                </span>
              </Link>
            ))}
          </span>
        ) : (
          <span className="text-muted-2 text-[11px]">{t("common.none")}</span>
        )}
      </MetaGroup>
      <MetaGroup label="创建者">
        <span className="text-bone-2 flex items-center gap-[7px] text-[11px]">
          <PersonAvatar person={issue.author} />
          {issue.author.name}
        </span>
      </MetaGroup>
      {issue.closedBy ? (
        <MetaGroup label="关闭者">
          <span className="text-muted-2 text-[11px]">{issue.closedBy}</span>
        </MetaGroup>
      ) : null}
    </RailBlock>
  );
}

/** 面板字段组：小标签 + 值，上下细分隔线。 */
function MetaGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-edge-1 border-b py-[11px] first:pt-0.5 last:border-b-0">
      <span className="text-faint mb-1.5 block text-[9.5px] font-semibold tracking-[0.13em] uppercase">{label}</span>
      {children}
    </div>
  );
}

/** 新建 Issue 弹窗：标题 + 描述（Markdown）+ 标签多选，创建后跳到新 Issue。 */
function CreateIssueDialog({
  open,
  onOpenChange,
  labels,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: ApiLabel[];
  pending: boolean;
  onSubmit: (input: { title: string; description: string; labelIds: string[] }) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);

  // 关闭后清空表单，避免下次打开残留上次输入
  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setSelectedLabels([]);
    }
  }, [open]);

  const toggleLabel = (labelId: string) =>
    setSelectedLabels((prev) => (prev.includes(labelId) ? prev.filter((id) => id !== labelId) : [...prev, labelId]));

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed || pending) return;
    onSubmit({ title: trimmed, description, labelIds: selectedLabels });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>新建 Issue</DialogTitle>
          <DialogDescription>标题必填；描述支持 Markdown，可多选标签。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题" aria-label="标题" />
          <div className="border-edge-2 bg-ink-950/45 overflow-hidden rounded-md border">
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              placeholder="描述（Markdown）…"
              className="text-bone px-2.5 py-2 text-[11px]"
            />
          </div>
          {labels.length ? (
            <div className="flex flex-wrap gap-1" aria-label="选择标签">
              {labels.map((label) => (
                <Chip key={label.id} active={selectedLabels.includes(label.id)} onClick={() => toggleLabel(label.id)}>
                  {label.name}
                </Chip>
              ))}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!title.trim() || pending}>
            {pending ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 优先级档位：与后端 `Issue.priority` 取值一致。 */
const EDIT_PRIORITIES = ["low", "medium", "high", "critical"] as const;

/**
 * 编辑 Issue 弹窗。
 *
 * 打开时用当前值预填；只提交被修改的语义（整表单提交，字段少且都有值）。
 * 指派候选来自仓库成员，未指派时提交 null 以清空。
 */
function EditIssueDialog({
  open,
  onOpenChange,
  issue,
  labels,
  members,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issue: Issue | null;
  labels: ApiLabel[];
  members: ApiRepoMember[];
  pending: boolean;
  onSubmit: (input: {
    title: string;
    description: string;
    priority: string;
    assigneeId: string | null;
    labelIds: string[];
  }) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [assigneeId, setAssigneeId] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);

  // 每次打开都按最新数据预填，避免沿用上一次编辑残留
  useEffect(() => {
    if (!open || !issue) return;
    setTitle(issue.title);
    setDescription(issue.body);
    setPriority(issue.priority);
    setAssigneeId(issue.assigneeId ?? "");
    setSelectedLabels(labels.filter((label) => issue.labels.includes(label.name)).map((label) => label.id));
  }, [open, issue, labels]);

  const toggleLabel = (labelId: string) =>
    setSelectedLabels((prev) =>
      prev.includes(labelId) ? prev.filter((id) => id !== labelId) : [...prev, labelId],
    );

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed || pending) return;
    onSubmit({
      title: trimmed,
      description,
      priority,
      assigneeId: assigneeId || null,
      labelIds: selectedLabels,
    });
  };

  const candidates = members.filter((member) => member.user && member.is_active !== false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>编辑 Issue #{issue?.id ?? ""}</DialogTitle>
          <DialogDescription>修改标题、描述、优先级、指派人与标签。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题" aria-label="标题" />
          <div className="border-edge-2 bg-ink-950/45 overflow-hidden rounded-md border">
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              placeholder="描述（Markdown）…"
              className="text-bone px-2.5 py-2 text-[11px]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1" aria-label="优先级">
            <span className="text-faint mr-1 text-[9.5px] font-semibold tracking-[0.12em] uppercase">优先级</span>
            {EDIT_PRIORITIES.map((level) => (
              <Chip key={level} active={priority === level} onClick={() => setPriority(level)}>
                {level}
              </Chip>
            ))}
          </div>

          <label className="flex items-center gap-2">
            <span className="text-faint text-[9.5px] font-semibold tracking-[0.12em] uppercase">指派给</span>
            <select
              value={assigneeId}
              onChange={(event) => setAssigneeId(event.target.value)}
              aria-label="指派给"
              className="border-edge-2 bg-ink-900 text-bone-2 focus:border-amber/45 h-[30px] min-w-0 flex-1 rounded-md border px-2 text-[11.5px] outline-none"
            >
              <option value="">未指派</option>
              {candidates.map((member) => (
                <option key={member.user?.id} value={member.user?.id}>
                  {member.user?.full_name || member.user?.username}
                </option>
              ))}
            </select>
          </label>

          {labels.length ? (
            <div className="flex flex-wrap gap-1" aria-label="选择标签">
              {labels.map((label) => (
                <Chip key={label.id} active={selectedLabels.includes(label.id)} onClick={() => toggleLabel(label.id)}>
                  {label.name}
                </Chip>
              ))}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!title.trim() || pending}>
            {pending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
