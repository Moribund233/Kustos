import { Bell, Bot, BookOpen, Command, KeyRound, LogOut, Plus, Search, Shield, UserRound, Zap } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { Lamp, ToneAvatar } from "@/components/kit/kit";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { api } from "@/lib/api/client";
import { formatRelative } from "@/lib/datetime/format";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import { useUiStore } from "@/stores/ui-store";
import { useApiQuery } from "@/lib/api/hooks";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** 站内通知（GET /api/v1/notifications 的列表项，按后端模型取字段）。 */
interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

/** 通知类型的图标与色调映射；未知类型回落到中性。 */
const NOTIF_STYLE: Record<string, { icon: typeof Bot; tone: string }> = {
  pr: { icon: BookOpen, tone: "text-amber bg-amber/10" },
  pull_request: { icon: BookOpen, tone: "text-amber bg-amber/10" },
  issue: { icon: Zap, tone: "text-sky bg-sky/10" },
  agent: { icon: Bot, tone: "text-amber bg-amber/10" },
  mention: { icon: Bell, tone: "text-sage bg-sage/10" },
};

/** 平台感知的搜索快捷键文案。 */
function useSearchShortcut() {
  const [label, setLabel] = useState("Ctrl K");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || "")) setLabel("⌘ K");
  }, []);
  return label;
}

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

/**
 * 顶栏：面包屑 + 全局搜索 + Agent 状态 + 通知 / 新建 / 账号菜单。
 *
 * 面包屑由当前页面写入 ui-store；搜索触发命令面板（状态也在 ui-store，
 * 与 Ctrl/⌘+K 共用一个开关）。通知来自站内信接口。
 */
