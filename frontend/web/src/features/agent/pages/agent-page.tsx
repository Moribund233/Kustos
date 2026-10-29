import {
  AlertTriangle,
  Bot,
  Check,
  FileDiff,
  FileText,
  PenLine,
  Play,
  Plus,
  Search,
  ShieldAlert,
  Terminal,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { Chip, Lamp, SectionHead, StatusPill, ToneAvatar, type Tone } from "@/components/kit/kit";
import type { AgentRun, RunStatus, RunStep, ToolStep } from "@/features/agent/types";
import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { Markdown } from "@/lib/markdown/markdown";
import { cn } from "@/lib/utils";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

/**
 * Agent 控制台（原型 agent.html）。
 *
 * 左栏是运行列表（按「等你决策 / 进行中 / 历史」分带），右栏是选中运行的
 * 详情：提问、模型用量、工具轨迹、流式回答，底部是写工具审批卡。
 * 数据来自仓库级 agent_controller；选中运行由 ?job=<job_id> 驱动。
 */

/* ------------------------------------------------------------------ */
/* 后端契约（schema.d.ts 响应体是 unknown，本地按 agent_controller 取形） */
/* ------------------------------------------------------------------ */

/** 作业 DTO（agent_controller._job_dict）。 */
interface AgentJobDto {
  id: string;
  session_id: string;
  status: string;
  prompt: string;
  result: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  step_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  /** 仅 awaiting_approval 时非空：{tool_call_id, tool, arguments}。 */
  pending_approval: { tool_call_id: string; tool: string; arguments: Record<string, unknown> } | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
}

/** 步骤 DTO（agent_controller._step_dict；data 是 JSON 原文字符串）。 */
interface AgentStepDto {
  seq: number;
  type: string;
  name: string | null;
  content: string | null;
  data: string | null;
}

function errDetail(error: unknown): string {
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return "请求失败，请稍后重试。";
}

async function fetchJobs(repoId: string): Promise<AgentJobDto[]> {
  const res = await api.GET("/api/v1/repositories/{repo_id}/agent/jobs", {
    params: { path: { repo_id: repoId }, query: { limit: 50 } },
  });
  if (res.error) throw new Error(errDetail(res.error));
  return (res.data as { jobs?: AgentJobDto[] } | undefined)?.jobs ?? [];
}

async function fetchJob(repoId: string, jobId: string): Promise<AgentJobDto> {
  const res = await api.GET("/api/v1/repositories/{repo_id}/agent/jobs/{job_id}", {
    params: { path: { repo_id: repoId, job_id: jobId } },
  });
  if (res.error) throw new Error(errDetail(res.error));
  return res.data as AgentJobDto;
}

async function fetchSteps(repoId: string, jobId: string): Promise<AgentStepDto[]> {
  const res = await api.GET("/api/v1/repositories/{repo_id}/agent/jobs/{job_id}/steps", {
    params: { path: { repo_id: repoId, job_id: jobId } },
  });
  if (res.error) throw new Error(errDetail(res.error));
  return (res.data as { steps?: AgentStepDto[] } | undefined)?.steps ?? [];
}

async function createJob(repoId: string, body: { prompt: string; model: string }): Promise<AgentJobDto> {
  const res = await api.POST("/api/v1/repositories/{repo_id}/agent/jobs", {
    params: { path: { repo_id: repoId } },
    body: { prompt: body.prompt, model: body.model || null },
  });
  if (res.error) throw new Error(errDetail(res.error));
  return res.data as AgentJobDto;
}

/** 取消运行。 */
async function cancelJob(repoId: string, jobId: string): Promise<void> {
  const res = await api.POST("/api/v1/repositories/{repo_id}/agent/jobs/{job_id}/cancel", {
    params: { path: { repo_id: repoId, job_id: jobId } },
  });
  if (res.error) throw new Error(errDetail(res.error));
}

/** 批准/拒绝挂起的写工具调用；批准后作业重新入队，拒绝时原因回灌给模型。 */
async function resolveApproval(repoId: string, jobId: string, decision: "approve" | "reject"): Promise<void> {
  const res =
    decision === "approve"
      ? await api.POST("/api/v1/repositories/{repo_id}/agent/jobs/{job_id}/approve", {
          params: { path: { repo_id: repoId, job_id: jobId } },
        })
      : await api.POST("/api/v1/repositories/{repo_id}/agent/jobs/{job_id}/reject", {
          params: { path: { repo_id: repoId, job_id: jobId } },
        });
  if (res.error) throw new Error(errDetail(res.error));
}

/* ------------------------------------------------------------------ */
/* DTO → 视图模型                                                      */
/* ------------------------------------------------------------------ */

/** 活跃状态 = 还会推进、可能需要决策的作业。 */
function isActiveStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "awaiting_approval";
}

