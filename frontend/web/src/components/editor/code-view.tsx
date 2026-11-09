import { CodeView as SharedCodeView, type CodeViewProps } from "@kustos/editor";

import { cn } from "@/lib/utils";

/**
 * 代码浏览视图。
 *
 * 实现已抽到 `@kustos/editor`（Web 与桌面端共用的基线层）。
 * 这里只保留 Web 侧的样式包装：两端的内容区留白不同，
 * 而那属于页面组合，不进共享包。
 */
export function CodeView({ className, ...rest }: CodeViewProps) {
  return <SharedCodeView {...rest} className={cn("bg-ink-950 overflow-auto", className)} />;
}
