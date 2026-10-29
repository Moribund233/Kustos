import { api } from "@/lib/api/client";

import type { AdminUser, AuditEntry, ConfigKey, ConfigSection, ConfigSource } from "@/features/admin/types";

/**
 * 管理控制台数据层：真实端点的取数与视图映射。
 *
 * openapi-fetch 的 schema 对部分响应只有骨架（process/requests/meta 为 unknown），
 * 这里按后端源码（backend/app/api/v1/app_controller.py 等）定义视图类型并断言。
 */

/** 带 HTTP 状态的请求异常：useApiQuery 依赖 error.status 识别 403（不重试、页面出受限提示）。 */
export class AdminApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

/** 从 FastAPI 错误体里取可读文案（{detail} 或 {message}）。 */
function extractDetail(body: unknown): string {
  if (typeof body === "string" && body) return body;
  if (body && typeof body === "object") {
    const record = body as { detail?: unknown; message?: unknown };
    if (typeof record.detail === "string" && record.detail) return record.detail;
    if (typeof record.message === "string" && record.message) return record.message;
  }
  return "请求失败";
}

/** openapi-fetch 不抛错：非 2xx 时包装成带 status 的异常；成功但空响应同样报错。 */
export function unwrap<T>(res: { data?: T; error?: unknown; response: Response }): T {
  if (res.error !== undefined && res.error !== null) {
    throw new AdminApiError(res.response.status, extractDetail(res.error));
  }
  if (res.data === undefined || res.data === null) {
    throw new AdminApiError(res.response.status, "空响应");
  }
  return res.data;
}

/* ------------------------------------------------------------------ */
/* 状态（GET /api/app/status）                                         */
/* ------------------------------------------------------------------ */

/** 进程信息（app_service._get_process_info，psutil 采样）。 */
export interface ProcessInfo {
  pid?: number;
  memory_mb?: number;
  cpu_percent?: number;
  threads?: number;
  connections?: number;
}

/** 请求统计（middleware/request_stats.get_stats，最近 window 分钟窗口）。 */
export interface RequestStats {
  total?: number;
  success?: number;
  failed?: number;
  avg_response_time_ms?: number;
  requests_per_minute?: number;
  window_minutes?: number;
}

/** 概览页视图模型：StatusResponse + 按源码断言的子结构。 */
export interface StatusView {
  status: string;
  debug_mode: boolean;
  uptime_formatted: string;
  version: string;
  server_time: string;
  process: ProcessInfo;
  requests: RequestStats;
  git_operations: { active_clones?: number; active_pushes?: number };
  schema_state: { applied?: string | null; head?: string | null };
}

export async function fetchStatus(): Promise<StatusView> {
  const body = unwrap(await api.GET("/api/app/status"));
  return {
    ...body,
    process: (body.process ?? {}) as ProcessInfo,
    requests: (body.requests ?? {}) as RequestStats,
    git_operations: (body.git_operations ?? {}) as StatusView["git_operations"],
    schema_state: (body.schema_state ?? {}) as StatusView["schema_state"],
  };
}

/* ------------------------------------------------------------------ */
/* 用户（GET /api/v1/users）                                           */
/* ------------------------------------------------------------------ */

/** 后端 user_to_dict 的字段子集（schema 对该端点返回 unknown）。 */
interface ApiUser {
  id: string;
  username: string;
  full_name?: string | null;
  email?: string | null;
  is_active?: boolean;
  is_admin?: boolean;
  created_at?: string | null;
}

const AVATAR_TONES: AdminUser["avatarTone"][] = ["amber", "sage", "sky", "rose", "slate"];

