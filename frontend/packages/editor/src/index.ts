/**
 * Kustos 编辑器基线层。
 *
 * 提供**两端共用**的东西：主题、语法高亮、语言检测、只读代码查看器。
 *
 * 刻意不包含：
 * - 页面组合与布局（两端取舍不同）
 * - `localFile` / `lsp` / `diffGutter` 这类桌面专有扩展
 * - 协作编辑器（`yCollab` 由承接方按需挂载）
 *
 * 颜色一律走 `var(--color-*)`：Web 与桌面端共用同一套设计令牌，
 * 色值写死会让两边的编辑器在调色板变化时逐渐分叉。
 */
export { CodeView, type CodeViewProps } from "./code-view";
export {
  kustosDarkTheme,
  kustosHighlightStyle,
  kustosEditorTheme,
  useTheme,
} from "./theme";
export { detectLanguage, looksBinary } from "./language";
export { applyEol, detectEol, normalizeEol, type Eol } from "./eol";
