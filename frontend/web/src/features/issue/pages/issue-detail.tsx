import { MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { MarkdownEditor } from "@/components/editor/markdown-editor";
import { Button } from "@/components/ui/button";
import { SectionHead, StatusPill, ToneAvatar } from "@/components/kit/kit";
import { toPerson } from "@/features/issue/api";
import type { Issue, IssueComment } from "@/features/issue/types";
import { Markdown } from "@/lib/markdown/markdown";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";

interface IssueDetailProps {
  /** 当前选中的 Issue；为空时渲染未选择占位。 */
  issue: Issue | null;
  /** 评论时间线，来自评论接口。 */
  comments?: IssueComment[];
  /** 详情/评论加载失败的错误信息；有值时渲染错误态与重试。 */
  error?: string | null;
  /** 加载失败后的重试回调。 */
  onRetry?: () => void;
  /** 关闭/重新打开状态时回调，由页面调用对应接口并刷新缓存。 */
  onToggleStatus?: (issue: Issue) => void;
  /** 提交评论时回调，正文为 Markdown 原文；提示由页面的提交结果负责。 */
  onComment?: (issue: Issue, text: string) => void;
  /** 打开编辑弹窗（标题/描述/优先级/指派/标签）。 */
  onEdit?: (issue: Issue) => void;
}

/**
 * Issue 详情区（原型 issues.html 的详情栏）。
 *
 * 状态操作、Markdown 正文、活动时间线与评论编辑器一体呈现；
 * 字段面板浮在画布右缘的面板里，由列表页负责。
 *
 * Args:
 *   issue: 当前选中的 Issue，null 表示尚未选择。
 *   comments: 评论时间线数据。
 *   error: 加载失败的错误信息，有值时整块切换为错误态。
 *   onRetry: 错误态下的重试回调。
 *   onToggleStatus: 关闭/重新打开回调。
 *   onComment: 评论提交回调。
 *   onEdit: 打开编辑弹窗的回调。
 */
export function IssueDetail({ issue, comments, error, onRetry, onToggleStatus, onComment, onEdit }: IssueDetailProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const me = useAuthStore((state) => state.user);
  const mePerson = me ? toPerson(me) : null;

  // 切换 Issue 后清空上一条的评论草稿，避免误发到新线程
  useEffect(() => {
    setDraft("");
  }, [issue?.id]);

  if (!issue) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
        <p className="text-bone-2 text-base font-medium">{t("issue.noSelection")}</p>
        <p className="text-muted-2 text-xs">{t("issue.noSelectionHint")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
        <p className="text-bone-2 text-base font-medium">{t("issue.detailLoadFailed")}</p>
        <p className="text-muted-2 text-xs">{error}</p>
        {onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        ) : null}
      </div>
    );
  }

  const closed = issue.status === "closed";
  const timeline = comments ?? [];

  const submitComment = () => {
    const text = draft.trim();
    if (!text) return;
    onComment?.(issue, text);
    setDraft("");
  };

  return (
    <div className="bg-[radial-gradient(620px_300px_at_90%_0%,rgba(242,174,91,0.04),transparent_70%)] min-h-0 flex-1 overflow-y-auto">
      <div className="px-[26px] pt-[22px] pb-[30px]">
        {/* 头部：状态眉题 + 标题 + 元信息 + 操作 */}
        <header className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-[7px]">
              <StatusPill tone={closed ? "default" : "good"} lamp={!closed}>
                {closed ? t("issue.closed") : t("issue.open")}
              </StatusPill>
              <span className="text-muted-2 font-mono text-xs">#{issue.id}</span>
              <span
                className={cn(
                  "inline-flex h-[19px] items-center rounded-full border px-[7px] text-2xs font-medium",
                  issue.priority === "high" || issue.priority === "critical"
                    ? "border-rose/30 bg-rose/10 text-rose-2"
                    : issue.priority === "medium"
                      ? "border-amber/30 bg-amber/10 text-amber-2"
                      : "border-edge-1 bg-ink-800/70 text-muted",
                )}
              >
                {issue.priority}
              </span>
            </div>
            <h2 className="font-display text-bone mt-2 text-[clamp(1.35rem,2vw,1.7rem)] font-medium tracking-[-0.02em] leading-tight">
              {issue.title}
            </h2>
            <p className="text-muted-2 mt-2 flex flex-wrap items-center gap-1.5 text-2xs">
              {t("issue.createdBy", { author: issue.author.name, date: issue.opened })}
              <span className="text-faint">·</span>
              {t("issue.commentCount", { count: timeline.length })}
              <span className="text-faint">·</span>
              {t("issue.updatedAt", { date: issue.updated })}
            </p>
          </div>
          <div className="flex flex-none items-center gap-[5px]">
            <Button variant="ghost" size="sm" onClick={() => onToggleStatus?.(issue)}>
              {closed ? t("issue.reopen") : t("issue.close")}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t("common.more")}
              onClick={() => onEdit?.(issue)}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </div>
        </header>

        {/* 正文 */}
        <div className="max-w-[78ch]">
          <Markdown content={issue.body} className="mt-5 text-base" />
        </div>

        {/* 活动：评论时间线 + 评论编辑器 */}
        <section aria-label={t("issue.activity")} className="mt-[26px] border-edge-2 border-t pt-4">
          <SectionHead title={t("issue.timeline")} count={timeline.length} className="border-b-0 pb-1" />
          <div>
            {timeline.length ? (
              timeline.map((comment, index) => (
                <article
                  key={comment.id ?? index}
                  className="border-edge-1 grid grid-cols-[27px_minmax(0,1fr)] gap-[9px] border-b py-[11px] last:border-b-0"
                >
                  <ToneAvatar
                    initials={comment.author.initials}
                    tone={comment.author.bot ? "amber" : comment.author.tone}
                    size="sm"
                    bot={comment.author.bot}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-[7px]">
                      <strong className="text-bone-2 text-xs font-semibold">{comment.author.name}</strong>
                      <time className="text-muted-2 font-mono text-2xs">{comment.time}</time>
                      {comment.author.bot ? (
                        <span className="border-amber/30 bg-amber/10 text-amber-2 inline-flex h-[17px] items-center rounded-full border px-1.5 text-2xs">
                          agent
                        </span>
                      ) : null}
                    </div>
                    <Markdown content={comment.body} className="text-muted mt-1.5 max-w-[78ch] text-xs leading-[1.62]" />
                  </div>
                </article>
              ))
            ) : (
              <p className="text-muted-2 py-6 text-center text-xs">{t("issue.noComments")}</p>
            )}
          </div>

          {/* 评论编辑器：与正文同一套 Markdown 编辑器 */}
          <div className="mt-[15px] grid grid-cols-[27px_minmax(0,1fr)] gap-[9px]">
            <ToneAvatar initials={mePerson?.initials ?? "?"} tone={mePerson?.tone ?? "slate"} size="sm" className="mt-0.5" />
            <div className="border-edge-2 bg-ink-950/45 focus-within:border-amber/45 overflow-hidden rounded-md border transition-colors">
              <MarkdownEditor
                value={draft}
                onChange={setDraft}
                placeholder={t("issue.commentPlaceholder")}
                className="text-bone px-2.5 py-2 text-xs"
              />
              <div className="border-edge-1 flex items-center gap-[7px] border-t px-2.5 py-1.5">
                <span className="text-faint mr-auto text-2xs">
                  {t("issue.markdownHint")} · {t("issue.notifyHint")}
                </span>
                <Button size="sm" className="h-[26px] px-2.5 text-xs" onClick={submitComment}>
                  {t("issue.comment")}
                </Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