/** 用户名/全名 → 头像缩写（最多两段，每段取首字母）。 */
function initialsOf(user: ApiUser): string {
  const source = (user.full_name || user.username || "?").trim();
  const parts = source.split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export async function fetchUsers(): Promise<AdminUser[]> {
  const body = unwrap(await api.GET("/api/v1/users"));
  const users = body as ApiUser[];
  return users.map((user) => ({
    id: String(user.id),
    name: user.username,
    fullName: user.full_name ?? null,
    initials: initialsOf(user),
    email: user.email ?? "—",
    isAdmin: user.is_admin === true,
    isActive: user.is_active !== false,
    createdAt: user.created_at ?? null,
    // 头像色按 id 稳定散列，刷新不变、不需后端字段
    avatarTone: AVATAR_TONES[[...String(user.id)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_TONES.length]!,
  }));
}

/* ------------------------------------------------------------------ */
/* 配置（GET/POST /api/app/config、validate、reset）                   */
/* ------------------------------------------------------------------ */

/**
 * 镜像后端 `core/config_schema.py` 的 SECTION_META 标志位。
 *
 * shortcut: GET /api/app/config 不返回节元数据（writable/hot/restart_keys），
 * 这里手工镜像可写节的非默认标志；后端新增/调整节时需同步。
 */
const SECTION_FLAGS: Record<string, { writable?: boolean; hot?: boolean; restartKeys?: readonly string[]; protectedKeys?: readonly string[] }> = {
  server: { writable: true, restartKeys: ["host", "port", "log_level"], protectedKeys: ["reload"] },
  gunicorn: {
    writable: true,
    restartKeys: [
      "workers", "worker_class", "threads", "worker_connections", "backlog", "timeout",
      "graceful_timeout", "keepalive", "max_requests", "max_requests_jitter", "preload_app",
      "daemon", "access_log", "access_log_format", "capture_output", "enable_reuse_port",
    ],
  },
  cors: { writable: true, restartKeys: ["allow_origins", "allow_credentials", "allow_methods", "allow_headers", "max_age"] },
  storage: { writable: true, hot: true, restartKeys: ["repo_root", "upload_root"], protectedKeys: ["repo_root", "upload_root"] },
  database: {
    writable: true,
    restartKeys: [
      "pool_size", "max_overflow", "pool_timeout", "pool_recycle", "echo",
      "stress_pool_size", "stress_max_overflow", "stress_pool_timeout", "stress_pool_recycle", "stress_echo",
      "pg_ssl_mode", "pg_connect_timeout", "pg_application_name",
    ],
  },
  search: { writable: true, hot: true },
  agent: { hot: true },
  realtime: { hot: true },
  collab: { hot: true },
};

function asSource(value: unknown): ConfigSource {
  return value === "env" || value === "db" ? value : "default";
}

export async function fetchConfigSections(): Promise<ConfigSection[]> {
  const body = unwrap(await api.GET("/api/app/config"));
  const data = (body.data ?? {}) as Record<string, Record<string, unknown>>;
  const sources = ((body.meta as { sources?: Record<string, Record<string, string>> } | null)?.sources) ?? {};

  return Object.entries(data).map(([name, keys]) => {
    const flags = SECTION_FLAGS[name] ?? {};
    const restartKeys = flags.restartKeys ?? [];
    const protectedKeys = flags.protectedKeys ?? [];
    const rows: ConfigKey[] = Object.entries(keys).map(([key, raw]) => ({
      key,
      raw,
      value: raw === null || raw === undefined ? "—" : typeof raw === "string" ? raw : JSON.stringify(raw),
      source: asSource(sources[name]?.[key]),
      effect: restartKeys.includes(key) ? "restart" : "hot",
      // env 钉死、整节受保护、节内保护键、脱敏值（***）与复合值都不提供编辑入口
      locked:
        flags.writable !== true ||
        protectedKeys.includes(key) ||
        raw === "***" ||
        (raw !== null && typeof raw === "object"),
    }));
    return { name, writable: flags.writable === true, hot: flags.hot === true, keys: rows };
  });
}

/** 把输入框文本按原值类型还原（number/boolean 保持类型，其余保持字符串交后端校验）。 */
export function coerceConfigValue(raw: unknown, input: string): unknown {
  if (typeof raw === "number") {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : input;
  }
  if (typeof raw === "boolean") {
    if (input === "true") return true;
    if (input === "false") return false;
  }
  return input;
}

/* ------------------------------------------------------------------ */
/* 审计（GET /api/app/audit）                                          */
/* ------------------------------------------------------------------ */

/** 合并审计流的条目（http = audit.log JSON 行，activity = activities 表行）。 */
interface ApiAuditItem {
  source?: string;
  timestamp?: string | null;
  method?: string | null;
  path?: string | null;
  status_code?: number | null;
  client_ip?: string | null;
  username?: string | null;
  is_sensitive?: boolean;
  action?: string | null;
  details?: string | null;
  entity_type?: string | null;
  actor_id?: string | null;
  id?: string | null;
}

export interface AuditPageView {
  items: AuditEntry[];
  total: number;
  page: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
  truncated: boolean;
}

/** ISO 时间戳 → HH:mm:ss；解析失败回显原文。 */
function formatClock(timestamp: string | null | undefined): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function toAuditEntry(item: ApiAuditItem, index: number): AuditEntry {
  if (item.source === "activity") {
    return {
      id: String(item.id ?? index),
      at: formatClock(item.timestamp),
      actor: item.actor_id ? item.actor_id.slice(0, 8) : "—",
      method: "",
      path: item.action ?? "activity",
      status: 200,
      source: "activity",
      ip: "—",
      note: item.details || item.entity_type || undefined,
    };
  }
  return {
    id: `${item.timestamp ?? ""}-${index}`,
    at: formatClock(item.timestamp),
    actor: item.username ?? "匿名",
    method: item.method ?? "",
    path: item.path ?? "—",
    status: item.status_code ?? 0,
    source: "http",
    ip: item.client_ip ?? "—",
    sensitive: item.is_sensitive === true,
  };
}

export async function fetchAuditPage(page: number): Promise<AuditPageView> {
  const body = unwrap(await api.GET("/api/app/audit", { params: { query: { days: 7, page, limit: 20 } } }));
  return {
    items: body.items.map((item, index) => toAuditEntry(item as ApiAuditItem, index)),
    total: body.total,
    page: body.page,
    pages: body.pages,
    hasNext: body.has_next,
    hasPrev: body.has_prev,
    truncated: body.truncated,
  };
}

/* ------------------------------------------------------------------ */
/* 日志（GET /api/app/logs、/api/app/logs/content）                    */
/* ------------------------------------------------------------------ */

export interface LogFileView {
  name: string;
  sizeFormatted: string;
}

export async function fetchLogInfo(): Promise<LogFileView[]> {
  const body = unwrap(await api.GET("/api/app/logs"));
  return (body.today_files as { name?: string; size_formatted?: string }[] | undefined ?? [])
    .filter((file): file is { name: string; size_formatted?: string } => typeof file?.name === "string")
    .map((file) => ({ name: file.name, sizeFormatted: file.size_formatted ?? "" }));
}

export interface LogContentView {
  date: string;
  lines: number;
  totalLines: number;
  content: string;
  exists: boolean;
  truncated: boolean;
}

export async function fetchLogContent(params: { logName: string; level: string | null }): Promise<LogContentView> {
  const body = unwrap(
    await api.GET("/api/app/logs/content", {
      params: { query: { log_name: params.logName, lines: 200, level: params.level } },
    }),
  );
  return {
    date: body.date,
    lines: body.lines,
    totalLines: body.total_lines,
    content: body.content,
    exists: body.exists,
    truncated: body.truncated,
  };
}
