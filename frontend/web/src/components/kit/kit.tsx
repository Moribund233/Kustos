import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 夜巡设计套件：原型 `components.css` 原语的 Tailwind 翻译层。
 *
 * 状态灯、胶囊、检查片、悬浮舞台等在多页复用的小部件集中在这里，
 * 页面不再各自拼装同一批类名。样式与 docs/prototype/assets/css 保持同源。
 */

/* ------------------------------------------------------------------ */
/* 状态灯与胶囊                                                        */
/* ------------------------------------------------------------------ */

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

const LAMP_TONE: Record<Tone, string> = {
  neutral: "bg-muted-2",
  good: "bg-sage shadow-[0_0_8px_rgba(134,183,158,0.52)]",
  warn: "bg-amber shadow-[0_0_9px_rgba(242,174,91,0.62)]",
  bad: "bg-rose shadow-[0_0_9px_rgba(217,130,130,0.55)]",
  info: "bg-sky shadow-[0_0_8px_rgba(131,169,196,0.48)]",
};

interface LampProps {
  tone?: Tone;
  /** 呼吸动效：表示「正在发生」的状态（在线、执行中）。 */
  live?: boolean;
  size?: "sm" | "lg";
  className?: string;
}

/** 状态灯：6px 圆点 + 对应色辉光。 */
export function Lamp({ tone = "neutral", live = false, size = "sm", className }: LampProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 rounded-full",
        size === "lg" ? "size-2" : "size-1.5",
        LAMP_TONE[tone],
        live && "animate-lamp-breathe",
        className,
      )}
    />
  );
}

const PILL_TONE: Record<"default" | Tone, string> = {
  default: "border-edge-1 bg-ink-800/70 text-muted",
  neutral: "border-edge-1 bg-ink-800/70 text-muted",
  good: "border-sage/25 bg-sage/10 text-sage-2",
  warn: "border-amber/30 bg-amber/10 text-amber-2",
  bad: "border-rose/30 bg-rose/10 text-rose-2",
  info: "border-sky/25 bg-sky/10 text-sky",
};

interface StatusPillProps {
  tone?: "default" | Tone;
  lamp?: boolean;
  live?: boolean;
  className?: string;
  children: ReactNode;
}

/** 状态胶囊：顶栏/页头的摘要状态，如「1 check failing」。 */
export function StatusPill({ tone = "default", lamp, live, className, children }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-[7px] whitespace-nowrap rounded-full border px-2.5 text-xs",
        PILL_TONE[tone],
        className,
      )}
    >
      {lamp ? <Lamp tone={tone === "default" ? "neutral" : tone} live={live} /> : null}
      {children}
    </span>
  );
}

interface ChipProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  active?: boolean;
}

/** 筛选胶囊：悬停描边加深，激活态琥珀 wash。 */
export function Chip({ active = false, className, children, ...props }: ChipProps) {
  return (
    <button
      type="button"
      /* 激活态原先只改样式，屏幕阅读器听不出选中与否。aria-pressed 把
         「这是个开关」的语义补上；放在 ...props 之前，调用方仍可覆盖。 */
      aria-pressed={active}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs transition-colors",
        active
          ? "border-amber/30 bg-amber/10 text-amber-2"
          : "border-edge-1 text-muted hover:border-edge-2 hover:text-bone-2",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

const CHECK_TONE: Record<"neutral" | Tone | "agent", string> = {
  neutral: "border-edge-1 text-muted-2",
  good: "border-sage/20 bg-sage/[0.055] text-sage",
  warn: "border-amber/20 bg-amber/[0.055] text-amber",
  bad: "border-rose/20 bg-rose/[0.06] text-rose",
  info: "border-sky/20 bg-sky/[0.055] text-sky",
  agent: "border-amber/[0.26] bg-amber/10 text-amber-2",
};

interface CheckChipProps {
  tone?: "neutral" | Tone | "agent";
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}

/** 检查片：CI 检查 / Agent 评审的紧凑状态块。 */
export function CheckChip({ tone = "neutral", icon: Icon, children, className }: CheckChipProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded border px-[7px] text-2xs leading-none",
        CHECK_TONE[tone],
        className,
      )}
    >
      <Icon className="size-[11px]" aria-hidden="true" />
      {children}
    </span>
  );
}

