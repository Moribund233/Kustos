import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Window } from "@wailsio/runtime";

import { Icon, type IconName } from "@/shell/icon";
import { CommandPalette, type PaletteGroup } from "@/shell/command-palette";
import {
  LOCALE_LABELS,
  normalizeLocale,
  setLocale,
  type Locale,
} from "@/lib/i18n";

/**
 * 桌面端外壳：标题栏 / 左轨 / 三栏 / 状态条。
 *
 * 严格对齐 `docs/prototype/desktop` 的窗口模型：
 *
 *   38px 标题栏
 *   ├ 56px 左轨（7 个 surface，无第八个）
 *   ├ 列表栏（可拖拽 260–420，默认 316）
 *   ├ 详情区
 *   └ 可选检查器（292px，右侧）
 *   24px 状态条
 *
 * 与 Web 的差别不在配色，而在"常驻应用"的取舍：行高从 44–56px 压到 27–30px，
 * 导航从整页跳转变成长驻三栏，信息密度优先。
 */

export type Surface =
  | "inbox"
  | "working-copy"
  | "code"
  | "pulls"
  | "issues"
  | "chat"
  | "agent";

/** 左轨的一项。标签走翻译键，见下方 SURFACES 的说明。 */
interface SurfaceMeta {
  id: Surface;
  /** 翻译键，由 `nav.*` 提供。 */
  i18nKey: string;
  icon: IconName;
  key: number;
}

/**
 * 七个 surface，没有第八个。
 *
 * 管理面不在其中：网关按 `KUSTOS_ADMIN_ALLOWED_SOURCES` 拦掉了 `/api/app/`，
 * 桌面端跑在终端用户机器上，出口地址不可控，结构上就过不去那一层。
 * 做"按钮在、点了 403"的死路，比没有按钮更糟。
 *
 * 标签走翻译键而不是字面量：导航是最先被翻译的一层，
 * 在这里写死中文会让后续每个面都要回来改。
 */
export const SURFACES: SurfaceMeta[] = [
  { id: "inbox", i18nKey: "nav.inbox", icon: "home", key: 1 },
  { id: "working-copy", i18nKey: "nav.workingCopy", icon: "folder", key: 2 },
  { id: "code", i18nKey: "nav.code", icon: "code", key: 3 },
  { id: "pulls", i18nKey: "nav.pulls", icon: "pr", key: 4 },
  { id: "issues", i18nKey: "nav.issues", icon: "issue", key: 5 },
  { id: "chat", i18nKey: "nav.chat", icon: "chat", key: 6 },
  { id: "agent", i18nKey: "nav.agent", icon: "agent", key: 7 },
];

const LIST_MIN = 260;
const LIST_MAX = 420;
const LIST_DEFAULT = 316;

export interface ShellProps {
  active: Surface;
  onSelect: (surface: Surface) => void;
  /** 列表栏内容。 */
  list: React.ReactNode;
  /** 详情区内容。 */
  detail: React.ReactNode;
  /** 右侧检查器；不传则不渲染。 */
  inspector?: React.ReactNode;
  /** 标题栏中部的上下文（仓库 / 分支 / PR）。 */
  titleContext?: React.ReactNode;
  /** 状态条左侧（分支与工作树状态）。 */
  statusLeft?: React.ReactNode;
  /** 状态条右侧（在线、索引、待发、同步）。 */
  statusRight?: React.ReactNode;
  /** 在线状态文案，如 "online 46ms"。 */
  conn?: string;
  offline?: boolean;
  /** 左轨徽标（收件箱未读等）。 */
  badges?: Partial<Record<Surface, number>>;
  /** 用户显示名，用于左轨底部头像。 */
  userName?: string;
  /** 系统通知是否已获授权。 */
  notificationsAuthorized?: boolean;
  /** 授权请求进行中。 */
  notificationsPending?: boolean;
  /** 用户点击通知开关。 */
  onEnableNotifications?: () => void;
  /** 标题栏左侧的仓库 chip 文案。 */
  repoChip?: string;
  /** 标题栏的分支 chip 文案。 */
  branchChip?: string;
  /** 分支领先/落后。 */
  ahead?: number;
  behind?: number;
  /** 命令面板的动作组；不传则 `⌘K` 无内容可开。 */
  paletteGroups?: PaletteGroup[];
  /**
   * 窗口级覆盖层（对话框等）。
   *
   * 挂在根节点这一层而不是 detail 里：失败提示要挡住整个操作区，
   * 而且它不属于某个 surface 的内部布局。由调用方决定渲染什么，
   * 外壳只负责给它一个铺满窗口的定位上下文。
   */
  overlay?: React.ReactNode;
}