/** 运行状态 → 状态灯与文案。 */
function statusMeta(status: RunStatus, runningLabel: string): { tone: Tone; live: boolean; label: string } {
  switch (status) {
    case "awaiting_approval":
      return { tone: "warn", live: true, label: "等待批准" };
    case "running":
      return { tone: "info", live: true, label: runningLabel };
    case "queued":
      return { tone: "info", live: false, label: "排队中" };
    case "succeeded":
      return { tone: "good", live: false, label: "已完成" };
    case "failed":
      return { tone: "bad", live: false, label: "失败" };
    default:
      return { tone: "neutral", live: false, label: "已取消" };
  }
}

/** 后端状态字符串 → 视图状态；未登记的兜底为失败。 */
function mapStatus(status: string): RunStatus {
  switch (status) {
    case "queued":
    case "running":
    case "awaiting_approval":
    case "succeeded":
    case "cancelled":
      return status;
    default:
      return "failed";
  }
}

/** JSON 参数对象 → 键值对行；长值截断，避免撑爆 well 块。 */
function argRows(raw: unknown): [string, string][] {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.entries(raw).map(([key, value]): [string, string] => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return [key, text.length > 160 ? `${text.slice(0, 160)}…` : text];
    });
  }
  return raw == null ? [] : [["args", String(raw)]];
}

