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

import { detectLanguage } from "./language";
import { kustosEditorTheme } from "./theme";

export interface CodeViewProps {
  /** 文件内容原文。 */
  content: string;
  /** 文件路径，用于推断语言。 */
  path: string;
  className?: string;
  /** 只读浏览（默认）；可编辑模式在后续里程碑接入。 */
  readOnly?: boolean;
  /** 内容变化回调（可编辑模式下使用）。 */
  onChange?: (value: string) => void;
  /** 需要滚动到并选中的行号（1 起）。 */
  revealLine?: number;
}

/**
 * 代码查看器：行号、语法高亮、只读（默认）。
 *
 * 语言包用 `@codemirror/language-data` **按需加载**：二十多个语言包全打进
 * 首屏是数量级的浪费，而用户打开的通常是同一两种语言。装载结果通过
 * Compartment 重配，不销毁重建编辑器实例——重建会丢滚动位置与选区。
 *
 * 这个组件在 Web 与桌面端共用：它只依赖 CodeMirror 与设计令牌，
 * 不含任何宿主相关的假设（文件读写、协作连接都在调用方）。
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
    // 编辑器实例只创建一次；路径变化时靠下面的 effect 重配语言。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // 路径变化时重新加载语言包。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;

    const detected = detectLanguage(path);
    // 语言名大小写不敏感匹配：`detectLanguage` 按常见写法返回小写标识
    // （"python"、"typescript"），而 CodeMirror 的 `languages` 用展示名
    // （"Python"、"TypeScript"）。不在这里归一化，两边永远匹配不上，
    // 语法高亮会静默失效——界面上只是没颜色，没有任何报错。
    const wanted = detected.toLowerCase();
    const description = languages.find((item) => item.name.toLowerCase() === wanted);
    if (!description) {
      // 没有匹配的语言包时保持纯文本，不阻断浏览。
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
        // 语言包装载失败时保持纯文本展示。
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  // 外部内容变化时同步。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === content) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
  }, [content]);

  // 跳到指定行。
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
  }, [revealLine]);

  return <div ref={hostRef} className={className} data-code-view="" />;
}