/** 键盘按键提示。 */
export function Kbd({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] items-center whitespace-nowrap rounded border-edge-2 border bg-ink-950/45 px-[5px] font-mono text-2xs leading-none text-muted-2",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

interface SectionHeadProps {
  title: string;
  count?: number;
  /** 右侧的补充说明或链接。 */
  meta?: ReactNode;
  className?: string;
}

/** 区块头：小标签 + 计数 + 右侧 meta，下缘分隔线。 */
export function SectionHead({ title, count, meta, className }: SectionHeadProps) {
  return (
    <div className={cn("flex min-h-[27px] items-center gap-[9px] border-edge-2 border-b pb-[9px]", className)}>
      <h2 className="text-bone-2 text-2xs font-semibold tracking-[0.15em] uppercase">{title}</h2>
      {count !== undefined ? (
        <span className="rounded-full bg-bone/[0.06] px-1.5 font-mono text-2xs leading-[15px] text-muted-2">
          {count}
        </span>
      ) : null}
      {meta ? <div className="ml-auto text-faint font-mono text-2xs">{meta}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 头像                                                                */
/* ------------------------------------------------------------------ */

export type AvatarTone = "amber" | "sage" | "sky" | "rose" | "slate";

const AVATAR_TONE: Record<AvatarTone, string> = {
  amber: "bg-[#e7b276]",
  sage: "bg-[#9dc6af]",
  sky: "bg-[#a7c4d8]",
  rose: "bg-[#e2a5a5]",
  slate: "bg-[#b8c2c3]",
};

const AVATAR_SIZE: Record<"sm" | "md" | "lg", string> = {
  sm: "size-[23px] text-2xs",
  md: "size-7 text-2xs",
  lg: "size-9 text-sm",
};

interface ToneAvatarProps {
  /** 首字母缩写，如 LW。 */
  initials: string;
  tone?: AvatarTone;
  size?: "sm" | "md" | "lg";
  /** Agent 身份：描边发光的机器人头像。 */
  bot?: boolean;
  className?: string;
}

/** 实心头像：浅色底 + 深色字，区别于常见深底头像。 */
export function ToneAvatar({ initials, tone = "slate", size = "md", bot = false, className }: ToneAvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full font-bold leading-none",
        AVATAR_SIZE[size],
        bot
          ? "border-amber/50 border bg-ink-800 text-amber-2"
          : cn("text-ink-950 border-bone/15 border", AVATAR_TONE[tone]),
        className,
      )}
    >
      {initials}
    </span>
  );
}

/** 仓库字形块：首字母 + 彩底圆角方块。 */
export function RepoGlyph({ letter, tone = "amber" }: { letter: string; tone?: AvatarTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "font-display inline-grid size-6 shrink-0 place-items-center rounded-md text-base font-semibold text-ink-950",
        AVATAR_TONE[tone],
      )}
    >
      {letter}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 悬浮舞台（stage + dock + float-panel）                               */
/* ------------------------------------------------------------------ */

export interface DockTab {
  id: string;
  icon: LucideIcon;
  /** 面板标题。 */
  label: string;
  /** 面板副标题（眉题）。 */
  kicker?: string;
  ariaLabel?: string;
}

interface StageProps {
  /** 右缘的竖排面板开关；不传则渲染为普通容器。 */
  dock?: DockTab[];
  /** 面板内容，接收当前激活的 tab；dock 存在时必传。 */
  panel?: (tab: DockTab) => ReactNode;
  /** 默认打开的面板；不传则默认关闭。 */
  defaultPane?: string;
  className?: string;
  children: ReactNode;
}

/**
 * 悬浮舞台：画布 + 右缘 dock + 悬浮面板。
 *
 * 原型的「次级信息浮在画布上，不挤占画布宽度」交互：点击 dock 切换面板
 * pane，面板覆盖在画布右缘，画布上叠一层向右渐深的遮罩。
 */
export function Stage({ dock, panel, defaultPane, className, children }: StageProps) {
  const { t } = useTranslation();
  const [pane, setPane] = useState<string | null>(defaultPane ?? null);
  const [title, setTitle] = useState<{ label: string; kicker?: string } | null>(null);

  if (!dock?.length || !panel) {
    return <div className={cn("relative min-w-0", className)}>{children}</div>;
  }

  const activeTab = dock.find((tab) => tab.id === pane) ?? null;

  const toggle = (tab: DockTab) => {
    if (pane === tab.id) {
      setPane(null);
      setTitle(null);
      return;
    }
    setPane(tab.id);
    setTitle({ label: tab.label, kicker: tab.kicker });
  };

  return (
    <div className={cn("relative min-w-0", className)}>
      {children}

      {/* 面板开启时画布右缘的渐深遮罩 */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 z-10 bg-[linear-gradient(90deg,transparent_calc(100%-500px),rgba(4,8,11,0.2)_calc(100%-410px),rgba(4,8,11,0.52)_100%))] transition-opacity duration-[240ms]",
          pane ? "opacity-100" : "opacity-0",
        )}
      />

      <div className="absolute top-1/2 right-2.5 z-[12] flex -translate-y-1/2 flex-col gap-1.5" role="toolbar">
        {dock.map((tab) => (
          <button
            key={tab.id}
            type="button"
            title={tab.label}
            aria-label={tab.ariaLabel ?? tab.label}
            aria-expanded={pane === tab.id}
            onClick={() => toggle(tab)}
            className={cn(
              "grid size-[34px] place-items-center rounded-md border border-edge-2 bg-ink-850/80 text-muted-2 shadow-[0_8px_22px_rgba(0,0,0,0.38)] backdrop-blur transition-colors hover:-translate-x-0.5 hover:border-edge-3 hover:bg-ink-750/95 hover:text-bone",
              pane === tab.id && "border-amber/40 bg-amber/10 text-amber",
            )}
          >
            <tab.icon className="size-[15px]" aria-hidden="true" />
          </button>
        ))}
      </div>

      {/* 关闭时脱离 Tab 序列（原型用 inert） */}
      <aside
        aria-hidden={!pane}
        className={cn(
          "absolute top-2.5 right-[54px] z-[11] flex max-h-[calc(100%-20px)] w-[336px] min-h-[168px] flex-col overflow-hidden rounded-[14px] border border-edge-2 bg-[linear-gradient(180deg,rgba(23,36,44,0.975),rgba(10,18,23,0.99))] shadow-[0_40px_90px_rgba(0,0,0,0.58),0_4px_16px_rgba(0,0,0,0.4),-28px_0_48px_-20px_rgba(0,0,0,0.55)] backdrop-blur-[22px] saturate-[1.1] transition-all duration-[240ms]",
          pane
            ? "pointer-events-auto translate-x-0 scale-100 opacity-100"
            : "pointer-events-none translate-x-4 scale-[0.985] opacity-0",
        )}
      >
        {activeTab && title ? (
          <header className="flex flex-none items-start gap-2.5 border-edge-1 border-b px-[15px] pt-3.5 pb-[11px]">
            <div className="min-w-0 flex-1">
              <p className="text-faint text-2xs font-semibold tracking-[0.16em] uppercase">{title.kicker}</p>
              <h2 className="font-display text-bone mt-[3px] text-xl font-medium tracking-tight leading-tight">
                {title.label}
              </h2>
            </div>
            <button
              type="button"
              aria-label={t("nav.closePanel")}
              onClick={() => {
                setPane(null);
                setTitle(null);
              }}
              className="text-muted-2 -mt-0.5 grid size-[30px] place-items-center rounded-md transition-colors hover:bg-bone/5 hover:text-bone"
            >
              <X className="size-[15px]" aria-hidden="true" />
            </button>
          </header>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {pane && activeTab ? panel(activeTab) : null}
        </div>
      </aside>
    </div>
  );
}

/** 悬浮面板内的内容块：上下分隔线 + 小标签标题。 */
export function RailBlock({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="border-edge-1 border-b px-[15px] pt-3.5 pb-[15px] last:border-b-0">
      {title ? (
        <h3 className="text-muted-2 mb-2.5 text-2xs font-semibold tracking-[0.15em] uppercase">{title}</h3>
      ) : null}
      {children}
    </section>
  );
}

/** 事实键值对列表（面板内）。 */
export function FactList({ items }: { items: { key: string; value: ReactNode }[] }) {
  return (
    <dl>
      {items.map((item) => (
        <div key={item.key} className="flex items-baseline justify-between gap-3 border-edge-1 border-b py-[9px] last:border-b-0">
          <dt className="text-muted-2 text-2xs">{item.key}</dt>
          <dd className="text-bone-2 text-right text-2xs">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
