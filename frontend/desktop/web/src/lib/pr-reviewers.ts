import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@kustos/api";

import {
  pullsKeys,
  toPullRequestComment,
  toPullRequestReview,
  toUserSummary,
  type PullRequestComment,
  type PullRequestReview,
  type ReviewRequest,
} from "./pulls";

/**
 * PR 评审面的数据层：谁被请来评审、评了什么、目标分支为什么还不能合并。
 *
 * 与 `pulls.ts` 的分工：那边负责 PR 本体、评论列表与详情，这里只补评审侧独有的
 * 三件事——评审人请求（`/reviewers`）、分支保护（`/protection`）、以及两个写
 * 动作（发评论、提交评审结论）。核心开关"能不能合并"仍由服务端裁决
 * （`pull_request_service.evaluate_merge_conditions`），这里读到的保护开关**只
 * 用来向用户解释原因**，不参与放行判断。
 *
 * 后端这几个端点在契约里没有精确的响应类型（`unknown`），因此按
 * `app/utils/response_builder.py` 的出参收敛；服务端改字段时以它为准。
 */

/** 评审人视角的一条 request。 */
export interface ReviewerEntry extends ReviewRequest {
  /** 该评审人是否已经表态，以及表了什么态。 */
  state: "pending" | "approved" | "changes_requested";
  /** 评审人留下的总结意见；pending 时为 null。 */
  comment: string | null;
  requestedAt: string | null;
  reviewedAt: string | null;
}

/** 分支保护开关；评审窗用它解释"为什么还不能合并"。 */
export interface BranchProtection {
  isProtected: boolean;
  requireCodeReview: boolean;
  requireStatusChecks: boolean;
}

/** 出错的动作，与界面上的翻译键一一对应（`prReview.errors.<operation>`）。 */
export type PRReviewOperation = "reviewers" | "protection" | "comment" | "review";

/**
 * 评审侧请求错误。
 *
 * 除状态码外还要带上服务端给的机器可读错误码：`pr_self_approve_forbidden`
 * 这种情形必须让界面提示"不能给自己点赞"，而不是一句笼统的"HTTP 400"——
 * 后者用户看完也不知道该换谁去点。
 */
export class PRReviewError extends Error {
  readonly operation: PRReviewOperation;
  readonly status: number;
  /** 服务端给的机器可读错误码，例如 "pr_self_approve_forbidden"。 */
  readonly code: string | null;

