import { useQuery } from "@tanstack/react-query";

import { api } from "@kustos/api";

/**
 * Pull request 面的数据层。
 *
 * 只打真实接口，不做任何本地权限推断：哪些 PR 可见、能不能评审与合并，都由
 * 服务端裁决（`app/core/permissions.py` 是唯一裁决点）。列表接口已经按查看者
 * 过滤过了，桌面端不再筛一遍。
 *
 * 后端这几个端点在契约里没有精确的响应类型（`unknown`），因此按
 * `app/utils/response_builder.py` 的出参收敛；服务端改字段时以它为准。
 */

/**
 * 带 HTTP 状态码的请求错误。
 *
 * 抛**结构**而不是现成文案：数据层拿不到 i18n 上下文，写死中文会让英文界面里
 * 冒出中文。`operation` 与界面上的翻译键一一对应（`pulls.errors.<operation>`），
 * 状态码必须保留——"HTTP 403" 对排查很关键，而"加载失败"没有信息量。
 */
export class PullsRequestError extends Error {
  constructor(
    readonly operation: "list" | "detail" | "comments",
    readonly status: number,
  ) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "PullsRequestError";
  }
}

/** 分页接口的默认页大小，与后端列表接口的默认值一致。 */
export const DEFAULT_PAGE_SIZE = 20;

export const pullsKeys = {
  /** 某个仓库下的某一页 PR。筛选条件进 key：切换分段应该各自命中缓存。 */
  list: (repoId: string, query: PullRequestQueryKey) =>
    ["pulls", repoId, "list", query] as const,
  detail: (repoId: string, number: number) => ["pulls", repoId, "detail", number] as const,
  comments: (repoId: string, number: number) => ["pulls", repoId, "comments", number] as const,
};

/** 列表缓存键的可序列化形态（`null` 表示不筛该字段）。 */
export interface PullRequestQueryKey {
  status: string | null;
  author: string | null;
  page: number;
  limit: number;
}

/** 嵌套在 PR 里的用户摘要（`build_user_info`：id / username / full_name）。 */
export interface UserSummary {
  id: string;
  username: string;
  fullName: string | null;
}

