/** 文件换行符。 */
export type Eol = "\n" | "\r\n";

/**
 * 探测一段文本用的换行符。
 *
 * CodeMirror 的文档模型只存 `\n`：`\r\n` 在读入时就被归一掉了，
 * 而磁盘上的文件可能是 CRLF。编辑器要能原样写回，就必须在打开时
 * 先记下磁盘用的是哪一种。
 */
export function detectEol(text: string): Eol {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** 归一成 `\n`，与 CodeMirror 的文档模型一致。 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** 把编辑器文本按指定换行符还原成磁盘形态。 */
export function applyEol(text: string, eol: Eol): string {
  const normalized = normalizeEol(text);
  return eol === "\n" ? normalized : normalized.replace(/\n/g, "\r\n");
}
