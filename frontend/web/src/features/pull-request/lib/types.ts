import type { AvatarTone } from "@/components/kit/kit";

/**
 * Pull Request 接口的本地视图类型。
 *
 * 后端 schema.d.ts 里这些响应都是 `unknown`，这里按 service/response_builder
 * 的实际出参建模，字段名与后端保持一致。
 */

/** 嵌套的用户摘要（build_user_info：id / username / full_name）。 */
export interface PrUser {
  id: string;
  username: string;
  full_name?: string | null;
}

/** PR 列表项（build_pr_response，页头跳转只需要编号）。 */
export interface PrListItem {
  pr_number: number;
  title: string;
  status: string;
}

/** PR 列表（build_pagination_response）。 */
export interface PrListResponse {
  items?: PrListItem[];
  total?: number;
}

/** PR 评论（build_pr_comment_response）。 */
export interface PrComment {
  id: string;
  content: string;
  author: PrUser | null;
  created_at: string;
  file_path?: string | null;
  line_number?: number | null;
}

/** PR 评审（build_pr_review_response，status 为 approved / changes_requested）。 */
export interface PrReview {
  id: string;
  status: string;
  comment?: string | null;
  reviewer: PrUser | null;
  created_at: string;
}

/** PR 详情（GET /pull-requests/{pr_number}，include_details 附带评论与评审）。 */
export interface PrDetail {
  id: string;
  pr_number: number;
  title: string;
  description?: string | null;
  source_branch: string;
  target_branch: string;
  status: string;
  is_draft?: boolean;
  author: PrUser | null;
  created_at: string;
  updated_at?: string | null;
  merged_by?: PrUser | null;
  merged_commit_hash?: string | null;
  comments?: PrComment[];
  reviews?: PrReview[];
}

/** diff 端点的文件条目（get_pr_files：状态 + 路径，无行数据）。 */
export interface PrDiffFile {
  status: string;
  path: string;
  old_path: string | null;
  status_code: string;
}

/** diff 端点统计（get_pr_stats）。 */
export interface PrDiffStats {
  files_changed: number;
  additions: number;
  deletions: number;
  total_changes: number;
}

/** PR diff 响应（GET /diff：统一 diff 文本 + 文件列表 + 统计）。 */
export interface PrDiffResponse {
  diff?: string | null;
  files?: PrDiffFile[];
  stats?: PrDiffStats;
}

/** 评审请求（GET /reviewers，state 由已提交评审推导：pending/approved/changes_requested）。 */
export interface PrReviewerRequest {
  reviewer: PrUser | null;
  state: string;
  comment?: string | null;
  requested_at?: string | null;
  reviewed_at?: string | null;
}

/** 面板里的一行评审人：评审请求与已提交评审合并后的结果。 */
export interface ReviewerRow {
  user: PrUser;
  state: string;
}

/** 关联 Issue（GET /issues，build_pr_linked_issue_response）。 */
export interface PrLinkedIssue {
  id: string;
  issue_number: number;
  title: string;
  status: string;
  priority?: string | null;
  closes_on_merge: boolean;
  linked_at?: string | null;
}

/** 分支条目（GET /branches 的列表项，只取目标分支那行做合并条件）。 */
export interface BranchRow {
  name: string;
  is_protected: boolean;
  require_code_review: boolean;
  require_status_checks: boolean;
}

/** 仓库成员（GET /members 的列表项，评审邀请用）。 */
export interface RepoMember {
  user_id: string;
  is_active: boolean;
  role?: string | null;
  user: PrUser | null;
}

/** 合并条件列表的一行。 */
export interface MergeCond {
  done: boolean;
  label: string;
}

/** 时间线条目：由详情接口的 reviews 与 comments 合成，按 `at` 排序。 */
export interface PrTimelineItem {
  /** 合成 id：`review-<id>` / `comment-<id>`。 */
  id: string;
  initials: string;
  tone: AvatarTone;
  name: string;
  /** 动作短语，如「评论了该 PR」。 */
  action: string;
  badge?: string;
  /** Markdown 正文；评审无评论时不渲染引用块。 */
  body?: string;
  at: string;
}
