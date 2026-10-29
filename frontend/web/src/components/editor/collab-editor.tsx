import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
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
import { yCollab } from "y-codemirror.next";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as Y from "yjs";

import { cn } from "@/lib/utils";
import { kustosEditorTheme } from "./kustos-theme";

export interface CollabEditorProps {
  /** 协作会话的 Y.Doc。 */
  doc: Y.Doc;
  /** 协作 Provider，用于 awareness 与显式保存。 */
  provider: HocuspocusProvider;
  /** 只读用户不可编辑；后端鉴权已判定 `can_write`。 */
  readOnly?: boolean;
  className?: string;
  /** 编辑器内容变化回调（远端改动也会触发）。 */
  onChange?: (value: string) => void;
}

/**
 * 协作编辑器。
 *
 * 用 `yCollab` 把 Y.Doc 里的共享文本绑到 CodeMirror：本地编辑写入 CRDT，
 * 远端改动通过 awareness 与文档更新回灌。共享文本名必须与网关约定一致
 * （见 `lib/collab/client.ts` 的 `COLLAB_TEXT_KEY`）。
 */
export function CollabEditor({
  doc,
  provider,
  readOnly = false,
  className,
  onChange,
}: CollabEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
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
      // 绑定共享文本与感知层；awareness 承载协作光标与在线成员
      yCollab(doc.getText("content"), provider.awareness),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current?.(update.state.doc.toString());
        }
      }),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: doc.getText("content").toString(), extensions }),
      parent: host,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [doc, provider, readOnly]);

  return <div ref={hostRef} className={cn("bg-ink-950 overflow-auto", className)} />;
}
