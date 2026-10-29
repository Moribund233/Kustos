import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { RepoTabs } from "@/components/layout/repo-tabs";
import { BuildsSection } from "@/features/settings/components/builds-section";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

/**
 * Actions 页：仓库构建（CI 回调）列表与日志。
 *
 * 触发器/Agent 运行后续会以右缘浮窗并入这一页。
 */
export function ActionsPage() {
  const { t } = useTranslation();
  const repo = useRepoStore((state) => state.current);
  const setCrumbs = useUiStore((state) => state.setCrumbs);

  useEffect(() => {
    setCrumbs([{ label: repo?.name ?? "—" }, { label: t("nav.actions") }]);
  }, [setCrumbs, repo?.name, t]);

  return (
    <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px] pb-20">
      <header className="border-edge-1 border-b pb-5">
        <p className="text-faint text-[10.5px] font-semibold tracking-[0.16em] uppercase">
          {repo?.path ?? "—"}
        </p>
        <h1 className="font-display text-bone mt-[7px] text-[clamp(1.75rem,2.5vw,2.3rem)] leading-none font-medium tracking-tight">
          {t("actions.title")}
        </h1>
        <p className="text-muted-2 mt-2 text-[11.5px]">{t("actions.hint")}</p>
      </header>

      <RepoTabs />

      <div className="mt-4">
        {repo ? (
          <BuildsSection repoId={repo.id} />
        ) : (
          <p className="text-muted-2 text-[11.5px]">{t("settings.noRepo")}</p>
        )}
      </div>
    </div>
  );
}
