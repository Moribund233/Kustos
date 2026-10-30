/**
 * 把正文里的 @kustos-agent 换成带样式的胶囊。
 *
 * 为什么不在渲染前切字符串：聊天消息原先用 `content.split(/@kustos-agent/i)`
 * 把源文切成若干段分别渲染 Markdown。只要提及落在结构内部，语法就会被
 * 切断——代码块的围栏不配对、`**@kustos-agent**` 断成字面星号、含提及的
 * 列表项被拆成两段独立渲染。这里改为在 hast 的 text 节点上替换：文档先
 * 完整解析，再给匹配的文字套一层 span，提及出现在哪里都不影响语法。
 *
 * 必须挂在 rehype-sanitize 之后。sanitize 的 span 白名单只放行 `hljs-`
 * 前缀的类名，先着色会被整层剥掉。插件本身只插入固定标签与固定类名，
 * 文本取自已净化的节点，没有引入新的注入面。
 *
 * 节点类型只声明本插件用得到的字段：`hast` 与 `unified` 都不是本项目的
 * 直接依赖（由 react-markdown 带入），在这里 import 它们的类型会让
 * typecheck 依赖一个没被声明的包。
 */

/** hast 节点的最小形状。 */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** 提及的字面量。匹配不区分大小写，与后端约定的写法保持一致。 */
const MENTION = "@kustos-agent";

/** 带捕获组的 split 会保留分隔符，结果在普通文本与提及之间交替。 */
const SPLIT = /(@kustos-agent)/gi;

/** 提及胶囊的类名，样式定义在 styles/markdown.css。 */
const MENTION_CLASS = "kustos-mention";

function toNode(piece: string): HastNode {
  if (piece.toLowerCase() !== MENTION) {
    return { type: "text", value: piece };
  }
  return {
    type: "element",
    tagName: "span",
    properties: { className: [MENTION_CLASS] },
    children: [{ type: "text", value: piece }],
  };
}

function walk(parent: HastNode): void {
  const children = parent.children;
  if (!children) return;

  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child) continue;

    if (child.type === "text") {
      if (!child.value || !child.value.toLowerCase().includes(MENTION)) continue;

      const replacement = child.value
        .split(SPLIT)
        .filter((piece) => piece.length > 0)
        .map(toNode);

      children.splice(i, 1, ...replacement);
      // 跳过刚插入的节点，避免对生成的 span 再走一遍
      i += replacement.length - 1;
      continue;
    }

    if (child.type !== "element") continue;
    /* 代码里的字面量保持原样：那是在演示这个词，不是在呼叫人。

       块级代码即使漏了这行也看不出问题——rehype-highlight 排在本插件
       之后，会用 lowlight 重建 code 内的子树，把这里的 span 一并冲掉。
       但行内代码没有语言标注，highlight 不会碰它，漏掉判断就会把胶囊
       塞进 <code> 里。所以这个分支对行内代码是必需的，对块级代码是
       防御性的（将来 highlight 若改成原地标注，这里就必须生效）。 */
    if (child.tagName === "code" || child.tagName === "pre") continue;
    walk(child);
  }
}

/** rehype 插件：给正文中的 @kustos-agent 加胶囊。 */
export function rehypeMention() {
  return (tree: unknown): void => {
    walk(tree as HastNode);
  };
}
