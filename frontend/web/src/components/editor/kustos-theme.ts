/**
 * 兼容再导出：主题已抽到 `@kustos/editor`。
 *
 * Web 端保留这个文件是为了不动既有 import 路径——迁移应当可增量，
 * 一次改完所有调用点会把真实改动淹没在无意义的路径替换里。
 * 新代码请直接从 `@kustos/editor` 引入。
 */
export {
  kustosDarkTheme,
  kustosHighlightStyle,
  kustosEditorTheme,
  useTheme,
} from "@kustos/editor";
