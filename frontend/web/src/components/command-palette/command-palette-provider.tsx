import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { CommandPalette, type CommandItem } from "@/components/command-palette/command-palette";
import { INSTANCE_SECTION, NAV_SECTIONS } from "@/components/layout/nav-sections";
import { useAuthStore } from "@/stores/auth-store";
import { api } from "@/lib/api/client";
import { useApiQuery } from "@/lib/api/hooks";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

/** GET /api/v1/search/global 的返回体。 */
interface GlobalSearchResult {
  repositories: { repository_id: string; name: string; path: string }[];
  issues: { repository_id: string; repository_path: string; issue_number: number; title: string }[];
  pull_requests: { repository_id: string; repository_path: string; pr_number: number; title: string }[];
}

/**
 * 命令面板容器。
 *
 * 汇总固定页面、仓库、实例管理面，以及输入关键词后的全局检索结果
 * （仓库 / Issue / PR，来自 `/api/v1/search/global`）。
 */
export function CommandPaletteProvider() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const open = useUiStore((state) => state.paletteOpen);
  const setOpen = useUiStore((state) => state.setPaletteOpen);
  const togglePalette = useUiStore((state) => state.togglePalette);
  const repos = useRepoStore((state) => state.repos);
  const selectRepo = useRepoStore((state) => state.select);
  const isAdmin = useAuthStore((state) => state.user?.is_admin ?? false);
  const [query, setQuery] = useState("");
  const trimmed = query.trim();

  // 只在面板打开且有输入时请求；输入变化后由 React Query 去重缓存
  const searchQuery = useApiQuery<GlobalSearchResult>({
    queryKey: ["global-search", trimmed],
    enabled: open && trimmed.length > 0,
    queryFn: async () => {
      const res = await api.GET("/api/v1/search/global", {
        params: { query: { q: trimmed, per_type: 5 } },
      });
      if (res.error) throw new Error("搜索失败。");
      return res.data as unknown as GlobalSearchResult;
    },
  });

  // Ctrl/⌘ + K 唤起；`/` 在非输入态也唤起，与原型一致
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        togglePalette();
        return;
      }
      if (event.key === "/" && !isEditableTarget(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [setOpen, togglePalette]);

  const items = useMemo<CommandItem[]>(() => {
    const pages: CommandItem[] = NAV_SECTIONS.flatMap((section) =>
      section.items.map((item) => ({
        id: item.id,
        label: t(item.labelKey),
        group: t("command.groupPages"),
        onSelect: () => navigate(item.to),
      })),
    );
    const repoItems: CommandItem[] = (trimmed ? [] : repos).map((repo) => ({
      id: `repo-${repo.id}`,
      label: repo.path,
      group: t("command.groupRepositories"),
      hint: repo.default_branch,
      // 选中仓库再进代码页：两页共用 repo-store，切换即全局生效
      onSelect: () => {
        selectRepo(repo.id);
        navigate("/code");
      },
    }));
    const instance: CommandItem[] = isAdmin
      ? INSTANCE_SECTION.items.map((item) => ({
          id: item.id,
          label: t(item.labelKey),
          group: t("command.groupPages"),
          onSelect: () => navigate(item.to),
        }))
      : [];
    const result = searchQuery.data;
    const searchItems: CommandItem[] = trimmed
      ? [
          ...(result?.repositories ?? []).map((repo) => ({
            id: `search-repo-${repo.repository_id}`,
            label: repo.path,
            group: t("command.groupRepositories"),
            hint: repo.name,
            onSelect: () => {
              selectRepo(repo.repository_id);
              navigate("/code");
            },
          })),
          ...(result?.issues ?? []).map((issue) => ({
            id: `search-issue-${issue.repository_id}-${issue.issue_number}`,
            label: issue.title,
            group: t("command.groupIssues"),
            hint: `${issue.repository_path}#${issue.issue_number}`,
            onSelect: () => {
              selectRepo(issue.repository_id);
              navigate(`/issues?issue=${issue.issue_number}`);
            },
          })),
          ...(result?.pull_requests ?? []).map((pr) => ({
            id: `search-pr-${pr.repository_id}-${pr.pr_number}`,
            label: pr.title,
            group: t("command.groupPullRequests"),
            hint: `${pr.repository_path}#${pr.pr_number}`,
            onSelect: () => {
              selectRepo(pr.repository_id);
              navigate(`/pull-requests?pr=${pr.pr_number}`);
            },
          })),
        ]
      : [];

    return [...pages, ...instance, ...repoItems, ...searchItems];
  }, [navigate, t, repos, selectRepo, isAdmin, trimmed, searchQuery.data]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      items={items}
      query={query}
      onQueryChange={setQuery}
      loading={searchQuery.isPending && trimmed.length > 0}
    />
  );
}

/**
 * 判断事件目标是否是可输入元素。
 *
 * 在输入框里按 `/` 应该打出斜杠，而不是弹出命令面板。
 *
 * @param target 事件目标
 * @returns 是否为可输入元素
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}
