import { useState } from "react";
import { useTranslation } from "react-i18next";

import { MarkdownEditor } from "@/components/editor/markdown-editor";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/lib/markdown/markdown";

interface IssueDetailProps {
  /** Issue 正文（Markdown 原文）。 */
  body?: string;
  /** Issue 标题。 */
  title?: string;
}

/**
 * Issue 详情。
 *
 * 对应原型 `issues.html` 的全宽详情：正文 + 活动。正文按 Markdown 渲染，
 * 评论输入用同一套编辑器，提交前可切到预览。
 */
export function IssueDetail({ body = "", title = "" }: IssueDetailProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-edge-1 bg-ink-950 shrink-0 border-b px-5 py-3">
        <h1 className="font-display text-bone text-[15px]">{title || t("issue.title")}</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {body ? (
          <Markdown content={body} />
        ) : (
          <p className="text-faint text-[13px]">{t("common.empty")}</p>
        )}

        <section className="mt-8">
          <div className="mb-2 flex items-center gap-2">
            <p className="text-faint text-[10px] tracking-[0.15em] uppercase">
              {t("issue.comment")}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setPreview((prev) => !prev)}>
              {preview ? t("common.close") : t("issue.markdownHint")}
            </Button>
          </div>

          {preview ? (
            <div className="border-edge-2 bg-ink-900 min-h-32 rounded-md border p-3">
              {draft ? (
                <Markdown content={draft} />
              ) : (
                <p className="text-faint text-[13px]">{t("common.empty")}</p>
              )}
            </div>
          ) : (
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              placeholder={t("issue.comment")}
              className="border-edge-2 bg-ink-900 rounded-md border"
            />
          )}
        </section>
      </div>
    </div>
  );
}
