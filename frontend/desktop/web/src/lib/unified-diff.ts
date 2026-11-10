/**
 * 解析 `git diff` 的原始文本。
 *
 * 只看 hunk 内容行：文件头（`diff --git`、`index`、`---`、`+++`）对"这行改了什么"
 * 没有信息量，而桌面端的详情区宽度有限，保留它们只会挤掉有效内容。
 *
 * 不引第三方 diff 库：需要的只是行级着色，引入一个解析器会带来它自己的
 * 边界行为（尤其是二进制与超长行），而这些在本地工作树的场景里并不重要。
 */

export type DiffLineKind = "add" | "remove" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** hunk 内左侧行号（新增行为空）。 */
  oldLine: number | null;
  /** hunk 内右侧行号（删除行为空）。 */
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  /** 原文件是否被标记为二进制。 */
  binary: boolean;
  /**
   * 没有可显示内容时给出原因标识，避免详情区一片空白。
   *
   * 存**标识**而不是文案：这个函数是纯逻辑，拿不到 i18n 上下文，
   * 返回中文会让英文界面里冒出中文。翻译由调用方按标识查表。
   */
  note: "" | "noDiff" | "binary";
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** 二进制标记：git 在文件头区段输出的两种形态之一行首出现。 */
const BINARY_PREFIXES = ["Binary files ", "GIT binary patch"];

/** 判断一行是否是文件头噪声（不属于 hunk 内容）。 */
function isFileHeader(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ")
  );
}

/** 判断一行是否是二进制标记。 */
function isBinaryMarker(line: string): boolean {
  return BINARY_PREFIXES.some((p) => line.startsWith(p));
}

/**
 * 解析 unified diff 文本。
 *
 * hunk 的边界由 **hunk 头里的行数**决定，不由行前缀推断。这一点是必须的：
 * 一行被删除的 SQL/Lua/Haskell 注释在 diff 里正是 `--- 注释`，按前缀判断会被
 * 当成文件头 `--- a/file` 从而终止当前 hunk，导致该 hunk 后续内容整段消失。
 * 同理，文本内容里出现 "Binary files" 字样不该让整个文件被当成二进制。
 *
 * Args:
 *
 *	raw: `git diff` / `git diff --cached` 的原始输出
 *
 * Returns:
 *
 *	按 hunk 分组的行级内容；空输入返回带说明的空结果而不是抛错，
 *	因为"这个文件没有差异"是正常状态。
 */
export function parseUnifiedDiff(raw: string | null | undefined): ParsedDiff {
  if (!raw || raw.trim() === "") {
    return { hunks: [], binary: false, note: "noDiff" };
  }

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  // 当前 hunk 还各差多少行才算读完（取自 hunk 头）。读完即结束该 hunk，
  // 之后的行才重新按文件头规则处理。
  let oldLeft = 0;
  let newLeft = 0;
  let binary = false;
  let sawHunk = false;

  // CRLF 归一：Windows 上未规范化的 diff 输出会在每行尾部带 `\r`，
  // 它混进 header 与内容行后是不可见字符——着色看不出问题，但折叠标题、
  // 复制出来的文本、以及任何按行宽度的布局都会带上它。
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const m = HUNK_RE.exec(line);
    if (m) {
      sawHunk = true;
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      // 省略行数（`@@ -1 +1 @@`）表示 1 行，不是 0 行。
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }

    // hunk 内一律按内容行处理，不套文件头规则——见函数头的说明。
    if (current && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("+")) {
        current.lines.push({ kind: "add", text: line.slice(1), oldLine: null, newLine });
        newLine++;
        newLeft--;
      } else if (line.startsWith("-")) {
        current.lines.push({ kind: "remove", text: line.slice(1), oldLine, newLine: null });
        oldLine++;
        oldLeft--;
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file"：提示性质，不当成内容行，也不占行数。
        current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      } else {
        // 上下文行以空格开头（git 会保留这个前缀）。
        const text = line.startsWith(" ") ? line.slice(1) : line;
        current.lines.push({ kind: "context", text, oldLine, newLine });
        oldLine++;
        newLine++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }

    // 行数已读完，但紧跟着的 `\ No newline at end of file` 仍属于这个 hunk：
    // git 把标记放在它所修饰的那一行之后，而那一行正好是 hunk 的最后一行。
    if (current && line.startsWith("\\")) {
      current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }

    // hunk 已读完（或尚未开始）：此时才是文件头区段。
    current = null;

    // 二进制标记只在 hunk 之外成立：文本里出现这个词不该吞掉整份 diff。
    if (isBinaryMarker(line)) {
      binary = true;
      continue;
    }
    if (isFileHeader(line)) continue;
    // 末尾的空串是 split 的产物，不是内容；其余游离行（例如无 hunk 的
    // 文件头区段里的 `literal 12`）同样不属于任何 hunk。
  }

  if (binary) {
    return { hunks: [], binary: true, note: "binary" };
  }

  // 只有零内容行的 hunk 等于没有可显示内容：留着它会让详情区出现一块
  // "有折叠标题、没有任何行"的空块。
  const nonEmpty = hunks.filter((h) => h.lines.length > 0);
  if (!sawHunk || nonEmpty.length === 0) {
    return { hunks: [], binary: false, note: "noDiff" };
  }
  return { hunks: nonEmpty, binary: false, note: "" };
}

/** 统计新增与删除行数，用于列表里的 +N/-N 徽标。 */
export function diffStats(parsed: ParsedDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added++;
      else if (line.kind === "remove") removed++;
    }
  }
  return { added, removed };
}

