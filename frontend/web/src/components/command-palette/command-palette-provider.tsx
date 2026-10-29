import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { CommandPalette, type CommandItem } from "@/components/command-palette/command-palette";
import { NAV_SECTIONS } from "@/components/layout/nav-sections";

/**
 * 命令面板容器。
 *
 * 汇总可跳转的页面条目。仓库、PR、Issue、Agent 运行等动态条目在对应页面
 * 落地后按上下文补充——搜索源分层，避免这里塞满与当前视图无关的结果。
 */
export function CommandPaletteProvider() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  // Ctrl/⌘ + K 唤起；`/` 在非输入态也唤起，与原型一致
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (event.key === "/" && !isEditableTarget(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const items = useMemo<CommandItem[]>(
    () =>
      NAV_SECTIONS.flatMap((section) =>
        section.items.map((item) => ({
          id: item.id,
          label: t(item.labelKey),
          group: t("command.groupPages"),
          onSelect: () => navigate(item.to),
        })),
      ),
    [navigate, t],
  );

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