function parseData(data: string | null): unknown {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/** 工具结果摘要：错误直出，其余压成单行预览。 */
function resultSummary(data: unknown): string {
  if (data && typeof data === "object" && !Array.isArray(data) && "error" in data) {
    return String((data as { error: unknown }).error);
  }
  const text = typeof data === "string" ? data : JSON.stringify(data) ?? "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** 后端步骤序列 → 页面轨迹：tool_call 与紧随的同名 tool_result 合并为一步。 */
function mapSteps(dtos: AgentStepDto[], jobStatus: string): RunStep[] {
  const steps: RunStep[] = [];
  for (const dto of dtos) {
    if (dto.type === "user") continue; // 提问已在详情头部展示
    if (dto.type === "tool_call") {
      steps.push({ type: "tool", name: dto.name ?? "tool", args: argRows(parseData(dto.data)), result: "" });
    } else if (dto.type === "tool_result") {
      // 拒绝路径不产生 tool_call，单独落一条备注；批准路径补到对应调用步上
      const call = [...steps]
        .reverse()
        .find((step): step is ToolStep => step.type === "tool" && step.name === dto.name && !step.result);
      const summary = `${dto.name ?? "工具"}：${resultSummary(parseData(dto.data))}`;
      if (call) call.result = resultSummary(parseData(dto.data));
      else steps.push({ type: "note", content: summary });
    } else if (dto.type === "approval_required") {
      // 仅作业仍挂起时渲染成待审批步；已决策后由后续 tool_result 讲述
      if (jobStatus === "awaiting_approval") {
        const data = parseData(dto.data);
        const args = data && typeof data === "object" && "arguments" in data ? (data as { arguments: unknown }).arguments : data;
        steps.push({ type: "tool", name: dto.name ?? "write tool", args: argRows(args), result: "等待批准", pending: true });
      }
    } else if (dto.type === "assistant") {
      steps.push({ type: "assistant", content: dto.content ?? "" });
    } else if (dto.type === "error") {
      steps.push({ type: "error", content: dto.content ?? "运行失败" });
    }
  }
  return steps;
}

/** 相对时间：18 分钟前。 */
function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 时长：22s / 2m 14s；未开跑显示 —。 */
function formatDuration(started: string | null, finished: string | null): string {
  if (!started) return "—";
  const end = finished ? new Date(finished).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - new Date(started).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** 作业 DTO → 列表/详情共用的视图模型；steps 由详情侧的轨迹查询填入。 */
function mapJob(dto: AgentJobDto, repoName: string, steps: RunStep[] = []): AgentRun {
  const lastAssistant = [...steps].reverse().find((step) => step.type === "assistant");
  const pending = dto.pending_approval;
  return {
    id: dto.id,
    title: (dto.prompt.split("\n")[0] ?? "").slice(0, 48) || "未命名运行",
    repo: repoName,
    status: mapStatus(dto.status),
    model: dto.model ?? "实例默认",
    session: dto.session_id.slice(0, 8),
    created: formatRelative(dto.created_at),
    duration: formatDuration(dto.started_at, dto.finished_at),
    tokens: { prompt: dto.prompt_tokens, completion: dto.completion_tokens, cached: dto.cached_tokens },
    prompt: dto.prompt,
    answer: dto.result ?? (lastAssistant?.type === "assistant" ? lastAssistant.content : ""),
    streaming: dto.status === "running",
    steps,
    approval:
      dto.status === "awaiting_approval" && pending
        ? {
            tool: pending.tool,
            args: argRows(pending.arguments),
            reason: "向仓库写文件属于写操作。Kustos 在此暂停，等你决定。",
            note: "尚未写入任何内容。批准后作业继续执行，拒绝则该写入不会发生。",
          }
        : undefined,
  };
}

/** 千分位缩写：14352 → 14.4k。 */
function k(value: number): string {
  return `${(value / 1000).toFixed(1)}k`;
}

/** 进行中 = 会继续消耗配额、可能需要决策的运行。 */
function isActive(run: AgentRun): boolean {
  return isActiveStatus(run.status);
}

/** 工具名 → 轨迹图标；未登记的工具退回终端图标。 */
function toolIcon(name: string) {
  if (name.startsWith("search")) return Search;
  if (name.startsWith("read")) return FileText;
  if (name.startsWith("get_diff")) return FileDiff;
  if (name.startsWith("write")) return PenLine;
  return Terminal;
}

/** 活跃作业轮询间隔：状态推进靠轮询刷新，终态停止。 */
const POLL_MS = 5000;

export function AgentPage() {
  const { t } = useTranslation();
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const repo = useRepoStore((state) => state.current);
  const [searchParams, setSearchParams] = useSearchParams();
  const jobId = searchParams.get("job");
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<"active" | "history">("active");
  const [composing, setComposing] = useState(false);

  const jobsQuery = useApiQuery<AgentJobDto[]>({
    queryKey: ["agent-jobs", repo?.id ?? ""],
    queryFn: () => fetchJobs(repo!.id),
    enabled: !!repo,
    refetchInterval: (query) => (query.state.data?.some((job) => isActiveStatus(job.status)) ? POLL_MS : false),
  });
  const jobQuery = useApiQuery<AgentJobDto>({
    queryKey: ["agent-job", repo?.id ?? "", jobId ?? ""],
    queryFn: () => fetchJob(repo!.id, jobId!),
    enabled: !!repo && !!jobId,
    refetchInterval: (query) => (query.state.data && isActiveStatus(query.state.data.status) ? POLL_MS : false),
  });
  const stepsQuery = useApiQuery<AgentStepDto[]>({
    queryKey: ["agent-job-steps", repo?.id ?? "", jobId ?? ""],
    queryFn: () => fetchSteps(repo!.id, jobId!),
    enabled: !!repo && !!jobId,
    refetchInterval: () => (jobQuery.data && isActiveStatus(jobQuery.data.status) ? POLL_MS : false),
  });

  useEffect(() => {
    setCrumbs([{ label: t("nav.agent") }, ...(jobId ? [{ label: `Run ${jobId.slice(0, 8)}` }] : [])]);
  }, [setCrumbs, t, jobId]);

  /** 三个查询一起失效：列表分带、详情状态、工具轨迹同步刷新。 */
  function invalidate() {
    if (!repo || !jobId) return;
    void queryClient.invalidateQueries({ queryKey: ["agent-jobs", repo.id] });
    void queryClient.invalidateQueries({ queryKey: ["agent-job", repo.id, jobId] });
    void queryClient.invalidateQueries({ queryKey: ["agent-job-steps", repo.id, jobId] });
  }

  const decide = useApiMutation<void, "approve" | "reject">(
    (action) => resolveApproval(repo!.id, jobId!, action),
    {
      onSuccess: (_data, action) => {
        invalidate();
        if (action === "approve") toast.success("已批准写入，作业继续执行。");
        else toast("已拒绝写入，该写入不会发生。");
      },
      onError: (error) => toast.error(errDetail(error)),
    },
  );

  const cancel = useApiMutation<void, void>(() => cancelJob(repo!.id, jobId!), {
    onSuccess: () => {
      invalidate();
      toast("已取消运行。");
    },
    onError: (error) => toast.error(errDetail(error)),
  });

  const create = useApiMutation<AgentJobDto, { prompt: string; model: string }>(
    (vars) => createJob(repo!.id, vars),
    {
      onSuccess: (job) => {
        if (repo) void queryClient.invalidateQueries({ queryKey: ["agent-jobs", repo.id] });
        setComposing(false);
        setSearchParams({ job: job.id });
        toast.success("新运行已排队。");
      },
      onError: (error) => toast.error(errDetail(error)),
    },
  );

  if (!repo) {
    return (
      <div className="border-edge-2 bg-ink-900/60 mx-auto grid h-[calc(100vh_-_190px)] min-h-[640px] w-full max-w-[1560px] place-items-center rounded-[14px] border">
        <div className="text-muted-2 flex flex-col items-center gap-2.5 text-center">
          <Bot className="text-faint size-7" aria-hidden="true" />
          <strong className="text-bone-2 text-[12px] font-medium">未选择仓库</strong>
          <span className="max-w-[34ch] text-[10.5px]">Agent 作业按仓库隔离，先在侧栏选一个仓库。</span>
        </div>
      </div>
    );
  }

  const jobs = jobsQuery.data ?? [];
  const runs = jobs.map((job) => mapJob(job, repo.name));
  // 详情查询未返回前先用列表项顶上，选中即渲染，随后详情与轨迹补齐
  const currentDto = jobQuery.data ?? jobs.find((job) => job.id === jobId) ?? null;
  const current = currentDto
    ? mapJob(currentDto, repo.name, mapSteps(stepsQuery.data ?? [], currentDto.status))
    : null;

  const awaiting = runs.filter((run) => run.status === "awaiting_approval").length;
  const activeCount = runs.filter(isActive).length;
  const visible = runs.filter((run) => (filter === "active" ? isActive(run) : !isActive(run)));

  // 分带顺序 = 决策优先：先「等你决策」，再「进行中」，最后历史。
  const groups: { key: string; label: string; runs: AgentRun[] }[] = [];
  if (filter === "active") {
    const awaitingRuns = visible.filter((run) => run.status === "awaiting_approval");
    const runningRuns = visible.filter((run) => run.status !== "awaiting_approval");
    if (awaitingRuns.length) groups.push({ key: "awaiting", label: t("agent.pendingDecision"), runs: awaitingRuns });
    if (runningRuns.length) groups.push({ key: "running", label: t("agent.running"), runs: runningRuns });
  } else if (visible.length) {
    groups.push({ key: "history", label: t("agent.history"), runs: visible });
  }

  return (
    <div className="border-edge-2 bg-ink-900/60 mx-auto grid h-[calc(100vh_-_190px)] min-h-[640px] w-full max-w-[1560px] grid-cols-[252px_minmax(0,1fr)] overflow-hidden rounded-[14px] border">
      {/* 左栏：运行列表 */}
      <aside className="border-edge-2 bg-ink-850/40 flex min-w-0 flex-col overflow-hidden border-r" aria-label="Agent 运行列表">
        <div className="border-edge-2 flex flex-none items-end justify-between gap-2.5 border-b px-3.5 pt-4 pb-3">
          <div className="min-w-0">
            <p className="text-faint text-[9.5px] font-semibold tracking-[0.16em] uppercase">KUSTOS</p>
            <h1 className="font-display text-bone mt-[5px] text-[1.6rem] leading-none">{t("agent.title")}</h1>
          </div>
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="bg-amber border-amber hover:bg-amber-2 hover:border-amber-2 inline-flex h-[27px] flex-none items-center gap-[5px] rounded-md border px-2.5 text-[10.5px] font-semibold text-ink-950 transition-colors"
          >
            <Plus className="size-[13px]" aria-hidden="true" />
            {t("agent.newRun")}
          </button>
        </div>

        <div className="border-edge-1 flex flex-none gap-1.5 border-b px-2.5 py-2.5" role="group" aria-label="运行状态筛选">
          <Chip active={filter === "active"} onClick={() => setFilter("active")}>
            {t("agent.running")}
            <span className="font-mono text-[9.5px]">{activeCount}</span>
          </Chip>
          <Chip active={filter === "history"} onClick={() => setFilter("history")}>
            {t("agent.history")}
            <span className="font-mono text-[9.5px]">{runs.length - activeCount}</span>
          </Chip>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label} className="border-edge-2 first:border-t-0 border-t">
              <p className="text-muted-2 flex items-center gap-[7px] px-3 pt-3 pb-[5px] text-[9.5px] font-semibold tracking-[0.13em] uppercase">
                {group.label}
                <span className="rounded-full bg-bone/[0.06] px-1.5 font-mono text-[9px] leading-[14px] tracking-normal">
                  {group.runs.length}
                </span>
              </p>
              {group.runs.map((run) => (
                <RunItem
                  key={run.id}
                  run={run}
                  active={run.id === jobId && !composing}
                  onSelect={() => {
                    setSearchParams({ job: run.id });
                    setComposing(false);
                  }}
                />
              ))}
            </section>
          ))}
          {!groups.length ? (
            <p className="text-muted-2 px-3 py-6 text-center text-[10.5px]">
              {jobsQuery.isLoading ? "加载中…" : filter === "active" ? "暂无进行中的运行" : "暂无历史运行"}
            </p>
          ) : null}
        </div>

        <div className="border-edge-2 text-muted-2 flex flex-none items-center gap-1.5 border-t px-3 py-[9px] text-[10px]">
          <Lamp tone={awaiting ? "warn" : "good"} live={Boolean(awaiting)} className="size-[5px]" />
          {awaiting
            ? `${activeCount} 个进行中 · ${awaiting} 个等待批准`
            : activeCount
              ? `${activeCount} 个进行中 · 无待批准`
              : "暂无进行中的运行"}
        </div>
      </aside>

      {/* 右栏：新建表单 或 运行详情 */}
      {composing ? (
        <NewRunForm
          repoName={repo.name}
          onCancel={() => setComposing(false)}
          onSubmit={(detail) => create.mutate(detail)}
        />
      ) : current ? (
        <RunDetail
          run={current}
          onApprove={() => decide.mutate("approve")}
          onReject={() => decide.mutate("reject")}
          onCancel={() => cancel.mutate()}
          deciding={decide.isPending}
          cancelling={cancel.isPending}
        />
      ) : (
        <div className="text-muted-2 flex flex-col items-center justify-center gap-2.5 p-10 text-center">
          <Bot className="text-faint size-7" aria-hidden="true" />
          <strong className="text-bone-2 text-[12px] font-medium">未选中运行</strong>
          <span className="max-w-[34ch] text-[10.5px]">从左侧列表里挑一个运行，或新建一个。</span>
        </div>
      )}
    </div>
  );
}

