import type { AvatarTone, Tone } from "@/components/kit/kit";

/**
 * 管理控制台视图模型。
 *
 * 演示数据常量已移除（页面改接 /api/app/* 真实端点）；这里只保留页面
 * 与 features/admin/api.ts 共用的视图类型，字段口径以后端实际返回为准。
 */

export interface AdminKpi {
  label: string;
  value: string;
  unit?: string;
  meta: string;
  tone: Tone;
}

/** 编排组件（容器）的视图状态：由 ComponentInfo 映射，uptime 已格式化。 */
export interface ComponentState {
  service: string;
  label: string;
  image: string;
  running: boolean;
  health: string | null;
  /** Docker 状态原文（running/exited…），健康未知时兜底展示。 */
  state: string;
  uptime: string | null;
  restarts: number;
  exitCode: number | null;
}

/** 实例账号与全局角色（仓库级角色在各仓库管理，不在此表）。 */
export interface AdminUser {
  id: string;
  name: string;
  fullName: string | null;
  initials: string;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string | null;
  avatarTone: AvatarTone;
}

export type ConfigSource = "env" | "db" | "default";

export interface ConfigKey {
  key: string;
  /** 后端原始值（用于类型还原与变更比对）。 */
  raw: unknown;
  value: string;
  source: ConfigSource;
  effect: "hot" | "restart";
  /** 受保护的键：整节不可写、节内保护键、脱敏值或复合值，不提供编辑入口。 */
  locked: boolean;
}

export interface ConfigSection {
  name: string;
  writable: boolean;
  /** 整节是否热重载（写入即生效）。 */
  hot: boolean;
  keys: ConfigKey[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  /** activity 来源的事件没有 HTTP 方法，渲染为 —。 */
  method: string;
  path: string;
  status: number;
  source: "http" | "activity";
  ip: string;
  sensitive?: boolean;
  note?: string;
}
