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
  /** 没有可显示内容时给出原因，避免详情区一片空白。 */
  note: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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

/**
 * 解析 unified diff 文本。
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
    return { hunks: [], binary: false, note: "这个文件没有可显示的差异。" };
  }

  if (raw.includes("Binary files") || raw.includes("GIT binary patch")) {
    return { hunks: [], binary: true, note: "二进制文件，不显示逐行差异。" };
  }

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let sawHunk = false;

  for (const line of raw.split("\n")) {
    // 末尾的空串是 split 的产物，不是内容。
    if (line === "" && current === null) continue;

    const m = HUNK_RE.exec(line);
    if (m) {
      sawHunk = true;
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }

    if (isFileHeader(line)) {
      // 文件头出现在 hunk 之间时，后续内容属于新的 hunk 区段；
      // 把 current 置空，避免把下一段的 @@ 之前的内容错塞进上一段。
      current = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", text: line.slice(1), oldLine: null, newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "remove", text: line.slice(1), oldLine, newLine: null });
      oldLine++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"：提示性质，不当成内容行。
      current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
    } else {
      // 上下文行以空格开头（git 会保留这个前缀）。
      const text = line.startsWith(" ") ? line.slice(1) : line;
      current.lines.push({ kind: "context", text, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }

  if (!sawHunk) {
    return { hunks: [], binary: false, note: "这个文件没有可显示的差异。" };
  }
  return { hunks, binary: false, note: "" };
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
