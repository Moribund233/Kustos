import { api } from "@/lib/api/client";
import type { AvatarTone } from "@/components/kit/kit";
import type { Issue, IssueComment, LinkedPr, Person } from "@/features/issue/types";

/**
 * Issue 特性与后端的对接层。
 *
 * schema.d.ts 对 Issue 相关响应未建模（unknown），这里按后端
 * issue_controller / issue_service 的实际返回定义本地视图类型并做映射，
 * 页面只消费 types.ts 里的视图类型。
 */

/** 后端用户摘要（response_builder.build_user_info）。 */
export interface ApiUser {
  id: string;
  username: string;
  full_name?: string | null;
}

/** 后端标签（response_builder.build_label_response）。 */
export interface ApiLabel {
  id: string;
  name: string;
  color?: string | null;
}

/** 后端 Issue（response_builder.build_issue_response）。 */
export interface ApiIssue {
  id: string;
  issue_number: number;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  created_at?: string | null;
  updated_at?: string | null;
  author?: ApiUser | null;
  assignee?: ApiUser | null;
  labels?: ApiLabel[];
  closed_by?: ApiUser | null;
  pull_requests?: {
    pr_number: number;
    title: string;
    status: string;
    closes_on_merge?: boolean;
  }[];
}

/** 后端评论（response_builder.build_issue_comment_response）。 */
export interface ApiComment {
  id: string;
  content: string;
  author?: ApiUser | null;
  created_at?: string | null;
}

/** 后端分页壳（response_builder.build_pagination_response）。 */
export interface IssueListResult {
  items: Issue[];
  total: number;
  page: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** 列表筛选条件，字段对齐 GET /issues 的 query 参数。 */
export interface IssueListFilters {
  status?: "open" | "closed";
  label?: string;
  assignee?: string;
  page?: number;
  limit?: number;
}

/** 无头像/无姓名用户在 UI 上的占位身份。 */
const UNKNOWN_PERSON: Person = { name: "未知用户", initials: "?", tone: "slate" };

/** 头像色调取值（与 kit 的 AvatarTone 同源）。 */
const AVATAR_TONES: AvatarTone[] = ["amber", "rose", "sky", "sage", "slate"];

/** 把非 2xx 响应转成带后端 detail 的异常，供查询错误态展示。 */
function fail(error: unknown): Error {
  const detail = (error as { detail?: string } | null | undefined)?.detail;
  return new Error(typeof detail === "string" ? detail : "请求失败，请稍后重试。");
}

/** ISO 时间转中文相对时间（列表行与时间线共用）。 */
export function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "";
  const diffMinutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const hours = Math.floor(diffMinutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 用户名转头像首字母：全名取两词首字母，否则取用户名前两位。 */
function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("");
  return (letters || name.slice(0, 2)).toUpperCase();
}

/** 按用户 ID 稳定散列到头像色调，保证同一用户各处颜色一致。 */
function toneOf(seed: string): AvatarTone {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length] ?? "slate";
}

/** 后端用户摘要 → 视图 Person；无姓名时回落到用户名。 */
export function toPerson(user?: ApiUser | null): Person | null {
  if (!user?.username) return null;
  const name = user.full_name?.trim() || user.username;
  return { name, initials: initialsOf(name), tone: toneOf(user.id || name) };
}

/** 后端 Issue → 视图 Issue。 */
export function toIssue(dto: ApiIssue): Issue {
  const priority = ["critical", "high", "medium", "low"].includes(dto.priority) ? dto.priority : "medium";
  return {
    id: dto.issue_number,
    title: dto.title,
    status: dto.status === "closed" ? "closed" : "open",
    priority: priority as Issue["priority"],
    labels: (dto.labels ?? []).map((label) => label.name),
    author: toPerson(dto.author) ?? UNKNOWN_PERSON,
    assignee: toPerson(dto.assignee),
    assigneeId: dto.assignee?.id ?? null,
    opened: relativeTime(dto.created_at),
    updated: relativeTime(dto.updated_at),
    closedBy: toPerson(dto.closed_by)?.name,
    body: dto.description ?? "",
    linkedPrs: (dto.pull_requests ?? []).map(
      (pr): LinkedPr => ({
        number: pr.pr_number,
        title: pr.title,
        status: pr.status,
        closesOnMerge: pr.closes_on_merge,
      }),
    ),
    comments: [],
  };
}

