import type { DiffPayload } from "@/components/editor/diff-viewer";

/**
 * 代码浏览页视图类型，字段口径以后端实际返回为准。
 *
 * 数据来自 repository_browser_controller（分支/文件树/blob/符号/提交）
 * 与 repo-store 的仓库摘要；schema.d.ts 里响应为 unknown，页面按这些
 * 类型断言后端实际返回的字段。
 */

/** 后端符号条目映射到大纲行的形态。 */
export interface SymbolNode {
  kind: "class" | "fn" | "const";
  name: string;
  /** 声明所在行号（1 起）。 */
  line: number;
  children?: SymbolNode[];
}

export interface CodeFile {
  path: string;
  /** 后端 blob 的 language 字段（如 "python"）；无法识别时为空串。 */
  lang: string;
  /** 人类可读大小（blob.size 格式化）。 */
  size: string;
  content: string;
  symbols: SymbolNode[];
  /** 传入 diff prop 时以 diff 视图展示。 */
  diff?: DiffPayload;
}
