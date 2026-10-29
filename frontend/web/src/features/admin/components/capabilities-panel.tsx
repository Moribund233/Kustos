import { useState } from "react";
import type { TFunction } from "i18next";
import { toast } from "sonner";

import { Lamp } from "@/components/kit/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { unwrap } from "@/features/admin/api";

/**
 * 能力面：Agent 密钥/用量、搜索索引、Redis、指标时序与日志清理。
 *
 * 全部是 `/api/app/*` 管理端点，网关 ACL 与 `User.is_admin` 双层门禁；
 * 403 时页面显示受限提示而不是空数据。
 */

interface KeyStatus {
  env_name?: string;
  configured?: boolean;
  providers?: { id: string; key_env: string; configured: boolean; source_env?: string }[];
}

interface UsageSummary {
  totals?: { jobs?: number; succeeded?: number; failed?: number; tokens?: number };
  tools?: { name: string; calls: number }[];
}

interface IndexOverview {
  totals?: { repos?: number; in_sync?: number; behind?: number; chunks?: number; refs?: number };
  semantic_enabled?: boolean;
}

interface RedisStatus {
  reachable?: boolean;
  latency_ms?: number;
  server?: { version?: string; uptime_seconds?: number };
  memory?: { used?: number };
  keyspace?: { total?: number };
}

interface MetricsPoint {
  t: number;
  rpm: number;
  p95_ms: number;
  mem_mb?: number | null;
}

interface MetricsResponse {
  range?: string;
  source?: string;
  points?: MetricsPoint[];
}

function errorText(error: Error | null, t: TFunction): string | null {
  if (!error) return null;
  const status = (error as { status?: number }).status;
  return status === 403 ? t("admin.noPermission") : error.message;
}

