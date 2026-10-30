import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import { rehypeMention } from "./rehype-mention";
import { markdownSchema } from "./schema";

/** rehype 插件列表的类型。unified 不是直接依赖，从组件 props 反推。 */
type RehypePlugins = NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>;

interface MarkdownProps {
  /** Markdown 原文。空值渲染为空，不显示占位。 */
  content?: string | null;
  className?: string;
  /** 是否允许链接在同标签页打开。聊天与评论里通常不希望打断当前上下文。 */
  openLinksInNewTab?: boolean;
  /** 是否把 @kustos-agent 渲染成胶囊。仅聊天消息需要。 */
  mentions?: boolean;
}

/**
 * 渲染 Markdown 正文。
 *
 * 覆盖 Issue / PR / Release 描述、评论、聊天消息与 Agent 回答。
 * 输入来自用户，属于不可信内容，因此固定走 rehype-sanitize。
 */
export function Markdown({
  content,
  className,
  openLinksInNewTab = false,
  mentions = false,
}: MarkdownProps) {
  if (!content) return null;

  // 顺序有意义：sanitize 在最前（结果是后续插件的输入），mentions 居中
  // （它生成的 span class 不在 sanitize 白名单里，放在之前会被剥掉），
  // highlight 最后（它要包裹代码块内的 text）。
  const rehypePlugins: RehypePlugins = [
    [rehypeSanitize, markdownSchema],
    ...(mentions ? [rehypeMention] : []),
    [rehypeHighlight, { detect: true, ignoreMissing: true }],
  ];

  return (
    <div className={cn("kustos-markdown text-bone-2 text-base leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={{
          a({ children, href, ...props }) {
            return (
              <a
                href={href}
                target={openLinksInNewTab ? "_blank" : undefined}
                rel={openLinksInNewTab ? "noopener noreferrer" : undefined}
                className="text-sky decoration-sky/40 hover:decoration-sky underline underline-offset-2"
                {...props}
              >
                {children}
              </a>
            );
          },
          // preflight 会剥掉列表默认样式，这里显式恢复（否则列表退化成纯文本行）
          ul({ children }) {
            return <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>;
          },
          // 外层代码块自带滚动容器，内层 pre 不再重复加边距
          pre({ children }) {
            return <pre className="overflow-x-auto">{children}</pre>;
          },
          table({ children }) {
            return (
              <div className="border-edge-1 my-3 overflow-x-auto rounded-md border">
                <table className="w-full border-collapse text-base">{children}</table>
              </div>
            );
          },
          img({ children }) {
            return <span className="text-muted">{children}</span>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * 把纯文本渲染成单段。
 *
 * 用于标题、摘要等不允许 Markdown 语法的位置，避免其中的 `*` 被当成强调标记。
 */
export function PlainText({ children, className }: { children?: ReactNode; className?: string }) {
  return <span className={className}>{children}</span>;
}
