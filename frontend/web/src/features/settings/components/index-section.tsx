import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
  const queryClient = useQueryClient();

  const statusQuery = useApiQuery<IndexStatus>({
    queryKey: ["index-status", repoId],
    enabled: !!repoId,
    refetchInterval: (query) => (query.state.data?.in_sync === false ? 3000 : false),
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/search/index-status", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error("索引状态加载失败。");
      return res.data as unknown as IndexStatus;
    },
  });

  const reindexMutation = useApiMutation<{ started?: boolean; reason?: string }, void>(
    async () => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/search/reindex", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error("重建索引失败。");
      return res.data as { started?: boolean; reason?: string };
    },
    {
      onSuccess: (data) => {
        if (data?.started) toast.success("索引重建已在后台开始。");
        else toast.info("已有重建任务在进行。");
        void queryClient.invalidateQueries({ queryKey: ["index-status", repoId] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const status = statusQuery.data;

  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-[13px] font-semibold">搜索索引</h2>
      <p className="text-muted-2 mt-1 text-[11px]">
        块级索引用于符号检索与语义检索，只覆盖默认分支 HEAD。
      </p>

      <div className="mt-4 grid gap-2 text-[11px] sm:grid-cols-2">
        <p className="text-muted-2">
          状态：
          <span className={status?.in_sync ? "text-sage" : "text-amber-2"}>
            {status ? (status.in_sync ? "已同步" : "落后于 HEAD") : "—"}
          </span>
        </p>
        <p className="text-muted-2">
          块 / 引用 / 向量：
          <span className="text-bone-2 font-mono">
            {status?.chunks ?? 0} / {status?.refs ?? 0} / {status?.embeddings ?? 0}
          </span>
        </p>
        <p className="text-muted-2">
          最近索引：<span className="text-bone-2">{formatRelative(status?.last_indexed_at ?? "") || "—"}</span>
        </p>
        <p className="text-muted-2">
          语义检索：<span className="text-bone-2">{status?.semantic_enabled ? "已启用" : "未启用"}</span>
        </p>
      </div>

      <Button
        size="sm"
        className="mt-3"
        onClick={() => reindexMutation.mutate()}
        disabled={reindexMutation.isPending || status?.in_sync === false}
      >
        {reindexMutation.isPending ? "请求中…" : status?.in_sync === false ? "正在重建…" : "重建索引"}
      </Button>
    </section>
  );
}
