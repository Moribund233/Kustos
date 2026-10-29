import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";

/** GET /branches 的行（branch_service 返回模型字段）。 */
interface BranchRow {
  name: string;
  is_default: boolean;
  is_protected: boolean;
  require_code_review?: boolean;
  require_status_checks?: boolean;
}

/**
 * 分支保护与默认分支。
 *
 * 默认分支决定克隆后的 HEAD；保护开关由后端 `branch_controller` 裁决，
 * 需要仓库管理权限。开启了保护的仓库在 PR 合并时会读这些标志。
 */
export function BranchesSection({ repoId }: { repoId: string }) {
  const queryClient = useQueryClient();

  const branchesQuery = useApiQuery<BranchRow[]>({
    queryKey: ["branches", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/branches", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error("分支加载失败。");
      return (Array.isArray(res.data) ? res.data : []) as BranchRow[];
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["branches", repoId] });

  const mutation = useApiMutation<void, { name: string; action: "default" | "protect" | "unprotect"; settings?: Record<string, boolean> }>(
    async ({ name, action, settings }) => {
      if (action === "default") {
        const res = await api.PUT("/api/v1/repositories/{repo_id}/branches/{branch_name}/default", {
          params: { path: { repo_id: repoId, branch_name: name } },
        });
        if (res.error) throw new Error("设置默认分支失败。");
        return;
      }
      const res =
        action === "protect"
          ? await api.PUT("/api/v1/repositories/{repo_id}/branches/{branch_name}/protect", {
              params: { path: { repo_id: repoId, branch_name: name } },
              body: settings as never,
            })
          : await api.PUT("/api/v1/repositories/{repo_id}/branches/{branch_name}/unprotect", {
              params: { path: { repo_id: repoId, branch_name: name } },
            });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "分支保护更新失败。");
      }
    },
    {
      onSuccess: () => {
        toast.success("分支设置已更新。");
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const branches = branchesQuery.data ?? [];

  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-[13px] font-semibold">分支与保护</h2>
      <p className="text-muted-2 mt-1 text-[11px]">
        保护分支会阻止直接推送；要求评审 / 状态检查会在 PR 合并时校验。
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {branchesQuery.isLoading ? (
          <p className="text-muted-2 text-[11.5px]">加载中…</p>
        ) : branches.length === 0 ? (
          <p className="text-muted-2 text-[11.5px]">还没有分支。</p>
        ) : (
          branches.map((branch) => (
            <div
              key={branch.name}
              data-branch={branch.name}
              className="border-edge-1 rounded-md border px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-bone-2 min-w-0 flex-1 truncate font-mono text-[11.5px]">
                  {branch.name}
                </span>
                {branch.is_default ? (
                  <span className="border-edge-2 text-muted rounded-full border px-1.5 py-0.5 text-[9.5px]">
                    默认
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-muted-2 hover:text-amber-2 text-[10px] transition-colors"
                    onClick={() => mutation.mutate({ name: branch.name, action: "default" })}
                  >
                    设为默认
                  </button>
                )}
                <button
                  type="button"
                  className="border-edge-2 text-muted hover:border-edge-3 hover:text-bone-2 inline-flex h-6 items-center rounded-md border px-2 text-[10px] transition-colors"
                  onClick={() =>
                    mutation.mutate({
                      name: branch.name,
                      action: branch.is_protected ? "unprotect" : "protect",
                      settings: branch.is_protected
                        ? undefined
                        : { require_code_review: true, require_status_checks: false },
                    })
                  }
                >
                  {branch.is_protected ? "取消保护" : "保护分支"}
                </button>
              </div>

              {branch.is_protected ? (
                <div className="border-edge-1 mt-2 flex flex-wrap items-center gap-4 border-t pt-2">
                  <label className="flex items-center gap-2">
                    <span className="text-muted-2 text-[10.5px]">要求评审</span>
                    <Switch
                      checked={branch.require_code_review ?? false}
                      aria-label={`${branch.name} 要求评审`}
                      onCheckedChange={(checked) =>
                        mutation.mutate({
                          name: branch.name,
                          action: "protect",
                          settings: {
                            require_code_review: checked,
                            require_status_checks: branch.require_status_checks ?? false,
                          },
                        })
                      }
                    />
                  </label>
                  <label className="flex items-center gap-2">
                    <span className="text-muted-2 text-[10.5px]">要求状态检查</span>
                    <Switch
                      checked={branch.require_status_checks ?? false}
                      aria-label={`${branch.name} 要求状态检查`}
                      onCheckedChange={(checked) =>
                        mutation.mutate({
                          name: branch.name,
                          action: "protect",
                          settings: {
                            require_code_review: branch.require_code_review ?? false,
                            require_status_checks: checked,
                          },
                        })
                      }
                    />
                  </label>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
