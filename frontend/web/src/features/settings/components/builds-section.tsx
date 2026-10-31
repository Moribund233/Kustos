import { useState } from "react";

import { StatusPill } from "@/components/kit/kit";
import { SkeletonText } from "@/components/kit/skeletons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api/client";
import { useApiQuery } from "@/lib/api/hooks";
import { formatRelative } from "@/lib/datetime/format";

interface BuildRow {
  id: string;
  branch: string;
  commit_sha: string;
  commit_message: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface LogEntry {
  seq: number;
  stream: string;
  line: string;
}

interface BuildLogs {
  logs?: string | null;
  entries?: LogEntry[];
}

const STATUS_TONE: Record<string, "good" | "bad" | "warn" | "neutral" | "info"> = {
  success: "good",
  failure: "bad",
  error: "bad",
  running: "warn",
  pending: "info",
  cancelled: "neutral",
};

/**
 * 构建（CI）列表。
 *
 * 构建由外部 runner 或 webhook 推进状态；这里只读展示并查看日志，
 * 不提供触发入口（避免凭空造一条永远 pending 的构建）。
 */
export function BuildsSection({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const [logBuild, setLogBuild] = useState<BuildRow | null>(null);

  const buildsQuery = useApiQuery<BuildRow[]>({
    queryKey: ["builds", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/builds", {
        params: { path: { repo_id: repoId }, query: { limit: 20 } },
      });
      if (res.error) throw new Error(t("settings.buildLoadFailed"));
      return (Array.isArray(res.data) ? res.data : []) as BuildRow[];
    },
  });

  const builds = buildsQuery.data ?? [];

  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-base font-semibold">{t("settings.builds")}</h2>
      <p className="text-muted-2 mt-1 text-xs">
        {t("settings.buildsHint")}
      </p>

      <div className="mt-4 flex flex-col gap-1">
        {buildsQuery.isLoading ? (
          <SkeletonText lines={3} />
        ) : builds.length === 0 ? (
          <p className="text-muted-2 text-xs">{t("settings.noBuilds")}</p>
        ) : (
          builds.map((build) => (
            <button
              key={build.id}
              type="button"
              onClick={() => setLogBuild(build)}
              className="border-edge-1 hover:bg-ink-800/40 flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors"
            >
              <StatusPill tone={STATUS_TONE[build.status] ?? "neutral"}>{build.status}</StatusPill>
              <span className="text-bone-2 min-w-0 flex-1 truncate text-xs">
                {build.commit_message || build.commit_sha.slice(0, 7)}
              </span>
              <span className="text-faint font-mono text-2xs">{build.branch}</span>
              <span className="text-faint text-2xs">{formatRelative(build.created_at)}</span>
            </button>
          ))
        )}
      </div>

      {logBuild ? <BuildLogsDialog repoId={repoId} build={logBuild} onClose={() => setLogBuild(null)} /> : null}
    </section>
  );
}

/** 构建日志弹窗：兼容整串快照与增量 entries。 */
function BuildLogsDialog({
  repoId,
  build,
  onClose,
}: {
  repoId: string;
  build: BuildRow;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const logsQuery = useApiQuery<BuildLogs>({
    queryKey: ["build-logs", repoId, build.id],
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/builds/{build_id}/logs", {
        params: { path: { repo_id: repoId, build_id: build.id } },
      });
      if (res.error) throw new Error(t("settings.logLoadFailed"));
      return res.data as unknown as BuildLogs;
    },
  });

  const text =
    logsQuery.data?.entries?.length
      ? logsQuery.data.entries.map((entry) => `[${entry.stream}] ${entry.line}`).join("\n")
      : (logsQuery.data?.logs ?? "");

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-[820px]">
        <DialogHeader>
          <DialogTitle>{t("settings.buildLogs")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{build.commit_sha.slice(0, 10)}</span> · {build.branch} ·{" "}
            {build.status}
          </DialogDescription>
        </DialogHeader>
        <pre className="border-edge-1 bg-ink-950 max-h-[54vh] min-h-[200px] overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {logsQuery.isLoading ? t("common.loading") : text || t("settings.noLogs")}
        </pre>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