export function CapabilitiesPanel() {
  const keyQuery = useApiQuery<KeyStatus>({
    queryKey: ["admin", "agent-key-status"],
    queryFn: async () =>
      unwrap(await api.GET("/api/app/agent/key-status")) as unknown as KeyStatus,
  });

  const usageQuery = useApiQuery<UsageSummary>({
    queryKey: ["admin", "agent-usage"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/app/agent/usage", { params: { query: { days: 7 } } }),
      ) as unknown as UsageSummary,
  });

  const indexQuery = useApiQuery<IndexOverview>({
    queryKey: ["admin", "search-index-overview"],
    queryFn: async () =>
      unwrap(await api.GET("/api/app/search/index-overview")) as unknown as IndexOverview,
  });

  const redisQuery = useApiQuery<RedisStatus>({
    queryKey: ["admin", "redis-status"],
    queryFn: async () =>
      unwrap(await api.GET("/api/app/redis/status")) as unknown as RedisStatus,
  });

  const metricsQuery = useApiQuery<MetricsResponse>({
    queryKey: ["admin", "metrics", "1h"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/app/metrics/timeseries", { params: { query: { range: "1h" } } }),
      ) as unknown as MetricsResponse,
  });

  const [retention, setRetention] = useState("30");
  const { t } = useTranslation();
  const cleanupMutation = useApiMutation<unknown, void>(
    async () => {
      const res = await api.POST("/api/app/logs/cleanup", {
        body: { retention_days: Number(retention) } as never,
      });
      if (res.error) throw new Error(t("admin.cleanupFailed"));
      return res.data;
    },
    {
      onSuccess: () => toast.success(t("admin.cleanupDone")),
      onError: (error) => toast.error(error.message),
    },
  );

  const points = metricsQuery.data?.points ?? [];
  const usage = usageQuery.data?.totals;

  return (
    <div className="grid gap-3.5 lg:grid-cols-2">
      <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border p-4">
        <h3 className="text-bone text-[12.5px] font-semibold">{t("admin.capAgent")}</h3>
        {errorText(keyQuery.error, t) ? (
          <p className="text-muted-2 mt-2 text-[11px]">{errorText(keyQuery.error, t)}</p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5 text-[11px]">
            <p className="text-muted-2">
              {t("admin.capKey")}{" "}
              <span className={keyQuery.data?.configured ? "text-sage" : "text-amber-2"}>
                {keyQuery.data ? (keyQuery.data.configured ? t("admin.configured") : t("admin.notConfigured")) : "—"}
              </span>
              {keyQuery.data?.env_name ? (
                <span className="text-faint font-mono"> · {keyQuery.data.env_name}</span>
              ) : null}
            </p>
            <p className="text-muted-2">
              {t("admin.last7d")}<span className="text-bone-2 font-mono">{usage?.jobs ?? 0}</span> {t("admin.jobs")} ·{" "}
              <span className="text-sage font-mono">{usage?.succeeded ?? 0}</span> {t("admin.succeeded")} ·{" "}
              <span className="text-rose font-mono">{usage?.failed ?? 0}</span> {t("admin.failed")} ·{" "}
              <span className="text-bone-2 font-mono">{usage?.tokens ?? 0}</span> tokens
            </p>
            {usageQuery.data?.tools?.length ? (
              <p className="text-faint text-[10.5px]">
                {t("admin.toolCalls")}
                {usageQuery.data.tools.slice(0, 6).map((tool) => `${tool.name}×${tool.calls}`).join(" · ")}
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border p-4">
        <h3 className="text-bone text-[12.5px] font-semibold">{t("admin.capSearch")}</h3>
        {errorText(indexQuery.error, t) ? (
          <p className="text-muted-2 mt-2 text-[11px]">{errorText(indexQuery.error, t)}</p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5 text-[11px] text-muted-2">
            <p>
              {t("admin.repos")}<span className="text-bone-2 font-mono">{indexQuery.data?.totals?.repos ?? 0}</span> · {t("admin.inSync")}{" "}
              <span className="text-sage font-mono">{indexQuery.data?.totals?.in_sync ?? 0}</span> · {t("admin.behind")}{" "}
              <span className="text-amber-2 font-mono">{indexQuery.data?.totals?.behind ?? 0}</span>
            </p>
            <p>
              {t("admin.chunksRefs")}<span className="text-bone-2 font-mono">{indexQuery.data?.totals?.chunks ?? 0}</span> /{" "}
              <span className="text-bone-2 font-mono">{indexQuery.data?.totals?.refs ?? 0}</span>
            </p>
            <p>
              {t("admin.semantic")}<span className="text-bone-2">{indexQuery.data?.semantic_enabled ? t("settings.enabled") : t("settings.disabled")}</span>
            </p>
          </div>
        )}
      </section>

      <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border p-4">
        <h3 className="text-bone text-[12.5px] font-semibold">{t("admin.capRedis")}</h3>
        {errorText(redisQuery.error, t) ? (
          <p className="text-muted-2 mt-2 text-[11px]">{errorText(redisQuery.error, t)}</p>
        ) : (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-2">
            <Lamp tone={redisQuery.data?.reachable ? "good" : "bad"} />
            <span>{redisQuery.data ? (redisQuery.data.reachable ? t("admin.reachable") : t("admin.unreachable")) : "—"}</span>
            <span className="border-edge-1 text-muted rounded-full border px-2 py-0.5 font-mono text-[10px]">
              {redisQuery.data?.latency_ms ?? "—"} ms
            </span>
            <span className="font-mono">{redisQuery.data?.server?.version ?? ""}</span>
          </div>
        )}
      </section>

      <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border p-4">
        <h3 className="text-bone text-[12.5px] font-semibold">{t("admin.capMetrics")}</h3>
        {errorText(metricsQuery.error, t) ? (
          <p className="text-muted-2 mt-2 text-[11px]">{errorText(metricsQuery.error, t)}</p>
        ) : (
          <>
            <Sparkline points={points} />
            <p className="text-faint mt-1 font-mono text-[9.5px]">
              {points.length} {t("admin.points")} · {t("admin.source")} {metricsQuery.data?.source ?? "—"} · {t("admin.peakRpm")}{" "}
              {points.length ? Math.max(...points.map((point) => point.rpm)).toFixed(1) : "—"}
            </p>
          </>
        )}
      </section>

      <section className="border-edge-1 bg-ink-850/40 rounded-[10px] border p-4 lg:col-span-2">
        <h3 className="text-bone text-[12.5px] font-semibold">{t("admin.logCleanup")}</h3>
        <p className="text-muted-2 mt-1 text-[11px]">{t("admin.logCleanupHint")}</p>
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={retention}
            onChange={(event) => setRetention(event.target.value)}
            aria-label={t("admin.retentionDays")}
            className="h-8 w-24 text-[11px]"
          />
          <Button
            size="sm"
            onClick={() => cleanupMutation.mutate()}
            disabled={cleanupMutation.isPending || !Number(retention)}
          >
            {t("admin.runCleanup")}
          </Button>
        </div>
      </section>
    </div>
  );
}

/** 轻量折线：RPM（琥珀）与 P95（灰），避免为一张图引入图表库。 */
function Sparkline({ points }: { points: MetricsPoint[] }) {
  const { t } = useTranslation();
  if (points.length < 2) {
    return <p className="text-muted-2 mt-2 text-[11px]">{t("admin.noSamples")}</p>;
  }
  const width = 320;
  const height = 72;
  const max = Math.max(...points.map((point) => point.rpm), 1);
  const path = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - (point.rpm / max) * (height - 6) - 3;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 h-[72px] w-full" role="img" aria-label="请求速率">
      <path d={path} fill="none" stroke="rgba(242,174,91,0.85)" strokeWidth="1.5" />
      <line x1="0" y1={height - 3} x2={width} y2={height - 3} stroke="rgba(240,231,216,0.12)" />
    </svg>
  );
}

