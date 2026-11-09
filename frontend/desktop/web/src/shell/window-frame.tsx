import type { ReactNode } from "react";

import { Icon } from "@/shell/icon";
import { WindowControls } from "@/shell/shell";

/**
 * 前置页面（连接实例、登录、加载）的最小窗口外壳。
 *
 * 为什么需要它：窗口是 `Frameless: true`，系统标题栏不存在。前置页面
 * 如果直接铺满内容，用户在这几屏里既拖不动窗口，也点不到最小化/关闭
 * ——那是一个只能用任务栏操作的窗口，不是桌面应用。
 *
 * 与完整 `Shell` 的区别：没有左轨、列表栏、状态条。前置页面还没有
 * 实例与工作副本，那些栏位无内容可放；但标题栏**必须有**。
 */
export function WindowFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-[var(--color-ink-950)] text-[var(--color-bone)]">
      <header
        data-wails-drag
        className="flex h-[38px] shrink-0 items-center gap-[9px] border-b border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(21,35,42,0.6),rgba(10,17,21,0.94))] pr-2.5 pl-[13px] select-none"
      >
        <span className="flex items-center gap-[7px] pr-1">
          <img src="/brand/kustos-mark.svg" alt="" width={19} height={19} />
          <span className="text-[10.5px] font-medium tracking-[0.2em] text-[var(--color-bone-2)]">
            KUSTOS
          </span>
        </span>
        <span aria-hidden className="h-[14px] w-px bg-[var(--color-edge-2)]" />
        <span className="flex-1" />
        <WindowControls />
      </header>
      {/* 内容区用 flex 容器而不是普通 div：子页面普遍用 `h-full` 撑满，
          中间这一层若不是 flex 容器，`h-full` 会退化为 0 高度，
          表现为表单缩在角落或整片空白。 */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/**
 * 居中提示。
 *
 * 用于"正在读取本机实例""正在准备登录"这类短暂过渡页：
 * 它们同样需要窗口外壳，否则加载瞬间窗口会没有标题栏可拖。
 */
export function FramedNote({ children }: { children: ReactNode }) {
  return (
    <WindowFrame>
      <div className="flex h-full items-center justify-center gap-2">
        <Icon name="loader" size={13} className="text-[var(--color-faint)]" />
        <p className="text-[12px] text-[var(--color-muted)]">{children}</p>
      </div>
    </WindowFrame>
  );
}