  constructor(operation: PRReviewOperation, status: number, code: string | null = null) {
    super(`${operation} failed with HTTP ${status}${code === null ? "" : ` (${code})`}`);
    this.name = "PRReviewError";
    this.operation = operation;
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* 响应收敛：snake_case → camelCase                                    */
/* ------------------------------------------------------------------ */

/**
 * 本文件里的三个读值助手与 `pulls.ts` 里的同名函数是重复实现。
 *
 * `pulls.ts` 只导出了收敛函数本体（`toUserSummary` / `toPullRequestComment` /
 * `toPullRequestReview` …），`asString` / `asRecord` 这类逐字段读值助手是私有的；
 * 按"不改动 `pulls.ts`"的约束，这里只能用最小的本地副本，而不是把私有函数
 * 提出来变成公共 API（那会让 `pulls.ts` 多出没人需要的导出面）。
 */
function asRecord<T>(value: unknown): T | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as T;
}

/** 读非空字符串；空串按"没有值"处理，避免界面渲染出一个空壳。 */
function asText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 读布尔；非布尔一律按 fallback 处理，不做 truthy 猜测。 */
function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

interface RawReviewerEntry {
  reviewer?: unknown;
  state?: unknown;
  comment?: unknown;
  requested_at?: unknown;
  reviewed_at?: unknown;
}

interface RawBranchProtection {
  is_protected?: unknown;
  require_code_review?: unknown;
  require_status_checks?: unknown;
}

/**
 * 读评审状态。
 *
 * 只有 `approved` / `changes_requested` 是"已表态"；其余一律归到 `pending`。
 * 服务端在撤回评审等路径上会给出 `dismissed`，而界面只认识"等 / 通过 / 要改"
 * 三态：把未知值当成"已通过"是最危险的方向（会让人以为可以合并了），当成
 * pending 只是提示还差一个结论，最坏结果是多点一次评审。
 */
function asReviewerState(value: unknown): ReviewerEntry["state"] {
  if (value === "approved") return "approved";
  if (value === "changes_requested") return "changes_requested";
  return "pending";
}

/**
 * 把服务端数组收敛成前端结构。
 *
 * 这个端点返回**裸数组**（不是 `{items: [...]}`），因此非数组一律当成空列表：
 * 契约漂移时宁可列表空着，也不要因为一次 `Object.keys` 猜测而白屏。
 * 丢弃没有评审人的条目——它在界面上既显示不出名字也点不动。
 */
export function toReviewerEntries(raw: unknown): ReviewerEntry[] {
  const rows = Array.isArray(raw) ? raw : [];
  const entries: ReviewerEntry[] = [];

  for (const row of rows) {
    const record = asRecord<RawReviewerEntry>(row);
    if (record === null) continue;

    const reviewer = toUserSummary(record.reviewer);
    if (reviewer === null) continue;

    entries.push({
      reviewer,
      state: asReviewerState(record.state),
      comment: asText(record.comment),
      requestedAt: asText(record.requested_at),
      reviewedAt: asText(record.reviewed_at),
    });
  }

  return entries;
}

/**
 * 收敛分支保护开关。
 *
 * 三个字段全缺时返回全 false：接口对"未保护分支"就是三个 false，而字段缺失
 * 只可能出现在契约漂移时。宁可显示"没有保护"也不要凭猜测加锁——服务端才是
 * 唯一裁决点，界面多显示的锁只会让人反复确认一个不存在的限制。
 */
export function toBranchProtection(raw: unknown): BranchProtection {
  const body = asRecord<RawBranchProtection>(raw);
  return {
    isProtected: asBoolean(body?.is_protected, false),
    requireCodeReview: asBoolean(body?.require_code_review, false),
    requireStatusChecks: asBoolean(body?.require_status_checks, false),
  };
}

/* ------------------------------------------------------------------ */
/* 缓存键                                                              */
/* ------------------------------------------------------------------ */

/**
 * 评审侧缓存键。
 *
 * 命名空间与 `pullsKeys` 分开（`pr-reviewers` / `branch-protection`）：分支保护
 * 不随 PR 变化，一个仓库的多个 PR 共享同一份；塞进 `pullsKeys.detail` 的子树
 * 会让每次评审都白丢一次保护查询。
 *
 * 参数都接受 null 并收敛成空串 / 0：hook 在拿到仓库 id 之前也要能构造出稳定
 * 的键，否则同一状态在两次渲染里算出不同的 key，缓存直接失效。
 */
export const prReviewKeys = {
  reviewers: (repoId: string | null, number: number | null): readonly unknown[] =>
    ["pr-reviewers", repoId ?? "", number ?? 0],
  protection: (repoId: string | null, branch: string | null): readonly unknown[] =>
    ["branch-protection", repoId ?? "", branch ?? ""],
};

/* ------------------------------------------------------------------ */
/* 错误收敛                                                            */
/* ------------------------------------------------------------------ */

interface RawErrorDetail {
  error_code?: unknown;
}

interface RawErrorEnvelope {
  error?: unknown;
}

/** 从 `{error: {error_code}}` 里取出机器可读错误码；取不到给 null。 */
function readErrorCode(body: unknown): string | null {
  const envelope = asRecord<RawErrorEnvelope>(body);
  if (envelope === null) return null;
  const detail = asRecord<RawErrorDetail>(envelope.error);
  if (detail === null) return null;
  return asText(detail.error_code);
}

/**
 * 把一次失败响应收敛成 `PRReviewError`。
 *
 * 优先读生成客户端已经解析好的 `error`：openapi-fetch 在响应体可解析时已经把
 * 它消费掉了，这时再 `response.json()` 只会抛"body already read"。
 * 客户端没给 `error` 时才自己读一次，且读取过程整体兜住——拿错误码失败不该
 * 把真正的 HTTP 状态码（403 / 400 才是排查线索）盖掉。
 */
async function toFailure(
  operation: PRReviewOperation,
  status: number,
  response: Response,
  error: unknown,
): Promise<PRReviewError> {
  let code = readErrorCode(error);

  if (code === null) {
    try {
      const body: unknown = await response.json().catch(() => null);
      code = readErrorCode(body);
    } catch {
      code = null;
    }
  }

  return new PRReviewError(operation, status, code);
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/** 某个 PR 被请求的评审人及其表态。`repoId` 为空或编号非正时不发请求。 */
export function usePullRequestReviewers(repoId: string | null, number: number | null) {
  const repo = repoId ?? "";
  const prNumber = number ?? 0;

  return useQuery({
    queryKey: prReviewKeys.reviewers(repo, prNumber),
    enabled: repo !== "" && prNumber > 0,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/reviewers",
        { params: { path: { repo_id: repo, pr_number: prNumber } } },
      );
      if (error || !response.ok) {
        throw await toFailure("reviewers", response.status, response, error);
      }
      return toReviewerEntries(data);
    },
    // 与 `pulls.ts` 同一口径：评审状态由服务端推进，一分钟的窗口足够让界面
    // 跟上，又不至于每次切回评审窗都打一次网络。
    staleTime: 60_000,
  });
}

