import { useQuery } from "@tanstack/react-query";

import { api } from "@kustos/api";

/**
 * Issue 面的数据层。
 *
 * 只打真实接口，不做任何本地权限推断：哪些 Issue 可见、能不能创建与关闭，都由
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
 * 冒出中文。`operation` 与界面上的翻译键一一对应（`issues.errors.<operation>`），
 * 状态码必须保留——"HTTP 403" 对排查很关键，而"加载失败"没有信息量。
 */
export class IssuesRequestError extends Error {
  constructor(
    readonly operation: "list" | "detail" | "comments",
    readonly status: number,
  ) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "IssuesRequestError";
  }
}

/** 分页接口的默认页大小，与后端列表接口的默认值一致。 */
export const DEFAULT_PAGE_SIZE = 20;

export const issuesKeys = {
  /** 某个仓库下的某一页 Issue。筛选条件进 key：切换分段应该各自命中缓存。 */
  list: (repoId: string, query: IssueQueryKey) => ["issues", repoId, "list", query] as const,
  detail: (repoId: string, number: number) => ["issues", repoId, "detail", number] as const,
  comments: (repoId: string, number: number) => ["issues", repoId, "comments", number] as const,
};

/** 列表缓存键的可序列化形态（`null` 表示不筛该字段）。 */
export interface IssueQueryKey {
  status: string | null;
  label: string | null;
  assignee: string | null;
  author: string | null;
  page: number;
  limit: number;
}

/** 嵌套在 Issue 里的用户摘要（`build_user_info`：id / username / full_name）。 */
export interface UserSummary {
  id: string;
  username: string;
  fullName: string | null;
}

