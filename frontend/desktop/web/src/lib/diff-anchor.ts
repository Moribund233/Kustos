import type { DiffHunk, DiffLine } from "./unified-diff";

/**
 * 收集 diff 里出现过的所有新文件侧行号。
 *
 * 评审意见最终是以「新文件的行号」提交给后端的，所以判断一行能否挂意见
 * 也要以新文件侧为准。
 */
export function collectNewLines(hunks: readonly DiffHunk[]): Set<number> {
  const set = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null) set.add(line.newLine);
    }
  }
  return set;
}

/**
 * 一行对应的锚点行号：评审意见挂在这个行号下面。
 *
 * 删除行没有新行号，但它的**旧**行号可能与某个新增行**同号**。最典型的
 * 情况是把第 1 行整行替换掉：
 *
 * ```
 * @@ -1,3 +1,5 @@
 * -# 旧标题      oldLine=1  newLine=null
 * +## 新标题     oldLine=null newLine=1
 * ```
 *
 * 如果直接写 `newLine ?? oldLine`，两行都会得到 1，同一条评论会在这两行
 * 下面各渲染一次（草稿也会开出两个输入框）。所以有新行号时一律归新文件
 * 侧；删除行只有在它的旧行号于新文件侧确实不存在时才占用锚点。
 *
 * 返回 null 表示这一行不能挂意见（不渲染、不可点击）。
 */
export function anchorLineNumber(
  line: DiffLine | null | undefined,
  newLines: ReadonlySet<number>,
): number | null {
  if (line === null || line === undefined) return null;
  if (line.newLine !== null) return line.newLine;
  if (line.oldLine !== null && !newLines.has(line.oldLine)) return line.oldLine;
  return null;
}