/** 后端评论 → 视图 IssueComment。 */
function toComment(dto: ApiComment): IssueComment {
  return {
    id: dto.id,
    author: toPerson(dto.author) ?? UNKNOWN_PERSON,
    time: relativeTime(dto.created_at),
    body: dto.content,
  };
}

/** 拉取 Issue 列表（分页）；字段对齐 GET /repositories/{repo_id}/issues。 */
export async function fetchIssues(repoId: string, filters: IssueListFilters): Promise<IssueListResult> {
  const res = await api.GET("/api/v1/repositories/{repo_id}/issues", {
    params: {
      path: { repo_id: repoId },
      query: {
        status: filters.status,
        label: filters.label,
        assignee: filters.assignee,
        page: filters.page,
        limit: filters.limit,
      },
    },
  });
  if (res.error) throw fail(res.error);
  // 分页壳字段按 response_builder.build_pagination_response 取值
  const payload = res.data as { items?: ApiIssue[]; total?: number; page?: number; pages?: number; has_next?: boolean; has_prev?: boolean } | null;
  return {
    items: (payload?.items ?? []).map(toIssue),
    total: payload?.total ?? 0,
    page: payload?.page ?? filters.page ?? 1,
    pages: payload?.pages ?? 0,
    hasNext: payload?.has_next ?? false,
    hasPrev: payload?.has_prev ?? false,
  };
}

/** 只取总数（limit=1），用于页头「打开/已关闭/指派给你」计数。 */
export async function fetchIssueTotal(repoId: string, filters: IssueListFilters): Promise<number> {
  return (await fetchIssues(repoId, { ...filters, limit: 1 })).total;
}

/**
 * 关键词/高级筛选。
 *
 * `GET /issues` 只有单值 query 参数，关键词检索在 `POST /issues/filter` 上
 * （`IssueFilterRequest.search` 匹配标题与描述）。两个端点返回同一个分页壳，
 * 因此页面可以按条件切换而不改渲染。
 */
export async function fetchFilteredIssues(
  repoId: string,
  filters: {
    search?: string;
    statuses?: string[];
    priority?: string;
    labelIds?: string[];
    assigneeId?: string;
    page?: number;
    limit?: number;
  },
): Promise<IssueListResult> {
  const keyword = filters.search?.trim();
  const res = await api.POST("/api/v1/repositories/{repo_id}/issues/filter", {
    params: {
      path: { repo_id: repoId },
      query: {
        page: filters.page ?? 1,
        per_page: filters.limit ?? 20,
      },
    },
    body: {
      search: keyword || null,
      statuses: filters.statuses?.length ? filters.statuses : null,
      priorities: filters.priority ? [filters.priority] : null,
      label_ids: filters.labelIds?.length ? filters.labelIds : null,
      assignee_ids: filters.assigneeId ? [filters.assigneeId] : null,
    },
  });
  if (res.error) throw fail(res.error);
  const payload = res.data as
    | { items?: ApiIssue[]; total?: number; page?: number; pages?: number; has_next?: boolean; has_prev?: boolean }
    | null;
  return {
    items: (payload?.items ?? []).map(toIssue),
    total: payload?.total ?? 0,
    page: payload?.page ?? filters.page ?? 1,
    pages: payload?.pages ?? 0,
    hasNext: payload?.has_next ?? false,
    hasPrev: payload?.has_prev ?? false,
  };
}

/** 拉取 Issue 详情。 */
export async function fetchIssueDetail(repoId: string, issueNumber: number): Promise<Issue> {
  const res = await api.GET("/api/v1/repositories/{repo_id}/issues/{issue_number}", {
    params: { path: { repo_id: repoId, issue_number: issueNumber } },
  });
  if (res.error) throw fail(res.error);
  return toIssue(res.data as ApiIssue);
}

