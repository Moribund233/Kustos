import { Languages, LogOut, MoreHorizontal, PanelLeftOpen, Plus, Shield, UserRound } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation, useNavigate } from "react-router";

import { ToneAvatar } from "@/components/kit/kit";
import { BrandMark } from "@/components/brand/brand-mark";
import { CreateRepositoryDialog } from "@/features/repository/components/create-repository-dialog";
import { INSTANCE_SECTION, NAV_SECTIONS, type NavSection } from "@/components/layout/nav-sections";
import { formatRelative } from "@/lib/datetime/format";
import { cn } from "@/lib/utils";
import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from "@/lib/i18n/locales";
import { setLocale } from "@/lib/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useRepoStore, type RepoSummary } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** 当前仓库页在侧栏嵌套的「你在这里」视图；对象详情由页面自己显示。 */
const REPO_HERE: Record<string, string> = {
  "/code": "nav.code",
  "/pull-requests": "nav.pullRequests",
  "/issues": "nav.issues",
  "/chat": "nav.chat",
};

/** 由用户名推导头像缩写（full_name 优先，取首字母）。 */
function initialsOf(name: string | null | undefined, fallback: string): string {
  const source = (name ?? "").trim();
  if (!source) return fallback.slice(0, 2).toUpperCase();
  return source
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function NavItemRow({ item }: { item: NavSection["items"][number] }) {
  const { t } = useTranslation();
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) =>
        cn(
          "relative mb-0.5 flex h-[34px] items-center gap-2.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
          "text-muted hover:bg-ink-750/55 hover:text-bone",
          isActive &&
            "bg-[linear-gradient(90deg,rgba(242,174,91,0.14),rgba(242,174,91,0.025))] text-bone before:absolute before:top-2 before:bottom-2 before:-left-px before:w-0.5 before:rounded-sm before:bg-amber before:shadow-[0_0_12px_rgba(242,174,91,0.55)] before:content-['']",
        )
      }
    >
      <item.icon
        className={cn("size-[18px] shrink-0 text-muted-2", item.badgeAmber && "text-amber")}
        aria-hidden="true"
      />
      <span className="truncate">{t(item.labelKey)}</span>
      {item.badge ? (
        <span
          className={cn(
            "ml-auto rounded-full bg-bone/[0.06] px-1.5 font-mono text-[9.5px] leading-4 text-muted-2",
            item.badgeAmber && "bg-amber/10 text-amber",
            item.id === "admin" &&
              "rounded-full border border-edge-2 bg-transparent px-1.5 text-[9px] uppercase tracking-[0.05em]",
          )}
          aria-hidden="true"
        >
          {item.badge}
        </span>
      ) : null}
    </NavLink>
  );
}

function NavGroup({
  label,
  action,
  children,
}: {
  label: string;
  /** 分组标题右侧的操作按钮（如「新建仓库」）。 */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <nav aria-label={label} className="mt-[18px]">
      <p className="text-faint flex items-center gap-1 px-2.5 pb-[7px] text-[10px] font-semibold tracking-[0.16em] uppercase">
        {label}
        {action ? <span className="ml-auto">{action}</span> : null}
      </p>
      {children}
    </nav>
  );
}

function RepoRow({
  repo,
  isActive,
  onSelect,
}: {
  repo: RepoSummary;
  isActive: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "mb-0.5 grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-[9px] rounded-md px-2.5 py-1.5 text-left transition-colors",
        isActive ? "bg-ink-750/40 text-bone" : "text-muted hover:bg-ink-750/45 hover:text-bone-2",
      )}
      onClick={() => onSelect(repo.id)}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-[5px] shrink-0 rounded-full",
          isActive ? "bg-amber shadow-[0_0_8px_rgba(242,174,91,0.65)]" : "bg-faint",
        )}
      />
      <span className="min-w-0 flex flex-col gap-px">
        <span className="truncate text-[12px] font-medium leading-tight">{repo.name}</span>
        <span className="text-faint truncate text-[10px] leading-snug">
          {formatRelative(repo.updated_at)}推送
        </span>
      </span>
      <span aria-hidden="true" className="text-faint mt-0.5 self-start font-mono text-[10px]">
        {repo.watch_count || repo.star_count || ""}
      </span>
    </button>
  );
}

/**
 * 折叠态：不占全高的图标 dock。
 *
 * 只保留纯图标导航（含当前仓库页跳转），底部提供展开按钮；
 * 悬停 title 与 aria-label 给出可读名称。收起后不挤压内容，也不留空白条。
 */
