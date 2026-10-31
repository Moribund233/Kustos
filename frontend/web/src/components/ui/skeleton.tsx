import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 骨架块：取数期间的形状占位。
 *
 * 只提供底色与流光（见 motion.css 的 `.skeleton`），尺寸、圆角、间距
 * 由调用方给，因此同一个原语既能当文本行，也能当头像圆点。
 *
 * 对辅助技术隐藏：骨架没有信息量，读屏用户应当听到的是
 * `aria-busy` 或 role=status 上的加载说明，而不是一堆空 div。
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("skeleton h-3 rounded-md", className)} {...props} />;
}
