import type { AvatarTone } from "@/components/kit/kit";

/**
 * Issue 页视图类型。
 *
 * 页面数据全部来自 issue 接口（映射见 api.ts），这里只保留渲染层
 * 消费的视图类型，字段口径以后端实际返回为准。
 */

/** 人员：Issue 的作者、指派人与评论者的身份与头像色调。 */
export interface Person {
  name: string;
  initials: string;
  tone: AvatarTone;
  /** Agent 身份，头像走机器人样式。 */
  bot?: boolean;
}

/** 评论时间线条目。 */
export interface IssueComment {
  /** 后端评论 ID；接口返回的列表项有值。 */
  id?: string;
  author: Person;
  time: string;
  /** Markdown 原文。 */
  body: string;
}

/** 关联的 Pull Request。 */
export interface LinkedPr {
  number: number;
  title: string;
  status: string;
  closesOnMerge?: boolean;
}

/** 一条 Issue：列表行与详情区共用。 */
export interface Issue {
  /** Issue 编号（后端 issue_number），页面以 #编号 展示。 */
  id: number;
  title: string;
  status: "open" | "closed";
  priority: "critical" | "high" | "medium" | "low";
  labels: string[];
  author: Person;
  assignee: Person | null;
  opened: string;
  updated: string;
  /** 关闭者姓名，仅已关闭的 Issue 有值。 */
  closedBy?: string;
  /** 正文 Markdown 原文。 */
  body: string;
  /** 评论数；列表接口不返回评论，仅详情侧有值。 */
  commentCount?: number;
  linkedPrs?: LinkedPr[];
  comments: IssueComment[];
}
