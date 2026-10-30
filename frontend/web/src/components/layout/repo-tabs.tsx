import { Code2, History, Package, PlayCircle, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";

import { cn } from "@/lib/utils";

const TAB_BASE =
  "relative inline-flex h-[38px] items-center gap-[7px] px-[11px] text-sm font-medium transition-colors";

/**
 * 仓库级 tab 栏。
 *
 * 只在仓库内容页出现：代码 / 提交 / Actions / Releases / 设置。
 * PR、Issue、聊天由侧栏进入，不在这排 tab 里重复。
 */
export function RepoTabs() {
  const { t } = useTranslation();

  const tabs = [
    { id: "code", to: "/code", icon: Code2, label: t("nav.code") },
    { id: "commits", to: "/commits", icon: History, label: t("nav.commits") },
    { id: "actions", to: "/actions", icon: PlayCircle, label: t("nav.actions") },
    { id: "releases", to: "/releases", icon: Package, label: t("nav.releases") },
    { id: "settings", to: "/settings", icon: Settings, label: t("nav.settings") },
  ];

  return (
    <nav className="border-edge-1 mt-0.5 flex items-center gap-0.5 border-b" aria-label={t("nav.repositoryTabs")}>
      {tabs.map((tab) => (
        <NavLink
          key={tab.id}
          to={tab.to}
          className={({ isActive }) =>
            cn(
              TAB_BASE,
              isActive
                ? "text-bone after:absolute after:right-2 after:bottom-[-1px] after:left-2 after:h-0.5 after:rounded-full after:bg-amber after:shadow-[0_0_10px_rgba(242,174,91,0.35)]"
                : "text-muted hover:bg-ink-800/35 hover:text-bone",
            )
          }
        >
          {({ isActive }) => (
            <>
              <tab.icon className={cn("size-[13px]", isActive ? "text-amber" : "text-muted-2")} aria-hidden="true" />
              {tab.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
