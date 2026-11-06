import { useCallback, useEffect, useState } from "react";

import { cn } from "@kustos/ui";

/**
 * 三栏外壳。
 *
 * Web 是"整页路由跳转 + 侧栏"；桌面端是**常驻三栏 master-detail**：
 * 左轨 56px 固定、列表栏可拖、详情区自适应，底部一条 24px 状态条。
 *
 * 状态条是桌面端独有的：它承担"远端状态 vs 本机状态"的差异表达，
 * Web 没有这个概念所以不需要。
 */

export type Surface = "inbox" | "working-copy" | "code" | "pulls" | "issues" | "chat" | "agent";

export interface SurfaceMeta {
  id: Surface;
  label: string;
  /** 单字符图标占位：骨架阶段不引入图标字体，后续换 lucide。 */
  glyph: string;
  /** 快捷键序：⌘1..7 */
  key: number;
}

/**
 * 七个 surface，没有第八个。
 *
 * 管理面不在其中，且**不是"暂时不做"**：桌面端跑在终端用户机器上，
 * 过不了网关的来源白名单，结构上就不该有这条路。
 */
export const SURFACES: SurfaceMeta[] = [
  { id: "inbox", label: "收件箱", glyph: "⌂", key: 1 },
  { id: "working-copy", label: "工作副本", glyph: "⎇", key: 2 },
  { id: "code", label: "代码", glyph: "{}", key: 3 },
  { id: "pulls", label: "合并请求", glyph: "⇄", key: 4 },
  { id: "issues", label: "议题", glyph: "✉", key: 5 },
  { id: "chat", label: "聊天", glyph: "◍", key: 6 },
  { id: "agent", label: "智能体", glyph: "✦", key: 7 },
];

interface ShellProps {
  active: Surface;
  onSelect: (surface: Surface) => void;
  /** 列表栏内容。 */
  list: React.ReactNode;
  /** 详情区内容。 */
  detail: React.ReactNode;
  /** 状态条左侧（分支与工作树状态）。 */
  statusLeft?: React.ReactNode;
  /** 状态条右侧（在线、索引、待发、同步）。 */
  statusRight?: React.ReactNode;
  /** 标题栏中部的上下文（仓库 / 分支），由调用方决定。 */
  titleContext?: React.ReactNode;
}

/** 列表栏宽度约束：260–420，默认 320。 */
const LIST_MIN = 260;
const LIST_MAX = 420;
const LIST_DEFAULT = 320;

export function Shell({
  active,
  onSelect,
  list,
  detail,
  statusLeft,
  statusRight,
  titleContext,
}: ShellProps) {
  const [listWidth, setListWidth] = useState(LIST_DEFAULT);

  return (
    <div className="flex h-full flex-col bg-ink-900 text-bone">
      <TitleBar titleContext={titleContext} />
      <div className="flex min-h-0 flex-1">
        <IconRail active={active} onSelect={onSelect} />
        <ListPane width={listWidth} onResize={setListWidth}>
          {list}
        </ListPane>
        <main className="min-w-0 flex-1 overflow-auto" aria-label="详情">
          {detail}
        </main>
      </div>
      <StatusBar left={statusLeft} right={statusRight} />
    </div>
  );
}

/** 标题栏：38px 高，可拖拽移动窗口。 */
function TitleBar({ titleContext }: { titleContext?: React.ReactNode }) {
  return (
    <header
      data-wails-drag
      className="flex h-[38px] shrink-0 items-center gap-3 border-b border-[var(--color-edge-1)] px-3 select-none"
    >
      <span className="font-display text-sm tracking-wide text-bone">kustos</span>
      {titleContext}
      <div className="flex-1" />
      <kbd className="rounded border border-[var(--color-edge-2)] px-1.5 py-0.5 text-[11px] text-faint">
        ⌘K
      </kbd>
    </header>
  );
}

/** 左轨：56px 固定，只放 7 个 surface 图标，不再承载三层导航。 */
function IconRail({
  active,
  onSelect,
}: {
  active: Surface;
  onSelect: (s: Surface) => void;
}) {
  return (
    <nav
      aria-label="主导航"
      className="flex w-[56px] shrink-0 flex-col items-center gap-1 border-r border-[var(--color-edge-1)] py-2"
    >
      {SURFACES.map((s) => (
        <button
          key={s.id}
          type="button"
          title={`${s.label} (⌘${s.key})`}
          aria-current={active === s.id ? "page" : undefined}
          onClick={() => onSelect(s.id)}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-md text-[13px] transition-colors",
            active === s.id
              ? "bg-ink-750 text-amber"
              : "text-muted hover:bg-ink-800 hover:text-bone",
          )}
        >
          <span aria-hidden>{s.glyph}</span>
          <span className="sr-only">{s.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** 列表栏：可拖拽改宽，宽度记住。 */
function ListPane({
  width,
  onResize,
  children,
}: {
  width: number;
  onResize: (w: number) => void;
  children: React.ReactNode;
}) {
  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const originX = e.clientX;
      const originWidth = width;

      const onMove = (ev: PointerEvent) => {
        const next = Math.min(LIST_MAX, Math.max(LIST_MIN, originWidth + ev.clientX - originX));
        onResize(next);
      };
      const onUp = () => {
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
      aria-label="列表"
      className="relative shrink-0 overflow-y-auto border-r border-[var(--color-edge-1)]"
      style={{ width }}
    >
      {children}
      {/* 热区 6px、预览线 2px 琥珀；当前先给热区与指针，预览线待补。 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整列表宽度"
        onPointerDown={startDrag}
        className="absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize hover:bg-[color-mix(in_srgb,var(--color-amber)_20%,transparent)]"
      />
    </section>
  );
}

/** 状态条：24px 常驻，承载"远端 vs 本机"的差异表达。 */
function StatusBar({ left, right }: { left?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <footer className="flex h-[24px] shrink-0 items-center gap-4 border-t border-[var(--color-edge-1)] px-3 text-[11px] text-faint">
      <div className="flex min-w-0 items-center gap-4 truncate">{left}</div>
      <div className="flex-1" />
      <div className="flex items-center gap-4">{right}</div>
    </footer>
  );
}

/** 键盘快捷键：⌘1..7 切 surface。 */
export function useSurfaceShortcuts(onSelect: (s: Surface) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // metaKey 覆盖 macOS，ctrlKey 覆盖 Windows/Linux。
      if (!(e.metaKey || e.ctrlKey)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > SURFACES.length) return;
      e.preventDefault();
      onSelect(SURFACES[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect, enabled]);
}
