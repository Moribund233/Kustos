import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";

import { cn } from "@/lib/utils";
import { INSTANCE_ICON, NAV_SECTIONS, type NavSection } from "./nav-sections";

interface SidebarProps {
  /** 过滤后的导航分区；未传则显示全部。 */
  sections?: NavSection[];
}

export function Sidebar({ sections = NAV_SECTIONS }: SidebarProps) {
  const { t } = useTranslation();
  const InstanceIcon = INSTANCE_ICON;

  return (
    <nav
      aria-label={t("nav.watch")}
      className="border-edge-1 bg-ink-950 flex w-[232px] shrink-0 flex-col border-r"
    >
      <div className="flex h-14 items-center gap-2 px-4">
        <span className="bg-amber/15 text-amber-2 grid size-6 place-items-center rounded text-[13px]">
          K
        </span>
        <span className="font-display text-bone text-[15px]">Kustos</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {sections.map((section) => (
          <div key={section.label} className="mt-4">
            <p className="text-faint px-2 pb-1.5 text-[10px] font-semibold tracking-[0.15em] uppercase">
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.id}>
                  <NavLink
                    to={item.to}
                    end={item.to === "/"}
                    className={({ isActive }) =>
                      cn(
                        "text-muted hover:bg-ink-850 hover:text-bone-2 flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px]",
                        isActive && "bg-ink-850 text-bone-2",
                      )
                    }
                  >
                    <item.icon className="text-faint size-4 shrink-0" />
                    <span className="truncate">{t(item.labelKey)}</span>
                    {item.badge ? (
                      <span className="text-faint ml-auto font-mono text-[10px]">{item.badge}</span>
                    ) : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-edge-1 text-faint border-t px-4 py-3 text-[11px]">
        <span className="inline-flex items-center gap-1.5">
          <InstanceIcon className="size-3.5" />
          {t("auth.selfHosted")}
        </span>
      </div>
    </nav>
  );
}