/** 列表项：状态灯 + 标题 + ID + 元信息 + 状态胶囊。 */
function RunItem({ run, active, onSelect }: { run: AgentRun; active: boolean; onSelect: () => void }) {
  const meta = statusMeta(run.status, "执行中");
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "border-edge-1 hover:bg-ink-750/50 block w-full border-b px-3 py-[11px] text-left transition-colors",
        active && "bg-[linear-gradient(90deg,rgba(242,174,91,0.1),rgba(242,174,91,0.02))] shadow-[inset_2px_0_0_rgba(242,174,91,0.9)]",
      )}
    >
      <span className="flex items-start gap-[7px]">
        <Lamp tone={meta.tone} live={meta.live} className="mt-[5px]" />
        <span className={cn("truncate text-[12px] font-medium leading-snug", active ? "text-bone" : "text-bone-2")}>
          {run.title}
        </span>
        <span className="text-faint ml-auto flex-none font-mono text-[9.5px]">{run.session}</span>
      </span>
      <span className="text-muted-2 mt-1 block truncate font-mono text-[9.5px]">
        {run.repo} · {run.model}
      </span>
      <span className="mt-1.5 flex items-center gap-1.5">
        <StatusPill tone={meta.tone} lamp live={meta.live} className="h-[17px] px-1.5 text-[9px]">
          {meta.label}
        </StatusPill>
        <span className="text-muted-2 text-[10px]">{run.duration}</span>
      </span>
    </button>
  );
}

