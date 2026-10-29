import type { ReactNode } from "react";

import { LocaleSwitcher } from "@/components/layout/locale-switcher";

interface TopbarProps {
  title?: string;
  actions?: ReactNode;
}

export function Topbar({ title = "Kustos", actions }: TopbarProps) {
  return (
    <header className="border-edge-1 bg-ink-950/80 flex h-14 shrink-0 items-center gap-4 border-b px-5 backdrop-blur">
      <h1 className="font-display text-bone text-[15px]">{title}</h1>
      <div className="ml-auto flex items-center gap-2">
        {actions}
        <LocaleSwitcher />
      </div>
    </header>
  );
}
