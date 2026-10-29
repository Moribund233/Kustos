import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * CodeMirror 主题：夜巡提灯。
 *
 * 取色与 `src/styles/globals.css` 的 `@theme` 一致——墨蓝底、骨白字，
 * 琥珀只留给光标与当前行，语法色偏冷，避免与琥珀的行动语义打架。
 */
export const kustosDarkTheme: Extension = EditorView.theme(
  {
    "&": {
      color: "#d8cdbb",
      backgroundColor: "#0a1115",
      fontSize: "13px",
    },
    ".cm-content": {
      caretColor: "#f2ae5b",
      fontFamily: "var(--font-mono)",
      padding: "10px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#f2ae5b",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(242, 174, 91, 0.18)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(240, 231, 216, 0.035)",
    },
    ".cm-gutters": {
      backgroundColor: "#0a1115",
      color: "#536064",
      border: "none",
      borderRight: "1px solid rgba(240, 231, 216, 0.07)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(240, 231, 216, 0.035)",
      color: "#9aa5a7",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 12px 0 16px",
      minWidth: "44px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.65",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(131, 169, 196, 0.22)",
      outline: "1px solid rgba(131, 169, 196, 0.4)",
      color: "inherit",
    },
    ".cm-nonmatchingBracket": {
      backgroundColor: "rgba(217, 130, 130, 0.18)",
      color: "#d98282",
    },
    ".cm-selectionMatch": {
      backgroundColor: "rgba(131, 169, 196, 0.16)",
    },
    ".cm-tooltip": {
      backgroundColor: "#111c22",
      border: "1px solid rgba(240, 231, 216, 0.12)",
      color: "#d8cdbb",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "#15232a",
      color: "#f0e7d8",
    },
    ".cm-panels": {
      backgroundColor: "#111c22",
      color: "#d8cdbb",
      borderTop: "1px solid rgba(240, 231, 216, 0.12)",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(242, 174, 91, 0.22)",
      outline: "1px solid rgba(242, 174, 91, 0.35)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(242, 174, 91, 0.38)",
    },
    ".cm-placeholder": {
      color: "#536064",
      fontStyle: "italic",
    },
  },
  { dark: true },
);

/**
 * 语法高亮配色。
 *
 * 关键字用天蓝，字符串用鼠尾草绿，数字与常量用琥珀，
 * 注释压到最暗的一档——让代码结构先于颜色被读到。
 */
export const kustosHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#83a9c4" },
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: "#83a9c4" },
  { tag: [tags.definitionKeyword, tags.modifier], color: "#83a9c4" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#f0e7d8" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#aed6bf" },
  { tag: [tags.propertyName, tags.attributeName], color: "#d8cdbb" },
  { tag: [tags.variableName, tags.labelName], color: "#d8cdbb" },
  { tag: [tags.string, tags.special(tags.string)], color: "#86b79e" },
  { tag: [tags.number, tags.bool, tags.null], color: "#f2ae5b" },
  { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)], color: "#f2ae5b" },
  { tag: [tags.operator, tags.operatorKeyword], color: "#9aa5a7" },
  { tag: [tags.punctuation, tags.separator, tags.bracket], color: "#758185" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "#536064",
    fontStyle: "italic",
  },
  { tag: tags.heading, color: "#f0e7d8", fontWeight: "500" },
  { tag: tags.link, color: "#83a9c4", textDecoration: "underline" },
  { tag: tags.url, color: "#83a9c4" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "500" },
  { tag: tags.invalid, color: "#d98282" },
  { tag: tags.meta, color: "#758185" },
  { tag: tags.tagName, color: "#d85a30" },
  { tag: tags.atom, color: "#f2ae5b" },
  { tag: tags.monospace, color: "#d8cdbb" },
]);

/** 主题 + 语法高亮的组合扩展。 */
export const kustosEditorTheme: Extension = [
  kustosDarkTheme,
  syntaxHighlighting(kustosHighlightStyle),
];

/**
 * 按当前主题返回 CodeMirror 扩展。
 *
 * 目前只有夜巡一种主题；日间主题落地后在这里按主题名分支。
 */
export function useTheme(): Extension {
  return kustosEditorTheme;
}
