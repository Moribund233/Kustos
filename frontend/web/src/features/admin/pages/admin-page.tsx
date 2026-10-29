import { Activity, Lock, RefreshCw, XCircle } from "lucide-react";
import { Link, Navigate } from "react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FactList, Lamp, SectionHead, StatusPill, ToneAvatar, type Tone } from "@/components/kit/kit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CapabilitiesPanel } from "@/features/admin/components/capabilities-panel";
import { CreateUserDialog, UserRowActions } from "@/features/admin/components/user-admin";
import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import {
  AdminApiError,
  coerceConfigValue,
  fetchAuditPage,
  fetchConfigSections,
  fetchLogContent,
  fetchLogInfo,
  fetchStatus,
  fetchUsers,
  unwrap,
  type AuditPageView,
  type LogContentView,
  type LogFileView,
  type StatusView,
} from "@/features/admin/api";
import type {
  AdminKpi,
  AdminUser,
  AuditEntry,
  ComponentState,
  ConfigSection,
} from "@/features/admin/types";
import { useAuthStore } from "@/stores/auth-store";
import { useUiStore } from "@/stores/ui-store";
import { cn } from "@/lib/utils";
import type { components } from "@/api/schema";

type ComponentsResponse = components["schemas"]["ComponentsResponse"];
type ComponentInfo = components["schemas"]["ComponentInfo"];
type MonitoringResponse = components["schemas"]["MonitoringResponse"];

/** 行内 code 样式：原型 admin-gate / sec-lede 内的等宽代码片段。 */
const CODE_CLS = "rounded bg-bone/[0.055] px-1 font-mono text-[0.94em] text-bone-2";

const TAG_TONE: Record<Tone, string> = {
  neutral: "border-edge-2 text-muted-2",
  good: "border-sage/25 bg-sage/10 text-sage-2",
  warn: "border-amber/30 bg-amber/10 text-amber-2",
  bad: "border-rose/30 bg-rose/10 text-rose-2",
  info: "border-sky/25 bg-sky/10 text-sky",
};

/** 日志级别选项（values 与后端 logs/content 的 level 参数一致）。 */
const LOG_LEVELS = [
  { value: "", label: "全部级别" },
  { value: "debug", label: "debug" },
  { value: "info", label: "info" },
  { value: "warning", label: "warning" },
  { value: "error", label: "error" },
] as const;

/** 组件分组顺序（按职责）；后端 components 不带分组，按服务名就近归类。 */
const COMPONENT_GROUPS = ["核心服务", "网关", "数据", "可选组件"] as const;

function groupFor(service: string): string {
  if (service === "gateway") return "网关";
  if (service === "postgres" || service === "redis") return "数据";
  if (service === "prometheus" || service === "grafana") return "可选组件";
  return "核心服务";
}

/** 秒 → 人读时长。 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分`;
  return `${seconds}秒`;
}

/** 后端 ComponentInfo → 页面视图状态。 */
function toComponentState(info: ComponentInfo): ComponentState {
  return {
    service: info.service,
    label: info.label ?? info.service,
    image: info.image ?? "—",
    running: info.running,
    health: info.health ?? null,
    state: info.status_text ?? info.state,
    uptime: info.uptime_seconds != null ? formatUptime(info.uptime_seconds) : null,
    restarts: info.restart_count ?? 0,
    exitCode: info.exit_code ?? null,
  };
}

/** 数值 → zh-CN 千分位（最多两位小数）；空/非法值显示 0。 */
function fmtNum(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value ?? 0);
  return (Number.isFinite(num) ? num : 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

/** ISO 日期 → 本地日期；解析失败回显原文。 */
function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("zh-CN");
}

/** 微型描边徽标：表格与事实流内的状态标记。 */
function Tag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex h-[17px] items-center whitespace-nowrap rounded-full border px-[7px] text-[10px]", TAG_TONE[tone])}>
      {children}
    </span>
  );
}

/** 查询失败的行内提示：403 走页面级受限块，其余错误就地展示并可重试。 */
function LoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <p className="text-rose flex items-center gap-2 text-[11px]">
      加载失败：{error.message}
      <Button variant="ghost" size="sm" type="button" onClick={onRetry}>
        重试
      </Button>
    </p>
  );
}

/** 组件健康 → 状态灯色：未运行时按退出码区分「正常结束」与「异常」。 */
function lampFor(component: ComponentState): Tone {
  if (!component.running) return component.exitCode === 0 ? "neutral" : "bad";
  if (component.health === "unhealthy") return "bad";
  if (component.health === "starting") return "warn";
  return "good";
}

/** 组件状态文案：运行中按健康度区分，停止时展示退出码。 */
function stateOf(component: ComponentState): { tone: Tone; text: string } {
  if (!component.running) {
    return {
      tone: component.exitCode === 0 ? "neutral" : "bad",
      text: component.exitCode === null ? "已停止" : `已退出 (${component.exitCode})`,
    };
  }
  if (component.health === "starting") return { tone: "warn", text: "启动中" };
  if (component.health === "unhealthy") return { tone: "bad", text: "异常" };
  return { tone: "good", text: "正常" };
}

/** 配置值来源徽标文案（与 i18n admin.source* 键同源）。 */
function sourceTagText(source: "env" | "db" | "default", t: (key: string) => string): { tone: Tone; text: string } {
  if (source === "env") return { tone: "info", text: t("admin.sourceEnv") };
  if (source === "db") return { tone: "warn", text: t("admin.sourceDb") };
  return { tone: "neutral", text: t("admin.sourceDefault") };
}

/** 审计状态码 → 徽标色：403/409 记为警告而非错误（被门禁拦下是预期行为）。 */
function statusTone(status: number): Tone {
  if (status < 400) return "good";
  if (status === 403 || status === 409) return "warn";
  return "bad";
}

/**
 * 管理控制台页。
 *
 * 实例运行时、访问控制、动态配置与审计的管理员专属面，数据全部来自
 * /api/app/* 与 /api/v1/users 真实端点；分区用 Tabs 组织，危险操作
 * （重启/关机/配置重置）走确认对话框后调用真实接口。
 */
