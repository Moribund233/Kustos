/**
 * Markdown 渲染的 sanitize 白名单。
 *
 * 用户提交的 Markdown 属于不可信输入，必须经过 sanitize。
 * 默认 schema 会剥掉 `<span>` 上的 class，导致 highlight.js 的着色失效；
 * 这里只放行 `hljs-` 前缀的类名，不放开任意 class。
 */
import { defaultSchema } from "rehype-sanitize";

export const markdownSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // highlight.js 用 span 上色；只认 hljs- 前缀，避免用户伪造样式
    span: [["className", /^hljs-/]],
    // 代码块容器需要保留语言标记，复制按钮等由前端组件自行渲染
    code: [["className", /^language-/, "hljs"]],
  },
  // 默认已限制 http/https/mailto 等协议；这里显式禁止 data:，
  // 否则 img 的 src 可被用来读取内网地址
  protocols: {
    ...defaultSchema.protocols,
    src: ["http", "https"],
    href: ["http", "https", "mailto"],
  },
};
