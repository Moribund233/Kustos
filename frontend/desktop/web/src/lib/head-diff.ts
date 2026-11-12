/**
 * 编辑器行标：把「HEAD 版本」和「编辑器里的当前文本」按月对齐成逐行的增删标记。
 *
 * 为什么在本地对整个文件做 diff，而不是直接用 `git diff` 的输出：
 *
 * - `git diff` 只描述**磁盘上**的文件，而编辑器里可能还有没保存的改动。
 *   用户一边打字一边看行标，行标必须跟着缓冲区走，否则标记会停在上一版位置上。
 * - `git diff` 给的是 hunk，未改动的行不在里面；行标需要的是"每一行是什么状态"，
 *   是全文范围的问题。
 *
 * 因此 Go 侧只提供 HEAD 版本的原文，对齐放在这里做；纯函数、可单测。
 */

/**
 * 一行相对 HEAD 的状态。
 *
 * - `added`：这行是新加的
 * - `modified`：这行本身换了内容（旧行被改写成它）
 * - `removed`：这行前面少了东西——纯删除没有对应的新行，只能挂在删除位置之后
 *   那一行上，否则"这里删了几行"在界面上完全看不见
 */
export type LineMark = "added" | "modified" | "removed";

/** 对齐结果。 */
export interface HeadDiff {
  /**
   * 逐行标记，`marks[i]` 对应编辑器第 `i + 1` 行；`null` 表示这行相对 HEAD 没变。
   *
   * 长度等于当前文本的行数（与 CodeMirror 的 `doc.lines` 同一口径：末尾换行
   * 会多出一个空行，两边用同一套切分方式，行号才对得上号）。
   */
  marks: (LineMark | null)[];
  /** 相对 HEAD 新增的行数。 */
  added: number;
  /** 相对 HEAD 删除的行数。 */
  removed: number;
}

/**
 * 中间段做 LCS 的规模上限。
 *
 * 前后公共部分先剥掉之后，正常编辑只剩几行；只有在整篇重写时才会走到这里。
 * 超过上限就不再做逐行对齐，直接把整段记成"全部新增"——大文件全选重排时
 * 用户要的是"这里整块变了"，而不是一条精确但卡住界面的对齐结果。
 */
const MAX_LCS_CELLS = 4_000_000;

/**
 * 切行。
 *
 * 用 `split("\n")` 而不像界面里的行数统计那样 pop 掉末尾空行：CodeMirror 的
 * 最后一行就是那个空行，行标数组要按下标对上 `doc.line(n)`，必须同口径。
 * 同时剥掉 CRLF 的 `\r`，否则同一份内容在 Windows 上会被判成"改过"。
 */
function splitLines(text: string): string[] {
  return text.replace(/\r/g, "").split("\n");
}

/**
 * 切 HEAD 里的文件内容。
 *
 * 空文本是零行，而不是 `[""]`：HEAD 里的空文件确实一行都没有。若按当前文本的
 * 切法处理，"空文件改成两行"会被当成"删一行空行、加两行"，两行都变成"修改"。
 */
function splitHeadLines(text: string): string[] {
  const normalized = text.replace(/\r/g, "");
  return normalized === "" ? [] : normalized.split("\n");
}

