/**
 * 编辑器的 diff 行标与 blame 行。
 *
 * 为什么做成 CodeMirror 扩展而不是 React 组件：
 *
 * - 行标要贴着**行**走。折叠、按行号定位、滚动都只有编辑器自己知道，在外面用
 *   React 画一层，行高一变就错位。
 * - 行标要随缓冲区实时更新：用户打字时标记必须立刻跟着移动。但注入的扩展数组
 *   必须保持稳定（`CodeView` 的扩展插槽按数组身份重配），所以数据不通过 props
 *   传递，而是走一个外部数据源 + `StateEffect`：数组不动，只往编辑器里推新状态。
 */
import { RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter } from "@codemirror/view";

import type { BlameLine } from "@/bindings/github.com/kustos/kustos-desktop/internal/git/models";
import type { HeadDiff, LineMark } from "@/lib/head-diff";

/**
 * 一个可被外部推进、可被扩展订阅的只读数据源。
 *
 * React 侧持有实际数据，编辑器侧只订阅变化：两边互不依赖，谁先就绪都不报错。
 */
export interface MarksSource<T> {
  /** 当前值。 */
  get(): T;
  /** 订阅变化；返回取消订阅的函数。 */
  subscribe(listener: () => void): () => void;
}

/** 由调用方持有、可写的数据源。 */
export interface MutableMarksSource<T> extends MarksSource<T> {
  /** 写入新值并通知订阅者；与旧值相同时什么都不做。 */
  set(next: T): void;
}

/**
 * 建一个可写数据源。
 *
 * 相等判断用引用比较：调用方负责在数据没变时复用同一个对象（`useMemo`），
 * 这样打字引起的重渲染不会每次都触发一次编辑器状态更新。
 */
export function createMarksSource<T>(initial: T): MutableMarksSource<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * 把数据源接到编辑器状态上。
 *
 * Returns:
 *
 *   一个 state field（存数据）与一个 view plugin（转发订阅）。
 */
function follow<T>(source: MarksSource<T>) {
  const effect = StateEffect.define<T>();
  const field = StateField.define<T>({
    create: () => source.get(),
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(effect)) return e.value;
      }
      return value;
    },
  });
  const plugin = ViewPlugin.fromClass(
    class {
      private readonly stop: () => void;

      constructor(view: EditorView) {
        this.stop = source.subscribe(() => {
          const next = source.get();
          if (Object.is(view.state.field(field), next)) return;
          view.dispatch({ effects: effect.of(next) });
        });
      }

      destroy(): void {
        this.stop();
      }
    },
  );
  return { field, extensions: [field, plugin] as Extension };
}

/** 三种行标的说明文字，用作 gutter 元素的 title。 */
export interface DiffMarkLabels {
  added: string;
  modified: string;
  removed: string;
}

/** 一种行标对应的固定 DOM；`eq` 让 CodeMirror 复用已有元素，避免每帧重建。 */
class DiffMarker extends GutterMarker {
  constructor(
    private readonly mark: LineMark,
    private readonly labels: DiffMarkLabels,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof DiffMarker && other.mark === this.mark;
  }

  toDOM(): Node {
    const span = document.createElement("span");
    span.className = `cm-diff-mark cm-diff-mark-${this.mark}`;
    span.title = this.labels[this.mark];
    return span;
  }
}

/** 逐行标记转成 gutter 的元素集合。 */
function markRanges(diff: HeadDiff | null, doc: Text, marks: Record<LineMark, DiffMarker>): RangeSet<GutterMarker> {
  if (!diff) return RangeSet.empty;

  // 标记数组的行数与文档行数不一致，只可能是"内容刚被替换、标记还没重算"的那
  // 一帧。按较小的一侧收敛：多画会闪出一条错位的标记，少画只是短暂缺一段。
  const limit = Math.min(diff.marks.length, doc.lines);
  const ranges: { from: number; to: number; value: GutterMarker }[] = [];
  for (let i = 0; i < limit; i += 1) {
    const mark = diff.marks[i];
    if (!mark) continue;
    const line = doc.line(i + 1);
    // gutter 的标记必须落到一个行块上；`from`/`to` 都取行首，表示"挂在这一行"。
    ranges.push({ from: line.from, to: line.from, value: marks[mark] });
  }
  return RangeSet.of(ranges, true);
}

/**
 * diff 行标扩展。
 *
 * Args:
 *
 *   source: 逐行标记的数据源；`null` 表示没有数据，此时不画任何标记
 *   labels: 三种标记的 hover 说明
 *
 * Returns:
 *
 *   可塞进 `CodeView` 的 `extensions` 数组的扩展。
 */
export function diffGutter(source: MutableMarksSource<HeadDiff | null>, labels: DiffMarkLabels): Extension {
  const marks: Record<LineMark, DiffMarker> = {
    added: new DiffMarker("added", labels),
    modified: new DiffMarker("modified", labels),
    removed: new DiffMarker("removed", labels),
  };
  const tracking = follow(source);

  return [
    tracking.extensions,
    gutter({
      class: "cm-diff-gutter",
      // 行标不可交互：点它不该把光标挪走，用户点那里多半是想回编辑器继续打字。
      renderEmptyElements: false,
      initialSpacer: () => new DiffMarker("added", labels),
      markers: (view) => markRanges(view.state.field(tracking.field), view.state.doc, marks),
    }),
    EditorView.baseTheme({
      // 宽度写死 4px：有没有标记的行都占同一套布局，横向不跳动。
      ".cm-diff-gutter": { width: "4px", minWidth: "4px" },
      ".cm-diff-gutter .cm-gutterElement": { padding: "0", display: "flex" },
      ".cm-diff-mark": { display: "block", width: "4px", height: "100%", cursor: "default" },
      // 颜色取设计令牌：增 = sage、删 = rose、改 = sky，与评审窗的 diff 配色同源。
      ".cm-diff-mark-added": { backgroundColor: "var(--color-sage)" },
      ".cm-diff-mark-removed": { backgroundColor: "var(--color-rose)" },
      ".cm-diff-mark-modified": { backgroundColor: "var(--color-sky)" },
    }),
  ];
}

