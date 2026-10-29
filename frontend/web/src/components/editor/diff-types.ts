/**
 * Diff 数据类型。
 *
 * 对应后端 `repository_browser_service._serialize_diff` 的输出：
 * 文件 → hunk → 行（带 origin 与 content）。后端已把 diff 解析成结构，
 * 前端不再自己解析 unified diff 文本。
 */

/** 行类型：新增、删除或上下文。 */
export type DiffLineOrigin = "+" | "-" | " ";

export interface DiffLine {
  origin: DiffLineOrigin;
  content: string;
}

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  old_path: string;
  new_path: string;
  /** Git delta 状态字符：M / A / D / R 等。 */
  status: string;
  additions: number;
  deletions: number;
  /** 删除的文件没有新内容，因此可能没有 hunks。 */
  hunks?: DiffHunk[];
}

export interface DiffStats {
  files_changed: number;
  additions: number;
  deletions: number;
}

export interface DiffPayload {
  files: DiffFile[];
  stats: DiffStats;
}

/**
 * hunk 内的一行，带上它在旧/新版本中的行号。
 *
 * 行内评论锚在「新版本行号」上；删除行没有新行号，取 null。
 */
export interface NumberedDiffLine extends DiffLine {
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

/**
 * 给 hunk 里的每一行标上行号。
 *
 * @param hunk hunk 数据
 * @returns 带行号的行数组
 */
export function numberHunkLines(hunk: DiffHunk): NumberedDiffLine[] {
  let oldLine = hunk.old_start;
  let newLine = hunk.new_start;

  return hunk.lines.map((line) => {
    const numbered: NumberedDiffLine = {
      ...line,
      oldLineNumber: null,
      newLineNumber: null,
    };

    if (line.origin === "+") {
      numbered.newLineNumber = newLine;
      newLine += 1;
    } else if (line.origin === "-") {
      numbered.oldLineNumber = oldLine;
      oldLine += 1;
    } else {
      numbered.oldLineNumber = oldLine;
      numbered.newLineNumber = newLine;
      oldLine += 1;
      newLine += 1;
    }

    return numbered;
  });
}

/** diff 文件的展示路径：优先用新路径，重命名时保留旧路径信息。 */
export function diffFilePath(file: DiffFile): string {
  return file.new_path || file.old_path;
}

/** diff 文件是否被重命名。 */
export function isRenamed(file: DiffFile): boolean {
  return file.status === "R" && file.old_path !== file.new_path;
}
