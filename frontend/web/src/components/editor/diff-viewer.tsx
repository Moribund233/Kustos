import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  diffFilePath,
  isRenamed,
  numberHunkLines,
  type DiffFile,
  type DiffHunk,
  type DiffPayload,
} from "./diff-types";

export type { DiffFile, DiffHunk, DiffPayload } from "./diff-types";

interface DiffViewerProps {
  payload: DiffPayload;
  className?: string;
  /** 行内评论锚点：返回被点击的行号与所在文件。 */
  onLineClick?: (file: DiffFile, lineNumber: number) => void;
  /** 已有行内评论的行号（新版本行号），用于在行尾标出讨论标记。 */
  commentedLines?: Record<string, number[]>;
}

interface DiffFileBlockProps {
  file: DiffFile;
  defaultOpen?: boolean;
  onLineClick?: (file: DiffFile, lineNumber: number) => void;
  commentedLines?: number[];
}

/** 单个文件的 diff 区块。 */
function DiffFileBlock({
  file,
  defaultOpen = true,
  onLineClick,
  commentedLines = [],
}: DiffFileBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const path = diffFilePath(file);
  const commented = new Set(commentedLines);

  return (
    <section className="border-edge-1 bg-ink-900 mb-3 overflow-hidden rounded-md border">
      <header className="border-edge-1 bg-ink-850 flex items-center gap-2 border-b px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="text-muted hover:text-bone-2 flex items-center gap-1.5"
          aria-expanded={open}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="font-mono text-[12px]">{path}</span>
        </button>
        {isRenamed(file) && (
          <span className="text-faint font-mono text-[11px]">← {file.old_path}</span>
        )}
        <span className="text-faint ml-auto flex items-center gap-2 font-mono text-[11px]">
          <span className="text-sage">+{file.additions}</span>
          <span className="text-rose">−{file.deletions}</span>
        </span>
      </header>

      {open && (
        <div className="font-mono text-[12px] leading-relaxed">
          {(file.hunks ?? []).map((hunk, hunkIndex) => (
            <DiffHunkBlock
              key={`${path}-${hunkIndex}`}
              hunk={hunk}
              file={file}
              commented={commented}
              onLineClick={onLineClick}
            />
          ))}
          {file.status === "D" && <p className="text-faint px-3 py-2">文件已删除</p>}
        </div>
      )}
    </section>
  );
}

interface DiffHunkBlockProps {
  hunk: DiffHunk;
  file: DiffFile;
  commented: Set<number>;
  onLineClick?: (file: DiffFile, lineNumber: number) => void;
}

/** 单个 hunk：表头 + 逐行内容。 */
function DiffHunkBlock({ hunk, file, commented, onLineClick }: DiffHunkBlockProps) {
  const lines = numberHunkLines(hunk);

  return (
    <div className="border-edge-1 border-b last:border-b-0">
      <div className="bg-ink-850/60 text-faint border-edge-1 border-b px-3 py-1 text-[11px]">
        @@ -{hunk.old_start},{hunk.old_lines} +{hunk.new_start},{hunk.new_lines} @@
      </div>
      {lines.map((line, index) => {
        const lineNumber = line.newLineNumber;
        const hasComment = lineNumber !== null && commented.has(lineNumber);

        return (
          <div
            key={index}
            className={cn(
              "grid grid-cols-[3.25rem_3.25rem_1.5rem_1fr] items-start",
              hasComment && "bg-amber/5",
            )}
          >
            <span className="text-faint pr-2 text-right select-none">
              {line.oldLineNumber ?? ""}
            </span>
            <span className="text-faint pr-2 text-right select-none">
              {line.newLineNumber ?? ""}
            </span>
            <span
              className={cn(
                "text-center select-none",
                line.origin === "+" && "text-sage",
                line.origin === "-" && "text-rose",
                line.origin === " " && "text-faint",
              )}
            >
              {line.origin}
            </span>
            <button
              type="button"
              disabled={!onLineClick || lineNumber === null}
              onClick={() => {
                if (onLineClick && lineNumber !== null) onLineClick(file, lineNumber);
              }}
              className="hover:bg-ink-800/60 block w-full truncate pr-3 text-left whitespace-pre disabled:cursor-default disabled:hover:bg-transparent"
            >
              {line.content}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Diff 视图。
 *
 * 对应原型 `pull.html` 的文件分组 + hunk + 行内讨论结构。
 * 面板浮在画布上，这里只负责内容，不做布局。
 */
export function DiffViewer({ payload, className, onLineClick, commentedLines }: DiffViewerProps) {
  if (!payload.files.length) {
    return <p className="text-faint py-6 text-center text-[13px]">没有差异</p>;
  }

  return (
    <div className={cn("space-y-0", className)}>
      {payload.files.map((file) => (
        <DiffFileBlock
          key={`${file.old_path}-${file.new_path}`}
          file={file}
          onLineClick={onLineClick}
          commentedLines={commentedLines?.[file.new_path] ?? []}
        />
      ))}
    </div>
  );
}