/** blame 一行的说明文字。 */
export interface BlameLabels {
  /** 未提交行的说明。 */
  uncommitted: string;
  /** hover 提示：作者、时间、标题拼好的一段话。 */
  describe: (line: BlameLine) => string;
}

/** 一行 blame 的作者缩写；同一提交复用同一个元素。 */
class BlameMarker extends GutterMarker {
  constructor(
    private readonly line: BlameLine,
    private readonly labels: BlameLabels,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof BlameMarker &&
      other.line.commit === this.line.commit &&
      other.line.author === this.line.author &&
      other.line.time === this.line.time &&
      other.line.summary === this.line.summary
    );
  }

  toDOM(): Node {
    const span = document.createElement("span");
    span.className = this.line.commit === "" ? "cm-blame cm-blame-dirty" : "cm-blame";
    span.textContent = this.line.commit === "" ? this.labels.uncommitted : abbreviate(this.line.author);
    span.title = this.labels.describe(this.line);
    return span;
  }
}

/** 作者名缩写：中文名整段保留，英文名取姓氏之前的词或首字母。 */
function abbreviate(author: string): string {
  const trimmed = author.trim();
  if (trimmed === "") return "?";
  // 非 ASCII（中文、日文等）没有"名 姓"之分，整段更可读，代价是列宽。
  if (/[^\x20-\x7e]/.test(trimmed)) return trimmed.slice(0, 6);
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 10);
  // 英文名习惯把姓放最后，取姓更短也更好认。
  return parts[parts.length - 1].slice(0, 10);
}

/** blame 行数据转成 gutter 的元素集合。 */
function blameRanges(
  lines: BlameLine[] | null,
  doc: Text,
  labels: BlameLabels,
): RangeSet<GutterMarker> {
  if (!lines || lines.length === 0) return RangeSet.empty;
  const ranges: { from: number; to: number; value: GutterMarker }[] = [];
  for (const line of lines) {
    // blame 给的是工作树侧行号；超出当前文档的行（编辑器里已删掉）直接跳过。
    if (line.line < 1 || line.line > doc.lines) continue;
    const start = doc.line(line.line).from;
    ranges.push({ from: start, to: start, value: new BlameMarker(line, labels) });
  }
  return RangeSet.of(ranges, true);
}

/**
 * blame 行扩展。
 *
 * Args:
 *
 *   source: 逐行归属数据源；`null` 表示没开启或没有数据
 *   labels: 缩写之外的文字（未提交、hover 提示）
 *
 * Returns:
 *
 *   可塞进 `CodeView` 的 `extensions` 数组的扩展。
 */
export function blameGutter(source: MutableMarksSource<BlameLine[] | null>, labels: BlameLabels): Extension {
  const tracking = follow(source);

  return [
    tracking.extensions,
    gutter({
      class: "cm-blame-gutter",
      renderEmptyElements: false,
      initialSpacer: () => new BlameMarker({ line: 1, commit: "", author: "", time: 0, summary: "" }, labels),
      markers: (view) => blameRanges(view.state.field(tracking.field), view.state.doc, labels),
    }),
    EditorView.baseTheme({
      ".cm-blame-gutter": { minWidth: "84px" },
      ".cm-blame-gutter .cm-gutterElement": {
        padding: "0 8px 0 10px",
        maxWidth: "140px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "var(--text-2xs)",
        color: "var(--color-faint)",
      },
      ".cm-blame-dirty": { color: "var(--color-amber-3)", fontStyle: "italic" },
    }),
  ];
}

/** 光标所在的行，1 基。 */
export interface CursorLine {
  /** 行号，从 1 开始。 */
  line: number;
}

/**
 * 光标行上报扩展。
 *
 * blame 的当前行说明要跟着光标走（"这一行是谁写的"），而 `CodeView` 只对外
 * 暴露内容与变更回调，没有选区回调。用一个只读的扩展把光标行推出去，比往通用
 * 编辑器组件加一个只服务桌面的 prop 更克制。
 *
 * Args:
 *
 *   onChange: 光标行变化时调用；同一行内改列不触发
 *
 * Returns:
 *
 *   可注入的扩展。
 */
export function cursorLineReporter(onChange: (cursor: CursorLine) => void): Extension {
  return ViewPlugin.fromClass(
    class {
      private last = 0;

      constructor(private readonly view: EditorView) {
        this.report();
      }

      update(update: {
        docChanged: boolean;
        selectionSet: boolean;
        state: EditorView["state"];
      }): void {
        if (!update.docChanged && !update.selectionSet) return;
        this.report();
      }

      private report(): void {
        const head = this.view.state.selection.main.head;
        const line = this.view.state.doc.lineAt(head).number;
        if (line === this.last) return;
        this.last = line;
        onChange({ line });
      }
    },
  );
}
