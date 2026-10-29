import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface CommandItem {
  /** 唯一标识。 */
  id: string;
  /** 展示标题。 */
  label: string;
  /** 分组名；同组内按给定顺序排列。 */
  group: string;
  /** 附加说明，排在标题右侧。 */
  hint?: string;
  /** 触发动作；不传则视为纯展示项。 */
  onSelect?: () => void;
  /** 关键词，参与搜索但不必显示。 */
  keywords?: string[];
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItem[];
}

/**
 * 命令面板。
 *
 * 对应原型的 `Ctrl/⌘ + K`（以及 `/` 唤起）：跨页面、仓库、PR、Issue、Agent 运行检索。
 * 搜索用 cmdk 自带的模糊匹配，条目由调用方按当前上下文组装。
 */
export function CommandPalette({ open, onOpenChange, items }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");

  // 关闭时清空搜索词，下次打开是干净的
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const grouped = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const item of items) {
      const bucket = map.get(item.group);
      if (bucket) bucket.push(item);
      else map.set(item.group, [item]);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-edge-2 bg-ink-850 p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogTitle className="sr-only">{t("common.search")}</DialogTitle>
        <DialogDescription className="sr-only">{t("command.placeholder")}</DialogDescription>
        <Command
          loop
          shouldFilter
          className="flex flex-col"
          // 面板内的输入框由 cmdk 提供，Enter 直接触发首个匹配项
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onOpenChange(false);
            }
          }}
        >
          <Command.Input
            value={search}
            onValueChange={setSearch}
            placeholder={t("command.placeholder")}
            className="border-edge-2 text-bone placeholder:text-faint h-11 w-full border-b bg-transparent px-4 text-[13px] outline-none"
          />
          <Command.List className="max-h-80 overflow-y-auto p-1.5">
            <Command.Empty className="text-faint py-6 text-center text-[13px]">
              {t("command.noResults")}
            </Command.Empty>
            {grouped.map(([group, groupItems]) => (
              <Command.Group
                key={group}
                heading={group}
                className="[&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:tracking-[0.15em] [&_[cmdk-group-heading]]:uppercase"
              >
                {groupItems.map((item) => (
                  <Command.Item
                    key={item.id}
                    value={`${item.label} ${item.keywords?.join(" ") ?? ""}`}
                    onSelect={() => {
                      item.onSelect?.();
                      onOpenChange(false);
                    }}
                    className={cn(
                      "text-muted data-[selected=true]:bg-ink-750 data-[selected=true]:text-bone-2 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px]",
                    )}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.hint && (
                      <span className="text-faint ml-auto truncate text-[11px]">{item.hint}</span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
