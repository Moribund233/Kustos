import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const branchesQuery = useApiQuery<BranchRow[]>({
    queryKey: ["branches", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/branches", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error(t("settings.branchLoadFailed"));
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
        if (res.error) throw new Error(t("settings.defaultFailed"));
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
        throw new Error(detail ?? t("settings.protectionFailed"));
      }
    },
    {
      onSuccess: () => {
        toast.success(t("settings.branchUpdated"));
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const branches = branchesQuery.data ?? [];

  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-base font-semibold">{t("settings.branches")}</h2>
      <p className="text-muted-2 mt-1 text-xs">
        {t("settings.branchesHint")}
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {branchesQuery.isLoading ? (
          <p className="text-muted-2 text-xs">{t("common.loading")}</p>
        ) : branches.length === 0 ? (
          <p className="text-muted-2 text-xs">{t("settings.noBranches")}</p>
        ) : (
          branches.map((branch) => (
            <div
              key={branch.name}
              data-branch={branch.name}
              className="border-edge-1 rounded-md border px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-bone-2 min-w-0 flex-1 truncate font-mono text-xs">
                  {branch.name}
                </span>
                {branch.is_default ? (
                  <span className="border-edge-2 text-muted rounded-full border px-1.5 py-0.5 text-2xs">
                    {t("settings.defaultBadge")}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-muted-2 hover:text-amber-2 text-2xs transition-colors"
                    onClick={() => mutation.mutate({ name: branch.name, action: "default" })}
                  >
                    {t("settings.setDefault")}
                  </button>
                )}
                <button
                  type="button"
                  className="border-edge-2 text-muted hover:border-edge-3 hover:text-bone-2 inline-flex h-6 items-center rounded-md border px-2 text-2xs transition-colors"
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
                  {branch.is_protected ? t("settings.unprotect") : t("settings.protect")}
                </button>
              </div>

              {branch.is_protected ? (
                <div className="border-edge-1 mt-2 flex flex-wrap items-center gap-4 border-t pt-2">
                  <label className="flex items-center gap-2">
                    <span className="text-muted-2 text-xs">{t("settings.requireReview")}</span>
                    <Switch
                      checked={branch.require_code_review ?? false}
                      aria-label={`${branch.name} ${t("settings.requireReview")}`}
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
                    <span className="text-muted-2 text-xs">{t("settings.requireChecks")}</span>
                    <Switch
                      checked={branch.require_status_checks ?? false}
                      aria-label={`${branch.name} ${t("settings.requireChecks")}`}
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