/**
 * 目标分支的保护开关。
 *
 * 分支名可以带斜杠（`feature/x`），它必须作为**单个**路径段传输。编码这件事
 * 由生成客户端负责：`openapi-fetch` 的 `defaultPathSerializer` 对每个 path
 * 参数都做 `encodeURIComponent`（已对本仓库锁定的 0.13.8 核对过）。因此这里
 * **不能**再手动编一次——那会得到 `feature%252Fx`，服务端解码后拿到的是字面量
 * `feature%2Fx`，指向一个不存在的分支。
 *
 * 缓存时间取 5 分钟：保护开关由仓库管理员手动改，比 PR 状态稳定得多，
 * 而每次打开评审窗都会查它。
 */
export function useBranchProtection(repoId: string | null, branch: string | null) {
  const repo = repoId ?? "";
  const name = (branch ?? "").trim();

  return useQuery({
    queryKey: prReviewKeys.protection(repo, name),
    enabled: repo !== "" && name !== "",
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        "/api/v1/repositories/{repo_id}/branches/{branch_name}/protection",
        { params: { path: { repo_id: repo, branch_name: name } } },
      );
      if (error || !response.ok) {
        throw await toFailure("protection", response.status, response, error);
      }
      return toBranchProtection(data);
    },
    staleTime: 5 * 60_000,
  });
}

/* ------------------------------------------------------------------ */
/* 写操作                                                              */
/* ------------------------------------------------------------------ */

/** 发表一条评审意见的入参；行内评论带文件与行号，会话级评论两者都空着。 */
export interface PrCommentInput {
  content: string;
  /** 文件路径（仓库内相对路径）；行级评论必填，会话级评论为 null。 */
  filePath?: string | null;
  /** 行号（新文件侧）；行级评论必填。 */
  lineNumber?: number | null;
  commitHash?: string | null;
  /** 父评论 ID（回复某条评论时用）。 */
  parentId?: string | null;
}

/**
 * 发表一条评审意见（可以是行内，也可以是会话级）。
 *
 * 一次只收一条：服务端的评论端点没有批量形态，所以"写完一起提交"由调用方
 * 拆成多次调用，本地草稿见 `lib/pr-drafts.ts`。
 *
 * 成功后同时失效评论列表与详情：详情接口自带一份评论，只失效列表会让时间线
 * 停在旧内容上——用户以为自己刚发的意见丢了。
 */
