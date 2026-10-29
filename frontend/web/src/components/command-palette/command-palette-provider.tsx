import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { CommandPalette, type CommandItem } from "@/components/command-palette/command-palette";
import { INSTANCE_SECTION, NAV_SECTIONS } from "@/components/layout/nav-sections";
import { useAuthStore } from "@/stores/auth-store";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

/**
 * 命令面板容器。
 *
 * 汇总三类可跳转条目：固定页面、当前用户可访问的仓库、实例管理面（仅管理员）。
 * PR / Issue / Agent 运行等对象级条目要等各自页面的检索接口，不在这里造静态结果。
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
    const repoItems: CommandItem[] = repos.map((repo) => ({
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
    return [...pages, ...instance, ...repoItems];
  }, [navigate, t, repos, selectRepo, isAdmin]);

  return <CommandPalette open={open} onOpenChange={setOpen} items={items} />;
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
