import { useTranslation } from "react-i18next";

import { api } from "@/lib/api/client";
import { useApiQuery } from "@/lib/api/hooks";

interface RepoStats {
  pr_count?: number;
  issue_count?: number;
  review_count?: number;
  star_count?: number;
  member_count?: number;
}

/** 仓库聚合统计：PR / Issue / 评审 / Star / 成员。 */
export function RepoStatsRow({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const statsQuery = useApiQuery<RepoStats>({
    queryKey: ["repo-stats", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/stats", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error(t("settings.statsLoadFailed"));
      return res.data as RepoStats;
    },
  });

  const items = [
    { label: t("settings.statPr"), value: statsQuery.data?.pr_count ?? 0 },
    { label: t("settings.statIssue"), value: statsQuery.data?.issue_count ?? 0 },
    { label: t("settings.statReview"), value: statsQuery.data?.review_count ?? 0 },
    { label: t("settings.statStar"), value: statsQuery.data?.star_count ?? 0 },
    { label: t("settings.statMembers"), value: statsQuery.data?.member_count ?? 0 },
  ];

  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-base font-semibold">{t("settings.stats")}</h2>
      <div className="mt-4 grid grid-cols-5 gap-3">
        {items.map((item) => (
          <div key={item.label}>
            <p className="text-muted-2 text-2xs font-semibold tracking-[0.13em] uppercase">{item.label}</p>
            <p className="text-bone mt-1 font-mono text-2xl leading-none">{item.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
