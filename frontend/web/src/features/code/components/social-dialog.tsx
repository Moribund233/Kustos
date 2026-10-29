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
import { formatRelative } from "@/lib/datetime/format";
import { getAccessToken } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { useRepoStore } from "@/stores/repo-store";

interface PersonRow {
  id?: string;
  user_id?: string;
  username: string;
  full_name?: string | null;
  created_at?: string | null;
}

interface StatusShape {
  starred?: boolean;
  watching?: boolean;
}

/**
 * Star / Watch。
 *
 * 关注与收藏都按用户生效（不是仓库级开关）：列表展示当前仓库的
 * stargazers / watchers，切换后重拉仓库列表以更新页头计数。
 */
export function SocialDialog({
  mode,
  repoId,
  repoName,
  open,
  onOpenChange,
}: {
  mode: "star" | "watch";
  repoId: string;
  repoName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const loadRepos = useRepoStore((state) => state.load);

  const base = `/api/v1/repositories/${repoId}/${mode === "star" ? "star" : "watch"}`;
  const listPath = `${base}${mode === "star" ? "gazers" : "ers"}`;
  const label = mode === "star" ? "Star" : "关注";

  const statusQuery = useApiQuery<StatusShape>({
    queryKey: [mode, repoId],
    enabled: open && !!repoId,
    queryFn: async () => {
      const data = await request("GET", base);
      return (data ?? {}) as StatusShape;
    },
  });

  const listQuery = useApiQuery<PersonRow[]>({
    queryKey: [`${mode}-list`, repoId],
    enabled: open && !!repoId,
    queryFn: async () => {
      const data = await request("GET", listPath);
      return (Array.isArray(data) ? data : []) as PersonRow[];
    },
  });

  const toggleMutation = useApiMutation<void, boolean>(
    async (active) => {
      await request(active ? "DELETE" : "POST", base);
    },
    {
      onSuccess: async () => {
        await loadRepos();
        void queryClient.invalidateQueries({ queryKey: [mode, repoId] });
        void queryClient.invalidateQueries({ queryKey: [`${mode}-list`, repoId] });
        toast.success("已更新。");
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const active = Boolean(mode === "star" ? statusQuery.data?.starred : statusQuery.data?.watching);
  const people = listQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{repoName}</span> · {people.length} 人
          </DialogDescription>
        </DialogHeader>

        <div className="border-edge-1 max-h-[280px] min-h-[100px] overflow-auto rounded-md border">
          {listQuery.isLoading ? (
            <p className="text-muted-2 p-3 text-[11.5px]">加载中…</p>
          ) : people.length === 0 ? (
            <p className="text-muted-2 p-3 text-[11.5px]">还没有人。</p>
          ) : (
            <ul>
              {people.map((person) => (
                <li
                  key={person.user_id ?? person.id ?? person.username}
                  className="border-edge-1 flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
                >
                  <span className="text-bone-2 min-w-0 flex-1 truncate text-[11.5px]">
                    {person.username}
                    {person.full_name ? <span className="text-faint"> · {person.full_name}</span> : null}
                  </span>
                  <span className="text-faint text-[10px]">{formatRelative(person.created_at ?? "")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button
            onClick={() => toggleMutation.mutate(active)}
            disabled={toggleMutation.isPending}
          >
            {active ? `取消${label}` : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** star / watch 端点在生成的 schema 里未建模，统一走原生 fetch。 */
async function request(method: string, path: string): Promise<unknown> {
  const token = getAccessToken();
  const res = await fetch(path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(payload.detail ?? `请求失败（${res.status}）。`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