export function Topbar() {
  const { t } = useTranslation();
  const crumbs = useUiStore((state) => state.crumbs);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);
  const shortcut = useSearchShortcut();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const isAdmin = user?.is_admin ?? false;

  const { data: notifications } = useApiQuery<NotificationItem[]>({
    queryKey: ["notifications"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/notifications", { params: { query: { page: 1, limit: 20 } } });
      const payload = res.data as { items?: NotificationItem[] } | undefined;
      return payload?.items ?? [];
    },
  });

  const unread = (notifications ?? []).filter((item) => !item.is_read).length;

  /** 全部已读：服务端标记后本地失效通知缓存。 */
  const markAllRead = async () => {
    await api.POST("/api/v1/notifications/read-all", {});
    await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    toast.success("通知已全部标记为已读。");
  };

  return (
    <header className="border-edge-1 bg-ink-950/80 sticky top-0 z-40 flex h-14 shrink-0 items-center gap-4 border-b px-7 backdrop-blur-[16px] saturate-[1.05] after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-[linear-gradient(90deg,transparent,rgba(242,174,91,0.12),transparent)] after:content-['']">
      {/* 面包屑 */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-[0_1_auto] items-center gap-[7px] overflow-hidden text-[12px] whitespace-nowrap">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-[7px]">
            {index > 0 ? (
              <span aria-hidden="true" className="text-faint font-mono text-[10px]">
                /
              </span>
            ) : null}
            {crumb.to && index < crumbs.length - 1 ? (
              <Link to={crumb.to} className="text-muted-2 hover:text-bone rounded-sm transition-colors">
                {crumb.label}
              </Link>
            ) : (
              <span
                aria-current={index === crumbs.length - 1 ? "page" : undefined}
                className={cn(
                  "truncate",
                  index === crumbs.length - 1 ? "text-bone-2 max-w-[220px]" : "text-muted-2",
                )}
              >
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      {/* 全局搜索 */}
      <button
        type="button"
        aria-label="搜索 Kustos"
        onClick={() => setPaletteOpen(true)}
        className="border-edge-1 bg-ink-800/55 hover:border-edge-2 hover:text-muted flex h-8 w-[310px] items-center gap-2 rounded-md border px-2.5 text-left text-[11.5px] text-muted-2 transition-colors hover:bg-ink-800"
      >
        <Search className="size-[15px]" aria-hidden="true" />
        <span className="truncate">{t("command.placeholder")}</span>
        <KbdHint>{shortcut}</KbdHint>
      </button>

      <div className="ml-auto flex items-center gap-2">
        {/* Agent 状态胶囊 */}
        <Link
          to="/agent"
          className="border-amber/[0.24] bg-amber/[0.07] hover:border-amber/[0.42] hover:bg-amber/[0.13] text-amber-2 flex h-[30px] items-center gap-[7px] whitespace-nowrap rounded-full border px-2.5 text-[11px] font-medium transition-colors"
        >
          <Lamp tone="warn" live />
          <span>
            <strong className="text-bone font-semibold">{t("nav.agent")}</strong>
          </span>
        </Link>

        {/* 通知 */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("nav.notifications")}
              className="border-edge-1 hover:bg-ink-750/60 hover:text-bone relative grid size-[30px] place-items-center rounded-md border text-muted transition-colors"
            >
              <Bell className="size-[17px]" aria-hidden="true" />
              {unread > 0 ? (
                <span
                  aria-hidden="true"
                  className="border-ink-950 bg-amber absolute top-[5px] right-1 size-[5px] rounded-full border shadow-[0_0_7px_rgba(242,174,91,0.7)]"
                />
              ) : null}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[350px] overflow-hidden rounded-[10px] p-0">
            <div className="border-edge-1 flex items-center gap-2.5 border-b px-[13px] py-3">
              <h3 className="text-[12px] font-semibold">{t("nav.notifications")}</h3>
              {unread > 0 ? (
                <button
                  type="button"
                  className="text-muted-2 hover:text-bone ml-auto text-[11.5px] transition-colors"
                  onClick={() => void markAllRead()}
                >
                  全部已读
                </button>
              ) : null}
            </div>
            <div className="max-h-[380px] overflow-y-auto">
              {(notifications ?? []).length === 0 ? (
                <p className="text-muted-2 px-[13px] py-8 text-center text-[11.5px]">暂无通知</p>
              ) : (
                (notifications ?? []).map((notif) => {
                  const style = NOTIF_STYLE[notif.type] ?? { icon: Bell, tone: "text-sky bg-sky/10" };
                  return (
                    <button
                      key={notif.id}
                      type="button"
                      className={cn(
                        "hover:bg-ink-750/50 flex w-full gap-2.5 border-edge-1 border-b px-[13px] py-[11px] text-left transition-colors last:border-b-0",
                        !notif.is_read && "bg-amber/[0.025]",
                      )}
                      onClick={() => {
                        if (!notif.is_read) {
                          void api.PATCH("/api/v1/notifications/{notification_id}/read", {
                            params: { path: { notification_id: notif.id } },
                          });
                        }
                        queryClient.invalidateQueries({ queryKey: ["notifications"] });
                      }}
                    >
                      <span className={cn("grid size-[25px] shrink-0 place-items-center rounded-full", style.tone)}>
                        <style.icon className="size-[13px]" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <p className="text-bone-2 text-[11.5px] leading-[1.45]">
                          {notif.title}
                          {!notif.is_read ? (
                            <span aria-hidden="true" className="bg-amber ml-1.5 inline-block size-1 rounded-full align-[2px]" />
                          ) : null}
                        </p>
                        <p className="text-muted mt-0.5 text-[10.5px] leading-[1.4]">{notif.message}</p>
                        <time className="text-muted-2 mt-0.5 block font-mono text-[9.5px]">
                          {formatRelative(notif.created_at)}
                        </time>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </PopoverContent>
        </Popover>

        {/* 新建 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="bg-amber border-amber hover:bg-amber-2 hover:border-amber-2 inline-flex h-[27px] items-center gap-[7px] whitespace-nowrap rounded-md border px-2.5 text-[11px] font-semibold text-ink-950 transition-colors"
            >
              <Plus className="size-[13px]" aria-hidden="true" />
              新建
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[214px]">
            <DropdownMenuLabel className="text-muted-2 text-[9px] font-semibold tracking-[0.13em] uppercase">
              创建
            </DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link to="/issues">
                <Zap className="text-muted-2 size-[14px]" aria-hidden="true" />
                新建 Issue
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => toast.info("先推送分支，再从 compare 视图发起 PR。")}>
              <BookOpen className="text-muted-2 size-[14px]" aria-hidden="true" />
              新建 Pull Request
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/agent">
                <Bot className="text-muted-2 size-[14px]" aria-hidden="true" />
                发起 Agent 运行
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 账号 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="账号菜单" className="rounded-full">
              <ToneAvatar initials={initialsOf(user?.full_name, user?.username ?? "?")} tone="amber" size="md" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[214px]">
            <DropdownMenuLabel className="text-[11px]">{user?.username}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => toast.info("账号设置页尚未落地（auth 控制器已就绪）。")}>
              <UserRound className="text-muted-2 size-[14px]" aria-hidden="true" />
              资料与偏好
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => toast.info("SSH 密钥管理页尚未落地（keys 控制器已就绪）。")}>
              <KeyRound className="text-muted-2 size-[14px]" aria-hidden="true" />
              SSH 与访问密钥
            </DropdownMenuItem>
            {isAdmin ? (
              <DropdownMenuItem asChild>
                <Link to="/admin">
                  <Shield className="text-muted-2 size-[14px]" aria-hidden="true" />
                  管理控制台
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => toast.info("快捷键：Ctrl K 搜索 · A 新建运行。")}>
              <Command className="text-muted-2 size-[14px]" aria-hidden="true" />
              键盘快捷键
            </DropdownMenuItem>
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

        <LocaleSwitcher />
      </div>
    </header>
  );
}

function KbdHint({ children }: { children: string }) {
  return (
    <kbd className="border-edge-2 text-muted-2 ml-auto inline-flex h-[18px] items-center whitespace-nowrap rounded border bg-ink-950/45 px-[5px] font-mono text-[9px] leading-none">
      {children}
    </kbd>
  );
}
