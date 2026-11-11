import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/shell/icon";

/**
 * 操作失败时弹出的居中对话框。
 *
 * 为什么不就地显示：git 的失败输出是跨多行、可能几十行的原始文本。
 * 塞进提交按钮下方会把整个左栏顶开、挤掉变更列表，而且这段文本才是
 * 用户真正需要读、需要复制出去求助的内容。用对话框给它一块固定、
 * 可滚动、可复制的区域，同时挡住主操作——失败之后本来也不该继续点。
 *
 * 覆盖层照命令面板的写法：`absolute inset-0` 挂在 Shell 根节点上，
 * 不引 `createPortal`，因为这个应用只有一个窗口、一层根节点。
 */
export interface ErrorDialogProps {
  /** 失败的动作名，作为标题。 */
  title: string;
  /** 原始输出。 */
  detail: string;
  onClose: () => void;
}

export function ErrorDialog({ title, detail, onClose }: ErrorDialogProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(detail);
      setCopied(true);
    } catch {
      // 剪贴板不可用时用户仍能手动选中文本，不必再弹一个错误。
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="absolute inset-0 z-50 flex items-center justify-center bg-[rgba(4,7,9,0.66)] px-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[min(560px,80vh)] w-[min(620px,92vw)] flex-col overflow-hidden rounded-[10px] border border-[var(--color-edge-2)] bg-[var(--color-ink-850)] shadow-[0_24px_64px_rgba(0,0,0,0.55)]"
        // 点面板内部不该关闭面板。
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-edge-1)] px-3.5 py-[11px]">
          <Icon name="alert" size={13} className="shrink-0 text-[var(--color-rose)]" />
          <h2 className="text-[12.5px] font-medium text-[var(--color-bone)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
            className="ml-auto shrink-0 rounded p-1 text-[var(--color-faint)] hover:text-[var(--color-bone)]"
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        <p className="shrink-0 px-3.5 pt-2.5 text-[11px] leading-relaxed text-[var(--color-muted)]">
          {t("workingCopy.errors.dialogHint")}
        </p>

        {/* 原始输出：等宽、保留换行、可滚动、可选中。 */}
        <pre className="mx-3.5 mt-2 mb-0 max-h-[300px] shrink overflow-auto rounded-[6px] border border-[var(--color-edge-1)] bg-[var(--color-ink-950)] px-2.5 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-words text-[var(--color-bone-2)] select-text">
          {detail}
        </pre>

        <div className="flex shrink-0 items-center gap-1.5 px-3.5 py-3">
          <button
            type="button"
            onClick={() => void copy()}
            className="flex h-[26px] items-center gap-1.5 rounded-[6px] border border-[var(--color-edge-2)] px-2.5 text-[11px] text-[var(--color-bone-2)] hover:text-[var(--color-bone)]"
          >
            <Icon name="copy" size={11} />
            {copied ? t("workingCopy.errors.copied") : t("workingCopy.errors.copyDetail")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-[26px] rounded-[6px] border border-[var(--color-edge-2)] px-3 text-[11px] text-[var(--color-bone)] hover:border-[var(--color-edge-3)]"
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
