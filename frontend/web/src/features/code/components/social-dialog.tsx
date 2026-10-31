import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { SkeletonRows } from "@/components/kit/skeletons";
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const loadRepos = useRepoStore((state) => state.load);

  const base = `/api/v1/repositories/${repoId}/${mode === "star" ? "star" : "watch"}`;
  const listPath = `${base}${mode === "star" ? "gazers" : "ers"}`;

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
        toast.success(t("code.updated"));
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
          <DialogTitle>{t(mode === "star" ? "code.star" : "code.watch")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{repoName}</span> · {t("code.peopleCount", { count: people.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="border-edge-1 max-h-[280px] min-h-[100px] overflow-auto rounded-md border">
          {listQuery.isLoading ? (
            <SkeletonRows
              rows={4}
              leading="avatar"
              meta={false}
              className="p-3"
              rowClassName="px-0 py-2.5"
            />
          ) : people.length === 0 ? (
            <p className="text-muted-2 p-3 text-xs">{t("code.noPeople")}</p>
          ) : (
            <ul>
              {people.map((person) => (
                <li
                  key={person.user_id ?? person.id ?? person.username}
                  className="border-edge-1 flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
                >
                  <span className="text-bone-2 min-w-0 flex-1 truncate text-xs">
                    {person.username}
                    {person.full_name ? <span className="text-faint"> · {person.full_name}</span> : null}
                  </span>
                  <span className="text-faint text-2xs">{formatRelative(person.created_at ?? "")}</span>
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
            {active ? t(mode === "star" ? "code.unstar" : "code.unwatch") : t(mode === "star" ? "code.star" : "code.watch")}
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

