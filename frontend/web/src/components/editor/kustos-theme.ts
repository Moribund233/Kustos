import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * CodeMirror 主题：夜巡提灯。
 *
 * 颜色一律引用 `styles/globals.css` 的 `@theme` 令牌，而非拷贝色值：
 * 早先这里写的是十六进制字面量，globals.css 调整对比度时编辑器不会跟随，
 * 于是同一处界面出现两种灰阶。走 var() 后编辑器与其余界面共用一条色带，
 * 后续换主题也只需覆盖令牌，不必再改这个文件。
 *
 * 琥珀只留给光标与当前行，语法色偏冷，避免与琥珀的行动语义打架。
 */
export const kustosDarkTheme: Extension = EditorView.theme(
  {
    "&": {
      color: "var(--color-bone-2)",
      backgroundColor: "var(--color-ink-900)",
      fontSize: "13px",
    },
    ".cm-content": {
      caretColor: "var(--color-amber)",
      fontFamily: "var(--font-mono)",
      padding: "10px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--color-amber)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(242, 174, 91, 0.18)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(240, 231, 216, 0.035)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--color-ink-900)",
      color: "var(--color-faint)",
      border: "none",
      borderRight: "1px solid rgba(240, 231, 216, 0.07)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(240, 231, 216, 0.035)",
      color: "var(--color-muted)",
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
      color: "var(--color-rose)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "rgba(131, 169, 196, 0.16)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--color-ink-800)",
      border: "1px solid rgba(240, 231, 216, 0.12)",
      color: "var(--color-bone-2)",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "var(--color-ink-750)",
      color: "var(--color-bone)",
    },
    ".cm-panels": {
      backgroundColor: "var(--color-ink-800)",
      color: "var(--color-bone-2)",
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
      color: "var(--color-faint)",
      fontStyle: "italic",
    },
    // 协作编辑（y-codemirror.next）：远程光标与名字标签。库不带样式，
    // 不写这里的话名字是裸着的 span 之外的 div，会把正文顶成两行并且看不出是谁
    ".cm-ySelectionCaret": {
      position: "relative",
      borderLeft: "2px solid", // 内联 style 已带 border-color / background-color（用户色）
      marginLeft: "-1px",
      pointerEvents: "none",
      userSelect: "none",
    },
    ".cm-ySelectionCaretDot": {
      position: "absolute",
      top: "-3px",
      left: "-5px",
      width: "8px",
      height: "8px",
      borderRadius: "50%",
      backgroundColor: "inherit",
    },
    ".cm-ySelectionInfo": {
      position: "absolute",
      left: "4px",
      top: "50%",
      transform: "translateY(-50%)",
      padding: "0 6px",
      borderRadius: "4px",
      backgroundColor: "inherit",
      color: "#241a10",
      fontFamily: "var(--font-mono)",
      fontSize: "10.5px",
      fontWeight: 600,
      lineHeight: "1.6",
      letterSpacing: "0.01em",
      whiteSpace: "nowrap",
      opacity: "0.78", // 半透明贴在文字行上，不抢正文视线
      boxShadow: "0 1px 6px rgba(0, 0, 0, 0.35)",
      pointerEvents: "none",
      userSelect: "none",
      zIndex: "5",
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
  { tag: tags.keyword, color: "var(--color-sky)" },
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: "var(--color-sky)" },
  { tag: [tags.definitionKeyword, tags.modifier], color: "var(--color-sky)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--color-bone)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--color-sage-2)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--color-bone-2)" },
  { tag: [tags.variableName, tags.labelName], color: "var(--color-bone-2)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--color-sage)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--color-amber)" },
  { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)], color: "var(--color-amber)" },
  { tag: [tags.operator, tags.operatorKeyword], color: "var(--color-muted)" },
  { tag: [tags.punctuation, tags.separator, tags.bracket], color: "var(--color-muted-2)" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--color-faint)",
    fontStyle: "italic",
  },
  { tag: tags.heading, color: "var(--color-bone)", fontWeight: "500" },
  { tag: tags.link, color: "var(--color-sky)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--color-sky)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "500" },
  { tag: tags.invalid, color: "var(--color-rose)" },
  { tag: tags.meta, color: "var(--color-muted-2)" },
  { tag: tags.tagName, color: "var(--color-ember)" },
  { tag: tags.atom, color: "var(--color-amber)" },
  { tag: tags.monospace, color: "var(--color-bone-2)" },
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