/** 嵌套在 PR 里的标签（`build_label_response`）。 */
export interface LabelSummary {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

/** 一条 PR 评论（`build_pr_comment_response`）。行级评论带文件与行号。 */
export interface PullRequestComment {
  id: string;
  content: string;
  filePath: string | null;
  lineNumber: number | null;
  commitHash: string | null;
  parentId: string | null;
  author: UserSummary | null;
  createdAt: string | null;
}

/** 一条已提交的评审（`build_pr_review_response`）。 */
export interface PullRequestReview {
  id: string;
  /** approved / changes_requested，原样透传服务端取值。 */
  status: string;
  comment: string | null;
  reviewer: UserSummary | null;
  createdAt: string | null;
}

/** 一条评审请求（`build_pr_review_request_response`）。 */
export interface ReviewRequest {
  reviewer: UserSummary | null;
  /** pending / approved / changes_requested：由已提交的评审推导，不是存储值。 */
  state: string;
  comment: string | null;
  requestedAt: string | null;
  reviewedAt: string | null;
}

/** PR 关联的 Issue 摘要（`build_pr_linked_issue_response`）。 */
export interface LinkedIssueSummary {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string | null;
  /** 该 PR 合并时是否自动关闭这个 Issue。 */
  closesOnMerge: boolean;
  linkedAt: string | null;
}

/**
 * 一条 Pull Request（`build_pr_response` 的收敛结果）。
 *
 * 列表与详情共用一个形状：后端按 `include_details` / `include_reviewers` 决定
 * 附带哪些关联，因此不同端点上部分字段恒为空——
 *
 * - 列表带 `reviewers` / `reviewCount`，详情**不带**（详情用 `reviewRequests`
 *   表达"谁被请来评审、评了没有"）；
 * - 详情带 `comments` / `reviews` / `reviewRequests` / `linkedIssues`，列表不带。
 *
 * 统一成一份字段表而不是两个类型：界面共用同一套列表/详情骨架，两套类型只会
 * 让调用方在两处做字段翻译。
 */
export interface PullRequest {
  id: string;
  /** 仓库内编号（服务端 `pr_number`）。缺失时为 0，界面不可跳转。 */
  number: number;
  title: string;
  description: string | null;
  /** open / merged / closed，原样透传服务端取值。 */
  status: string;
  sourceBranch: string;
  targetBranch: string;
  repositoryId: string | null;
  /** 草稿不是独立状态：它是 open 段里的一个标记。 */
  isDraft: boolean;
  author: UserSummary | null;
  labels: LabelSummary[];
  reviewers: UserSummary[];
  reviewCount: number;
  reviewRequests: ReviewRequest[];
  linkedIssues: LinkedIssueSummary[];
  comments: PullRequestComment[];
  reviews: PullRequestReview[];
  mergedBy: UserSummary | null;
  mergedCommitHash: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 一页 PR（`build_pagination_response`）。 */
export interface PullRequestPage {
  items: PullRequest[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** 列表筛选条件。字段与端点 query 一一对应，缺省值即服务端默认值。 */
export interface PullRequestFilter {
  /** 分段筛选：只接受服务端认识的三个取值。 */
  status?: PullRequestStatus | null;
  /** 作者用户 ID。 */
  author?: string | null;
  page?: number;
  limit?: number;
}

/* ------------------------------------------------------------------ */
/* 响应收敛：snake_case → camelCase                                    */
/* ------------------------------------------------------------------ */

interface RawUser {
  id?: unknown;
  username?: unknown;
  full_name?: unknown;
}

interface RawLabel {
  id?: unknown;
  name?: unknown;
  color?: unknown;
  description?: unknown;
}

interface RawPrComment {
  id?: unknown;
  content?: unknown;
  file_path?: unknown;
  line_number?: unknown;
  commit_hash?: unknown;
  parent_id?: unknown;
  author?: unknown;
  created_at?: unknown;
}

interface RawPrReview {
  id?: unknown;
  status?: unknown;
  comment?: unknown;
  reviewer?: unknown;
  created_at?: unknown;
}

interface RawReviewRequest {
  reviewer?: unknown;
  state?: unknown;
  comment?: unknown;
  requested_at?: unknown;
  reviewed_at?: unknown;
}

interface RawLinkedIssue {
  id?: unknown;
  issue_number?: unknown;
  title?: unknown;
  status?: unknown;
  priority?: unknown;
  closes_on_merge?: unknown;
  linked_at?: unknown;
}

interface RawPullRequest {
  id?: unknown;
  pr_number?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  source_branch?: unknown;
  target_branch?: unknown;
  repository_id?: unknown;
  is_draft?: unknown;
  author?: unknown;
  labels?: unknown;
  reviewers?: unknown;
  review_count?: unknown;
  review_requests?: unknown;
  linked_issues?: unknown;
  comments?: unknown;
  reviews?: unknown;
  merged_by?: unknown;
  merged_commit_hash?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface RawPage {
  items?: unknown;
  total?: unknown;
  page?: unknown;
  limit?: unknown;
  pages?: unknown;
  has_next?: unknown;
  has_prev?: unknown;
}

/** 读字符串字段；类型不符时回落。 */
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** 读可空字符串字段。空串按"没有值"处理，避免界面渲染出一个空壳。 */
function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 读整数；接受数字形式的字符串（服务端偶有把计数序列化成字符串的历史）。 */
function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

/** 读布尔；非布尔一律按 fallback 处理，不做 truthy 猜测。 */
function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 读标识符。这个值可能被拼进 URL，不能出现 `undefined` 这种字符串。 */
function asId(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 数组字段；不是数组时按空列表处理。 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 服务端对象字段；不是对象（含 null 与数组）时按"没有"处理。 */
function asRecord<T>(value: unknown): T | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as T;
}

/**
 * 过滤出成形的对象条目。
 *
 * 用于"逐条收敛"的数组字段：一条既没有 id 也没有内容的记录在界面上渲染不出
 * 任何东西，留着只会占掉一行空白。
 */
function recordsOnly(value: unknown): unknown[] {
  return asArray(value).filter(
    (item) => typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

/**
 * 收敛用户摘要。
 *
 * id 与 username 同时缺失时返回 null：这种条目在界面上既显示不出名字也
 * 点不动，留着只会渲染成一行空白。
 */
export function toUserSummary(raw: unknown): UserSummary | null {
  const user = asRecord<RawUser>(raw);
  if (!user) return null;

  const id = asId(user.id);
  const username = asString(user.username);
  if (id === "" && username === "") return null;

  return { id, username, fullName: asNullableString(user.full_name) };
}

/** 收敛标签。id 与 name 同时缺失时丢弃该条。 */
export function toLabelSummary(raw: unknown): LabelSummary | null {
  const label = asRecord<RawLabel>(raw);
  if (!label) return null;

  const id = asId(label.id);
  const name = asString(label.name);
  if (id === "" && name === "") return null;

  return {
    id,
    name,
    color: asNullableString(label.color),
    description: asNullableString(label.description),
  };
}

/** 收敛一组标签，丢弃无法表达成标签的条目。 */
function toLabels(value: unknown): LabelSummary[] {
  return asArray(value)
    .map(toLabelSummary)
    .filter((label): label is LabelSummary => label !== null);
}

/** 收敛一组用户摘要，丢弃空条目。 */
function toUsers(value: unknown): UserSummary[] {
  return asArray(value)
    .map(toUserSummary)
    .filter((user): user is UserSummary => user !== null);
}

/** 读可空整数；非数字与 0 都按"没有值"处理（行号从 1 开始）。 */
function asNullableInt(value: unknown): number | null {
  const parsed = asInt(value, 0);
  return parsed > 0 ? parsed : null;
}

/** 收敛一条 PR 评论。 */
export function toPullRequestComment(raw: unknown): PullRequestComment {
  const comment = asRecord<RawPrComment>(raw) ?? {};
  return {
    id: asId(comment.id),
    content: asString(comment.content),
    filePath: asNullableString(comment.file_path),
    lineNumber: asNullableInt(comment.line_number),
    commitHash: asNullableString(comment.commit_hash),
    parentId: asNullableString(comment.parent_id),
    author: toUserSummary(comment.author),
    createdAt: asNullableString(comment.created_at),
  };
}

/** 收敛一条已提交的评审。 */
export function toPullRequestReview(raw: unknown): PullRequestReview {
  const review = asRecord<RawPrReview>(raw) ?? {};
  return {
    id: asId(review.id),
    status: asString(review.status),
    comment: asNullableString(review.comment),
    reviewer: toUserSummary(review.reviewer),
    createdAt: asNullableString(review.created_at),
  };
}

/**
 * 收敛一条评审请求。
 *
 * 条目不成形时返回 null 而不是占位对象：一条既没有评审人也没有状态的记录
 * 在界面上会渲染成一行空白，不如直接丢掉。
 */
export function toReviewRequest(raw: unknown): ReviewRequest | null {
  const request = asRecord<RawReviewRequest>(raw);
  if (!request) return null;
  return {
    reviewer: toUserSummary(request.reviewer),
    // 未提交时服务端明确给 "pending"；缺失按 pending 处理是安全的方向——
    // 它表示"还没有结论"，而不是"已通过"。
    state: asString(request.state, "pending"),
    comment: asNullableString(request.comment),
    requestedAt: asNullableString(request.requested_at),
    reviewedAt: asNullableString(request.reviewed_at),
  };
}

/** 收敛 PR 侧的一条关联 Issue 摘要。编号缺失或非正的条目丢弃。 */
export function toLinkedIssue(raw: unknown): LinkedIssueSummary | null {
  const link = asRecord<RawLinkedIssue>(raw);
  if (!link) return null;

  const number = asInt(link.issue_number, 0);
  if (number <= 0) return null;

  return {
    id: asId(link.id),
    number,
    title: asString(link.title),
    status: asString(link.status),
    priority: asNullableString(link.priority),
    // 关联边默认自动关闭：服务端建边时 `closes_on_merge` 默认为 true，
    // 字段缺失时按 true 处理才与"Fixes #N"的语义一致。
    closesOnMerge: asBoolean(link.closes_on_merge, true),
    linkedAt: asNullableString(link.linked_at),
  };
}

/**
 * 把服务端的 snake_case PR 响应收敛成前端结构。
 *
 * 缺失字段一律给安全默认值而不是抛错：列表里有一条脏数据不该让整页白屏，
 * 界面按"没有值"渲染即可。
 */
export function toPullRequest(raw: unknown): PullRequest {
  const pr = asRecord<RawPullRequest>(raw) ?? {};

  return {
    id: asId(pr.id),
    number: asInt(pr.pr_number, 0),
    title: asString(pr.title),
    description: asNullableString(pr.description),
    status: asString(pr.status),
    sourceBranch: asString(pr.source_branch),
    targetBranch: asString(pr.target_branch),
    repositoryId: asNullableString(pr.repository_id),
    isDraft: asBoolean(pr.is_draft, false),
    author: toUserSummary(pr.author),
    labels: toLabels(pr.labels),
    reviewers: toUsers(pr.reviewers),
    reviewCount: asInt(pr.review_count, 0),
    reviewRequests: recordsOnly(pr.review_requests)
      .map(toReviewRequest)
      .filter((request): request is ReviewRequest => request !== null),
    linkedIssues: recordsOnly(pr.linked_issues)
      .map(toLinkedIssue)
      .filter((link): link is LinkedIssueSummary => link !== null),
    comments: recordsOnly(pr.comments).map(toPullRequestComment),
    reviews: recordsOnly(pr.reviews).map(toPullRequestReview),
    mergedBy: toUserSummary(pr.merged_by),
    mergedCommitHash: asNullableString(pr.merged_commit_hash),
    createdAt: asNullableString(pr.created_at),
    updatedAt: asNullableString(pr.updated_at),
  };
}

/**
 * 收敛一页 PR。
 *
 * 分页字段缺失时用已拿到的条目数兜底：界面要显示计数，`total` 显示 0 而列表
 * 里有内容，比"不显示计数"更糟。
 */
export function toPullRequestPage(raw: unknown, page: number, limit: number): PullRequestPage {
  const payload = (raw ?? {}) as RawPage;
  const items = asArray(payload.items).map(toPullRequest);
  const total = asInt(payload.total, items.length);
  const currentPage = asInt(payload.page, page);
  const pageSize = asInt(payload.limit, limit);
  const pages = asInt(
    payload.pages,
    pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  );

  return {
    items,
    total,
    page: currentPage,
    limit: pageSize,
    pages,
    hasNext: asBoolean(payload.has_next, currentPage < pages),
    hasPrev: asBoolean(payload.has_prev, currentPage > 1),
  };
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/**
 * 某个仓库的 PR 列表。
 *
 * `repoId` 为空时不发请求：桌面端要先把本机工作副本对到服务端仓库
 * （见 `lib/repos.ts`），在那之前没有可用的 id。
 */
export function usePullRequests(repoId: string | null, filter: PullRequestFilter = {}) {
  const repo = repoId ?? "";
  const page = Math.max(1, asInt(filter.page, 1));
  const limit = Math.max(1, asInt(filter.limit, DEFAULT_PAGE_SIZE));
  const status = filter.status ?? null;
  const author = filter.author ?? null;

  return useQuery({
    queryKey: pullsKeys.list(repo, { status, author, page, limit }),
    enabled: repo !== "",
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        "/api/v1/repositories/{repo_id}/pull-requests",
        {
          params: {
            path: { repo_id: repo },
            query: {
              status: status ?? undefined,
              author: author ?? undefined,
              page,
              limit,
            },
          },
        },
      );
      if (error || !response.ok) {
        throw new PullsRequestError("list", response.status);
      }
      return toPullRequestPage(data, page, limit);
    },
    // 常驻应用：切 surface 不该重新拉。PR 状态由服务端推进（合并、关闭），
    // 留一分钟的窗口足够让界面跟上，又不至于每次切回都打一次网络。
    staleTime: 60_000,
    // 翻页时保留上一页内容，避免列表在中途塌成空白。
    placeholderData: (prev) => prev,
  });
}

/** 单个 PR 的详情（服务端已附带评论、评审与关联 Issue）。 */
export function usePullRequest(repoId: string | null, number: number | null) {
  const repo = repoId ?? "";
  const prNumber = number ?? 0;

  return useQuery({
    queryKey: pullsKeys.detail(repo, prNumber),
    enabled: repo !== "" && prNumber > 0,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}",
        { params: { path: { repo_id: repo, pr_number: prNumber } } },
      );
      if (error || !response.ok) {
        throw new PullsRequestError("detail", response.status);
      }
      return toPullRequest(data);
    },
    staleTime: 60_000,
  });
}

/** 某个 PR 的评论列表（评论面板单独刷新时用；详情接口已自带一份）。 */
export function usePullRequestComments(repoId: string | null, number: number | null) {
  const repo = repoId ?? "";
  const prNumber = number ?? 0;

  return useQuery({
    queryKey: pullsKeys.comments(repo, prNumber),
    enabled: repo !== "" && prNumber > 0,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/comments",
        { params: { path: { repo_id: repo, pr_number: prNumber } } },
      );
      if (error || !response.ok) {
        throw new PullsRequestError("comments", response.status);
      }
      // 这个端点返回数组；兼容包成 { items } 的形态，免得契约一变就白屏。
      const payload = data as { items?: unknown } | unknown[] | undefined;
      const rows = Array.isArray(payload)
        ? payload
        : asArray((payload as { items?: unknown } | undefined)?.items);
      return rows.map(toPullRequestComment);
    },
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ */
/* 分段                                                                */
/* ------------------------------------------------------------------ */

/** PR 列表的分段，取值与服务端 `status` 筛选一一对应。 */
export type PullRequestStatus = "open" | "merged" | "closed";

/** 同 `PullRequestStatus`，界面侧的可读别名。 */
export type PullRequestSegment = PullRequestStatus;

/**
 * 分段清单。
 *
 * 只存 id 与翻译键，不存字面量：语言切换时这些标签必须跟着变。
 * 草稿没有第四段——服务端把它表达为 `status=open` 加 `is_draft`，
 * 因此草稿留在 open 段，用标记区分。
 */
export const PULL_SEGMENTS: { id: PullRequestSegment; i18nKey: string }[] = [
  { id: "open", i18nKey: "pulls.segments.open" },
  { id: "merged", i18nKey: "pulls.segments.merged" },
  { id: "closed", i18nKey: "pulls.segments.closed" },
];

/**
 * 一条 PR 落在哪一段。
 *
 * 只有服务端明确给出 merged / closed 才移出待处理段：未知状态（服务端将来
 * 新增的状态）留在 open，宁可在默认段里显示，也不让数据从界面上消失。
 */
export function segmentOf(pr: PullRequest): PullRequestSegment {
  switch (pr.status.toLowerCase()) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      return "open";
  }
}

/** 取某一段的条目，保持服务端给的顺序（创建时间倒序）。 */
export function itemsInSegment(items: PullRequest[], segment: PullRequestSegment): PullRequest[] {
  return items.filter((pr) => segmentOf(pr) === segment);
}

/** 各段计数，供分段标签上的数字使用。 */
export function segmentCounts(items: PullRequest[]): Record<PullRequestSegment, number> {
  const counts: Record<PullRequestSegment, number> = { open: 0, merged: 0, closed: 0 };
  for (const pr of items) counts[segmentOf(pr)] += 1;
  return counts;
}