function SidebarDock() {
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const expand = useUiStore((state) => state.toggleSidebar);
  const isAdmin = user?.is_admin ?? false;

  const items = [
    ...NAV_SECTIONS.flatMap((section) => section.items),
    ...(isAdmin ? INSTANCE_SECTION.items : []),
  ];

  return (
    <nav
      aria-label={t("nav.toggleSidebar")}
      className="border-edge-2 bg-ink-900/85 sticky top-4 z-30 m-3 flex h-fit w-[54px] shrink-0 flex-col items-center gap-1 rounded-xl border p-1.5 shadow-[0_14px_34px_rgba(0,0,0,0.4)] backdrop-blur"
    >
      <Link
        to="/"
        aria-label="Kustos"
        className="hover:bg-ink-800 grid size-9 place-items-center rounded-lg transition-colors"
      >
        <BrandMark size={24} />
      </Link>
      <span aria-hidden="true" className="bg-edge-1 my-1 h-px w-6" />
      {items.map((item) => (
        <NavLink
          key={item.id}
          to={item.to}
          end={item.to === "/"}
          title={t(item.labelKey)}
          aria-label={t(item.labelKey)}
          className={({ isActive }) =>
            cn(
              "text-muted-2 hover:bg-ink-800 hover:text-bone grid size-9 place-items-center rounded-lg transition-colors",
              isActive &&
                "bg-[linear-gradient(135deg,rgba(242,174,91,0.16),rgba(242,174,91,0.04))] text-amber shadow-[inset_2px_0_0_rgba(242,174,91,0.9)]",
            )
          }
        >
          <item.icon className="size-[18px]" aria-hidden="true" />
        </NavLink>
      ))}
      <span aria-hidden="true" className="bg-edge-1 my-1 h-px w-6" />
      <button
        type="button"
        onClick={expand}
        aria-label={t("nav.toggleSidebar")}
        title={t("nav.toggleSidebar")}
        className="text-muted-2 hover:bg-ink-800 hover:text-bone grid size-9 place-items-center rounded-lg transition-colors"
      >
        <PanelLeftOpen className="size-[16px]" aria-hidden="true" />
      </button>
    </nav>
  );
}

/**
 * 侧栏：品牌 → 实例卡 → 个人/仓库导航 → 仓库列表 → 底部账号。
 *
 * 仓库列表与账号信息来自真实会话（repo-store / auth-store）；层级与原型
 * 一致：当前仓库页在仓库条目下方嵌套「视图 · 对象」两行，共享同一块底色。
 */