/**
 * 管理控制台入口。
 *
 * 非全局管理员直接回退到值守页（不渲染任何管理界面）；真正的管理台
 * 组件只在确认 `is_admin` 后挂载，避免先请求一批注定 403 的管理端点。
 */
export function AdminPage() {
  const user = useAuthStore((state) => state.user);
  if (!user) return null;
  if (!user.is_admin) return <Navigate to="/" replace />;
  return <AdminConsole />;
}

function AdminConsole() {
  const { t } = useTranslation();
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const queryClient = useQueryClient();
  const [danger, setDanger] = useState<"restart" | "shutdown" | "reset" | null>(null);
  const [cfgSection, setCfgSection] = useState("");
  const [cfgDraft, setCfgDraft] = useState<Record<string, string>>({});
  const [auditPage, setAuditPage] = useState(1);
  const [logName, setLogName] = useState<string | null>(null);
  const [logLevel, setLogLevel] = useState("");

  useEffect(() => {
    setCrumbs([{ label: t("nav.adminConsole") }, { label: t("admin.title") }]);
  }, [setCrumbs, t]);

  /* ---------------------------------------------- 取数 */
  const statusQuery = useApiQuery<StatusView>({ queryKey: ["admin", "status"], queryFn: fetchStatus });
  const componentsQuery = useApiQuery<ComponentsResponse>({
    queryKey: ["admin", "components"],
    queryFn: async () => unwrap(await api.GET("/api/app/components")),
  });
  const monitoringQuery = useApiQuery<MonitoringResponse>({
    queryKey: ["admin", "monitoring"],
    queryFn: async () => unwrap(await api.GET("/api/app/monitoring")),
  });
  const usersQuery = useApiQuery<AdminUser[]>({ queryKey: ["admin", "users"], queryFn: fetchUsers });
  const configQuery = useApiQuery<ConfigSection[]>({
    queryKey: ["admin", "config"],
    queryFn: fetchConfigSections,
  });
  // 空数组按引用稳定，避免 pendingPatch 的 useMemo 每帧重算
  const sections = useMemo(() => configQuery.data ?? [], [configQuery.data]);
  const auditQuery = useApiQuery<AuditPageView>({
    queryKey: ["admin", "audit", auditPage],
    queryFn: () => fetchAuditPage(auditPage),
  });
  const logInfoQuery = useApiQuery<LogFileView[]>({ queryKey: ["admin", "logs"], queryFn: fetchLogInfo });
  const logFiles = logInfoQuery.data ?? [];
  const activeLogName = logName ?? logFiles[0]?.name ?? "app";
  const logContentQuery = useApiQuery<LogContentView>({
    queryKey: ["admin", "logs", "content", activeLogName, logLevel],
    queryFn: () => fetchLogContent({ logName: activeLogName, level: logLevel || null }),
  });

  /** 管理端点 403（非全局管理员，或来源不在网关白名单）→ 整页受限提示。 */
  const forbidden = [statusQuery, componentsQuery, monitoringQuery, usersQuery, configQuery, auditQuery, logInfoQuery].some(
    (query) => query.error instanceof AdminApiError && query.error.status === 403,
  );

  /* ---------------------------------------------- 派生视图 */
  const status = statusQuery.data ?? null;
  const requests = status?.requests;
  const processInfo = status?.process;
  const components = (componentsQuery.data?.components ?? []).map(toComponentState);
  const coreComponents = components.filter((component) => groupFor(component.service) !== "可选组件");
  const optionalComponents = components.filter((component) => groupFor(component.service) === "可选组件");
  const monitoring = monitoringQuery.data ?? null;
  const section = sections.find((item) => item.name === cfgSection) ?? sections[0] ?? null;

  const windowTotal = (requests?.success ?? 0) + (requests?.failed ?? 0);
  const errRate = windowTotal ? (((requests?.failed ?? 0) / windowTotal) * 100).toFixed(2) : "0.00";
  const kpis: AdminKpi[] = [
    {
      label: "请求 / 分",
      value: fmtNum(requests?.requests_per_minute),
      meta: `最近 ${requests?.window_minutes ?? "—"} 分钟窗口`,
      tone: "good",
    },
    {
      label: "错误率",
      value: errRate,
      unit: "%",
      meta: `${fmtNum(requests?.failed)} 次失败`,
      tone: requests?.failed ? "warn" : "good",
    },
    {
      label: "平均延迟",
      value: fmtNum(requests?.avg_response_time_ms),
      unit: "ms",
      meta: `${fmtNum(requests?.success)} 次成功`,
      tone: "good",
    },
    {
      label: "内存",
      value: fmtNum(processInfo?.memory_mb),
      unit: "MB",
      meta: `${processInfo?.threads ?? "—"} 线程 · ${processInfo?.connections ?? "—"} 连接`,
      tone: "info",
    },
  ];

  const schema = status?.schema_state ?? null;
  const schemaText = schema?.applied
    ? schema.applied === schema.head
      ? `${schema.applied} · 与 head 一致`
      : `${schema.applied} / ${schema.head ?? "?"}`
    : "—";
  const facts: { key: string; value: ReactNode }[] = status
    ? [
        { key: "版本", value: <span className="font-mono">kustos {status.version}</span> },
        { key: "运行时长", value: <span className="font-mono">{status.uptime_formatted}</span> },
        { key: "PID", value: <span className="font-mono">{processInfo?.pid ?? "—"}</span> },
        { key: "调试模式", value: status.debug_mode ? "开启" : "关闭" },
        { key: "Schema", value: <span className="font-mono">{schemaText}</span> },
        {
          key: "Git 操作",
          value: (
            <span className="font-mono">
              {status.git_operations.active_clones ?? 0} clone · {status.git_operations.active_pushes ?? 0} push
            </span>
          ),
        },
        { key: "请求总数", value: <span className="font-mono">{fmtNum(requests?.total)}</span> },
      ]
    : [];

  /** 配置草稿 → 待提交补丁 `{节: {键: 原类型的值}}`（与当前值相同的草稿丢弃）。 */
  const pendingPatch = useMemo(() => {
    const patch: Record<string, Record<string, unknown>> = {};
    for (const [compound, input] of Object.entries(cfgDraft)) {
      const dot = compound.indexOf(".");
      const secName = compound.slice(0, dot);
      const key = compound.slice(dot + 1);
      const row = sections.find((item) => item.name === secName)?.keys.find((item) => item.key === key);
      if (!row || String(row.raw) === input) continue;
      (patch[secName] ??= {})[key] = coerceConfigValue(row.raw, input);
    }
    return patch;
  }, [cfgDraft, sections]);
  const pendingCount = Object.values(pendingPatch).reduce((total, keys) => total + Object.keys(keys).length, 0);

  /* ---------------------------------------------- 变更操作 */
  const restartApp = useApiMutation(
    async () => {
      const body = unwrap(await api.POST("/api/app/restart", {}));
      if (!body.success) throw new AdminApiError(400, body.message || "重启失败");
      return body;
    },
    {
      onSuccess: (body) => {
        toast.success(body.message || "应用将在稍后重启。");
        setDanger(null);
        void queryClient.invalidateQueries({ queryKey: ["admin", "status"] });
        void queryClient.invalidateQueries({ queryKey: ["admin", "components"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const shutdownApp = useApiMutation(
    async () => {
      const body = unwrap(await api.POST("/api/app/shutdown", {}));
      if (!body.success) throw new AdminApiError(400, body.message || "关闭失败");
      return body;
    },
    {
      onSuccess: (body) => {
        toast.success(body.message || "应用将在稍后关闭。");
        setDanger(null);
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const saveConfig = useApiMutation(
    async () => {
      const body = unwrap(await api.POST("/api/app/config", { body: { config: pendingPatch } }));
      if (!body.success) throw new AdminApiError(400, body.errors?.map(String).join("；") || "保存失败");
      return body;
    },
    {
      onSuccess: (body) => {
        const hints = (body.hints ?? []).map(String);
        toast.success(hints.length ? `配置已保存：${hints.join("；")}` : "配置已保存。");
        setCfgDraft({});
        void queryClient.invalidateQueries({ queryKey: ["admin", "config"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const validateConfig = useApiMutation(
    async () => {
      const payload: Record<string, unknown> = pendingCount
        ? pendingPatch
        : { [section?.name ?? "server"]: Object.fromEntries((section?.keys ?? []).map((row) => [row.key, row.raw])) };
      return unwrap(await api.POST("/api/app/config/validate", { body: payload }));
    },
    {
      onSuccess: (body) => {
        if (body.success) toast.success("配置校验通过。");
        else toast.error(`校验未通过：${body.errors?.map(String).join("；") || "未知错误"}`);
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const resetConfig = useApiMutation(
    async () => {
      const body = unwrap(await api.POST("/api/app/config/reset", {}));
      if (!body.success) throw new AdminApiError(400, body.errors?.map(String).join("；") || "重置失败");
      return body;
    },
    {
      onSuccess: () => {
        toast.success("配置已重置为种子默认值。");
        setCfgDraft({});
        setDanger(null);
        void queryClient.invalidateQueries({ queryKey: ["admin", "config"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const toggleMonitoring = useApiMutation(
    async (enabled: boolean) => unwrap(await api.POST("/api/app/monitoring/enabled", { body: { enabled } })),
    {
      onSuccess: () => {
        toast.success("监控栈状态已更新。");
        void queryClient.invalidateQueries({ queryKey: ["admin", "monitoring"] });
        void queryClient.invalidateQueries({ queryKey: ["admin", "components"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const grafanaSso = useApiMutation(async () => unwrap(await api.GET("/api/app/monitoring/grafana/sso")), {
    onSuccess: (body) => {
      // Cookie 已随 SSO 响应下发，直接跳转网关反代的 /grafana 入口
      if (body.ok) window.location.assign(body.entry);
    },
    onError: (error) => toast.error(`Grafana 暂不可用：${error.message}`),
  });

  // 管理员但来源被网关拦截：给中性提示，不暴露门禁细节
  if (forbidden) {
    return (
      <div className="mx-auto flex w-full max-w-[1560px] flex-col items-center px-[34px] pt-[120px] pb-20">
        <div className="border-edge-2 bg-ink-900/60 flex max-w-[440px] flex-col items-center rounded-xl border px-8 py-10 text-center">
          <Lock className="text-faint size-7" aria-hidden="true" />
          <h1 className="font-display text-bone mt-3 text-[19px] font-medium">
            {t("admin.unavailableTitle")}
          </h1>
          <p className="text-muted-2 mt-2 text-[12px] leading-relaxed">
            {t("admin.unavailableHint")}
          </p>
          <Link
            to="/"
            className="border-edge-2 text-muted hover:border-edge-3 hover:text-bone-2 mt-5 inline-flex h-8 items-center rounded-md border px-3 text-[11px] transition-colors"
          >
            {t("admin.backToWatch")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px] pb-20">
      {/* 页头 */}
      <header className="mb-3.5 flex items-end justify-between gap-7">
        <div className="min-w-0">
          <p className="text-faint text-[10.5px] font-semibold tracking-[0.16em] uppercase">
            Instance · <span className="font-mono">kustos {status?.version ?? "…"}</span>
          </p>
          <h1 className="font-display text-bone mt-1.5 text-[clamp(1.9rem,2.6vw,2.6rem)] font-medium tracking-[-0.028em] leading-none">
            {t("admin.title")}
          </h1>
          <p className="text-muted mt-2.5 max-w-[78ch] text-[13px] leading-relaxed">
            本实例的运行时、访问与配置——这里的每一项操作都会写入审计日志。
          </p>
        </div>
        <div className="flex flex-none items-center gap-2 pb-0.5">
          <StatusPill tone="info" lamp>
            <Lock className="size-3" aria-hidden="true" />
            global admin
          </StatusPill>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => {
              if (!monitoring?.grafana.running) {
                toast.info("监控栈未运行——可在运行时页启动监控栈后重试。");
                return;
              }
              grafanaSso.mutate();
            }}
          >
            <Activity className="size-4" aria-hidden="true" />
            打开 Grafana
          </Button>
        </div>
      </header>

      <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview" type="button">
              {t("admin.overview")}
            </TabsTrigger>
            <TabsTrigger value="runtime" type="button" className="gap-1.5">
              {t("admin.runtime")}
              {coreComponents.filter((component) => !component.running).length > 0 ? (
                <span className="bg-amber/10 text-amber-2 rounded-full px-1.5 font-mono text-[9.5px] leading-4">
                  {coreComponents.filter((component) => !component.running).length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="access" type="button" className="gap-1.5">
              {t("admin.access")}
              <span className="rounded-full bg-bone/[0.06] px-1.5 font-mono text-[9.5px] leading-4 text-muted-2">
                {usersQuery.data?.length ?? 0}
              </span>
            </TabsTrigger>
            <TabsTrigger value="configuration" type="button">
              {t("admin.configuration")}
            </TabsTrigger>
            <TabsTrigger value="capabilities" type="button">
              {t("admin.capabilities")}
            </TabsTrigger>
            <TabsTrigger value="audit" type="button">
              {t("admin.audit")}
            </TabsTrigger>
          </TabsList>

          {/* ---------------------------------------------- 概览 */}
          <TabsContent value="overview">
            <dl aria-label="实例指标" className="border-edge-2 border-y grid grid-cols-4">
              {statusQuery.error ? (
                <div className="col-span-4 py-4">
                  <LoadError error={statusQuery.error} onRetry={() => void statusQuery.refetch()} />
                </div>
              ) : (
                kpis.map((kpi, index) => (
                  <div
                    key={kpi.label}
                    className={cn(
                      "min-w-0 py-4 pr-[22px]",
                      index < kpis.length - 1 ? "border-edge-1 border-r" : "pr-0",
                      index > 0 && "pl-[22px]",
                    )}
                  >
                    <dt className="text-muted-2 text-[10px] font-semibold tracking-[0.14em] uppercase">{kpi.label}</dt>
                    <dd className="font-display text-bone mt-[7px] text-[28px] font-medium tabular-nums tracking-[-0.03em] leading-none">
                      {kpi.value}
                      {kpi.unit ? (
                        <span className="text-muted-2 font-sans ml-1 text-[11.5px] font-medium tracking-normal">{kpi.unit}</span>
                      ) : null}
                    </dd>
                    <dd className="text-muted-2 mt-2 flex items-center gap-1.5 text-[10px] leading-[1.35]">
                      <Lamp tone={kpi.tone} />
                      {kpi.meta}
                    </dd>
                  </div>
                ))
              )}
            </dl>

            <div className="mt-6 grid grid-cols-2 gap-3.5">
              <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border p-4 shadow-[inset_0_1px_0_rgba(240,231,216,0.04)]">
                <SectionHead title="进程与 Schema" meta="GET /api/app/status" className="mb-3" />
                {statusQuery.error ? (
                  <LoadError error={statusQuery.error} onRetry={() => void statusQuery.refetch()} />
                ) : (
                  <FactList items={facts} />
                )}
              </section>

              <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border p-4 shadow-[inset_0_1px_0_rgba(240,231,216,0.04)]">
                <SectionHead
                  title="组件"
                  count={components.length}
                  meta={
                    componentsQuery.data && !componentsQuery.data.available
                      ? "编排不可用"
                      : `${components.filter((component) => component.running).length}/${components.length} 运行中`
                  }
                  className="mb-3"
                />
                {componentsQuery.error ? (
                  <LoadError error={componentsQuery.error} onRetry={() => void componentsQuery.refetch()} />
                ) : componentsQuery.data && !componentsQuery.data.available ? (
                  <p className="text-muted-2 text-[10.5px] leading-relaxed">
                    Docker 编排状态不可用：{componentsQuery.data.reason ?? "未知原因"}——指标仍在进程内记录。
                  </p>
                ) : (
                  <div>
                    {COMPONENT_GROUPS.map((group) => {
                      const items = components.filter((component) => groupFor(component.service) === group);
                      if (!items.length) return null;
                      const down = items.filter((component) => !component.running && component.exitCode !== 0);
                      const optionalStopped = group === "可选组件" && items.every((component) => !component.running);
                      return (
                        <div key={group} className="border-edge-1 flex items-center gap-2.5 border-b py-[7px] last:border-b-0">
                          <span className="text-muted-2 w-[68px] shrink-0 text-[10.5px]">{group}</span>
                          <span className="flex gap-1">
                            {items.map((component) => (
                              <Lamp key={component.service} tone={lampFor(component)} />
                            ))}
                          </span>
                          <span
                            className={cn(
                              "ml-auto font-mono text-[9.5px]",
                              down.length ? "text-amber-2" : optionalStopped ? "text-faint" : "text-sage",
                            )}
                          >
                            {optionalStopped
                              ? "可选 · 已停止"
                              : down.length
                                ? `${down.length} 个异常`
                                : `${items.length} 个运行中`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {monitoring ? (
                  <p className="text-muted-2 mt-3 flex items-center gap-1.5 text-[10.5px] leading-relaxed">
                    <Lamp tone={monitoring.grafana.running ? "good" : "warn"} />
                    {monitoring.grafana.running
                      ? "监控栈运行中——Grafana / Prometheus 容器在线。"
                      : "监控栈当前已停止——指标仍在进程内记录。"}
                  </p>
                ) : null}
              </section>
            </div>
          </TabsContent>

          {/* ---------------------------------------------- 运行时 */}
          <TabsContent value="runtime">
            <div className="border-edge-2 bg-ink-900/55 mb-3.5 flex flex-wrap items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-[11px] text-muted-2">
              <span className="text-faint text-[9px] font-semibold tracking-[0.12em] uppercase">核心</span>
              <strong className="text-bone font-mono text-[11.5px] font-medium">
                {coreComponents.filter((component) => component.running).length}/{coreComponents.length}
              </strong>
              <span aria-hidden="true" className="bg-edge-2 h-3.5 w-px" />
              <span className="text-faint text-[9px] font-semibold tracking-[0.12em] uppercase">可选</span>
              <strong className="text-bone font-mono text-[11.5px] font-medium">
                {optionalComponents.filter((component) => component.running).length}/{optionalComponents.length}
              </strong>
              <span className="text-muted-2 ml-auto font-mono text-[10px]">
                docker · project {componentsQuery.data?.project ?? "—"}
              </span>
              <Button variant="ghost" size="sm" type="button" onClick={() => void componentsQuery.refetch()}>
                <RefreshCw className="size-4" aria-hidden="true" />
                刷新
              </Button>
            </div>

            <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border shadow-[inset_0_1px_0_rgba(240,231,216,0.04)]">
              <div className="border-edge-1 flex items-center gap-3 border-b px-4 py-3">
                <h3 className="text-bone text-[12.5px] font-semibold">{t("admin.components")}</h3>
                <span className="text-faint text-[9.5px]">按职责分组 · 健康来自只读 Docker socket 代理</span>
              </div>
              {componentsQuery.error ? (
                <div className="px-4 py-3">
                  <LoadError error={componentsQuery.error} onRetry={() => void componentsQuery.refetch()} />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] border-collapse text-[12px]">
                    <thead>
                      <tr className="border-edge-2 border-b">
                        <th className="w-6" />
                        <Th>服务</Th>
                        <Th>镜像</Th>
                        <Th>状态</Th>
                        <Th>运行时长</Th>
                        <Th className="text-right">重启次数</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {COMPONENT_GROUPS.map((group) => (
                        <ComponentRows
                          key={group}
                          group={group}
                          items={components.filter((component) => groupFor(component.service) === group)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-muted-2 border-edge-1 border-t px-4 py-2.5 text-[10.5px] leading-relaxed">
                <code className={CODE_CLS}>init</code> 是迁移 + 管理员引导任务，退出码 0 即成功——监控栈停止不影响指标记录。
              </p>
            </section>

            {/* 监控栈（Prometheus / Grafana） */}
            <section className="border-edge-1 bg-ink-850/40 mt-3.5 rounded-[10px] border p-4 shadow-[inset_0_1px_0_rgba(240,231,216,0.04)]">
              <SectionHead
                title="监控栈"
                meta={monitoring?.available === false ? "编排不可用" : "GET /api/app/monitoring"}
                className="mb-3"
              />
              {monitoringQuery.error ? (
                <LoadError error={monitoringQuery.error} onRetry={() => void monitoringQuery.refetch()} />
              ) : monitoring ? (
                <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted">
                  {(["grafana", "prometheus"] as const).map((name) => {
                    const service = monitoring[name];
                    return (
                      <span key={name} className="inline-flex items-center gap-2">
                        <Lamp tone={service.ready ? "good" : service.running ? "warn" : "neutral"} />
                        <span className="text-bone-2 font-mono text-[11.5px]">{name}</span>
                        <span className="text-muted-2">
                          {service.ready ? "就绪" : service.running ? "运行中（未就绪）" : service.configured ? "已停止" : "未部署"}
                        </span>
                      </span>
                    );
                  })}
                  <span className="ml-auto flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      disabled={toggleMonitoring.isPending}
                      onClick={() => toggleMonitoring.mutate(!(monitoring.grafana.running || monitoring.prometheus.running))}
                    >
                      {monitoring.grafana.running || monitoring.prometheus.running ? "停止监控栈" : "启动监控栈"}
                    </Button>
                  </span>
                  <p className="text-muted-2 w-full text-[10.5px] leading-relaxed">
                    启停经窄写 docker 代理对监控容器做 start/stop；从未部署过会返回 409 并给出拉起命令。
                  </p>
                </div>
              ) : (
                <p className="text-muted-2 text-[10.5px]">加载中…</p>
              )}
            </section>

            {/* 危险操作区 */}
            <section className="border-edge-1 bg-ink-850/40 mt-3.5 rounded-[10px] border p-4 shadow-[inset_0_1px_0_rgba(240,231,216,0.04)]">
              <SectionHead title="实例控制" meta="危险操作 · 全部记入审计" className="mb-1" />
              <DangerRow
                title="重启应用"
                desc="信号交给进程管理器做滚动重启（新 worker 就绪后才退役旧 worker）；在途请求可能出现短暂 503，会话与 Agent 流会断开。"
                action={
                  <Button variant="outline" size="sm" type="button" onClick={() => setDanger("restart")}>
                    <RefreshCw className="size-4" aria-hidden="true" />
                    {t("admin.restart")}
                  </Button>
                }
              />
              <DangerRow
                title="关闭实例"
                desc="停止 API 进程。本控制台无法再将其拉起——需要进入宿主机操作。"
                action={
                  <Button variant="danger" size="sm" type="button" onClick={() => setDanger("shutdown")}>
                    <XCircle className="size-4" aria-hidden="true" />
                    {t("admin.shutdown")}
                  </Button>
                }
              />
              <p className="text-muted-2 mt-3 text-[10.5px] leading-relaxed">
                两个接口都只接受管理员（或回环地址上的调试模式）；都不是软重置——会话与 Agent 流都会断开。
              </p>
            </section>
          </TabsContent>

          {/* ---------------------------------------------- 访问控制 */}
          <TabsContent value="access">
            <p className="border-edge-2 bg-ink-900/55 text-muted-2 mb-3.5 rounded-lg border px-3.5 py-2.5 text-[10.5px] leading-relaxed">
              {t("admin.accessHint")}
            </p>

            <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border shadow-[inset_0_1px_0_rgba(240,231,216,0.04)]">
              <div className="border-edge-1 flex items-center gap-3 border-b px-4 py-3">
                <h3 className="text-bone text-[12.5px] font-semibold">{t("admin.users")}</h3>
                <span className="text-faint text-[9.5px]">{usersQuery.data?.length ?? 0} 个账号 · 全局角色</span>
                <span className="ml-auto">
                  <CreateUserDialog />
                </span>
              </div>
              {usersQuery.error ? (
                <div className="px-4 py-3">
                  <LoadError error={usersQuery.error} onRetry={() => void usersQuery.refetch()} />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse text-[12px]">
                    <thead>
                      <tr className="border-edge-2 border-b">
                        <Th>账号</Th>
                        <Th>全局角色</Th>
                        <Th>状态</Th>
                        <Th className="text-right">注册时间</Th>
                        <Th className="text-right">操作</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {(usersQuery.data ?? []).map((user) => (
                        <tr key={user.id} className={cn("border-edge-1 border-b last:border-b-0", !user.isActive && "opacity-70")}>
                          <td className="py-2.5 pr-3">
                            <span className="flex items-center gap-2.5">
                              <ToneAvatar initials={user.initials} tone={user.avatarTone} size="sm" />
                              <span className="flex min-w-0 flex-col">
                                <span className="text-bone-2 text-[12px] leading-tight">{user.name}</span>
                                <span className="text-faint truncate font-mono text-[9.5px]">{user.email}</span>
                              </span>
                            </span>
                          </td>
                          <td>
                            {user.isAdmin ? <Tag tone="warn">管理员</Tag> : <Tag tone="neutral">成员</Tag>}
                          </td>
                          <td>
                            <span className={cn("inline-flex items-center gap-1.5 text-[10.5px]", user.isActive ? "text-sage" : "text-muted-2")}>
                              <Lamp tone={user.isActive ? "good" : "neutral"} />
                              {user.isActive ? "活跃" : "已停用"}
                            </span>
                          </td>
                          <td className="text-muted text-right font-mono text-[11px]">{formatDate(user.createdAt)}</td>
                          <td className="text-right">
                            <UserRowActions
                              user={{
                                id: user.id,
                                name: user.name,
                                email: user.email,
                                isAdmin: user.isAdmin,
                                isActive: user.isActive,
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-muted-2 border-edge-1 border-t px-4 py-2.5 text-[10.5px] leading-relaxed">
                全局管理员是用户记录上的一位标记；仓库角色（owner/admin/developer/readonly）挂在成员关系上，在各仓库内管理，两者互不推导。
              </p>
            </section>
          </TabsContent>

          {/* ---------------------------------------------- 配置 */}
          <TabsContent value="configuration">
            {configQuery.error ? (
              <LoadError error={configQuery.error} onRetry={() => void configQuery.refetch()} />
            ) : !section ? (
              <p className="text-muted-2 text-[10.5px]">加载中…</p>
            ) : (
              <div className="grid grid-cols-[192px_minmax(0,1fr)] items-start gap-3.5">
                <nav
                  aria-label="配置分节"
                  className="border-edge-2 bg-ink-900/60 flex max-h-[560px] flex-col gap-px overflow-y-auto rounded-[10px] border p-1.5"
                >
                  {sections.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => setCfgSection(item.name)}
                      className={cn(
                        "flex h-[30px] items-center gap-1.5 rounded-md px-2 text-left transition-colors",
                        item.name === section.name
                          ? "bg-amber/10 text-bone shadow-[inset_2px_0_0_rgba(242,174,91,0.9)]"
                          : "text-muted hover:bg-ink-750/50 hover:text-bone-2",
                      )}
                    >
                      <span className="truncate font-mono text-[10.5px]">{item.name}</span>
                      {item.writable ? null : (
                        <Lock className="ml-auto size-2.5 text-faint" aria-label={t("admin.protectedKey")} />
                      )}
                      {item.hot ? (
                        <span className="bg-sage/10 text-sage ml-auto rounded px-1 text-[8.5px] leading-[14px] tracking-[0.04em]">
                          hot
                        </span>
                      ) : null}
                    </button>
                  ))}
                </nav>

                <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border shadow-[inset_0_1px_0_rgba(240,231,216,0.04)]">
                  <div className="border-edge-1 flex items-center gap-3 border-b px-4 py-3">
                    <h3 className="text-bone font-mono text-[12.5px] font-semibold">{section.name}</h3>
                    <span className="text-faint text-[9.5px]">
                      {section.keys.length} 个键 · {section.writable ? "可写" : "受保护"}
                      {section.hot ? " · 热重载" : ""}
                    </span>
                  </div>

                  {/* 优先级说明：env 钉死的键永远不可在此编辑 */}
                  <div className="border-edge-1 flex flex-wrap items-center gap-[7px] border-b px-4 py-2.5 text-[9.5px] text-muted-2">
                    <Tag tone="info">{t("admin.sourceEnv")}</Tag>
                    <span className="text-faint">›</span>
                    <Tag tone="warn">{t("admin.sourceDb")}</Tag>
                    <span className="text-faint">›</span>
                    <Tag tone="neutral">{t("admin.sourceDefault")}</Tag>
                    <span className="text-faint ml-auto">有效值 = 最高存在的层</span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] border-collapse">
                      <thead>
                        <tr className="border-edge-2 border-b">
                          <Th className="w-[36%]">键</Th>
                          <Th>当前值</Th>
                          <Th>来源</Th>
                          <Th>生效方式</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {section.keys.map((row) => {
                          // env 与受保护键不提供编辑入口——给出输入框就是在谎称值的归属
                          const pinned = row.locked || row.source === "env";
                          const source = sourceTagText(row.source, t);
                          const draftKey = `${section.name}.${row.key}`;
                          return (
                            <tr key={row.key} className="border-edge-1 border-b last:border-b-0">
                              <td className="py-[7px] pr-3 text-bone-2 font-mono text-[10.5px]">
                                {row.key}
                                {pinned ? (
                                  <Lock
                                    className="ml-1.5 inline size-2.5 text-faint align-middle"
                                    aria-label={row.source === "env" ? "环境变量钉死" : t("admin.protectedKey")}
                                  />
                                ) : null}
                              </td>
                              <td className="py-[7px] pr-3">
                                {pinned ? (
                                  <span className="font-mono text-[10.5px] text-muted">{row.value}</span>
                                ) : (
                                  <Input
                                    value={cfgDraft[draftKey] ?? row.value}
                                    onChange={(event) => setCfgDraft((prev) => ({ ...prev, [draftKey]: event.target.value }))}
                                    className="h-6 w-full min-w-[160px] px-1.5 font-mono text-[10.5px]"
                                    aria-label={`${row.key} 的值`}
                                  />
                                )}
                              </td>
                              <td className="py-[7px] pr-3">
                                <Tag tone={source.tone}>{source.text}</Tag>
                              </td>
                              <td className="py-[7px] pr-3">
                                {row.effect === "hot" ? (
                                  <Tag tone="good">{t("admin.hotReload")}</Tag>
                                ) : (
                                  <Tag tone="warn">{t("admin.needRestart")}</Tag>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="border-edge-2 bg-ink-850/80 flex flex-wrap items-center gap-2.5 border-t px-4 py-2.5">
                    <span className="inline-flex items-center gap-1.5 text-[10.5px] text-muted-2">
                      <Lamp tone={pendingCount ? "warn" : "good"} />
                      {pendingCount ? `有 ${pendingCount} 项未保存的修改` : "无未保存的修改"}
                    </span>
                    <span className="text-muted-2 ml-auto text-[10px]">密钥不会回显</span>
                    <Button variant="ghost" size="sm" type="button" onClick={() => validateConfig.mutate()}>
                      校验
                    </Button>
                    <Button variant="ghost" size="sm" type="button" onClick={() => setDanger("reset")}>
                      重置为默认
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      disabled={!pendingCount || saveConfig.isPending}
                      onClick={() => saveConfig.mutate()}
                    >
                      保存并应用
                    </Button>
                  </div>
                </section>
              </div>
            )}
          </TabsContent>

          {/* ---------------------------------------------- 审计日志 */}
          <TabsContent value="capabilities">
            <CapabilitiesPanel />
          </TabsContent>

          <TabsContent value="audit">
            <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border shadow-[inset_0_1px_0_rgba(240,231,216,0.04)]">
              <div className="border-edge-1 flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <h3 className="text-bone text-[12.5px] font-semibold">{t("admin.audit")}</h3>
                <span className="text-faint text-[9.5px]">
                  {auditQuery.data?.total ?? 0} 条 · 最近 7 天 · 最新在前
                </span>
                <Tag tone="warn">仅管理员</Tag>
                {auditQuery.data?.truncated ? (
                  <span className="text-amber-2 text-[9.5px]">已达扫描上限，更早记录未纳入</span>
                ) : null}
              </div>
              {auditQuery.error ? (
                <div className="px-4 py-3">
                  <LoadError error={auditQuery.error} onRetry={() => void auditQuery.refetch()} />
                </div>
              ) : auditQuery.isPending ? (
                <p className="text-muted-2 px-4 py-3 text-[10.5px]">加载中…</p>
              ) : auditQuery.data.items.length === 0 ? (
                <p className="text-muted-2 px-4 py-3 text-[10.5px]">窗口内暂无审计条目。</p>
              ) : (
                <ol className="px-4 py-1">
                  {auditQuery.data.items.map((entry) => (
                    <AuditRow key={entry.id} entry={entry} />
                  ))}
                </ol>
              )}
              <div className="border-edge-1 flex items-center gap-2 border-t px-4 py-2.5">
                <span className="text-muted-2 text-[10.5px]">
                  第 {auditQuery.data?.page ?? 1} / {Math.max(auditQuery.data?.pages ?? 1, 1)} 页
                </span>
                <div className="ml-auto flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={!auditQuery.data?.hasPrev || auditQuery.isFetching}
                    onClick={() => setAuditPage((page) => Math.max(1, page - 1))}
                  >
                    上一页
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={!auditQuery.data?.hasNext || auditQuery.isFetching}
                    onClick={() => setAuditPage((page) => page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </div>
              <p className="text-muted-2 border-edge-1 border-t px-4 py-2.5 text-[10.5px] leading-relaxed">
                HTTP 请求审计（<code className={CODE_CLS}>audit.log</code>）与业务事件（
                <code className={CODE_CLS}>activities</code> 表）两条轨迹合并展示。
              </p>
            </section>

            {/* 日志视图（/api/app/logs/content） */}
            <section className="border-edge-1 bg-ink-850/40 mt-3.5 rounded-[10px] border shadow-[inset_0_1px_0_rgba(240,231,216,0.04)]">
              <div className="border-edge-1 flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <h3 className="text-bone text-[12.5px] font-semibold">日志视图</h3>
                <span className="text-faint font-mono text-[9.5px]">logs/{activeLogName}</span>
                <div className="ml-auto flex items-center gap-2">
                  <select
                    value={activeLogName}
                    onChange={(event) => setLogName(event.target.value)}
                    aria-label="日志文件"
                    className="border-edge-2 bg-ink-900/60 text-bone-2 h-6 rounded-md border px-1.5 font-mono text-[10.5px]"
                  >
                    {logFiles.length === 0 ? <option value="app">app</option> : null}
                    {logFiles.map((file) => (
                      <option key={file.name} value={file.name}>
                        {file.name}
                        {file.sizeFormatted ? ` · ${file.sizeFormatted}` : ""}
                      </option>
                    ))}
                  </select>
                  <select
                    value={logLevel}
                    onChange={(event) => setLogLevel(event.target.value)}
                    aria-label="日志级别"
                    className="border-edge-2 bg-ink-900/60 text-bone-2 h-6 rounded-md border px-1.5 text-[10.5px]"
                  >
                    {LOG_LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>
                        {level.label}
                      </option>
                    ))}
                  </select>
                  <Button variant="ghost" size="sm" type="button" onClick={() => void logContentQuery.refetch()}>
                    <RefreshCw className="size-4" aria-hidden="true" />
                    刷新
                  </Button>
                </div>
              </div>
              {logContentQuery.error ? (
                <div className="px-4 py-3">
                  <LoadError error={logContentQuery.error} onRetry={() => void logContentQuery.refetch()} />
                </div>
              ) : (
                <pre className="text-muted bg-ink-900/40 max-h-[320px] overflow-auto px-4 py-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap">
                  {logContentQuery.data?.content || (logContentQuery.data && !logContentQuery.data.exists ? "该日期没有此日志文件。" : "加载中…")}
                </pre>
              )}
              <p className="text-muted-2 border-edge-1 border-t px-4 py-2.5 text-[10.5px] leading-relaxed">
                {logContentQuery.data
                  ? `${logContentQuery.data.date} · 返回末尾 ${logContentQuery.data.lines}/${logContentQuery.data.totalLines} 行`
                  : "GET /api/app/logs/content"}
                {logContentQuery.data?.truncated ? " · 已达保留上限，更早分片可能已丢弃" : ""}
              </p>
            </section>
          </TabsContent>
        </Tabs>

      {/* 危险操作确认（重启 / 关机 / 配置重置） */}
      <Dialog open={danger !== null} onOpenChange={(open) => !open && setDanger(null)}>
        <DialogContent>
          <DialogHeader>
            <p className="text-faint text-[9.5px] font-semibold tracking-[0.16em] uppercase">特权操作</p>
            <DialogTitle>
              {danger === "restart"
                ? t("admin.confirmRestart")
                : danger === "reset"
                  ? "确认重置全部配置？"
                  : "确认关闭实例？"}
            </DialogTitle>
            <DialogDescription>
              {danger === "restart"
                ? t("admin.restartImpact")
                : danger === "reset"
                  ? "重置会把数据库里的动态配置覆盖回种子默认值（config.example.toml）；环境变量注入的引导层键不受影响，当前自定义值将全部丢失。"
                  : "关机将停止 API 进程，本控制台无法再将其拉起——需要进入宿主机执行。"}
            </DialogDescription>
          </DialogHeader>
          <p className="border-edge-1 bg-ink-850/60 text-muted-2 rounded-md border px-3 py-2 text-[11px]">
            操作立即生效并写入审计日志；重启/关机会断开全部会话与 Agent 流。
          </p>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => setDanger(null)}>
              取消
            </Button>
            <Button
              variant={danger === "shutdown" || danger === "reset" ? "danger" : "default"}
              type="button"
              disabled={restartApp.isPending || shutdownApp.isPending || resetConfig.isPending}
              onClick={() => {
                if (danger === "restart") restartApp.mutate();
                else if (danger === "shutdown") shutdownApp.mutate();
                else resetConfig.mutate();
              }}
            >
              {danger === "restart" ? t("admin.restart") : danger === "reset" ? "重置" : t("admin.shutdown")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 表头单元格：小标签风格（9px 大写宽字距）。 */
function Th({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <th
      className={cn(
        "text-muted-2 py-2 pr-3 text-left text-[9px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase",
        className,
      )}
    >
      {children}
    </th>
  );
}

/** 组件表的「分组标题行 + 组件行」。 */
function ComponentRows({ group, items }: { group: string; items: ComponentState[] }) {
  if (!items.length) return null;
  return (
    <>
      <tr>
        <td colSpan={6} className="border-edge-1 bg-bone/[0.012] pt-3 pb-1 text-[9.5px] font-semibold tracking-[0.13em] text-muted-2 uppercase">
          {group}
          {group === "可选组件" ? <span className="text-faint ml-2 font-normal tracking-normal normal-case">可选栈</span> : null}
        </td>
      </tr>
      {items.map((component) => {
        const state = stateOf(component);
        return (
          <tr key={component.service} className={cn("border-edge-1 border-b last:border-b-0", !component.running && "opacity-70")}>
            <td className="py-2.5">
              <Lamp tone={lampFor(component)} />
            </td>
            <td className="py-2.5 pr-3">
              <span className="text-bone-2 font-mono text-[11.5px]">{component.service}</span>
              <span className="text-muted-2 ml-2 text-[9.5px]">{component.label}</span>
            </td>
            <td className="text-muted-2 max-w-[210px] truncate py-2.5 pr-3 font-mono text-[9.5px]">{component.image}</td>
            <td className="py-2.5 pr-3">
              <Tag tone={state.tone}>{state.text}</Tag>
            </td>
            <td className="text-muted py-2.5 pr-3 font-mono text-[11px]">{component.uptime ?? "—"}</td>
            <td className="text-muted py-2.5 text-right font-mono text-[11px]">{component.restarts}</td>
          </tr>
        );
      })}
    </>
  );
}

/** 危险操作行：说明在左，动作按钮固定在右。 */
function DangerRow({ title, desc, action }: { title: string; desc: string; action: ReactNode }) {
  return (
    <div className="border-edge-1 flex items-center justify-between gap-4 border-t py-3 first:border-t-0">
      <div className="min-w-0">
        <strong className="text-bone-2 block text-[12.5px] font-semibold">{title}</strong>
        <span className="text-muted-2 mt-0.5 block max-w-[70ch] text-[10px] leading-relaxed">{desc}</span>
      </div>
      <div className="flex flex-none items-center gap-2">{action}</div>
    </div>
  );
}

/** 审计事件流的单条目：时间 / 主体 / 动作 / 状态 / 来源 IP。 */
function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <li
      className={cn(
        "border-edge-1 grid grid-cols-[74px_minmax(96px,130px)_minmax(0,1fr)_auto] items-baseline gap-3 border-b py-2.5 last:border-b-0",
        entry.sensitive && "border-amber/45 border-l-2 pl-2",
      )}
    >
      <time className="text-muted-2 font-mono text-[10px]">{entry.at}</time>
      <span className="text-bone-2 truncate text-[11.5px] font-medium">{entry.actor}</span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        {entry.method ? (
          <span className="text-sky min-w-[34px] font-mono text-[9.5px] tracking-[0.02em]">{entry.method}</span>
        ) : null}
        <span className="text-muted-2 font-mono text-[10px]">{entry.path}</span>
        {entry.sensitive ? <Tag tone="warn">敏感</Tag> : null}
        {entry.note ? <span className="text-faint w-full truncate text-[10px] leading-relaxed">{entry.note}</span> : null}
      </span>
      <span className="flex items-center gap-2 justify-self-end">
        <Tag tone={statusTone(entry.status)}>{entry.status}</Tag>
        <span className="text-faint font-mono text-[9.5px]">{entry.ip}</span>
        <Tag tone={entry.source === "http" ? "neutral" : "info"}>{entry.source}</Tag>
      </span>
    </li>
  );
}