/** 对齐两份文本，得出逐行标记。 */
export function compareWithHead(headText: string | null, currentText: string): HeadDiff {
  const current = splitLines(currentText);
  const marks: (LineMark | null)[] = new Array(current.length).fill(null);

  // HEAD 未知（新文件、读不到）时整份都是新增：这正是新文件该有的样子。
  if (headText === null) {
    for (let i = 0; i < marks.length; i += 1) marks[i] = "added";
    return { marks, added: current.length, removed: 0 };
  }

  const head = splitHeadLines(headText);

  // 先把首尾相同的部分剥掉：编辑通常发生在局部，剥完只剩几行要算 LCS。
  let prefix = 0;
  while (prefix < head.length && prefix < current.length && head[prefix] === current[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < head.length - prefix &&
    suffix < current.length - prefix &&
    head[head.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const headMid = head.slice(prefix, head.length - suffix);
  const curMid = current.slice(prefix, current.length - suffix);

  const stat = { added: 0, removed: 0 };

  if (headMid.length === 0) {
    // 纯新增：中间的每一行都是新加进来的。
    for (let i = 0; i < curMid.length; i += 1) marks[prefix + i] = "added";
    stat.added = curMid.length;
    return { marks, ...stat };
  }

  if (curMid.length === 0) {
    // 纯删除：标记落在这段删除之后的第一行上（删到文件末尾时落在最后一行），
    // 让用户看得到"这里少了东西"，而不是一片空白。
    markDeletionAnchor(marks, prefix, current.length);
    stat.removed = headMid.length;
    return { marks, ...stat };
  }

  if (curMid.length * headMid.length > MAX_LCS_CELLS) {
    // 整段重写：不再逐行对齐，按"全新增 + 全删除"记账。
    for (let i = 0; i < curMid.length; i += 1) marks[prefix + i] = "added";
    stat.added = curMid.length;
    stat.removed = headMid.length;
    return { marks, ...stat };
  }

  // 逐段处理变更块：一段里删了 d 行、加了 i 行。
  for (const block of alignmentBlocks(headMid, curMid)) {
    const newStart = prefix + block.newIndex;
    if (block.deleted === 0) {
      for (let i = 0; i < block.inserted; i += 1) marks[newStart + i] = "added";
    } else if (block.inserted === 0) {
      markDeletionAnchor(marks, newStart, current.length);
    } else if (isBlankSlice(curMid, block.newIndex, block.inserted)) {
      // 加进来的都是空行、同时又删了东西：这是"内容被清掉后留下空行"，
      // 不是"这一行改了内容"。标成删除锚点才说得通。
      markDeletionAnchor(marks, newStart, current.length);
    } else {
      // 有删有加视为"改这几行"：用蓝色区分于纯新增的绿色。
      for (let i = 0; i < block.inserted; i += 1) marks[newStart + i] = "modified";
      if (block.deleted > block.inserted) {
        // 删得比加得多，多出来的删除挂到块后那一行上。
        markDeletionAnchor(marks, newStart + block.inserted, current.length);
      }
    }
    stat.added += block.inserted;
    stat.removed += block.deleted;
  }

  return { marks, ...stat };
}

/**
 * 这段插入是不是全是空行。
 *
 * 清空文件后编辑器里会剩一行空行，那是"内容被删掉"的余留，不是改写出来的一行。
 */
function isBlankSlice(lines: string[], start: number, count: number): boolean {
  if (count === 0) return false;
  for (let i = 0; i < count; i += 1) {
    if (lines[start + i].trim() !== "") return false;
  }
  return true;
}

/**
 * 纯删除的落点：优先标在删除位置之后的那一行，删在文件末尾时退回最后一行。
 *
 * 已有标记的行不覆盖：那块已经用增改色表达过状态，再涂一层反而看不出主次。
 */
function markDeletionAnchor(marks: (LineMark | null)[], index: number, lineCount: number): void {
  if (lineCount === 0) return;
  const target = index < lineCount ? index : lineCount - 1;
  if (marks[target] === null) marks[target] = "removed";
}

/** 一段变更：相对当前文本的起点、删了几行、加了几行。 */
interface AlignmentBlock {
  /** 这段变更在当前文本里的起始下标（0 基）。 */
  newIndex: number;
  /** 删掉的行数。 */
  deleted: number;
  /** 新增的行数。 */
  inserted: number;
}

/**
 * 用 LCS 求出两份文本的差异段。
 *
 * 先算最长公共子序列的长度表，再从末尾往前回溯，把连续的删除/新增合并成块。
 * 只返回"有变化"的段，未变化的行靠块之间的间隔隐式表达。
 */
function alignmentBlocks(head: string[], current: string[]): AlignmentBlock[] {
  const n = head.length;
  const m = current.length;

  // 长度表用一维数组：`table[i * (m + 1) + j]` = head[i..] 与 current[j..] 的 LCS 长度。
  const stride = m + 1;
  const table = new Uint32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * stride + j] =
        head[i] === current[j]
          ? table[(i + 1) * stride + (j + 1)] + 1
          : Math.max(table[(i + 1) * stride + j], table[i * stride + (j + 1)]);
    }
  }

  const blocks: AlignmentBlock[] = [];
  let i = 0;
  let j = 0;
  let pending: AlignmentBlock | null = null;

  const flush = () => {
    if (pending) blocks.push(pending);
    pending = null;
  };

  while (i < n && j < m) {
    if (head[i] === current[j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }
    if (!pending) pending = { newIndex: j, deleted: 0, inserted: 0 };
    if (table[(i + 1) * stride + j] >= table[i * stride + (j + 1)]) {
      pending.deleted += 1;
      i += 1;
    } else {
      pending.inserted += 1;
      j += 1;
    }
  }

  // 尾巴上剩下的一侧也属于最后一段变更。
  if (i < n || j < m) {
    if (!pending) pending = { newIndex: j, deleted: 0, inserted: 0 };
    if (i < n) pending.deleted += n - i;
    if (j < m) pending.inserted += m - j;
  }
  flush();

  return blocks;
}
