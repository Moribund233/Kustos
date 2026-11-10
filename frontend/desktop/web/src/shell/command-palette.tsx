import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "@/shell/icon";

/**
 * 命令面板（`⌘K` / `Ctrl+K`）。
 *
 * 结构对齐原型 `docs/prototype/desktop/windows.html` 的 Command palette 区块：
 * 顶部输入框、按组分列的动作条目（图标 + 文案 + 右侧快捷键提示）、底部键位说明。
 *
 * **只放当下真的能执行的动作。** 原型里还画了 Join live session、
 * Observe without editing、Copy link to line，那些依赖尚未实现的协作能力；
 * 把它们放进来就是"按钮在、点了没反应"，比没有这个入口更糟。
 * 等协作面落地后再按同一套分组补回来。
 *
 * 面板是**窗口内覆盖层**，不是独立窗口。设计文档里"应用不在前台也响应"的
 * 全局命令面板窗属于常驻能力，需要系统级快捷键注册，与这一层不是同一件事。
 */

/** 一个可执行动作。 */
export interface PaletteAction {
  id: string;
  /** 分组键：UI 上按它分节显示。 */
  group: string;
  /** 已翻译的显示文案。 */
  label: string;
  icon: IconName;
  /** 右侧键位提示；没有快捷键时留空。 */
  hint?: string;
  /** 执行动作。 */
  run: () => void;
}

/** 面板里的一组动作。 */
export interface PaletteGroup {
  key: string;
  /** 已翻译的分组标题。 */
  label: string;
  actions: PaletteAction[];
}

/**
 * 按查询过滤动作组。
 *
 * 匹配规则与原型一致：大小写无关的子串匹配，命中范围是条目文案。
 * 整组无命中则整组消失——留着空分组标题会让列表看起来像加载失败。
 *
 * 抽成纯函数是为了能单测：键盘导航与"第一个可见项自动选中"都依赖
 * 这个过滤结果的顺序与形状。
 *
 * Args:
 *
 *	groups: 全部动作组
 *	query:  输入框内容
 *
 * Returns:
 *
 *	过滤后的动作组；查询为空时原样返回（保持声明顺序）。
 */
export function filterPaletteGroups(groups: PaletteGroup[], query: string): PaletteGroup[] {
  const q = query.trim().toLowerCase();
  if (q === "") return groups;

  return groups
    .map((g) => ({
      ...g,
      actions: g.actions.filter((a) => a.label.toLowerCase().includes(q)),
    }))
    .filter((g) => g.actions.length > 0);
}

/**
 * 把过滤结果压平成一条有序列表。
 *
 * 键盘上下移动需要跨组连续游标，而渲染要按组分行，两者共用同一个顺序，
 * 所以由这里定义"第 n 项是谁"。
 */
export function flattenPalette(groups: PaletteGroup[]): PaletteAction[] {
  return groups.flatMap((g) => g.actions);
}

/**
 * 把游标夹在合法范围内。
 *
 * 过滤之后结果会变短，游标可能越界；越界时回到最后一项而不是回到 0，
 * 因为用户通常是在往下浏览时被过滤收窄了结果。
 */
export function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  if (cursor < 0) return 0;
  if (cursor >= length) return length - 1;
  return cursor;
}

/** 面板属性。 */
export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** 由调用方组装的动作组：外壳不该知道"哪些动作存在"这件事。 */
  groups: PaletteGroup[];
}

/** 命令面板覆盖层。 */
export function CommandPalette({ open, onClose, groups }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 每次打开都清空：用户上次搜的"runtime.py"与这次要找的东西无关，
  // 留着只会让第一眼看到的是过期结果。
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    // 等一帧再聚焦：面板刚挂载时输入框还没进 DOM。
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const filtered = useMemo(() => filterPaletteGroups(groups, query), [groups, query]);
  const flat = useMemo(() => flattenPalette(filtered), [filtered]);

  // 过滤结果变化时把游标夹回去：否则用户按回车会执行一个已经不存在的位置。
  useEffect(() => {
    setCursor((c) => clampCursor(c, flat.length));
  }, [flat.length]);

  const runAt = useCallback(
    (index: number) => {
      const action = flat[index];
      if (!action) return;
      // 先关面板再执行：动作可能切换 surface 或打开文件，
      // 覆盖层留着会遮住它刚刚产生的界面变化。
      onClose();
      action.run();
    },
    [flat, onClose],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => clampCursor(c + 1, flat.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => clampCursor(c - 1, flat.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(cursor);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  // 渲染时按组切分游标：flat 的顺序与下面双重循环的枚举顺序一致。
  let seen = -1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("palette.title")}
      className="absolute inset-0 z-40 flex items-start justify-center bg-[rgba(4,7,9,0.62)] pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-[min(680px,92vw)] overflow-hidden rounded-[10px] border border-[var(--color-edge-2)] bg-[var(--color-ink-850)] shadow-[0_24px_64px_rgba(0,0,0,0.55)]"
        // 点面板内部不该关闭面板。
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-[9px] border-b border-[var(--color-edge-1)] px-3.5 py-[11px]">
          <Icon name="search" size={13} className="shrink-0 text-[var(--color-muted-2)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.placeholder")}
            className="min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-[var(--color-bone)] outline-none placeholder:text-[var(--color-faint)]"
          />
          <span className="shrink-0 rounded border border-[var(--color-edge-2)] px-[5px] py-px text-[10px] text-[var(--color-faint)]">
            esc
          </span>
        </div>

        <div className="max-h-[46vh] overflow-auto">
          {flat.length === 0 && (
            <p className="px-3 py-4 text-[11.5px] text-[var(--color-muted)]">
              {t("palette.noResults", { query })}
            </p>
          )}

          {filtered.map((group) => (
            <div key={group.key} className="p-1.5">
              <p className="px-2 pt-1.5 pb-1 text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase">
                {group.label}
              </p>
              {group.actions.map((action) => {
                seen += 1;
                const on = seen === cursor;
                const index = seen;
                return (
                  <button
                    key={action.id}
                    type="button"
                    // 键盘与鼠标共用同一套游标：鼠标悬停不抢焦点，
                    // 避免用户正在打字时被悬停打乱选中项。
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => runAt(index)}
                    className={[
                      "flex h-[30px] w-full items-center gap-[9px] rounded-[6px] px-2 text-left text-[12px]",
                      on
                        ? "bg-[var(--color-ink-750)] text-[var(--color-bone)]"
                        : "text-[var(--color-bone-2)] hover:bg-[var(--color-ink-800)]",
                    ].join(" ")}
                  >
                    <Icon
                      name={action.icon}
                      size={14}
                      className={on ? "shrink-0 text-[var(--color-amber)]" : "shrink-0 text-[var(--color-muted-2)]"}
                    />
                    <span className="truncate">{action.label}</span>
                    {action.hint && (
                      <span className="ml-auto shrink-0 text-[10.5px] text-[var(--color-faint)]">
                        {action.hint}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-[var(--color-edge-1)] bg-[var(--color-ink-900)] px-3 py-[7px] text-[10px] text-[var(--color-faint)]">
          <span>
            <Kbd>↑↓</Kbd> {t("palette.move")}
          </span>
          <span>
            <Kbd>↵</Kbd> {t("palette.run")}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 底部键位提示里的键帽。 */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[4px] border border-[var(--color-edge-2)] px-1 py-px text-[9.5px]">
      {children}
    </span>
  );
}
