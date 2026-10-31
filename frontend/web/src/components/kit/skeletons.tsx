import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * 骨架屏组合件。
 *
 * 单块占位由 `components/ui/skeleton` 提供，这里只做「一整段内容」的形状：
 * 段落、列表行。各页面再按自己的版式拼装（统计条、代码行、符号树），
 * 避免把所有页面的骨架都堆进一个文件里。
 */

interface SkeletonTextProps {
  /** 行数。最后一行默认收到 62% 宽，模拟段落的自然收尾。 */
  lines?: number;
  /** 逐行宽度覆盖，长度不足时用默认值。 */
  widths?: string[];
  className?: string;
}

/** 段落占位：等距细线，末行留白。 */
export function SkeletonText({ lines = 3, widths, className }: SkeletonTextProps) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className="h-2.5"
          style={{ width: widths?.[index] ?? (index === lines - 1 ? "62%" : "100%") }}
        />
      ))}
    </div>
  );
}

/**
 * 代码行占位：等宽行号槽 + 参差的行宽。
 *
 * 用于 diff、blame 这类「等宽逐行」的内容。行宽按取模序列生成，
 * 既不整齐得像表格，也不乱到显得脏。
 */
export function SkeletonCodeLines({ lines = 12, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col gap-1.5", className)}>
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-2 w-5 flex-none opacity-60" />
          <Skeleton className="h-2" style={{ width: `${24 + ((index * 37) % 58)}%` }} />
        </div>
      ))}
    </div>
  );
}

interface SkeletonRowsProps {
  rows?: number;
  /** 行首占位：状态灯圆点、仓库字形方块、头像，或直接省略。 */
  leading?: "dot" | "glyph" | "avatar" | "none";
  /** 行尾是否留一块元信息占位（时间、计数）。 */
  meta?: boolean;
  className?: string;
  /** 行内边距/边框覆盖，用于对齐各页面真实列表行。 */
  rowClassName?: string;
}

const LEADING_CLASS: Record<NonNullable<SkeletonRowsProps["leading"]>, string> = {
  dot: "size-1.5 rounded-full",
  glyph: "size-6 rounded-md",
  avatar: "size-7 rounded-full",
  none: "hidden",
};

/** 列表占位：行首标识 + 主副两行文本 + 可选行尾元信息。 */
export function SkeletonRows({
  rows = 6,
  leading = "dot",
  meta = true,
  className,
  rowClassName,
}: SkeletonRowsProps) {
  return (
    <div aria-hidden="true" className={className}>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className={cn(
            "border-edge-1 flex items-center gap-3 border-b px-3 py-3 last:border-b-0",
            rowClassName,
          )}
        >
          <Skeleton className={cn("flex-none", LEADING_CLASS[leading])} />
          <span className="min-w-0 flex-1">
            {/* 标题行宽度按 3 段循环，避免所有行等长显得像表格线 */}
            <Skeleton className="h-2.5" style={{ width: `${56 + ((index % 3) * 14) % 34}%` }} />
            <span className="mt-1.5 flex items-center gap-2">
              <Skeleton className="h-2 w-14" />
              <Skeleton className="h-2 w-24" />
            </span>
          </span>
          {meta ? <Skeleton className="h-2 w-10 flex-none" /> : null}
        </div>
      ))}
    </div>
  );
}
