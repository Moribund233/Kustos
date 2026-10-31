import { Code2, History, Package, PlayCircle, Settings } from "lucide-react";
import { motion } from "motion/react";
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
 *
 * 下划线由激活项自己画：该栏随页面重挂载，跨页时整条 bar 会跟着淡出再淡入，
 * 下划线做「滑动」既看不见也会与页面过渡打架，因此只做 160ms 的生长动画，
 * 让落点有一个短促的确认感。
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
              isActive ? "text-bone" : "text-muted hover:bg-ink-800/35 hover:text-bone",
            )
          }
        >
          {({ isActive }) => (
            <>
              <tab.icon className={cn("size-[13px]", isActive ? "text-amber" : "text-muted-2")} aria-hidden="true" />
              {tab.label}
              {isActive ? (
                <motion.span
                  aria-hidden="true"
                  initial={{ opacity: 0, scaleX: 0.35 }}
                  animate={{ opacity: 1, scaleX: 1 }}
                  transition={{ duration: 0.16, ease: "easeOut" }}
                  className="bg-amber absolute inset-x-2 -bottom-px h-0.5 origin-center rounded-full shadow-[0_0_10px_rgba(242,174,91,0.35)]"
                />
              ) : null}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