/** 拉取 Issue 评论时间线（升序）。 */
export async function fetchIssueComments(repoId: string, issueNumber: number): Promise<IssueComment[]> {
  const res = await api.GET("/api/v1/repositories/{repo_id}/issues/{issue_number}/comments", {
    params: { path: { repo_id: repoId, issue_number: issueNumber } },
  });
  if (res.error) throw fail(res.error);
  return ((res.data as ApiComment[] | null) ?? []).map(toComment);
}

/** 拉取仓库标签（筛选胶囊与新建表单共用）。 */
export async function fetchIssueLabels(repoId: string): Promise<ApiLabel[]> {
  const res = await api.GET("/api/v1/repositories/{repo_id}/labels", {
    params: { path: { repo_id: repoId } },
  });
  if (res.error) throw fail(res.error);
  return (res.data as ApiLabel[] | null) ?? [];
}

/** 关闭 Issue，返回更新后的视图 Issue。 */
export async function closeIssue(repoId: string, issueNumber: number): Promise<Issue> {
  const res = await api.POST("/api/v1/repositories/{repo_id}/issues/{issue_number}/close", {
    params: { path: { repo_id: repoId, issue_number: issueNumber } },
  });
  if (res.error) throw fail(res.error);
  return toIssue(res.data as ApiIssue);
}

/** 重新打开 Issue，返回更新后的视图 Issue。 */
export async function reopenIssue(repoId: string, issueNumber: number): Promise<Issue> {
  const res = await api.POST("/api/v1/repositories/{repo_id}/issues/{issue_number}/reopen", {
    params: { path: { repo_id: repoId, issue_number: issueNumber } },
  });
  if (res.error) throw fail(res.error);
  return toIssue(res.data as ApiIssue);
}

/** 提交评论（正文为 Markdown 原文）。 */
export async function postIssueComment(repoId: string, issueNumber: number, content: string): Promise<IssueComment> {
  const res = await api.POST("/api/v1/repositories/{repo_id}/issues/{issue_number}/comments", {
    params: { path: { repo_id: repoId, issue_number: issueNumber } },
    body: { content },
  });
  if (res.error) throw fail(res.error);
  return toComment(res.data as ApiComment);
}

/** 新建 Issue；后端字段为 title/description/label_ids（优先级走默认 medium）。 */export async function createIssue(
  repoId: string,
  input: { title: string; description?: string; labelIds?: string[] },
): Promise<Issue> {
  const res = await api.POST("/api/v1/repositories/{repo_id}/issues", {
    params: { path: { repo_id: repoId } },
    body: {
      title: input.title,
      description: input.description || null,
      priority: "medium",
      label_ids: input.labelIds?.length ? input.labelIds : null,
    },
  });
  if (res.error) throw fail(res.error);
  return toIssue(res.data as ApiIssue);
}

/**
 * 更新 Issue（标题 / 描述 / 优先级 / 指派 / 标签）。
 *
 * 后端 `IssueUpdateRequest` 的字段都是可选，只传要改的键；传 null 表示清空
 * 指派人或标签。
 */
export async function updateIssue(
  repoId: string,
  issueNumber: number,
  patch: {
    title?: string;
    description?: string | null;
    priority?: string;
    assigneeId?: string | null;
    labelIds?: string[];
  },
): Promise<Issue> {
  const res = await api.PATCH("/api/v1/repositories/{repo_id}/issues/{issue_number}", {
    params: { path: { repo_id: repoId, issue_number: issueNumber } },
    body: {
      title: patch.title,
      description: patch.description,
      priority: patch.priority,
      assignee_id: patch.assigneeId ?? null,
      label_ids: patch.labelIds ?? null,
    },
  });
  if (res.error) throw fail(res.error);
  return toIssue(res.data as ApiIssue);
}

/** 仓库成员（指派候选）：后端返回 `{ user, role, is_active }` 形态。 */
export interface ApiRepoMember {
  user?: ApiUser | null;
  role?: string;
  is_active?: boolean;
}

/** 拉取仓库成员，供指派选择器使用。 */
export async function fetchRepoMembers(repoId: string): Promise<ApiRepoMember[]> {
  const res = await api.GET("/api/v1/repositories/{repo_id}/members", {
    params: { path: { repo_id: repoId } },
  });
  if (res.error) throw fail(res.error);
  return Array.isArray(res.data) ? (res.data as ApiRepoMember[]) : [];
}
