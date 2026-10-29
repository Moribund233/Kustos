import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CodeView } from "@/components/editor/code-view";
import { DiffViewer, type DiffPayload } from "@/components/editor/diff-viewer";
import { cn } from "@/lib/utils";

interface CodePageProps {
  /** 当前查看的文件路径。 */
  path?: string;
  /** 文件内容。 */
  content?: string;
  /** 当前提交的差异；存在时以 diff 视图展示。 */
  diff?: DiffPayload;
}

/**
 * 代码浏览页。
 *
 * 对应原型 `code.html`：画布占满可用宽度，符号树与文件事实收进右侧浮动面板。
 * 这里只负责画布内容，面板由布局层叠加。
 */
export function CodePage({ path = "", content = "", diff }: CodePageProps) {
  const { t } = useTranslation();

  const editorClass = useMemo(() => cn("bg-ink-950 h-full min-h-[420px] overflow-auto"), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-edge-1 bg-ink-950 flex h-10 shrink-0 items-center gap-3 border-b px-4">
        <span className="text-bone-2 font-mono text-[12px]">{path || t("code.fileTree")}</span>
      </header>

      {diff ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <DiffViewer payload={diff} />
        </div>
      ) : (
        <CodeView content={content} path={path} className={editorClass} />
      )}
    </div>
  );
}