/** 嵌套在 Issue 里的标签（`build_label_response`）。 */
export interface LabelSummary {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

/** 一条 Issue 评论（`build_issue_comment_response`）。 */
export interface IssueComment {
  id: string;
  content: string;
  author: UserSummary | null;
  createdAt: string | null;
}

/** Issue 侧关联的 PR 摘要（`build_issue_pull_request_response`）。 */
export interface LinkedPullRequestSummary {
  id: string;
  number: number;
  title: string;
  status: string;
  sourceBranch: string;
  targetBranch: string;
  /** 该 PR 合并时是否自动关闭本 Issue。 */
  closesOnMerge: boolean;
  linkedAt: string | null;
}

/**
 * 一条 Issue（`build_issue_response` 的收敛结果）。
 *
 * 列表与详情共用一个形状：详情接口额外附带 `comments`、`closedBy` 与
 * `linkedPullRequests`，列表里这些字段为空数组 / null。
 */
export interface Issue {
  id: string;
  /** 仓库内编号（服务端 `issue_number`）。缺失时为 0，界面不可跳转。 */
  number: number;
  title: string;
  description: string | null;
  /** open / closed，原样透传服务端取值。 */
  status: string;
  /** low / medium / high / critical，原样透传服务端取值。 */
  priority: string;
  repositoryId: string | null;
  author: UserSummary | null;
  assignee: UserSummary | null;
  labels: LabelSummary[];
  comments: IssueComment[];
  linkedPullRequests: LinkedPullRequestSummary[];
  /** 仅已关闭的 Issue 有值（服务端只在 `status == "closed"` 时输出）。 */
  closedBy: UserSummary | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 一页 Issue（`build_pagination_response`）。 */
export interface IssuePage {
  items: Issue[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** 列表筛选条件。字段与端点 query 一一对应，缺省值即服务端默认值。 */
export interface IssueFilter {
  /** 分段筛选：只接受服务端认识的取值。 */
  status?: IssueStatus | null;
  /** 标签**名称**（服务端按名称匹配，不是标签 ID）。 */
  label?: string | null;
  /** 指派人用户 ID。 */
  assignee?: string | null;
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

interface RawIssueComment {
  id?: unknown;
  content?: unknown;
  author?: unknown;
  created_at?: unknown;
}

interface RawLinkedPr {
  id?: unknown;
  pr_number?: unknown;
  title?: unknown;
  status?: unknown;
  source_branch?: unknown;
  target_branch?: unknown;
  closes_on_merge?: unknown;
  linked_at?: unknown;
}

interface RawIssue {
  id?: unknown;
  issue_number?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  repository_id?: unknown;
  author?: unknown;
  assignee?: unknown;
  labels?: unknown;
  comments?: unknown;
  pull_requests?: unknown;
  closed_by?: unknown;
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

/** 收敛一条 Issue 评论。 */
export function toIssueComment(raw: unknown): IssueComment {
  const comment = asRecord<RawIssueComment>(raw) ?? {};
  return {
    id: asId(comment.id),
    content: asString(comment.content),
    author: toUserSummary(comment.author),
    createdAt: asNullableString(comment.created_at),
  };
}

/** 收敛 Issue 侧的一条关联 PR 摘要。编号缺失或非正的条目丢弃。 */
export function toLinkedPullRequest(raw: unknown): LinkedPullRequestSummary | null {
  const link = asRecord<RawLinkedPr>(raw);
  if (!link) return null;

  const number = asInt(link.pr_number, 0);
  if (number <= 0) return null;

  return {
    id: asId(link.id),
    number,
    title: asString(link.title),
    status: asString(link.status),
    sourceBranch: asString(link.source_branch),
    targetBranch: asString(link.target_branch),
    // 关联边默认自动关闭：服务端建边时 `closes_on_merge` 默认为 true，
    // 字段缺失时按 true 处理才与"Fixes #N"的语义一致。
    closesOnMerge: asBoolean(link.closes_on_merge, true),
    linkedAt: asNullableString(link.linked_at),
  };
}

/**
 * 把服务端的 snake_case Issue 响应收敛成前端结构。
 *
 * 缺失字段一律给安全默认值而不是抛错：列表里有一条脏数据不该让整页白屏，
 * 界面按"没有值"渲染即可。`priority` 缺失时给 medium——它既是服务端建 Issue
 * 时的默认值，也是界面上最不误导的一档。
 */
export function toIssue(raw: unknown): Issue {
  const issue = asRecord<RawIssue>(raw) ?? {};

  return {
    id: asId(issue.id),
    number: asInt(issue.issue_number, 0),
    title: asString(issue.title),
    description: asNullableString(issue.description),
    status: asString(issue.status),
    priority: asString(issue.priority, "medium"),
    repositoryId: asNullableString(issue.repository_id),
    author: toUserSummary(issue.author),
    assignee: toUserSummary(issue.assignee),
    labels: toLabels(issue.labels),
    comments: recordsOnly(issue.comments).map(toIssueComment),
    linkedPullRequests: asArray(issue.pull_requests)
      .map(toLinkedPullRequest)
      .filter((link): link is LinkedPullRequestSummary => link !== null),
    closedBy: toUserSummary(issue.closed_by),
    createdAt: asNullableString(issue.created_at),
    updatedAt: asNullableString(issue.updated_at),
  };
}

/**
 * 收敛一页 Issue。
 *
 * 分页字段缺失时用已拿到的条目数兜底：界面要显示计数，`total` 显示 0 而列表
 * 里有内容，比"不显示计数"更糟。
 */
export function toIssuePage(raw: unknown, page: number, limit: number): IssuePage {
  const payload = asRecord<RawPage>(raw) ?? {};
  const items = asArray(payload.items).map(toIssue);
  const total = asInt(payload.total, items.length);
  const currentPage = asInt(payload.page, page);
  const pageSize = asInt(payload.limit, limit);
  const pages = asInt(payload.pages, pageSize > 0 ? Math.ceil(total / pageSize) : 0);

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
 * 某个仓库的 Issue 列表。
 *
 * `repoId` 为空时不发请求：桌面端要先把本机工作副本对到服务端仓库
 * （见 `lib/repos.ts`），在那之前没有可用的 id。
 */
export function useIssues(repoId: string | null, filter: IssueFilter = {}) {
  const repo = repoId ?? "";
  const page = Math.max(1, asInt(filter.page, 1));
  const limit = Math.max(1, asInt(filter.limit, DEFAULT_PAGE_SIZE));
  const status = filter.status ?? null;
  const label = filter.label ?? null;
  const assignee = filter.assignee ?? null;
  const author = filter.author ?? null;

  return useQuery({
    queryKey: issuesKeys.list(repo, { status, label, assignee, author, page, limit }),
    enabled: repo !== "",
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        "/api/v1/repositories/{repo_id}/issues",
        {
          params: {
            path: { repo_id: repo },
            query: {
              status: status ?? undefined,
              label: label ?? undefined,
              assignee: assignee ?? undefined,
              author: author ?? undefined,
              page,
              limit,
            },
          },
        },
      );
      if (error || !response.ok) {
        throw new IssuesRequestError("list", response.status);
      }
      return toIssuePage(data, page, limit);
    },
    // 常驻应用：切 surface 不该重新拉。Issue 状态由服务端推进（关闭、重开），
    // 留一分钟的窗口足够让界面跟上，又不至于每次切回都打一次网络。
    staleTime: 60_000,
    // 翻页时保留上一页内容，避免列表在中途塌成空白。
    placeholderData: (prev) => prev,
  });
}

/** 单个 Issue 的详情（服务端已附带评论、关闭者与关联 PR）。 */
export function useIssue(repoId: string | null, number: number | null) {
  const repo = repoId ?? "";
  const issueNumber = number ?? 0;

  return useQuery({
    queryKey: issuesKeys.detail(repo, issueNumber),
    enabled: repo !== "" && issueNumber > 0,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        "/api/v1/repositories/{repo_id}/issues/{issue_number}",
        { params: { path: { repo_id: repo, issue_number: issueNumber } } },
      );
      if (error || !response.ok) {
        throw new IssuesRequestError("detail", response.status);
      }
      return toIssue(data);
    },
    staleTime: 60_000,
  });
}

/** 某个 Issue 的评论列表（评论面板单独刷新时用；详情接口已自带一份）。 */
export function useIssueComments(repoId: string | null, number: number | null) {
  const repo = repoId ?? "";
  const issueNumber = number ?? 0;

  return useQuery({
    queryKey: issuesKeys.comments(repo, issueNumber),
    enabled: repo !== "" && issueNumber > 0,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        "/api/v1/repositories/{repo_id}/issues/{issue_number}/comments",
        { params: { path: { repo_id: repo, issue_number: issueNumber } } },
      );
      if (error || !response.ok) {
        throw new IssuesRequestError("comments", response.status);
      }
      // 这个端点返回数组；兼容包成 { items } 的形态，免得契约一变就白屏。
      const payload = data as { items?: unknown } | unknown[] | undefined;
      const rows = Array.isArray(payload)
        ? payload
        : asArray((payload as { items?: unknown } | undefined)?.items);
      return rows.map(toIssueComment);
    },
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ */
/* 分段                                                                */
/* ------------------------------------------------------------------ */

/** Issue 列表的分段，取值与服务端 `status` 筛选一一对应。 */
export type IssueStatus = "open" | "closed";

/** 同 `IssueStatus`，界面侧的可读别名。 */
export type IssueSegment = IssueStatus;

/**
 * 分段清单。
 *
 * 只存 id 与翻译键，不存字面量：语言切换时这些标签必须跟着变。
 */
export const ISSUE_SEGMENTS: { id: IssueSegment; i18nKey: string }[] = [
  { id: "open", i18nKey: "issues.segments.open" },
  { id: "closed", i18nKey: "issues.segments.closed" },
];

/**
 * 一条 Issue 落在哪一段。
 *
 * 只有服务端明确给出 closed 才移出待处理段：未知状态（服务端将来新增的状态）
 * 留在 open，宁可在默认段里显示，也不让数据从界面上消失。
 */
export function segmentOf(issue: Issue): IssueSegment {
  return issue.status.toLowerCase() === "closed" ? "closed" : "open";
}

/** 取某一段的条目，保持服务端给的顺序（创建时间倒序）。 */
export function itemsInSegment(items: Issue[], segment: IssueSegment): Issue[] {
  return items.filter((issue) => segmentOf(issue) === segment);
}

/** 各段计数，供分段标签上的数字使用。 */
export function segmentCounts(items: Issue[]): Record<IssueSegment, number> {
  const counts: Record<IssueSegment, number> = { open: 0, closed: 0 };
  for (const issue of items) counts[segmentOf(issue)] += 1;
  return counts;
}