/** 窗口外壳。 */
export function Shell({
  active,
  onSelect,
  list,
  detail,
  inspector,
  titleContext,
  statusLeft,
  statusRight,
  conn,
  offline,
  badges,
  userName,
  notificationsAuthorized = false,
  notificationsPending = false,
  onEnableNotifications,
  repoChip,
  branchChip,
  ahead = 0,
  behind = 0,
  paletteGroups,
  overlay,
}: ShellProps) {
  const { t } = useTranslation();
  const [listWidth, setListWidth] = useState(LIST_DEFAULT);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // `⌘K` 的开合放在外壳这一层：面板是窗口级覆盖层，不是某个 surface 的
  // 局部控件。只为有动作可执行的场景注册监听，否则会留下一个能开却空的面板。
  useEffect(() => {
    if (!paletteGroups || paletteGroups.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [paletteGroups]);

  return (
    <div className="relative flex h-full flex-col bg-[var(--color-ink-950)] text-[var(--color-bone)]">
      <TitleBar
        titleContext={titleContext}
        conn={conn}
        offline={offline}
        repoChip={repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        <IconRail
          active={active}
          onSelect={onSelect}
          badges={badges}
          userName={userName}
          notificationsAuthorized={notificationsAuthorized}
          notificationsPending={notificationsPending}
          onEnableNotifications={onEnableNotifications ?? (() => {})}
        />
        <ListPane width={listWidth} onResize={setListWidth}>
          {list}
        </ListPane>
        <main
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
          aria-label={t("shell.detail")}
        >
          {detail}
        </main>
        {inspector}
      </div>
      <StatusBar left={statusLeft} right={statusRight} />
      {paletteGroups && (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          groups={paletteGroups}
        />
      )}
      {overlay}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 标题栏                                                              */
/* ------------------------------------------------------------------ */

/**
 * 标题栏：38px，可拖拽移动窗口。
 *
 * 中间的 chips 表达"我现在在哪个上下文"——分支、PR、领先/落后。
 * 桌面用户一小时内会在多个上下文之间来回几十次，让它常驻比藏进菜单有用。
 */
function TitleBar({
  titleContext,
  conn,
  offline,
  repoChip,
  branchChip,
  ahead,
  behind,
  onOpenPalette,
}: {
  titleContext?: React.ReactNode;
  conn?: string;
  offline?: boolean;
  repoChip?: string;
  branchChip?: string;
  ahead: number;
  behind: number;
  onOpenPalette?: () => void;
}) {
  const { t } = useTranslation();
  const hasContext = Boolean(repoChip || branchChip);

  return (
    <header
      data-wails-drag
      className="flex h-[38px] shrink-0 items-center gap-[9px] border-b border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(21,35,42,0.6),rgba(10,17,21,0.94))] pr-[10px] pl-[13px] select-none"
    >
      <span className="flex items-center gap-[7px] pr-1">
        <img src="/brand/kustos-mark.svg" alt="" width={19} height={19} />
        <span className="text-[10.5px] font-medium tracking-[0.2em] text-[var(--color-bone-2)]">
          KUSTOS
        </span>
      </span>
      <span aria-hidden className="h-[14px] w-px bg-[var(--color-edge-2)]" />

      {/* 上下文 chips：仓库与分支常驻，用户一眼知道"我现在在哪个上下文"。 */}
      {repoChip && <Chip icon="folder" label={repoChip} chevron />}
      {branchChip && <Chip icon="branch" label={branchChip} mono chevron />}
      {(ahead > 0 || behind > 0) && (
        <span className="inline-flex gap-1.5 font-mono text-[10.5px] text-[var(--color-sage)]">
          <span>↑{ahead}</span>
          <span className="text-[var(--color-muted-2)]">↓{behind}</span>
        </span>
      )}
      {!hasContext && titleContext}

      <span className="flex-1" />
      <button
        type="button"
        onClick={onOpenPalette}
        className="inline-flex h-[24px] w-[226px] items-center gap-[7px] rounded-[7px] border border-[var(--color-edge-1)] bg-[rgba(8,13,16,0.6)] px-2 text-[11.5px] text-[var(--color-muted-2)] hover:border-[var(--color-edge-2)] hover:text-[var(--color-muted)]"
      >
        <Icon name="search" size={13} />
        <span>{t("app.searchPlaceholder")}</span>
        <span className="ml-auto rounded border border-[var(--color-edge-2)] px-[5px] py-px text-[10px] text-[var(--color-faint)]">
          ⌘K
        </span>
      </button>
      {conn && (
        <span
          className={[
            "inline-flex items-center gap-[5px] px-0.5 text-[11px]",
            offline ? "text-[var(--color-amber)]" : "text-[var(--color-sage)]",
          ].join(" ")}
        >
          <span
            aria-hidden
            className={[
              "h-[5px] w-[5px] rounded-full",
              offline ? "bg-[var(--color-amber)]" : "bg-[var(--color-sage)]",
            ].join(" ")}
          />
          {conn}
        </span>
      )}
      <WindowControls />
    </header>
  );
}

/** 标题栏里的上下文 chip。 */
function Chip({
  icon,
  label,
  mono,
  chevron,
}: {
  icon: IconName;
  label: string;
  mono?: boolean;
  chevron?: boolean;
}) {
  return (
    <span className="inline-flex h-[22px] max-w-[260px] items-center gap-[5px] rounded-[7px] border border-[var(--color-edge-1)] bg-[var(--color-ink-850)] px-[7px] text-[11.5px] text-[var(--color-bone-2)]">
      <Icon name={icon} size={12} className="shrink-0 text-[var(--color-muted-2)]" />
      <span className={`truncate ${mono ? "font-mono text-[11px]" : ""}`}>{label}</span>
      {/* 原型在仓库 chip 尾部放一个下拉箭头：它提示"点这里能切仓库"。 */}
      {chevron && <Icon name="chevron-down" size={10} className="shrink-0 text-[var(--color-faint)]" />}
    </span>
  );
}

/**
 * 窗口控制：最小化 / 最大化 / 关闭。
 *
 * 无边框窗口没有系统标题栏，这三个按钮必须由界面提供——否则用户只能
 * 通过任务栏或快捷键操作窗口，那不是一个能用的桌面应用。
 *
 * 两件事都要做，缺一件都不成立：
 *
 *  1. `data-window-*` 标记（样式见 globals.css 的 `--wails-non-client-region`）：
 *     让原生层把这些矩形识别为 caption 按钮，命中测试、悬停语义与系统
 *     Snap Layout 才与普通标题栏一致。
 *  2. 点击处理器显式调用 Window 运行时方法：**必须**。composition 托管下
 *     Wails v3.0.0 会把按钮的 WM_NCLBUTTON 消息转发回 WebView 当作普通
 *     鼠标输入，不再走 DefWindowProc，`SC_MINIMIZE/SC_MAXIMIZE/SC_CLOSE`
 *     一个都不会发出。只挂标记不接方法，按钮看起来完全正常、点了没反应。
 */
export function WindowControls() {
  const { t } = useTranslation();

  return (
    <div className="ml-1 flex items-center">
      <button
        type="button"
        data-window-minimise
        aria-label={t("app.windowMinimise")}
        title={t("app.windowMinimise")}
        onClick={() => void Window.Minimise()}
        className="grid h-[30px] w-[34px] place-items-center text-[var(--color-muted-2)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-bone-2)]"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        data-window-maximise
        aria-label={t("app.windowMaximise")}
        title={t("app.windowMaximise")}
        // 最大化与还原共用一个按钮：与系统标题栏的行为一致。
        onClick={() => void Window.ToggleMaximise()}
        className="grid h-[30px] w-[34px] place-items-center text-[var(--color-muted-2)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-bone-2)]"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <rect
            x="1.5"
            y="1.5"
            width="7"
            height="7"
            rx="1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
      </button>
      <button
        type="button"
        data-window-close
        aria-label={t("app.windowClose")}
        title={t("app.windowClose")}
        // 关闭不做"未保存确认"拦截：未保存内容已经按文件落到恢复表，
        // 重开时由恢复提示让用户显式选择，而不是在这里替他决定。
        onClick={() => void Window.Close()}
        className="grid h-[30px] w-[34px] place-items-center text-[var(--color-muted-2)] hover:bg-[#c23b3b] hover:text-white"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="m2 2 6 6M8 2l-6 6"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 左轨                                                                */
/* ------------------------------------------------------------------ */

/** 左轨：56px 固定，40×34 图标项，激活项带左侧琥珀竖条。 */
function IconRail({
  active,
  onSelect,
  badges,
  userName,
  notificationsAuthorized,
  notificationsPending,
  onEnableNotifications,
}: {
  active: Surface;
  onSelect: (s: Surface) => void;
  badges?: Partial<Record<Surface, number>>;
  userName?: string;
  /** 系统通知是否已获授权。 */
  notificationsAuthorized: boolean;
  /** 授权请求进行中。 */
  notificationsPending: boolean;
  /** 用户点击通知开关。 */
  onEnableNotifications: () => void;
}) {
  const { t } = useTranslation();

  return (
    <nav
      aria-label={t("nav.surfaces")}
      className="flex w-[56px] shrink-0 flex-col items-center gap-0.5 border-r border-[var(--color-edge-1)] bg-[var(--color-ink-900)] pt-[9px] pb-2"
    >
      {SURFACES.map((s) => {
        const on = s.id === active;
        const badge = badges?.[s.id];
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            aria-current={on ? "page" : undefined}
            aria-label={t(s.i18nKey)}
            title={t("nav.shortcutHint", { label: t(s.i18nKey), key: s.key })}
            className={[
              "relative grid h-[34px] w-[40px] place-items-center rounded-[7px]",
              on
                ? "bg-[var(--color-amber-wash)] text-[var(--color-amber)]"
                : "text-[var(--color-muted-2)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-bone-2)]",
            ].join(" ")}
          >
            {on && (
              <span
                aria-hidden
                className="absolute top-[7px] bottom-[7px] -left-[9px] w-0.5 rounded-r-[2px] bg-[var(--color-amber)]"
              />
            )}
            <Icon name={s.icon} size={17} />
            {badge !== undefined && badge > 0 && (
              <i className="absolute top-0 right-px grid h-[13px] min-w-[13px] place-items-center rounded-full bg-[var(--color-amber)] px-[3px] text-[9.5px] font-medium text-[#2a1a08] not-italic">
                {badge > 99 ? "99+" : badge}
              </i>
            )}
          </button>
        );
      })}

      <span aria-hidden className="my-[7px] h-px w-[22px] bg-[var(--color-edge-1)]" />
      <span className="flex-1" />

      <LanguageToggle />
      <NotificationToggle
        authorized={notificationsAuthorized}
        onEnable={onEnableNotifications}
        pending={notificationsPending}
      />
      <button
        type="button"
        aria-label={t("nav.settings")}
        title={t("nav.settings")}
        className="grid h-[34px] w-[40px] place-items-center rounded-[7px] text-[var(--color-muted-2)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-bone-2)]"
      >
        <Icon name="settings" size={17} />
      </button>
      <span
        title={userName}
        className="mt-1 grid h-[26px] w-[26px] place-items-center rounded-full border border-[var(--color-edge-2)] bg-[var(--color-ink-800)] text-[10.5px] text-[var(--color-bone-2)]"
      >
        {initials(userName)}
      </span>
    </nav>
  );
}

/**
 * 通知开关。
 *
 * 为什么放在左轨而不是设置页：桌面端还没有设置页，而"要不要被通知打扰"是
 * 用户第一天就会想确认的事。放在语言开关旁边，与"这台机器上的偏好"同属一类。
 *
 * 只在**用户显式点击**时申请授权：启动就弹授权请求时用户还不知道会收到什么，
 * 拒绝一次之后系统就很难再让他改回来。
 */
function NotificationToggle({
  authorized,
  onEnable,
  pending,
}: {
  authorized: boolean;
  onEnable: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onEnable}
      disabled={authorized || pending}
      aria-pressed={authorized}
      aria-label={t(authorized ? "notifications.enabled" : "notifications.enable")}
      title={t(authorized ? "notifications.enabled" : "notifications.enable")}
      className={[
        "grid h-[34px] w-[40px] place-items-center rounded-[7px]",
        authorized
          ? "text-[var(--color-sage)]"
          : "text-[var(--color-muted-2)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-bone-2)]",
      ].join(" ")}
    >
      <Icon name="bell" size={16} />
    </button>
  );
}

/**
 * 语言切换。
 *
 * 桌面端只有一个窗口、没有"设置页"之前，切换入口放在左轨底部：
 * 它足够隐蔽（不是高频操作），又不至于找不到。
 *
 * 文案用语言自身的名字（简体中文 / English），而不是当前语言的翻译——
 * 用户看不懂当前语言时才最需要这个按钮。
 */
function LanguageToggle() {
  const { i18n } = useTranslation();
  const active = normalizeLocale(i18n.resolvedLanguage ?? i18n.language);
  const next: Locale = active === "zh" ? "en" : "zh";

  return (
    <button
      type="button"
      onClick={() => setLocale(next)}
      aria-label={LOCALE_LABELS[next]}
      title={LOCALE_LABELS[next]}
      className="grid h-[26px] w-[40px] place-items-center rounded-[7px] text-[9.5px] font-medium tracking-wide text-[var(--color-muted-2)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-bone-2)]"
    >
      {active === "zh" ? "EN" : "中"}
    </button>
  );
}

/** 取显示名的首字母，最多两个字符。 */
function initials(name?: string): string {  if (!name) return "—";
  const trimmed = name.trim();
  if (trimmed === "") return "—";
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* 列表栏                                                              */
/* ------------------------------------------------------------------ */

/** 列表栏：可拖拽宽度，热区 6px。 */
function ListPane({
  width,
  onResize,
  children,
}: {
  width: number;
  onResize: (next: number) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const dragging = useRef(false);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return;
        const next = Math.min(
          LIST_MAX,
          Math.max(LIST_MIN, startWidth + (ev.clientX - startX)),
        );
        onResize(next);
      };
      const onUp = () => {
        dragging.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, onResize],
  );

  return (
    <section
      aria-label={t("shell.list")}
      className="relative flex shrink-0 flex-col overflow-hidden border-r border-[var(--color-edge-1)] bg-[var(--color-ink-950)]"
      style={{ width }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("status.listWidth")}
        onPointerDown={startDrag}
        className="absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize hover:bg-[color-mix(in_srgb,var(--color-amber)_20%,transparent)]"
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 状态条                                                              */
/* ------------------------------------------------------------------ */

/** 状态条：24px，"远端状态 vs 本机状态"的差异常驻表达。 */
function StatusBar({
  left,
  right,
}: {
  left?: React.ReactNode;
  right?: React.ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <footer
      aria-label={t("status.region")}
      className="flex h-[24px] shrink-0 items-center gap-2.5 border-t border-[var(--color-edge-1)] bg-[var(--color-ink-900)] px-2.5 text-[10.5px] text-[var(--color-muted-2)] select-none"
    >
      <div className="flex items-center gap-2.5">{left}</div>
      <span className="flex-1" />
      <div className="flex items-center gap-2.5">{right}</div>
    </footer>
  );
}

/** 状态条里的一项（图标 + 文本）。 */
export function StatusItem({
  icon,
  children,
  tone,
}: {
  icon: IconName;
  children: React.ReactNode;
  tone?: "amber" | "sage";
}) {
  const color =
    tone === "amber"
      ? "text-[var(--color-amber)]"
      : tone === "sage"
        ? "text-[var(--color-sage)]"
        : "";
  return (
    <span className={`inline-flex items-center gap-1.5 ${color}`}>
      <Icon name={icon} size={11} />
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 快捷键                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⌘1..7 切 surface。
 *
 * 只在就绪（已登录）时启用：登录页里的数字键要留给输入框。
 */
export function useSurfaceShortcuts(onSelect: (s: Surface) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > SURFACES.length) return;
      e.preventDefault();
      onSelect(SURFACES[n - 1].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSelect, enabled]);
}