/** 运行详情：头部 + 滚动区（提问 / 用量 / 轨迹 / 回答）+ 底部审批区。 */
function RunDetail({
  run,
  onApprove,
  onReject,
  onCancel,
  deciding,
  cancelling,
}: {
  run: AgentRun;
  onApprove: () => void;
  onReject: () => void;
  onCancel: () => void;
  deciding: boolean;
  cancelling: boolean;
}) {
  const { t } = useTranslation();
  const meta = statusMeta(run.status, t("agent.running"));
  const toolSteps = run.steps.filter((step): step is ToolStep => step.type === "tool");
  const pending = run.approval;

  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden"
      style={{
        // 原型主栏的顶部暖色氛围光
        background:
          "radial-gradient(760px 340px at 50% -10%, rgba(242,174,91,0.045), transparent 68%), var(--color-ink-950)",
      }}
    >
      <header className="border-edge-1 bg-ink-850/40 flex flex-none items-start justify-between gap-4 border-b px-[18px] py-[13px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-[7px]">
            <StatusPill tone={meta.tone} lamp live={meta.live}>
              {meta.label}
            </StatusPill>
            <span className="text-muted font-mono text-[11px]">{run.session}</span>
          </div>
          <h2 className="font-display text-bone mt-1.5 text-[1.35rem] font-medium tracking-[-0.02em] leading-tight">
            {run.title}
          </h2>
          <p className="text-muted-2 mt-[7px] flex flex-wrap items-center gap-1.5 text-[10px]">
            <span>{run.repo}</span>
            <span className="text-faint">·</span>
            <span className="font-mono">{run.model}</span>
            <span className="text-faint">·</span>
            <span>
              {run.steps.length} {t("agent.steps")}
            </span>
            <span className="text-faint">·</span>
            <span>{run.duration}</span>
          </p>
        </div>
        {isActive(run) ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            className="border-edge-2 bg-ink-750/55 hover:border-edge-3 hover:bg-ink-750 text-bone-2 inline-flex h-[27px] flex-none items-center gap-[5px] rounded-md border px-2.5 text-[11px] font-medium transition-colors disabled:opacity-60"
          >
            <X className="size-[13px]" aria-hidden="true" />
            {t("agent.cancel")}
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[18px] py-[17px]">
        {/* 提问 */}
        <div className="border-edge-1 bg-ink-850/45 grid grid-cols-[29px_minmax(0,1fr)] gap-2.5 rounded-[10px] border px-3 py-[11px]">
          <ToneAvatar initials="我" tone="amber" size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-[7px]">
              <span className="text-bone-2 text-[12px] font-semibold">我</span>
              <span className="text-muted-2 font-mono text-[10px]">{run.created}</span>
            </div>
            <p className="text-bone-2 mt-1.5 text-[12px] leading-[1.62]">{run.prompt}</p>
          </div>
        </div>

        {/* 模型用量 */}
        <TokenUsage run={run} />

        {/* 工具轨迹 */}
        <section aria-label={t("agent.toolTrace")} className="mt-4">
          <SectionHead title={t("agent.toolTrace")} count={toolSteps.length} meta={run.model} />
          <div className="relative pt-2.5">
            <span aria-hidden="true" className="bg-edge-1 absolute top-4 bottom-2 left-[13px] w-px" />
            {run.steps.map((step, index) => (
              <StepRow key={index} step={step} />
            ))}
          </div>
        </section>

        {/* 流式回答 */}
        {run.answer ? (
          <section aria-label={t("agent.answer")} className="mt-4">
            <SectionHead
              title={t("agent.answer")}
              meta={
                run.streaming ? (
                  <span className="text-amber inline-flex items-center gap-1.5">
                    <Lamp tone="warn" live />
                    流式输出中
                  </span>
                ) : (
                  run.model
                )
              }
            />
            <div className="border-amber/[0.18] bg-amber/[0.045] mt-2.5 rounded-[10px] border px-3.5 py-3">
              <Markdown content={run.answer} />
              {run.streaming ? (
                <span aria-hidden="true" className="bg-amber ml-0.5 inline-block h-[13px] w-[6px] animate-pulse align-middle" />
              ) : null}
            </div>
          </section>
        ) : null}
      </div>

      {/* 审批卡 / 暂停提示 */}
      {pending ? (
        <div className="border-amber/[0.34] bg-[radial-gradient(500px_200px_at_0%_0%,rgba(242,174,91,0.12),transparent_68%),rgba(21,35,42,0.7)] mx-[18px] mb-2.5 flex-none overflow-hidden rounded-[12px] border shadow-[0_0_36px_rgba(242,174,91,0.08)]">
          <div className="border-amber/[0.16] flex items-center gap-[9px] border-b px-3 py-[11px]">
            <span
              aria-hidden="true"
              className="border-amber/[0.35] bg-amber/10 text-amber grid size-[27px] flex-none place-items-center rounded-full border"
            >
              <ShieldAlert className="size-[13px]" />
            </span>
            <div className="min-w-0">
              <strong className="text-bone block text-[12px] font-semibold">{t("agent.awaitingApproval")}</strong>
              <span className="text-muted-2 block text-[10px]">写工具 · 任务已暂停</span>
            </div>
            <StatusPill tone="warn" className="ml-auto h-[19px] px-[7px] text-[9.5px]">
              已阻塞
            </StatusPill>
          </div>
          <div className="flex flex-col gap-[9px] px-3 py-[11px]">
            <span className="border-amber/[0.3] bg-ink-950/40 text-amber inline-flex h-6 w-fit items-center gap-[5px] rounded-md border px-2 font-mono text-[10px]">
              <Terminal className="size-[11px]" aria-hidden="true" />
              {pending.tool}
            </span>
            <div className="border-edge-1 bg-ink-950/60 rounded-md border px-2.5 py-2 font-mono text-[10px] leading-[1.6] shadow-[inset_0_1px_6px_rgba(0,0,0,0.28)]">
              {pending.args.map(([key, value]) => (
                <div key={key} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 py-px">
                  <span className="text-faint">{key}</span>
                  <span className="text-bone-2 overflow-wrap-anywhere">{value}</span>
                </div>
              ))}
            </div>
            <div>
              <p className="text-muted text-[11.5px] leading-[1.55]">{pending.reason}</p>
              <p className="text-faint mt-[5px] text-[10px] leading-[1.5]">{pending.note}</p>
            </div>
          </div>
          <div className="flex items-center gap-[7px] px-3 pb-3">
            <button
              type="button"
              onClick={onApprove}
              disabled={deciding}
              className="bg-amber border-amber hover:bg-amber-2 hover:border-amber-2 inline-flex h-[27px] items-center gap-[5px] rounded-md border px-2.5 text-[10.5px] font-semibold text-ink-950 transition-colors disabled:opacity-60"
            >
              <Check className="size-[13px]" aria-hidden="true" />
              {t("agent.approveWrite")}
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={deciding}
              className="border-edge-2 bg-ink-750/55 hover:border-edge-3 hover:bg-ink-750 text-bone-2 inline-flex h-[27px] items-center gap-[5px] rounded-md border px-2.5 text-[10.5px] font-medium transition-colors disabled:opacity-60"
            >
              <X className="size-[13px]" aria-hidden="true" />
              {t("agent.reject")}
            </button>
            <span className="text-faint ml-auto text-[10px]">没有你的决定，任何写入都不会发生。</span>
          </div>
        </div>
      ) : null}
      {!pending && run.status === "awaiting_approval" ? (
        <div className="border-edge-2 text-muted-2 flex flex-none items-center gap-2 border-t px-[18px] py-3 text-[10px]">
          <Lamp tone="warn" live className="size-[5px]" />
          运行停在批准闸门上。批准或拒绝上方的写工具以继续。
        </div>
      ) : null}
    </div>
  );
}

