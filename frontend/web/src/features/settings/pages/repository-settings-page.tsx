import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";

import { Chip } from "@/components/kit/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BranchesSection } from "@/features/settings/components/branches-section";
import { BuildsSection } from "@/features/settings/components/builds-section";
import { DiscussionsSection } from "@/features/settings/components/discussions-section";
import { DangerSection } from "@/features/settings/components/danger-section";
import { IndexSection } from "@/features/settings/components/index-section";
import { LabelsSection } from "@/features/settings/components/labels-section";
import { MembersSection } from "@/features/settings/components/members-section";
import { RepoStatsRow } from "@/features/settings/components/repo-stats";
import { TagsSection } from "@/features/settings/components/tags-section";
import { WebhooksSection } from "@/features/settings/components/webhooks-section";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

/**
 * 仓库设置页。
 *
 * 只做能改的字段（名称 / 描述 / 可见性）：路径由 `owner/name` 决定，改名会牵动
 * 克隆地址与已有引用，交给后端冲突校验而不是在这里猜。保存后重拉仓库列表，
 * 侧栏与其它页面的仓库信息随之更新。
 */
export function RepositorySettingsPage() {
  const { t } = useTranslation();
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const repo = useRepoStore((state) => state.current);
  const loadRepos = useRepoStore((state) => state.load);
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  // 切仓库时用新数据重填，避免把上一个仓库的字段带过来
  useEffect(() => {
    if (!repo) return;
    setName(repo.name);
    setDescription(repo.description ?? "");
    setIsPublic(repo.is_public);
    setCrumbs([{ label: repo.name }, { label: t("nav.settings") }]);
  }, [repo, setCrumbs, t]);

  const saveMutation = useApiMutation<
    { id: string },
    { name: string; description: string; is_public: boolean }
  >(
    async (input) => {
      const res = await api.PUT("/api/v1/repositories/{repo_id}", {
        params: { path: { repo_id: repo?.id ?? "" } },
        body: input,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("settings.saveFailed"));
      }
      return res.data as { id: string };
    },
    {
      onSuccess: async () => {
        toast.success(t("settings.saved"));
        await loadRepos();
        void queryClient.invalidateQueries({ queryKey: ["repositories"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  if (!repo) {
    return (
      <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px]">
        <h1 className="font-display text-bone text-[clamp(1.7rem,2.6vw,2.3rem)] font-medium tracking-[-0.028em] leading-none">
          {t("settings.title")}
        </h1>
        <p className="text-muted-2 mt-4 text-[12px]">{t("settings.noRepo")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[860px] px-[34px] pt-[30px] pb-20">
      <header className="mb-6">
        <p className="text-faint text-[10.5px] font-semibold tracking-[0.16em] uppercase">{repo.path}</p>
        <h1 className="font-display text-bone mt-1.5 text-[clamp(1.7rem,2.6vw,2.3rem)] font-medium tracking-[-0.028em] leading-none">
          {t("settings.title")}
        </h1>
        <p className="text-muted-2 mt-2 text-[11.5px]">
          {t("settings.pathHint", { path: repo.path })}
        </p>
      </header>

      <div className="border-edge-2 bg-ink-900/50 flex flex-col gap-4 rounded-[12px] border p-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-muted-2 text-[10px] font-semibold tracking-[0.13em] uppercase">{t("settings.name")}</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label={t("settings.name")}
            placeholder={t("settings.name")}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-muted-2 text-[10px] font-semibold tracking-[0.13em] uppercase">{t("settings.description")}</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-label={t("settings.description")}
            rows={3}
            placeholder={t("settings.description")}
            className="border-edge-2 bg-ink-950/60 text-bone placeholder:text-muted-2 focus:border-amber/40 min-h-[70px] w-full resize-none rounded-md border px-2.5 py-2 text-[12px] outline-none transition-colors"
          />
        </label>

        <div className="flex items-center gap-2">
          <span className="text-muted-2 text-[10px] font-semibold tracking-[0.13em] uppercase">{t("settings.visibility")}</span>
          <Chip active={isPublic} onClick={() => setIsPublic(true)}>
            {t("repository.public")}
          </Chip>
          <Chip active={!isPublic} onClick={() => setIsPublic(false)}>
            {t("repository.private")}
          </Chip>
        </div>

        <div className="border-edge-1 flex items-center gap-2 border-t pt-4">
          <Button
            size="sm"
            onClick={() =>
              saveMutation.mutate({ name: name.trim(), description: description.trim(), is_public: isPublic })
            }
            disabled={!name.trim() || saveMutation.isPending}
          >
            {saveMutation.isPending ? t("common.saving") : t("common.save")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setName(repo.name);
              setDescription(repo.description ?? "");
              setIsPublic(repo.is_public);
            }}
          >
            {t("settings.reset")}
          </Button>
          <Link
            to="/code"
            className="text-muted-2 hover:text-amber-2 ml-auto text-[11px] transition-colors"
          >
            {t("settings.backToCode")}
          </Link>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <RepoStatsRow repoId={repo.id} />
        <MembersSection repoId={repo.id} />
        <LabelsSection repoId={repo.id} />
        <TagsSection repoId={repo.id} />
        <BranchesSection repoId={repo.id} />
        <IndexSection repoId={repo.id} />
        <BuildsSection repoId={repo.id} />
        <DiscussionsSection repoId={repo.id} />
        <WebhooksSection repoId={repo.id} />
        <DangerSection repoId={repo.id} repoName={repo.name} />
      </div>
    </div>
  );
}
