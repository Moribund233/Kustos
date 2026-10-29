import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";
import { useRepoStore } from "@/stores/repo-store";

/**
 * 危险操作：归档与删除。
 *
 * 归档保留全部数据，只从普通列表隐藏；删除会清掉仓库、Git 目录与所有
 * 关联数据（后端按外键级联），因此要求输入仓库名确认。
 */
export function DangerSection({ repoId, repoName }: { repoId: string; repoName: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const repo = useRepoStore((state) => state.current);
  const loadRepos = useRepoStore((state) => state.load);
  const [confirmName, setConfirmName] = useState("");

  const isArchived = Boolean((repo as { is_archived?: boolean } | null)?.is_archived);

  const archiveMutation = useApiMutation<void, boolean>(
    async (archive) => {
      const path = archive
        ? "/api/v1/repositories/{repo_id}/archive"
        : "/api/v1/repositories/{repo_id}/unarchive";
      const res = await api.POST(path, { params: { path: { repo_id: repoId } } });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "归档操作失败。");
      }
    },
    {
      onSuccess: async (_data, archived) => {
        toast.success(archived ? "仓库已归档。" : "仓库已取消归档。");
        await loadRepos();
        void queryClient.invalidateQueries({ queryKey: ["repositories"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const deleteMutation = useApiMutation<void, void>(
    async () => {
      const res = await api.DELETE("/api/v1/repositories/{repo_id}", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "删除仓库失败。");
      }
    },
    {
      onSuccess: async () => {
        toast.success("仓库已删除。");
        await loadRepos();
        void queryClient.invalidateQueries({ queryKey: ["repositories"] });
        navigate("/code", { replace: true });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  return (
    <section className="border-rose/25 bg-rose/[0.04] rounded-[12px] border p-5">
      <h2 className="text-rose-2 text-[13px] font-semibold">危险操作</h2>
      <p className="text-muted-2 mt-1 text-[11px]">
        归档只影响可见性；删除会移除 Git 目录与全部关联数据，且无法撤销。
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <div className="border-edge-1 flex items-center gap-3 border-b pb-3">
          <span className="text-muted flex-1 text-[11.5px]">
            {isArchived ? "仓库当前已归档，普通列表里不可见。" : "归档后从普通仓库列表隐藏，数据保留。"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => archiveMutation.mutate(!isArchived)}
            disabled={archiveMutation.isPending}
          >
            {isArchived ? "取消归档" : "归档仓库"}
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-muted-2 text-[11px]">
            删除请输入仓库名 <span className="text-bone-2 font-mono">{repoName}</span> 确认。
          </span>
          <div className="flex items-center gap-2">
            <Input
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              placeholder={repoName}
              aria-label="确认仓库名"
              className="h-8 font-mono text-[11px]"
            />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-rose hover:text-rose-2"
                  disabled={confirmName !== repoName || deleteMutation.isPending}
                >
                  删除仓库
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>永久删除 {repoName}？</AlertDialogTitle>
                  <AlertDialogDescription>
                    Git 仓库、分支、Issue、PR、Release、聊天频道与 Agent 作业会一并删除。此操作无法撤销。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => deleteMutation.mutate()}>确认删除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </section>
  );
}