/** 轨迹中的一步：图标 + 名称 + 结果摘要 + 参数 well 块。 */
function StepRow({ step }: { step: RunStep }) {
  if (step.type === "tool") {
    const Icon = toolIcon(step.name);
    return (
      <div className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-2.5 py-[7px]">
        <span
          aria-hidden="true"
          className={cn(
            "border-edge-2 bg-ink-850 text-muted-2 relative z-[1] grid size-[27px] place-items-center rounded-full border",
            step.pending && "border-amber/30 bg-amber/10 text-amber",
          )}
        >
          <Icon className="size-3" />
        </span>
        <div className="min-w-0 pt-0.5">
          <div className="flex flex-wrap items-center gap-[7px]">
            <span className="text-bone-2 font-mono text-[10.5px]">{step.name}</span>
            {step.pending ? (
              <StatusPill tone="warn" lamp live className="h-[17px] px-1.5 text-[9px]">
                待审批
              </StatusPill>
            ) : null}
            <span className="text-faint ml-auto font-mono text-[10px]">{step.result}</span>
          </div>
          <div className="border-edge-1 bg-ink-950/60 mt-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[10px] leading-[1.6] shadow-[inset_0_1px_6px_rgba(0,0,0,0.28)]">
            {step.args.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 py-px">
                <span className="text-faint">{key}</span>
                <span className="text-bone-2 overflow-wrap-anywhere">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (step.type === "error") {
    return (
      <div className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-2.5 py-[7px]">
        <span
          aria-hidden="true"
          className="border-rose/30 bg-rose/10 text-rose relative z-[1] grid size-[27px] place-items-center rounded-full border"
        >
          <AlertTriangle className="size-3" />
        </span>
        <div className="min-w-0 pt-0.5">
          <span className="text-rose-2 font-mono text-[10.5px]">运行失败</span>
          <p className="border-rose/[0.22] bg-rose/[0.06] text-rose-2 mt-1.5 max-w-[min(74ch,580px)] rounded-md border px-3 py-2.5 text-[12px] leading-[1.62]">
            {step.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-2.5 py-[7px]">
      <span
        aria-hidden="true"
        className="border-edge-2 bg-ink-850 text-muted-2 relative z-[1] grid size-[27px] place-items-center rounded-full border"
      >
        <Terminal className="size-3" />
      </span>
      <div className="min-w-0 pt-0.5">
        <p className="text-muted border-edge-1 bg-ink-850/40 mt-1.5 max-w-[min(74ch,580px)] rounded-md border px-3 py-2 text-[11.5px] leading-[1.55]">
          {step.content}
        </p>
      </div>
    </div>
  );
}

/** 模型用量：提示词 / 缓存 / 回答的三段拆分条；provider 未回传 usage 时整块隐藏。 */
function TokenUsage({ run }: { run: AgentRun }) {
  const { prompt, completion, cached } = run.tokens;
  if (!prompt && !completion && !cached) return null;
  const total = Math.max(prompt + completion, 1);
  // 缓存命中是提示词的子集，条形只拆「纯提示词 / 缓存 / 回答」三段。
  const promptOnly = Math.max(0, prompt - cached);
  const share = (value: number) => `${Math.round((value / total) * 100)}%`;

  return (
    <section aria-label="模型用量" className="border-edge-2 bg-ink-850/40 mt-4 rounded-[10px] border px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-muted-2 text-[10px] font-semibold tracking-[0.15em] uppercase">模型用量</h3>
        <span className="text-bone-2 font-mono text-[11px]">{k(prompt + completion)} tokens</span>
      </div>
      <div aria-hidden="true" className="bg-bone/5 mt-2 flex h-[5px] overflow-hidden rounded-full">
        <span className="bg-amber/60 h-full" style={{ width: share(promptOnly) }} />
        <span className="bg-sage/55 h-full" style={{ width: share(cached) }} />
        <span className="bg-sky/60 h-full" style={{ width: share(completion) }} />
      </div>
      <dl className="mt-1.5 grid grid-cols-3 gap-2">
        {[
          { label: "提示词", value: k(prompt) },
          { label: "回答", value: k(completion) },
          { label: "命中缓存", value: k(cached) },
        ].map((item) => (
          <div key={item.label}>
            <dt className="text-faint text-[9.5px]">{item.label}</dt>
            <dd className="text-bone-2 font-mono text-[11px] tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-faint mt-1.5 font-mono text-[9.5px]">
        {run.session} · provider usage
      </p>
    </section>
  );
}

/** 新建运行表单：原型「Start a run」弹窗的字段，落在主栏里，提交 POST agent/jobs。 */
function NewRunForm({
  repoName,
  onCancel,
  onSubmit,
}: {
  repoName: string;
  onCancel: () => void;
  onSubmit: (detail: { prompt: string; model: string }) => void;
}) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");

  return (
    <div className="min-w-0 overflow-y-auto px-[18px] py-[17px]">
      <p className="text-faint text-[9.5px] font-semibold tracking-[0.16em] uppercase">KUSTOS AGENT</p>
      <h2 className="font-display text-bone mt-1.5 text-[1.35rem] font-medium tracking-[-0.02em] leading-tight">
        {t("agent.startRun")}
      </h2>
      <p className="text-muted mt-1.5 max-w-[60ch] text-[11.5px] leading-[1.55]">
        Kustos 通过工具读取仓库。写操作会在批准前暂停。
      </p>

      <form
        className="mt-5 flex max-w-[560px] flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!prompt.trim()) return;
          onSubmit({ prompt: prompt.trim(), model: "" });
        }}
      >
        <label className="block">
          <span className="text-bone-2 text-[11px] font-medium">仓库</span>
          <span className="border-edge-2 bg-ink-900/60 text-bone mt-1.5 flex h-8 w-full items-center rounded-md border px-2 text-[12px]">
            {repoName}
          </span>
        </label>

        <label className="block">
          <span className="text-bone-2 text-[11px] font-medium">提示词</span>
          <textarea
            required
            rows={4}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="要让 Kustos 调查什么？"
            className="border-edge-2 bg-ink-900 text-bone mt-1.5 block w-full rounded-md border px-2.5 py-2 text-[12px] leading-relaxed outline-none transition-colors placeholder:text-muted-2 focus:border-amber/45"
          />
          <span className="text-faint mt-1 block text-[10px]">
            越具体越好。Kustos 能搜索代码、读文件、看 diff，也能在批准后写文件。
          </span>
        </label>

        <div className="block">
          <span className="text-bone-2 text-[11px] font-medium">模型</span>
          {/* shortcut: 后端无面向用户的模型目录端点，只支持实例默认；有目录端点后再恢复选择器 */}
          <span className="border-edge-1 bg-ink-900 text-muted mt-1.5 flex h-8 items-center rounded-md border px-2.5 text-[12px]">
            实例默认（由实例的 Agent provider 配置决定）
          </span>
        </div>

        <label className="flex cursor-not-allowed items-start gap-2">
          <input type="checkbox" checked disabled className="accent-amber mt-0.5 size-[14px]" />
          <span className="text-bone-2 text-[12px] leading-[1.5]">
            允许写工具
            <span className="text-faint mt-0.5 block text-[10px]">
              写工具始终逐次审批，作业发起后不可更改。
            </span>
          </span>
        </label>

        <div className="mt-1 flex items-center gap-2">
          <button
            type="submit"
            className="bg-amber border-amber hover:bg-amber-2 hover:border-amber-2 inline-flex h-8 items-center gap-[7px] rounded-md border px-3 text-[12px] font-semibold text-ink-950 transition-colors"
          >
            <Play className="size-[14px]" aria-hidden="true" />
            {t("agent.startRun")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="border-edge-2 bg-ink-750/55 hover:border-edge-3 hover:bg-ink-750 text-bone-2 inline-flex h-8 items-center rounded-md border px-3 text-[12px] font-medium transition-colors"
          >
            取消
          </button>
        </div>
      </form>
    </div>
  );
}
