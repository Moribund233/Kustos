import type { DiffFile, DiffHunk, DiffPayload } from "@/components/editor/diff-types";

import type { PrDiffResponse } from "./types";

/**
 * PR diff 的前端适配。
 *
 * 后端 `GET /diff` 返回的是 pygit2 统一 diff 文本（外加无行数据的文件列表与
 * 统计），而 DiffViewer 需要「文件 → hunk → 行」的结构，这里在前端把 patch
 * 解析成 DiffPayload。
 */

/** 解析出的单个文件：路径 / 状态 + hunk 结构 + 行统计。 */
interface ParsedFile {
  old_path: string;
  new_path: string;
  status: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** `@@ -a,b +c,d @@` 头 → hunk；行数缺省为 1。 */
function parseHunkHeader(line: string): DiffHunk | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return null;
  return {
    old_start: Number(match[1]),
    old_lines: match[2] ? Number(match[2]) : 1,
    new_start: Number(match[3]),
    new_lines: match[4] ? Number(match[4]) : 1,
    lines: [],
  };
}

/**
 * 解析统一 diff 文本为按文件分组的 hunk/行。
 *
 * 文件头行只在 hunk 之外出现，hunk 内的行一定带 `+`/`-`/空格前缀，
 * 据此区分头行与内容行（内容行可能以 `--- ` 开头）。
 */
function parsePatch(patch: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;
  let inHunk = false;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      current = { old_path: "", new_path: "", status: "M", hunks: [], additions: 0, deletions: 0 };
      files.push(current);
      inHunk = false;
      const paths = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (paths) {
        current.old_path = paths[1] ?? "";
        current.new_path = paths[2] ?? "";
      }
      continue;
    }
    if (!current) continue;

    if (!inHunk) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        current.hunks.push(hunk);
        inHunk = true;
      } else if (line.startsWith("new file mode")) {
        current.status = "A";
      } else if (line.startsWith("deleted file mode")) {
        current.status = "D";
      } else if (line.startsWith("rename from ")) {
        current.status = "R";
        current.old_path = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        current.new_path = line.slice("rename to ".length);
      } else if (line.startsWith("--- ")) {
        const path = line.slice(4);
        if (path !== "/dev/null") current.old_path = path.replace(/^a\//, "");
      } else if (line.startsWith("+++ ")) {
        const path = line.slice(4);
        if (path !== "/dev/null") current.new_path = path.replace(/^b\//, "");
      }
      continue;
    }

    const hunkHeader = parseHunkHeader(line);
    if (hunkHeader) {
      current.hunks.push(hunkHeader);
      continue;
    }
    // `\ No newline at end of file` 不是内容行
    if (line.startsWith("\\")) continue;

    const hunk = current.hunks[current.hunks.length - 1];
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ origin: "+", content: line.slice(1) });
      current.additions += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ origin: "-", content: line.slice(1) });
      current.deletions += 1;
    } else if (line.length > 0) {
      hunk.lines.push({ origin: " ", content: line.slice(1) });
    }
  }

  return files;
}

/**
 * 把 diff 端点响应适配成 DiffViewer 的 DiffPayload。
 *
 * 状态与展示路径以后端 `files` 列表为准（含重命名旧路径），
 * 行数据与每文件 +/- 统计来自 patch 解析，总体统计用后端 `stats`。
 */
export function toDiffPayload(response: PrDiffResponse): DiffPayload {
  const parsed = parsePatch(response.diff ?? "");
  const meta = response.files ?? [];

  const files: DiffFile[] = parsed.map((file, index) => {
    const info =
      meta[index] ?? meta.find((item) => item.path === file.new_path || item.path === file.old_path);
    const status = info?.status_code ?? file.status;
    const oldPath = status === "A" ? "" : (info?.old_path ?? file.old_path);
    const newPath = info?.path ?? file.new_path;
    return {
      old_path: oldPath,
      new_path: newPath,
      status,
      additions: file.additions,
      deletions: file.deletions,
      ...(file.hunks.length > 0 ? { hunks: file.hunks } : {}),
    };
  });

  const stats = response.stats ?? {
    files_changed: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };

  return {
    files,
    stats: {
      files_changed: stats.files_changed,
      additions: stats.additions,
      deletions: stats.deletions,
    },
  };
}
