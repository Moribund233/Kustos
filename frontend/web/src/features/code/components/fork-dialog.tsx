import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { formatRelative } from "@/lib/datetime/format";
import { useRepoStore } from "@/stores/repo-store";

interface ForkRow {
  id: string;
  name: string;
  path: string;
  updated_at: string | null;
}

interface ForkPage {
  items?: ForkRow[];
  total?: number;
}

interface ForkSource {
  id: string;
  name: string;
  path: string;
}

/**
 * Fork 管理。
 *
 * Fork 会复制 Git 仓库与数据行；如果当前仓库本身是 Fork，可从这里同步上游。
 * 列表来自 `GET /forks`，源仓库来自 `GET /forks/source`。
 */
export function ForkDialog({
  repoId,
  repoName,
  open,
  onOpenChange,
}: {
  repoId: string;
  repoName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const loadRepos = useRepoStore((state) => state.load);
  const select = useRepoStore((state) => state.select);
  const [name, setName] = useState(`${repoName}-fork`);

  const forksQuery = useApiQuery<ForkRow[]>({
    queryKey: ["forks", repoId],
    enabled: open && !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/forks", {
        params: { path: { repo_id: repoId }, query: { page: 1, limit: 50 } },
      });
      if (res.error) throw new Error("Fork 列表加载失败。");
      return (res.data as ForkPage | undefined)?.items ?? [];
    },
  });

  const sourceQuery = useApiQuery<ForkSource | null>({
    queryKey: ["fork-source", repoId],
    enabled: open && !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/forks/source", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) return null;
      return (res.data as ForkSource | null) ?? null;
    },
  });

  const forkMutation = useApiMutation<ForkRow, void>(
    async () => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/forks", {
        params: { path: { repo_id: repoId } },
        body: { name: name.trim(), is_public: undefined } as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "Fork 失败。");
      }
      return res.data as ForkRow;
    },
    {
      onSuccess: async (fork) => {
        toast.success(`已 Fork 为 ${fork.path}。`);
        await loadRepos();
        select(fork.id);
        onOpenChange(false);
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const syncMutation = useApiMutation<void, void>(
    async () => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/forks/sync", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "同步上游失败。");
      }
    },
    {
      onSuccess: () => {
        toast.success("已同步上游。");
        void queryClient.invalidateQueries({ queryKey: ["forks", repoId] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const forks = forksQuery.data ?? [];
  const source = sourceQuery.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Fork</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{repoName}</span> · Fork 会复制 Git 仓库与数据
          </DialogDescription>
        </DialogHeader>

        {source ? (
          <div className="border-edge-1 flex items-center gap-2 rounded-md border px-3 py-2">
            <span className="text-muted text-[11.5px]">
              当前仓库 Fork 自 <span className="text-bone-2 font-mono">{source.path}</span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
            >
              同步上游
            </Button>
          </div>
        ) : null}

        <div className="border-edge-1 max-h-[240px] min-h-[80px] overflow-auto rounded-md border">
          {forksQuery.isLoading ? (
            <p className="text-muted-2 p-3 text-[11.5px]">加载中…</p>
          ) : forks.length === 0 ? (
            <p className="text-muted-2 p-3 text-[11.5px]">还没有 Fork。</p>
          ) : (
            <ul>
              {forks.map((fork) => (
                <li
                  key={fork.id}
                  className="border-edge-1 flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
                >
                  <span className="text-bone-2 min-w-0 flex-1 truncate font-mono text-[11px]">
                    {fork.path}
                  </span>
                  <span className="text-faint text-[10px]">{formatRelative(fork.updated_at ?? "")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Fork 名称"
            aria-label="Fork 名称"
            className="h-8 font-mono text-[11px]"
          />
          <Button
            size="sm"
            onClick={() => forkMutation.mutate()}
            disabled={!name.trim() || forkMutation.isPending}
          >
            {forkMutation.isPending ? "Fork 中…" : "创建 Fork"}
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