export function Sidebar() {
  const { t, i18n } = useTranslation();
  const { pathname } = useLocation();
  const here = REPO_HERE[pathname];
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const { repos, current, select } = useRepoStore();
  const navigate = useNavigate();

  const isAdmin = user?.is_admin ?? false;
  const [createOpen, setCreateOpen] = useState(false);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);

  if (sidebarCollapsed) return <SidebarDock />;

  return (
    <nav
      aria-label={t("nav.watch")}
      className="border-edge-1 bg-ink-900 flex w-[252px] shrink-0 flex-col border-r px-3"
    >
      {/* 品牌：提灯标记 + 字标（标记为原型原始 SVG，不自绘） */}
      <div className="flex flex-none items-center gap-2.5 px-2.5 pt-[21px] pb-[15px]">
        <Link to="/" className="flex min-w-0 items-center gap-2.5 rounded-md">
          <BrandMark size={31} />
          <span className="min-w-0">
            <span className="font-display text-bone block text-[18px] font-semibold tracking-[0.155em] leading-none">
              KUSTOS
            </span>
            <span className="text-faint mt-1 block text-[8px] font-semibold tracking-[0.19em]">
              SELF-HOSTED
            </span>
          </span>
        </Link>
      </div>

      {/* 实例卡：只是标签，没有可切换的 workspace 实体 */}
      <div className="border-edge-1 bg-ink-750/55 mb-1 flex flex-none items-center gap-[9px] rounded-md border px-[9px] py-[7px]">
        <span
          aria-hidden="true"
          className="border-amber/35 bg-amber/10 grid size-[25px] shrink-0 place-items-center rounded-md border"
        >
          <BrandMark size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-bone-2 block truncate text-[12.5px] font-semibold leading-tight">
            Kustos 实例
          </span>
          <span className="text-muted-2 block truncate font-mono text-[10px] leading-snug">
            {window.location.host}
          </span>
        </span>
      </div>

      {/* 导航 */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {NAV_SECTIONS.map((section, index) => (
          <div key={section.label} className={cn(index > 0 && "mt-4 border-edge-1 border-t pt-[15px]")}>
            <NavGroup label={section.label}>
              {section.items.map((item) => (
                <NavItemRow key={item.id} item={item} />
              ))}
            </NavGroup>
          </div>
        ))}

        {/* 仓库列表（真实数据） */}
        <div className="mt-4 border-edge-1 border-t pt-[15px]">
          <NavGroup
            label="Repositories"
            action={
              <button
                type="button"
                aria-label="新建仓库"
                title="新建仓库"
                onClick={() => setCreateOpen(true)}
                className="text-muted-2 hover:text-amber-2 -my-1 inline-flex size-4 items-center justify-center rounded transition-colors"
              >
                <Plus className="size-[13px]" aria-hidden="true" />
              </button>
            }
          >
            {repos.length === 0 ? (
              <p className="text-faint px-2.5 py-1 text-[10.5px]">
                {useRepoStore.getState().loading ? "加载中…" : "还没有仓库"}
              </p>
            ) : (
              repos.map((repo) => {
                const isActive = repo.id === current?.id;
                return (
                  <div key={repo.id}>
                    <RepoRow repo={repo} isActive={isActive} onSelect={select} />
                    {isActive && here ? (
                      <div className="relative mb-1.5 flex flex-col gap-0.5 rounded-md bg-ink-750/40 py-1.5 pr-2.5 pl-[25px] before:absolute before:top-2 before:bottom-[9px] before:left-4 before:w-px before:bg-amber/40 before:content-['']">
                        <span className="text-amber text-[10px] font-semibold tracking-[0.04em] leading-snug">
                          {t(here)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </NavGroup>
        </div>

        {isAdmin ? (
          <div className="mt-4 border-edge-1 border-t pt-[15px]">
            <NavGroup label={INSTANCE_SECTION.label}>
              {INSTANCE_SECTION.items.map((item) => (
                <NavItemRow key={item.id} item={item} />
              ))}
            </NavGroup>
          </div>
        ) : null}
      </div>

      {/* 底部账号行 */}
      <div className="border-edge-1 relative flex-none border-t px-1 pt-2.5 pb-[13px]">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="hover:bg-ink-750/50 flex w-full items-center gap-[9px] rounded-md px-[9px] py-[7px] text-left transition-colors"
            >
              <ToneAvatar initials={initialsOf(user?.full_name, user?.username ?? "?")} tone="amber" size="sm" />
              <span className="min-w-0 flex-1">
                <span className="text-bone-2 block truncate text-[12px] font-medium leading-tight">
                  {user?.full_name || user?.username || "—"}
                </span>
                <span className="text-muted-2 block text-[10px] leading-tight">
                  {isAdmin ? "全局管理员" : "成员"}
                </span>
              </span>
              <MoreHorizontal className="text-muted-2 size-[15px]" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-[214px]">
            <DropdownMenuLabel className="text-[11px]">
              {user?.username} · @{user?.username}
            </DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link to="/account">
                <UserRound className="text-muted-2 size-[14px]" aria-hidden="true" />
                资料与偏好
              </Link>
            </DropdownMenuItem>
            {isAdmin ? (
              <DropdownMenuItem asChild>
                <Link to="/admin">
                  <Shield className="text-muted-2 size-[14px]" aria-hidden="true" />
                  管理控制台
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Languages className="text-muted-2 size-[14px]" aria-hidden="true" />
                {t("common.language")}
                <span className="text-faint mr-0.5 text-[10px]">
                  {LOCALE_LABELS[(i18n.resolvedLanguage ?? i18n.language) as Locale]}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={i18n.resolvedLanguage ?? i18n.language}
                  onValueChange={(value) => setLocale(value as Locale)}
                >
                  {SUPPORTED_LOCALES.map((locale) => (
                    <DropdownMenuRadioItem key={locale} value={locale}>
                      {LOCALE_LABELS[locale]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                void logout().then(() => navigate("/login", { replace: true }));
              }}
            >
              <LogOut className="text-muted-2 size-[14px]" aria-hidden="true" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CreateRepositoryDialog open={createOpen} onOpenChange={setCreateOpen} />
    </nav>
  );
}