export function useCreatePrComment(repoId: string | null, number: number | null) {
  const qc = useQueryClient();
  const repo = repoId ?? "";
  const prNumber = number ?? 0;

  return useMutation({
    mutationFn: async (vars: PrCommentInput): Promise<PullRequestComment> => {
      const { data, error, response } = await api.POST(
        "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/comments",
        {
          params: { path: { repo_id: repo, pr_number: prNumber } },
          // camelCase → snake_case 在发出请求这一层完成：调用方写前端形态的
          // 变量，契约形态是这一层的事，不该漏到界面代码里。
          body: {
            content: vars.content,
            file_path: vars.filePath ?? null,
            line_number: vars.lineNumber ?? null,
            commit_hash: vars.commitHash ?? null,
            parent_id: vars.parentId ?? null,
          },
        },
      );
      if (error || !response.ok) {
        throw await toFailure("comment", response.status, response, error);
      }
      return toPullRequestComment(data);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pullsKeys.comments(repo, prNumber) });
      void qc.invalidateQueries({ queryKey: pullsKeys.detail(repo, prNumber) });
    },
  });
}

/** 提交评审结论的入参。服务端只接受这两个取值，类型上就不留第三个口子。 */
export interface PrReviewInput {
  status: "approved" | "changes_requested";
  comment?: string | null;
}

/**
 * 提交评审结论。
 *
 * 批准自己的 PR 会被服务端以 HTTP 400 + `pr_self_approve_forbidden` 拒绝：
 * 这个拦截必须在服务端（客户端拦不住别的入口），界面拿到 `error.code` 后
 * 提示"不能批准自己发起的 PR"，不要退化成一句通用失败。
 *
 * 成功后详情、评审人列表都要失效：结论会改写 detail 里的 `reviews`，也会把
 * reviewers 里那一条从 pending 推进到 approved / changes_requested。
 */
/**
 * 提交一次评审（不经 React Query）。
 *
 * 给"通知里的批改按钮"这类**目标不固定**的路径用：那些调用拿到的 repoId 与
 * 编号来自通知的附加数据，不是某个已挂载组件当下的 props，套不进
 * `useCreatePrReview` 的固定参数形态。它只做请求本身，缓存失效由调用方决定。
 *
 * Args:
 *
 *	repoId:  仓库 id
 *	number:  PR 编号
 *	input:   评审内容
 *
 * Returns:
 *
 *	服务端返回的那条评审。
 *
 * Raises:
 *
 *	服务端拒绝时抛 `PRReviewError`：自己的 PR 会被 `pr_self_approve_forbidden`
 *	拒掉，调用方要能把它和"网络失败"分开。
 */
export async function submitPrReview(
  repoId: string,
  number: number,
  input: PrReviewInput,
): Promise<PullRequestReview> {
  const { data, error, response } = await api.POST(
    "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/reviews",
    {
      params: { path: { repo_id: repoId, pr_number: number } },
      body: { status: input.status, comment: input.comment ?? null },
    },
  );
  if (error || !response.ok) {
    throw await toFailure("review", response.status, response, error);
  }
  return toPullRequestReview(data);
}

export function useCreatePrReview(repoId: string | null, number: number | null) {  const qc = useQueryClient();
  const repo = repoId ?? "";
  const prNumber = number ?? 0;

  return useMutation({
    mutationFn: async (vars: PrReviewInput): Promise<PullRequestReview> => {
      const { data, error, response } = await api.POST(
        "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/reviews",
        {
          params: { path: { repo_id: repo, pr_number: prNumber } },
          body: { status: vars.status, comment: vars.comment ?? null },
        },
      );
      if (error || !response.ok) {
        throw await toFailure("review", response.status, response, error);
      }
      return toPullRequestReview(data);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pullsKeys.detail(repo, prNumber) });
      void qc.invalidateQueries({ queryKey: prReviewKeys.reviewers(repo, prNumber) });
      // 列表键是 `pullsKeys.list(repoId, query)`，需要完整的筛选对象（状态、作者、
      // 页码、页大小）才算得出来，而评审提交影响的只是"这一条 PR 的评审计数"，
      // 与筛选条件无关。因此按 `["pulls", repo]` 前缀失效：该仓库下所有页、
      // 所有筛选条件的列表缓存一起失效，代价是下次翻页多一次请求，换来计数
      // 一定不会停在旧值上。
      void qc.invalidateQueries({ queryKey: ["pulls", repo] });
    },
  });
}
