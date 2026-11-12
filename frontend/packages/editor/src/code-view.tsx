import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
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
import { normalizeEol } from "./eol";
import { kustosEditorTheme } from "./theme";

/**
 * 程序化写入的标记。
 *
 * 编辑器里只有一种"内容变了"的信号（`docChanged`），但来源有两种：
 * 用户敲键盘，和我们把 prop 里的内容回灌进来。两者在调用方意义完全不同——
 * 前者是"用户改了文件"，要标脏、要记草稿；后者只是把磁盘内容摆上去。
 *
 * 不区分时，切一次标签就多一个假脏点：同步 effect 覆盖文档 → 监听器
 * 回调 → 调用方标脏 → 存草稿。所以程序化 dispatch 一律带上这个 annotation，
 * 监听器见到它就闭嘴。
 */
const externalSync = Annotation.define<boolean>();

export interface CodeViewProps {
  /** 文件内容原文。 */
  content: string;
  /** 文件路径，用于推断语言。 */
  path: string;
  className?: string;
  /** 只读浏览（默认）；传 false 进入可编辑。 */
  readOnly?: boolean;
  /** 内容变化回调（可编辑模式下使用）。 */
  onChange?: (value: string) => void;
  /** 需要滚动到并选中的行号（1 起）。 */
  revealLine?: number;
  /**
   * 调用方注入的扩展（语言服务器、diff 行标这类宿主相关能力）。
   *
   * 这个包被 Web 与桌面端共用，所以代码里不写死任何 LSP 依赖：谁需要
   * 谁把扩展数组传进来。传进来的数组要稳定（用 `useMemo` 或模块级常量），
   * 每次渲染新建一个数组会让下面的 effect 反复重配扩展。
   */
  extensions?: readonly Extension[];
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
  extensions: injectedExtensions,
}: CodeViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const injectedCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  // 建实例的 effect 只依赖 `readOnly`：它重建编辑器时读不到 effect 之外的
  // 最新注入扩展。信任状态一翻转就会重建（只读 → 可编辑），若此时从空数组
  // 起步，LSP 插件、diff 行标与 blame 都会凭空消失，且后续没有变化能把它们
  // 补回来——用户看到的是"点了允许，行标没了"。
  const injectedRef = useRef(injectedExtensions);

  onChangeRef.current = onChange;
  injectedRef.current = injectedExtensions;

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
      injectedCompartment.current.of(injectedRef.current ?? []),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        // 程序化回灌不算用户编辑：见 `externalSync` 的说明。
        if (update.transactions.some((tr) => tr.annotation(externalSync))) return;
        onChangeRef.current?.(update.state.doc.toString());
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
    // CodeMirror 的文档只存 `\n`，而磁盘上可能是 CRLF。不归一就直接比较，
    // 两边永远不相等：每次挂载都走覆盖分支，并且把一次假编辑报给调用方。
    const wanted = normalizeEol(content);
    const current = view.state.doc.toString();
    if (current === wanted) return;
    // 只有"外部确实换了另一份内容"才覆盖：可编辑模式下用户可能已经改过，
    // 此时把一个陈旧的 prop 回灌进去会直接吞掉用户刚敲的字。
    // 调用方在每次 onChange 后都同步更新 content，因此两者一致时不会走到这里；
    // 走到这里意味着来源真的变了（切文件、外部刷新），覆盖才是对的。
    view.dispatch({
      changes: { from: 0, to: current.length, insert: wanted },
      annotations: externalSync.of(true),
    });
  }, [content]);

  // 注入的扩展变化时重配（不重建编辑器，否则会丢滚动位置与选区）。
  //
  // 顺序有讲究：必须排在内容同步之后。切文件时内容与扩展会在同一帧变化，
  // 语言服务器插件在构造时就把当前文档当作"已打开的内容"发给服务器——
  // 先重配扩展再灌内容，等于先告诉服务器上一份文件的内容属于新文件。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: injectedCompartment.current.reconfigure(injectedExtensions ?? []),
    });
  }, [injectedExtensions]);

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

