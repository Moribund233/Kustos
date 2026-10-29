import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { formatRelative } from "@/lib/datetime/format";

interface IndexStatus {
  head_commit?: string | null;
  indexed_commit?: string | null;
  in_sync?: boolean;
  chunks?: number;
  refs?: number;
  embeddings?: number;
  semantic_enabled?: boolean;
  last_indexed_at?: string | null;
}

/**
 * 搜索索引状态。
 *
 * 块级索引只覆盖默认分支 HEAD；`in_sync=false` 时按钮重建（后台执行，
 * 页面轮询状态直到追平）。
 */
export function IndexSection({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const statusQuery = useApiQuery<IndexStatus>({
    queryKey: ["index-status", repoId],
    enabled: !!repoId,
    refetchInterval: (query) => (query.state.data?.in_sync === false ? 3000 : false),
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/search/index-status", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error(t("settings.indexLoadFailed"));
      return res.data as unknown as IndexStatus;
    },
  });

  const reindexMutation = useApiMutation<{ started?: boolean; reason?: string }, void>(
    async () => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/search/reindex", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error(t("settings.reindexFailed"));
      return res.data as { started?: boolean; reason?: string };
    },
    {
      onSuccess: (data) => {
        if (data?.started) toast.success(t("settings.reindexStarted"));
        else toast.info(t("settings.reindexBusy"));
        void queryClient.invalidateQueries({ queryKey: ["index-status", repoId] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const status = statusQuery.data;

  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-[13px] font-semibold">{t("settings.index")}</h2>
      <p className="text-muted-2 mt-1 text-[11px]">
        {t("settings.indexHint")}
      </p>

      <div className="mt-4 grid gap-2 text-[11px] sm:grid-cols-2">
        <p className="text-muted-2">
          {t("settings.indexStatus")}
          <span className={status?.in_sync ? "text-sage" : "text-amber-2"}>
            {status ? (status.in_sync ? t("settings.indexInSync") : t("settings.indexBehind")) : "—"}
          </span>
        </p>
        <p className="text-muted-2">
          {t("settings.indexCounts")}
          <span className="text-bone-2 font-mono">
            {status?.chunks ?? 0} / {status?.refs ?? 0} / {status?.embeddings ?? 0}
          </span>
        </p>
        <p className="text-muted-2">
          {t("settings.indexLast")}<span className="text-bone-2">{formatRelative(status?.last_indexed_at ?? "") || "—"}</span>
        </p>
        <p className="text-muted-2">
          {t("settings.indexSemantic")}<span className="text-bone-2">{status?.semantic_enabled ? t("settings.enabled") : t("settings.disabled")}</span>
        </p>
      </div>

      <Button
        size="sm"
        className="mt-3"
        onClick={() => reindexMutation.mutate()}
        disabled={reindexMutation.isPending || status?.in_sync === false}
      >
        {reindexMutation.isPending ? t("common.loading") : status?.in_sync === false ? t("settings.reindexing") : t("settings.reindex")}
      </Button>
    </section>
  );
}
