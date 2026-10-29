import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { languages } from "@codemirror/language-data";

import { cn } from "@/lib/utils";
import { detectLanguage } from "./language";
import { kustosEditorTheme } from "./kustos-theme";

export interface CodeViewProps {
  /** 文件内容原文。 */
  content: string;
  /** 文件路径，用于推断语言。 */
  path: string;
  className?: string;
  /** 只读浏览（默认）；协作编辑由 collab editor 承担。 */
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** 需要滚动到并选中的行号（1 起）；用于符号大纲跳转。 */
  revealLine?: number;
}

/**
 * 代码浏览视图。
 *
 * 对应原型 `code.html` 的全宽编辑器区域：只读、可滚动、带行号与语法高亮。
 * 语言包用 `@codemirror/language-data` 按需加载，避免把二十多个语言包打进首屏；
 * 装载结果通过 Compartment 重配，不需要销毁重建编辑器实例。
 */
export function CodeView({
  content,
  path,
  className,
  readOnly = true,
  onChange,
  revealLine,
}: CodeViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);

  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      highlightSelectionMatches(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      kustosEditorTheme,
      languageCompartment.current.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current?.(update.state.doc.toString());
        }
      }),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: host,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 编辑器实例只创建一次；路径变化时靠下面的 effect 重配语言
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // 路径变化时重新加载语言包
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;

    const description = languages.find((item) => item.name === detectLanguage(path));
    if (!description) {
      // 没有匹配的语言包时保持纯文本，不阻断代码浏览
      view.dispatch({ effects: languageCompartment.current.reconfigure([]) });
      return;
    }

    void description
      .load()
      .then((support) => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure(support),
        });
      })
      .catch(() => {
        // 语言包装载失败时保持纯文本展示
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  // 外部内容变化时同步
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === content) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
  }, [content]);

  // 跳到指定行：符号大纲点击后把光标放过去并滚到视口中央
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealLine) return;
    const total = view.state.doc.lines;
    const target = Math.min(Math.max(revealLine, 1), total);
    const line = view.state.doc.line(target);
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }, [revealLine]);

  return <div ref={hostRef} className={cn("bg-ink-950 overflow-auto", className)} />;
}
