import type { DiffHunk, DiffLine } from "./unified-diff";

/**
 * 把 unified diff 的一个 hunk 配成左右两栏的行。
 *
 * 原型里评审窗右上角有「Split」按钮，点了把差异从单栏切成左右对照。切换本身
 * 只是视图选择，但"怎么配对"不是：git 的 hunk 里删除行与新增行各自成块，
 * 块与块之间靠上下文行隔开。按块配对（第 n 条删除对第 n 条新增）是 diff 工具
 * 的通行做法，也正好还原原型里左右行号对齐的观感——不配对而按顺序铺开，
 * 两栏会立刻错行。
 *
 * 配对只在**同一块内**做：一块里删除多、新增少时，多出来的那几行只有一侧有
 * 内容（另一侧留空），这比跨块强行拉平更贴近原文。
 *
 * 不抛错：输入再脏也只会退化成"一侧有内容、另一侧空"的行，渲染层不需要
 * 为解析结果再做一层判空。
 */

/** 一行在两栏里的落位：左侧是旧文件，右侧是新文件。 */
export interface SplitRow {
  /** 旧文件侧；该行是纯新增时为 null。 */
  left: DiffLine | null;
  /** 新文件侧；该行是纯删除时为 null。 */
  right: DiffLine | null;
  /**
   * 标记行（`\ No newline at end of file` 这类）。
   *
   * 它不属于任何一侧，渲染时横跨两栏：硬塞进某一侧会让人误以为那侧有内容。
   */
  meta: DiffLine | null;
}

/**
 * 把 hunk 的行配成两栏。
 *
 * Args:
 *
 *	hunk: 已解析的 hunk
 *
 * Returns:
 *
 *	按原顺序排列的两栏行；上下文行两侧同时有内容。
 */
export function splitHunk(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let removes: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = (): void => {
    const count = Math.max(removes.length, adds.length);
    for (let i = 0; i < count; i += 1) {
      rows.push({ left: removes[i] ?? null, right: adds[i] ?? null, meta: null });
    }
    removes = [];
    adds = [];
  };

  for (const line of hunk.lines) {
    if (line.kind === "remove") {
      removes.push(line);
      continue;
    }
    if (line.kind === "add") {
      adds.push(line);
      continue;
    }
    // 上下文行与标记行都会打断当前块：先把已经攒下的删除/新增配完，
    // 否则一条后续的删除会被配到前面那条新增上，两栏顺序整个错位。
    flush();
    if (line.kind === "meta") {
      rows.push({ left: null, right: null, meta: line });
      continue;
    }
    rows.push({ left: line, right: line, meta: null });
  }

  flush();
  return rows;
}
