import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/shell/icon";
import { applyEol, CodeView, detectEol, normalizeEol, type Eol } from "@kustos/editor";
import {
  languageLabel,
  languageOf,
  pathSegments,
  persistCodeLayout,
  useChangedFiles,
  useCodeLayout,
  useDirectory,
  useDiscardDraft,
  useDrafts,
  useFileSearch,
  useFileText,
  useSaveFile,
  useSaveDraft,
  type TreeNode,
} from "@/lib/code";
import { buildLayout, restoreLayout, tabName, type RestoredLayout } from "@/lib/code-layout";
import type { CodeLayout } from "@/bindings/github.com/kustos/kustos-desktop/internal/services/models";
import {
  blameGutter,
  createMarksSource,
  cursorLineReporter,
  diffGutter,
  type BlameLabels,
  type DiffMarkLabels,
  type MutableMarksSource,
} from "@/lib/diff-gutter";
import type { BlameLine } from "@/bindings/github.com/kustos/kustos-desktop/internal/git/models";
import { compareWithHead, type HeadDiff } from "@/lib/head-diff";
import { relativeTime } from "@/lib/relative-time";
import {
  sessionFor,
  useDetectedLanguage,
  useEnsureLSP,
  useLSPSessions,
  useRestartLSP,
  useSetWorkspaceTrust,
  useWorkspaceTrust,
} from "@/lib/lsp";
import { useDocumentSymbols, useLSPClient, type FlatSymbol } from "@/lib/lsp-client";
import { toFileUri } from "@/lib/lsp-uri";
import {
  useFileBlame,
  useHeadText,
  useWorkingCopies,
  type WorkingCopy,
} from "@/lib/working-copy";

/**
 * Code 面：文件树 + 标签页 + 编辑器。
 *
 * 结构对齐原型 `docs/prototype/desktop/editor.html`：
 *
 *   listcol
 *   ├ list-head（标题 + 仓库路径 + 分段）
 *   └ tree（可展开的目录，每行带变更状态标记）
 *   detail
 *   ├ tabs（打开的标签页，未保存的带圆点）
 *   ├ ed-bar（面包屑 + 语言 + 行数 + 保存）
 *   └ code（行号 + 源码，等宽）
 *
 * 编辑语义是**磁盘是唯一真相**：改动只存在内存里，`⌘S` 才落盘。
 * 未保存的内容会写进本地库，崩溃后重开能恢复——这是编辑器类应用
 * 必须有的兜底，而 Web 端没有对应问题，最容易漏。
 */

export interface OpenTab {
  path: string;
  name: string;
}

/** 左栏的三个分段：与原型一致。 */
export type CodeSegment = "files" | "symbols" | "changes";

export interface CodeParts {
  list: React.ReactNode;
  detail: React.ReactNode;
  inspector?: React.ReactNode;
  statusLeft: React.ReactNode;
  statusRight: React.ReactNode;
}

/** 编辑器里一份打开了的内容。 */
interface Buffer {
  /** 编辑器当前内容，换行一律是 `\n`（CodeMirror 的文档模型只存这个）。 */
  text: string;
  /** 上次与磁盘同步时的内容，同样已归一成 `\n`；判断"改没改"只跟它比。 */
  saved: string;
  /** 磁盘文件用的换行符，保存时按它还原。 */
  eol: Eol;
  /** 打开时磁盘上的 mtime；保存时作为冲突检测基准。 */
  baseMtime: number;
  /** 是否与磁盘内容不同。 */
  dirty: boolean;
}

/** 比较"改没改"必须归一换行：编辑器只存 `\n`，磁盘可能是 CRLF。 */
function sameText(a: string, b: string): boolean {
  return normalizeEol(a) === normalizeEol(b);
}

/** 汇总 Code 面的状态；由外层装配进 Shell。 */
export function useCodeSurface() {
  const copies = useWorkingCopies();
  const list = copies.data ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const active: WorkingCopy | null = list.find((c) => c.id === activeId) ?? list[0] ?? null;
  const workingCopyId = active?.id ?? null;

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [segment, setSegment] = useState<CodeSegment>("files");
  const [filter, setFilter] = useState("");
  // 编辑器缓冲区：按 path 存，切标签不丢改动。
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  /**
   * 要滚动到的那一行（符号列表点击）。
   *
   * 带上路径：只记行号的话，切到别的标签时会拿着上一份文件的行号去跳，
   * 落在哪一行纯看运气。
   */
  const [reveal, setReveal] = useState<{ path: string; line: number } | null>(null);

  // 过滤输入去抖：每敲一个字就遍历一次全树，在大仓库上是肉眼可见的卡顿。
  const [debouncedFilter, setDebouncedFilter] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedFilter(filter), 200);
    return () => window.clearTimeout(id);
  }, [filter]);

  const file = useFileText(workingCopyId, activePath);
  const save = useSaveFile(workingCopyId);
  const saveDraft = useSaveDraft(workingCopyId);
  const drafts = useDrafts(workingCopyId);
  const discardDraft = useDiscardDraft(workingCopyId);
  const storedLayout = useCodeLayout();

  // 本地智能：探测这个工作区该用哪种语言服务器，以及用户是否允许在它上面跑。
  //
  // 信任管两件事：语言服务器会执行工作区里的代码（解析 import、加载
  // package.json 里的脚本、跑 go list），所以没被信任之前它不启动；同时编辑器
  // 退回只读，让"还没有语言服务器"这件事在界面上有明确交代，而不是让人以为
  // 补全坏了。
  const workspaceRoot = active?.path ?? null;
  const detected = useDetectedLanguage(workspaceRoot);
  const trust = useWorkspaceTrust(workspaceRoot);
  const setTrust = useSetWorkspaceTrust(workspaceRoot);
  const ensureLSP = useEnsureLSP(workspaceRoot);
  const restartLSP = useRestartLSP(workspaceRoot);
  const sessions = useLSPSessions();
  const session = sessionFor(sessions.data, workspaceRoot);
  const trusted = trust.data?.trusted ?? false;
  const languageID = detected.data?.found ? detected.data.id : "";

  const openPath = useCallback((path: string) => {
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev;
      return [...prev, { path, name: tabName(path) }];
    });
    setActivePath(path);
  }, []);

  const openFile = useCallback(
    (node: TreeNode) => {
      openPath(node.path);
    },
    [openPath],
  );

  /**
   * 协议层的连接：只有服务器真的在跑时才连。
   *
   * 不看"已信任 + 已装"就建连接是错的——`/lsp/attach` 拿不到会话会直接
   * 回 404，用户看到的是一条莫名其妙的连接失败。服务器状态（进程池那边报
   * 上来的）才是这条连接该不该存在的唯一依据。
   */
  const lsp = useLSPClient({
    root: workspaceRoot,
    language: languageID === "" ? null : languageID,
    enabled: trusted && Boolean(detected.data?.installed) && session?.state === "running",
    onOpenFile: openPath,
  });

  const closeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.path !== path);
        // 关掉当前标签时，焦点落到相邻的一个上，而不是留一片空白。
        if (path === activePath) {
          const idx = prev.findIndex((t) => t.path === path);
          const fallback = next[idx] ?? next[idx - 1] ?? null;
          setActivePath(fallback?.path ?? null);
        }
        return next;
      });
      // 关标签时清掉缓冲区：磁盘是唯一真相，未保存的改动不该在后台悬着。
      setBuffers((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
    },
    [activePath],
  );

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /**
   * 本次会话里每个仓库的布局快照。
   *
   * 切走再切回来时从这里取，而不是回到库里的旧记录：库里的记录是上次
   * 启动时的样子，拿它覆盖当前会话已经打开的标签等于把用户的工作抹掉。
   * 库里只保留最后活跃的一个仓库（`ui_state` 只存一份布局）。
   */
  const sessionLayouts = useRef(new Map<string, RestoredLayout>());

  /**
   * 最近一次套用布局的仓库。
   *
   * 记它有两件事要做：一是套用只做一次——套完立刻按新状态写回，重复套用会把
   * 用户刚打开的标签又冲掉；二是写回要等套用完——切仓库那一帧标签已经被
   * `setActiveId` 清空，这时候写就等于把空白盖到记录上。
   */
  const appliedFor = useRef<string | null>(null);

  const applyLayout = useCallback((layout: RestoredLayout) => {
    setTabs(layout.tabs);
    setActivePath(layout.activePath);
    setExpanded(layout.expanded);
  }, []);

  // 切换仓库时套用布局。属于别的仓库的布局一律不套：路径相对的是原仓库根。
  useEffect(() => {
    if (!workingCopyId) return;
    if (appliedFor.current === workingCopyId) return;

    // 本会话里打开过：用会话快照，库里的那条记录是上次启动时的样子。
    const session = sessionLayouts.current.get(workingCopyId);
    if (session) {
      appliedFor.current = workingCopyId;
      applyLayout(session);
      return;
    }

    // 库里那份还没读出来，等下一次渲染。读失败也照样往下走：没有布局可用时
    // 仍要能存新的，否则读一次失败就让这个会话再也不记录标签页。
    if (!storedLayout.isFetched) return;

    appliedFor.current = workingCopyId;
    const restored = restoreLayout(storedLayout.data, workingCopyId);
    if (restored) applyLayout(restored);
  }, [workingCopyId, storedLayout.isFetched, storedLayout.data, applyLayout]);

  /**
   * 把当前布局写回本地库。
   *
   * 去抖 400ms：切标签、展开目录都是高频动作，每次都整份重写没有必要，
   * 而 400ms 之后崩溃丢失的也只是最后几次点击。
   */
  const pendingLayout = useRef<CodeLayout | null>(null);

  useEffect(() => {
    // 上一轮排下的那次写入已经作废：状态变了就等这一轮重新排，否则窗口隐藏时
    // 会把一份过期的布局写回库里。
    pendingLayout.current = null;

    if (!workingCopyId) return;
    // 还没套用布局时写，会把"空白布局"盖到上次的记录上；刚切过来那一帧
    // 标签也还是空的，同样要等套用完再写。
    if (appliedFor.current !== workingCopyId) return;

    const snapshot: RestoredLayout = {
      tabs,
      activePath,
      expanded,
    };
    sessionLayouts.current.set(workingCopyId, snapshot);

    const layout = buildLayout(workingCopyId, tabs, activePath, expanded);
    if (!layout) return;

    // 只是切过来看一眼、一个标签都没开：别用空白覆盖另一个仓库的记录。
    // 否则「切到空仓库再退出」会把上一天的标签页悄悄清掉。
    const storedOwner = storedLayout.data?.workingCopyId;
    if (tabs.length === 0 && storedOwner && storedOwner !== workingCopyId) return;

    pendingLayout.current = layout;
    const id = window.setTimeout(() => {
      pendingLayout.current = null;
      void persistCodeLayout(layout);
    }, 400);
    return () => window.clearTimeout(id);
  }, [workingCopyId, tabs, activePath, expanded, storedLayout.data]);

  // 窗口被关掉或最小化时不等去抖，立刻写一次：
  // 「打开一堆标签后马上关应用」是最常见的离开方式，丢掉它最扎眼。
  useEffect(() => {
    const flush = () => {
      const layout = pendingLayout.current;
      if (!layout) return;
      pendingLayout.current = null;
      void persistCodeLayout(layout);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };

    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // 文件读回来时建立缓冲区基准。
  useEffect(() => {
    if (!file.data || !activePath) return;
    setBuffers((prev) => {
      const existing = prev[activePath];
      // 编辑器文档只存 `\n`，磁盘上的换行符单独记下来，保存时按原样还原。
      const eol = detectEol(file.data.content);
      const text = normalizeEol(file.data.content);
      if (existing) {
        // 已经有缓冲区就不覆盖：用户可能正在编辑，重设会吞掉改动。
        // 例外是基准还空着——草稿先于磁盘内容恢复时会出现这种情况，
        // 补上基准之后"改回原样"才认得出。
        if (existing.saved !== "") return prev;
        return {
          ...prev,
          [activePath]: {
            ...existing,
            saved: text,
            eol,
            baseMtime: existing.baseMtime,
            // 基准补上之后重新判定：草稿内容与磁盘一致就不该再标脏。
            dirty: !sameText(existing.text, text),
          },
        };
      }
      return {
        ...prev,
        [activePath]: {
          text,
          saved: text,
          eol,
          baseMtime: file.data.mtime,
          dirty: false,
        },
      };
    });
  }, [file.data, activePath]);

  /**
   * 上次会话遗留的未保存内容。
   *
   * 崩溃或强杀后重开，这些内容还没落盘。**不自动套用**——磁盘可能在
   * 崩溃期间被外部改过，直接灌进编辑器等于替用户做了合并决定。
   * 界面只提示存在待恢复内容，由用户显式选择。
   */
  const recoverable = useMemo(() => {
    const list = drafts.data ?? [];
    return list.filter((d) => d.path !== activePath);
  }, [drafts.data, activePath]);

  const activeDraft = useMemo(() => {
    const list = drafts.data ?? [];
    return list.find((d) => d.path === activePath) ?? null;
  }, [drafts.data, activePath]);

  /**
   * 把草稿内容装进缓冲区。
   *
   * baseMtime 沿用草稿里记的值：如果磁盘在崩溃期间又被改过，
   * 保存时仍会触发冲突，用户还有机会看到差异。
   */
  const restoreDraft = useCallback(
    (path: string) => {
      const list = drafts.data ?? [];
      const d = list.find((x) => x.path === path);
      if (!d) return;
      // 草稿存的是编辑器文本（已经是 `\n`），换行符沿用当前磁盘上的写法。
      const text = normalizeEol(d.content);
      setBuffers((prev) => {
        const existing = prev[path];
        return {
          ...prev,
          [path]: {
            text,
            saved: existing?.saved ?? "",
            eol: existing?.eol ?? "\n",
            baseMtime: d.baseMtime,
            dirty: true,
          },
        };
      });
      openPath(path);
    },
    [drafts.data, openPath],
  );

  const edit = useCallback(
    (path: string, text: string) => {
      setBuffers((prev) => {
        const buf = prev[path];
        if (!buf) return prev;
        // 只有内容真的跟磁盘不一样才算脏：编辑器把外部内容摆上去时也会
        // 触发 onChange，无条件标脏会让"切一次标签"变成"改过一次文件"。
        const dirty = !sameText(text, buf.saved);
        const next: Buffer = { ...buf, text, dirty };
        if (dirty) {
          // 内容一变就记草稿（去抖在下面的 effect 里做）：
          // 真崩溃时，最后几秒的改动也应当能恢复。
          saveDraft.mutate({ path, content: text, baseMtime: buf.baseMtime });
        } else if (buf.dirty) {
          // 改回原样就把草稿撤掉，别让崩溃恢复列表里留一份"其实没改"的内容。
          discardDraft.mutate(path);
        }
        return { ...prev, [path]: next };
      });
    },
    [discardDraft, saveDraft],
  );

  const activeBuffer = activePath ? (buffers[activePath] ?? null) : null;

  /**
   * 保存当前文件。
   *
   * force 为 true 表示用户在冲突提示里明确选择"覆盖磁盘内容"，
   * 此时不做 mtime 校验——这个决定必须由用户做出，不能替他猜。
   */
  const saveActive = useCallback(
    async (force = false) => {
      const path = activePath;
      const buf = path ? buffers[path] : null;
      if (!path || !buf || !buf.dirty) return;

      setSaveError(null);
      setConflict(null);

      const outcome = await save.mutateAsync({
        path,
        // 编辑器里一律是 `\n`，落盘时还原成这个文件原本的换行符，
        // 否则在 CRLF 仓库里保存一次就等于把整个文件重写成 LF。
        content: applyEol(buf.text, buf.eol),
        expectedMtime: force ? 0 : buf.baseMtime,
      });

      if (outcome.conflict) {
        setConflict(path);
        return;
      }

      setBuffers((prev) => {
        const cur = prev[path];
        if (!cur) return prev;
        return {
          ...prev,
          [path]: { ...cur, saved: cur.text, baseMtime: outcome.mtime, dirty: false },
        };
      });
    },
    [activePath, buffers, save],
  );

  /**
   * 已信任 + 服务器已装时把语言服务器拉起来。
   *
   * 每个工作区只试一次：失败（超并发上限、重试用尽）时界面上会显示原因和
   * 重试按钮，而不是在这个 effect 里反复重试——那会变成看不见的重启循环。
   */
  const ensuredFor = useRef<string | null>(null);
  const startLSP = useCallback(() => {
    if (!workspaceRoot || languageID === "") return;
    ensuredFor.current = workspaceRoot;
    ensureLSP.mutate({ root: workspaceRoot, language: languageID });
  }, [workspaceRoot, languageID, ensureLSP]);

  useEffect(() => {
    if (!workspaceRoot || !trusted || languageID === "") return;
    if (!detected.data?.installed) return;
    if (ensuredFor.current === workspaceRoot) return;
    ensuredFor.current = workspaceRoot;
    ensureLSP.mutate({ root: workspaceRoot, language: languageID });
    // ensureLSP 是 mutation 对象，每次渲染都是新引用；这里只关心输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot, trusted, languageID, detected.data?.installed]);

  const search = useFileSearch(workingCopyId, debouncedFilter, segment === "files");
  const changes = useChangedFiles(workingCopyId, segment === "changes");

  /**
   * 行标的基准：文件在 HEAD 里的原文。
   *
   * 只在有活动文件时取；拿不到（新文件、仓库还没提交）时 `exists` 为 false，
   * 此时整个文件都算新增——这正是新文件该有的样子。
   */
  const headFile = useHeadText(workingCopyId, activePath);

  /**
   * blame 按需取：它不是每时每刻都要看的东西，默认关着。
   *
   * 开着时也只算一次（结果只随提交变化），但第一次跑 blame 在深历史上并不便宜，
   * 所以不能默认打开。
   */
  const [blameOn, setBlameOn] = useState(false);
  const blame = useFileBlame(workingCopyId, activePath, blameOn);

  /** 光标所在行，由编辑器上报；blame 的「当前行是谁写的」跟着它走。 */
  const [cursorLine, setCursorLine] = useState(1);

  const dirtyPaths = useMemo(
    () => new Set(Object.entries(buffers).filter(([, b]) => b.dirty).map(([p]) => p)),
    [buffers],
  );

  /**
   * 编辑器行标的数据。
   *
   * 以**缓冲区**（可能未保存）和 HEAD 原文在本地逐行对齐，而不是用 Go 侧给的
   * diff 文本：用户一边打字，标记必须一边跟着走，diff 文本只在磁盘干净时对得上。
   */
  const headDiff = useMemo<HeadDiff | null>(() => {
    if (headFile.data === undefined) return null;
    // 二进制文件没有"行"这回事，塞进逐行对齐只会得到满屏标记。
    if (headFile.data.binary) return null;
    const text = activeBuffer?.text ?? normalizeEol(file.data?.content ?? "");
    return compareWithHead(headFile.data.exists ? headFile.data.text : null, text);
  }, [headFile.data, activeBuffer?.text, file.data?.content]);

  // 数据源身份必须稳定：它是编辑器扩展的一部分，换了实例等于重配整个扩展。
  const diffSource = useRef<MutableMarksSource<HeadDiff | null>>(createMarksSource<HeadDiff | null>(null));
  const blameSource = useRef<MutableMarksSource<BlameLine[] | null>>(createMarksSource<BlameLine[] | null>(null));

  useEffect(() => {
    diffSource.current.set(headDiff);
  }, [headDiff]);

  useEffect(() => {
    blameSource.current.set(blameOn ? (blame.data ?? null) : null);
  }, [blameOn, blame.data]);

  // 切换文件时光标行归零：上一份文件的行号对这份文件没有意义。
  useEffect(() => {
    setCursorLine(1);
  }, [activePath]);

  /** 当前行在 blame 结果里的那一条；没有 blame 或该行未提交时为 null。 */
  const cursorBlame = useMemo(() => {
    if (!blameOn) return null;
    const line = (blame.data ?? []).find((b) => b.line === cursorLine);
    return line ?? null;
  }, [blameOn, blame.data, cursorLine]);

  return {
    copies: list,
    active,
    setActiveId: (id: string) => {
      setActiveId(id);
      setExpanded(new Set());
      setTabs([]);
      setActivePath(null);
      setFilter("");
      setBuffers({});
      setSaveError(null);
      setConflict(null);
    },
    expanded,
    toggleDir,
    openFile,
    openPath,
    tabs,
    closeTab,
    activePath,
    setActivePath,
    file,
    // 缓冲区版本的内容：编辑器始终以它为准，磁盘内容只在打开时读一次。
    buffers,
    activeBuffer,
    dirtyPaths,
    edit,
    saveActive,
    saving: save.isPending,
    saveError,
    conflict,
    drafts: drafts.data ?? [],
    // 当前文件存在未保存的遗留草稿时，界面提示"恢复 / 丢弃"。
    activeDraft,
    recoverable,
    restoreDraft,
    discardDraft: (path: string) => discardDraft.mutate(path),
    segment,
    setSegment,
    filter,
    setFilter,
    debouncedFilter,
    search: search.data ?? [],
    searchLoading: search.isFetching,
    changes: changes.data ?? [],
    changesLoading: changes.isLoading,

    // 本地智能
    workspaceRoot,
    detectedLanguage: detected.data?.found ? detected.data : null,
    detectedLoading: detected.isLoading,
    trusted,
    trustDecided: trust.data?.decided ?? false,
    trustLoading: trust.isLoading,
    setTrusted: (ok: boolean) => setTrust.mutate(ok),
    trusting: setTrust.isPending,
    lspSession: session,
    lspSessions: sessions.data ?? [],
    lspStarting: ensureLSP.isPending,
    lspError: ensureLSP.error instanceof Error ? ensureLSP.error.message : null,
    startLSP,
    // 装好服务器之后要能重新探测一次，否则 Infinity 的缓存会一直说"没装"。
    recheckLanguage: () => void detected.refetch(),
    restartLSP: () => restartLSP.mutate(),
    restartingLSP: restartLSP.isPending,
    // 协议层：编辑器挂载时用它拿插件，符号分段用它发 documentSymbol。
    lspClient: lsp.client,
    lspConnectError: lsp.error,
    // 符号点击后跳到那一行：先切到那个标签，再把行号交给编辑器。
    // 中间插一拍清空，是为了让"再点同一个符号"也能重新跳一次——
    // 编辑器的跳转 effect 只在行号数值变化时触发，值不变等于什么都没发生。
    revealLine: (line: number) => {
      if (!activePath) return;
      const target = activePath;
      setReveal(null);
      window.setTimeout(() => setReveal({ path: target, line }), 0);
    },
    revealTarget: reveal,

    // 版本对照：diff 行标与 blame。
    //
    // 两者都挂在编辑器上，但数据源（`diffSource` / `blameSource`）在状态层持有：
    // 编辑器只负责把行画出来，React 这边负责决定画什么。`null` 表示这一项关着、
    // 或者还没算出来——两种情况下编辑器都只是不画，不需要各自的特例分支。
    headDiff,
    diffSource: diffSource.current,
    blameOn,
    toggleBlame: () => setBlameOn((on) => !on),
    blameSource: blameSource.current,
    /** 当前行的 blame 归属；没开 blame、文件不在历史里、或该行未提交时为 null。 */
    cursorBlame,
    /** 编辑器上报光标行；blame 的当前行说明靠它跟随。 */
    setCursorLine,
  };
}

type CodeState = ReturnType<typeof useCodeSurface>;

/* ------------------------------------------------------------------ */
/* 左栏：文件树                                                        */
/* ------------------------------------------------------------------ */

export function CodeTree({ state }: { state: CodeState }) {
  const { t } = useTranslation();
  const id = state.active?.id ?? null;
  const path = state.activePath ?? state.tabs[0]?.path ?? null;
  const symbols = useDocumentSymbols(state.lspClient, state.workspaceRoot, path, state.segment === "symbols");

  const segments: { id: CodeSegment; label: string }[] = [
    { id: "files", label: t("code.segments.files") },
    { id: "symbols", label: t("code.segments.symbols") },
    { id: "changes", label: t("code.segments.changes") },
  ];

  return (
    <section className="flex h-full flex-col" aria-label={t("code.fileTree")}>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <h1 className="text-[13px] font-medium text-[var(--color-bone)]">{t("code.title")}</h1>
          <span className="ml-auto truncate font-mono text-[10.5px] text-[var(--color-faint)]">
            {state.active ? tabName(state.active.path) : "—"}
          </span>
        </div>
        {state.copies.length > 1 && (
          <select
            value={state.active?.id ?? ""}
            onChange={(e) => state.setActiveId(e.target.value)}
            className="mt-1.5 h-[22px] w-full rounded-[5px] border border-[var(--color-edge-2)] bg-[var(--color-ink-850)] px-1 text-[11px] text-[var(--color-bone-2)] outline-none"
          >
            {state.copies.map((c) => (
              <option key={c.id} value={c.id}>
                {tabName(c.path)}
              </option>
            ))}
          </select>
        )}

        {/* 三个分段：与原型一致。 */}
        <div className="mt-2 flex gap-0.5 rounded-[7px] border border-[var(--color-edge-1)] bg-[rgba(8,13,16,0.55)] p-0.5">
          {segments.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => state.setSegment(s.id)}
              className={[
                "h-[22px] flex-1 rounded-[5px] text-[11px] whitespace-nowrap",
                state.segment === s.id
                  ? "bg-[var(--color-ink-750)] text-[var(--color-bone)] shadow-[inset_0_1px_0_rgba(240,231,216,0.045)]"
                  : "text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]",
              ].join(" ")}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* 过滤框只在文件分段有意义：变更与符号都有自己的过滤语义。 */}
        {state.segment === "files" && (
          <input
            value={state.filter}
            onChange={(e) => state.setFilter(e.target.value)}
            placeholder={t("code.filterPlaceholder")}
            aria-label={t("code.filterPlaceholder")}
            className="mt-1.5 h-[22px] w-full rounded-[5px] border border-[var(--color-edge-2)] bg-[var(--color-ink-850)] px-1.5 text-[11px] text-[var(--color-bone)] outline-none focus:border-[var(--color-amber)]"
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {!id && <Hint>{t("code.noRepository")}</Hint>}

        {id && state.segment === "files" && state.debouncedFilter.trim() === "" && (
          <TreeLevel workingCopyId={id} path="" depth={0} state={state} />
        )}

        {id && state.segment === "files" && state.debouncedFilter.trim() !== "" && (
          <SearchResults state={state} />
        )}

        {id && state.segment === "symbols" && <SymbolList state={state} symbols={symbols} />}

        {id && state.segment === "changes" && <ChangeList state={state} />}
      </div>

      <div className="shrink-0 border-t border-[var(--color-edge-1)] px-3 py-1.5 text-[10px] text-[var(--color-faint)]">
        {state.active && !state.trusted
          ? t("code.untrustedHint")
          : t("code.readOnlyHint")}
      </div>
    </section>
  );
}

/** 过滤结果：平铺列表，点击直接打开。 */
function SearchResults({ state }: { state: CodeState }) {
  const { t } = useTranslation();

  if (state.searchLoading && state.search.length === 0) {
    return <Hint>{t("code.searching")}</Hint>;
  }
  if (state.search.length === 0) {
    return <Hint>{t("code.noMatches", { query: state.debouncedFilter })}</Hint>;
  }

  return (
    <>
      <p className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase">
        {t("code.matches", { count: state.search.length })}
      </p>
      {state.search.map((node) => (
        <button
          key={node.path}
          type="button"
          onClick={() => state.openPath(node.path)}
          className={[
            "flex h-[26px] w-full items-center gap-1.5 border-l-2 px-2.5 text-left text-[11.5px]",
            node.path === state.activePath
              ? "border-l-[var(--color-amber)] bg-[var(--color-ink-800)] text-[var(--color-bone)]"
              : "border-l-transparent text-[var(--color-muted)] hover:bg-[var(--color-ink-850)]",
          ].join(" ")}
        >
          <Icon name="file" size={13} className="shrink-0 text-[var(--color-faint)]" />
          <span className="truncate font-mono text-[11px]">{node.path}</span>
        </button>
      ))}
    </>
  );
}

/**
 * 符号列表：当前文件的文档符号，按层级缩进，点击跳到那一行。
 *
 * 这条路径完全依赖语言服务器：没有连接、服务器不支持 `documentSymbol`、
 * 或还没握手完，都只会得到一个空列表。所以"为什么是空的"必须写清楚，
 * 否则用户会以为是文件没有符号。
 */
function SymbolList({
  state,
  symbols,
}: {
  state: CodeState;
  symbols: { symbols: FlatSymbol[]; loading: boolean; error: string | null };
}) {
  const { t } = useTranslation();

  if (!state.lspClient) {
    return <Hint>{t("code.symbolsNoServer")}</Hint>;
  }
  if (symbols.loading) {
    return <Hint>{t("code.symbolsLoading")}</Hint>;
  }
  if (symbols.error != null) {
    return <Hint>{symbols.error}</Hint>;
  }
  if (symbols.symbols.length === 0) {
    return <Hint>{t("code.symbolsEmpty")}</Hint>;
  }

  return (
    <>
      {symbols.symbols.map((symbol, index) => (
        <button
          key={`${symbol.line}:${symbol.name}:${index}`}
          type="button"
          onClick={() => state.revealLine(symbol.line)}
          // 缩进用 padding 而不是嵌套列表：符号层级可以很深，
          // 每层加一个 div 会让左栏在窄窗口里被挤成一条竖线。
          style={{ paddingLeft: 10 + Math.min(symbol.depth, 6) * 12 }}
          className="flex h-[24px] w-full items-center gap-1.5 border-l-2 border-l-transparent pr-2.5 text-left text-[11.5px] text-[var(--color-muted)] hover:bg-[var(--color-ink-850)] hover:text-[var(--color-bone-2)]"
        >
          <span className="truncate">{symbol.name}</span>
          {symbol.detail !== "" && (
            <span className="truncate font-mono text-[9.5px] text-[var(--color-faint)]">
              {symbol.detail}
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-[var(--color-faint)]">
            {symbol.line}
          </span>
        </button>
      ))}
    </>
  );
}

/** 变更列表：平铺，点击打开，带状态标记。 */
function ChangeList({ state }: { state: CodeState }) {
  const { t } = useTranslation();

  if (state.changesLoading) {
    return <Hint>{""}</Hint>;
  }
  if (state.changes.length === 0) {
    return <Hint>{t("code.noChanges")}</Hint>;
  }

  return (
    <>
      {state.changes.map((node) => (
        <button
          key={node.path}
          type="button"
          onClick={() => state.openPath(node.path)}
          className={[
            "flex h-[26px] w-full items-center gap-1.5 border-l-2 px-2.5 text-left text-[11.5px]",
            node.path === state.activePath
              ? "border-l-[var(--color-amber)] bg-[var(--color-ink-800)] text-[var(--color-bone)]"
              : "border-l-transparent text-[var(--color-muted)] hover:bg-[var(--color-ink-850)]",
          ].join(" ")}
        >
          <Icon name="file" size={13} className="shrink-0 text-[var(--color-faint)]" />
          <span className="truncate font-mono text-[11px]">{node.path}</span>
          {node.status !== "" && (
            <span className="ml-auto shrink-0 font-mono text-[9.5px] text-[var(--color-amber)]">
              {node.status}
            </span>
          )}
        </button>
      ))}
    </>
  );
}

/** 递归列举一层目录。 */
function TreeLevel({
  workingCopyId,
  path,
  depth,
  state,
}: {
  workingCopyId: string;
  path: string;
  depth: number;
  state: CodeState;
}) {
  const { t } = useTranslation();
  const dir = useDirectory(workingCopyId, path);

  if (dir.isLoading) {
    return <Hint>{""}</Hint>;
  }
  if (dir.error != null) {
    return (
      <p className="px-3 py-1 text-[10.5px] text-[var(--color-rose)]">
        {dir.error instanceof Error ? dir.error.message : t("code.readFailed")}
      </p>
    );
  }

  const nodes = dir.data ?? [];
  if (nodes.length === 0 && depth === 0) {
    return <Hint>{t("code.emptyRepository")}</Hint>;
  }

  return (
    <>
      {nodes.map((node) => {
        const isOpen = state.expanded.has(node.path);
        const isActive = node.path === state.activePath;
        return (
          <div key={node.path}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => (node.isDir ? state.toggleDir(node.path) : state.openFile(node))}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                if (node.isDir) state.toggleDir(node.path);
                else state.openFile(node);
              }}
              className={[
                "flex h-[26px] cursor-pointer items-center gap-1.5 border-l-2 text-[11.5px]",
                isActive
                  ? "border-l-[var(--color-amber)] bg-[var(--color-ink-800)] text-[var(--color-bone)]"
                  : "border-l-transparent text-[var(--color-muted)] hover:bg-[var(--color-ink-850)]",
                node.isDir ? "font-medium text-[var(--color-bone-2)]" : "",
              ].join(" ")}
              style={{ paddingLeft: 10 + depth * 12 }}
            >
              {node.isDir ? (
                <Icon
                  name={isOpen ? "folder-open" : "folder"}
                  size={13}
                  className="shrink-0 text-[var(--color-faint)]"
                />
              ) : (
                <Icon name="file" size={13} className="shrink-0 text-[var(--color-faint)]" />
              )}
              <span className="truncate">{node.name}</span>
              {node.status !== "" && (
                <span className="ml-auto shrink-0 pr-2.5 font-mono text-[9.5px] text-[var(--color-amber)]">
                  {node.status}
                </span>
              )}
            </div>
            {node.isDir && isOpen && (
              <TreeLevel
                workingCopyId={workingCopyId}
                path={node.path}
                depth={depth + 1}
                state={state}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 右栏：标签页 + 代码                                                 */
/* ------------------------------------------------------------------ */

export function CodeDetail({ state }: { state: CodeState }) {
  const { t } = useTranslation();

  // 未信任的工作区退回只读（§7.6）：语言服务器会执行这里的项目代码，
  // 在用户点头之前，连"改这个文件"也不该顺手发生——读得到就够判断要不要信。
  const editable = state.trusted;

  // ⌘S / Ctrl+S 保存。必须显式接管：WebView 的默认行为是弹"另存为"。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "s") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      if (!editable) return;
      void state.saveActive();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, editable]);

  // 这个 useMemo 必须排在下面那个"没有标签页"的提前返回之前：标签页是从 0
  // 变成非 0 的（恢复上次布局那一帧），把 hook 放在 return 之后会让两次渲染的
  // hook 数量不一样，React 直接抛 #300 卸载整棵树。
  const pendingPath = state.activePath ?? state.tabs[0]?.path ?? null;
  const lspExtensions = useMemo(() => {
    if (!state.lspClient || !state.workspaceRoot || !pendingPath) return undefined;
    const languageId = state.detectedLanguage?.id;
    // `plugin()` 的返回类型标的是单个 Extension，实际是"插件 + 主题 + 客户端
    // 附带的一组扩展"的数组，统一摊成数组交给 CodeView 的插槽。
    return [state.lspClient.plugin(toFileUri(state.workspaceRoot, pendingPath), languageId)];
  }, [state.lspClient, state.workspaceRoot, pendingPath, state.detectedLanguage?.id]);

  /**
   * 行标与 blame 的文字。
   *
   * 这两个对象会进到扩展里，同样必须按引用稳定：每次渲染新建一份等于让
   * CodeView 反复重配注入的扩展，光标都会被打断。
   */
  const diffLabels = useMemo<DiffMarkLabels>(
    () => ({
      added: t("code.diff.added"),
      modified: t("code.diff.modified"),
      removed: t("code.diff.removed"),
    }),
    [t],
  );
  const blameLabels = useMemo<BlameLabels>(
    () => ({
      uncommitted: t("code.blame.uncommitted"),
      describe: (line: BlameLine) => {
        // 未提交的行没有作者，说明文字也不能编一个出来。
        if (line.commit === "") return t("code.blame.uncommittedHint");
        const when = line.time > 0 ? relativeTime(new Date(line.time).toISOString(), t) : "";
        const head = when === "" ? line.author : `${line.author} · ${when}`;
        return line.summary === "" ? head : `${head}\n${line.summary}`;
      },
    }),
    [t],
  );

  /**
   * 渲染进编辑器的扩展：语言服务器 + 行标 + blame + 光标行上报。
   *
   * 数组按依赖重建，但**数组里的扩展实例本身是稳定的**（行标读的是状态层手里
   * 那个不会变的 `diffSource`），所以重建只影响引用，不会让编辑器丢掉状态。
   *
   * blame 只在开关打开时才注入：gutter 只要挂上去就会占住自己的最小宽度，
   * 关掉开关还留着一条空条，看起来像界面漏了一块。
   */
  const editorExtensions = useMemo(() => {
    const list = [diffGutter(state.diffSource, diffLabels), cursorLineReporter((cursor) => state.setCursorLine(cursor.line))];
    if (state.blameOn) list.push(blameGutter(state.blameSource, blameLabels));
    if (lspExtensions) list.push(...lspExtensions);
    return list;
  }, [state.diffSource, state.blameSource, state.blameOn, state.setCursorLine, diffLabels, blameLabels, lspExtensions]);

  if (state.tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[15px] text-[var(--color-bone)]">{t("code.emptyTitle")}</p>
        <p className="max-w-[46ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
          {t("code.emptyHint")}
        </p>
      </div>
    );
  }

  const path = state.activePath ?? state.tabs[0].path;
  const language = languageOf(path);
  const buffer = state.activeBuffer;
  // 编辑器以缓冲区为准；缓冲区还没建立时退回磁盘内容，避免闪一帧空白。
  // 磁盘内容带的可能是 CRLF，先归一成 `\n` 才知道"改没改"。
  const content = buffer?.text ?? normalizeEol(state.file.data?.content ?? "");
  const dirty = buffer?.dirty ?? false;
  const lines = content === "" ? [] : content.split("\n");
  // 文件末尾的换行会产生一个空行，界面上多一个空行号没有意义。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return (
    <>
      <div className="flex shrink-0 items-stretch overflow-auto border-b border-[var(--color-edge-1)] bg-[var(--color-ink-900)]">
        {state.tabs.map((tab) => {
          const on = tab.path === path;
          const tabDirty = state.dirtyPaths.has(tab.path);
          return (
            <div
              key={tab.path}
              className={[
                "group flex h-[30px] shrink-0 items-center gap-1.5 border-r border-[var(--color-edge-1)] px-2.5 text-[11.5px]",
                on
                  ? "bg-[var(--color-ink-950)] text-[var(--color-bone)] shadow-[inset_0_1px_0_var(--color-amber)]"
                  : "text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]",
              ].join(" ")}
            >
              <button
                type="button"
                onClick={() => state.setActivePath(tab.path)}
                className="flex max-w-[200px] items-center gap-1.5 truncate"
              >
                <Icon name="file" size={11} className="shrink-0 text-[var(--color-faint)]" />
                <span className="truncate">{tab.name}</span>
                {/* 未保存标记：常驻在文件名后面，而不是只在标题栏汇总。 */}
                {tabDirty && (
                  <span
                    aria-label={t("code.unsaved")}
                    title={t("code.unsaved")}
                    className="shrink-0 text-[var(--color-amber)]"
                  >
                    ●
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={t("code.closeTab")}
                onClick={() => state.closeTab(tab.path)}
                className="shrink-0 text-[var(--color-faint)] hover:text-[var(--color-bone-2)]"
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          );
        })}
      </div>

      {/* ed-bar：面包屑 + 相对 HEAD 的增删 + 文档事实 + 保存。 */}
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--color-edge-1)] bg-[var(--color-ink-950)] px-2.5">
        <Breadcrumb path={path} />
        {/* 增删统计：与左侧行标同源（都是缓冲区对 HEAD 的结果），
            扫一眼就知道这个文件改了多少，不用去看工作副本面。 */}
        {state.headDiff != null && state.headDiff.added + state.headDiff.removed > 0 && (
          <span className="shrink-0 font-mono text-[10.5px]">
            <span className="text-[var(--color-sage)]">+{state.headDiff.added}</span>{" "}
            <span className="text-[var(--color-rose)]">−{state.headDiff.removed}</span>
          </span>
        )}
        <button
          type="button"
          onClick={state.toggleBlame}
          title={t("code.blame.toggleHint")}
          className={[
            "ml-auto h-[20px] shrink-0 rounded-[5px] border px-1.5 text-[10.5px]",
            state.blameOn
              ? "border-[var(--color-sky)] text-[var(--color-sky)]"
              : "border-[var(--color-edge-2)] text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]",
          ].join(" ")}
        >
          {t("code.blame.toggle")}
        </button>
        <span className="shrink-0 text-[10.5px] text-[var(--color-faint)]">
          {languageLabel(language, t)}
        </span>
        <span className="shrink-0 text-[10.5px] text-[var(--color-faint)]">
          {t("code.lineCount", { count: lines.length })}
        </span>
        <button
          type="button"
          onClick={() => void state.saveActive()}
          // 没有改动时禁用：一个永远可点但没有效果的按钮会让人怀疑保存没生效。
          disabled={!editable || !dirty || state.saving}
          title={
            !editable ? t("code.untrustedHint") : dirty ? t("code.saveHint") : t("code.noChangesToSave")
          }
          className={[
            "h-[22px] shrink-0 rounded-[7px] border px-2 text-[10.5px]",
            dirty && editable
              ? "border-[var(--color-amber)] text-[var(--color-amber)] hover:bg-[rgba(232,163,58,0.12)]"
              : "border-[var(--color-edge-2)] text-[var(--color-bone-2)] opacity-40",
          ].join(" ")}
        >
          {state.saving ? t("code.saving") : t("code.save")}
        </button>
      </div>

      {/* 语言服务器现状：这里必须一直有交代。
          没有它，用户看到的是"补全怎么不动"，而有它才看得出是未信任、
          没装服务器，还是进程崩了正在重启。 */}
      <LSPBar state={state} />

      {/* 遗留草稿提示：崩溃/强杀后重开，未保存的内容还在本地库里。
          不自动套用——磁盘可能已被外部改过，等于替用户做了合并决定。 */}
      {state.activeDraft != null && !dirty && (
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(19,32,39,0.6),rgba(12,21,26,0.7))] px-3 py-1.5">
          <Icon name="clock" size={12} className="mt-px shrink-0 text-[var(--color-muted-2)]" />
          <span className="text-[10.5px] leading-relaxed text-[var(--color-bone-2)]">
            {t("code.draftFound")}
          </span>
          <button
            type="button"
            onClick={() => state.restoreDraft(path)}
            className="ml-auto shrink-0 text-[10.5px] text-[var(--color-amber)] hover:underline"
          >
            {t("code.draftRestore")}
          </button>
          <button
            type="button"
            onClick={() => state.discardDraft(path)}
            className="shrink-0 text-[10.5px] text-[var(--color-muted-2)] hover:underline"
          >
            {t("code.draftDiscard")}
          </button>
        </div>
      )}

      {/* 冲突提示：磁盘文件在编辑期间被别的东西改过。 */}
      {state.conflict === path && (
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-edge-1)] bg-[rgba(232,163,58,0.1)] px-3 py-1.5">
          <Icon name="alert" size={12} className="mt-px shrink-0 text-[var(--color-amber)]" />
          <span className="text-[10.5px] leading-relaxed text-[var(--color-bone-2)]">
            {t("code.conflictHint")}
          </span>
          <button
            type="button"
            onClick={() => void state.saveActive(true)}
            className="ml-auto shrink-0 text-[10.5px] text-[var(--color-amber)] hover:underline"
          >
            {t("code.overwrite")}
          </button>
        </div>
      )}

      {state.saveError != null && (
        <div className="shrink-0 border-b border-[var(--color-edge-1)] px-3 py-1.5 text-[10.5px] text-[var(--color-rose)]">
          {state.saveError}
        </div>
      )}

      {/* 当前行的归属：行标只能看到"这一行是谁"的缩写，完整的提交信息放在这里。
          未提交的行也照样说明——它本来就没有作者可查，静默留白反而像没加载完。 */}
      {state.blameOn && (
        <div className="flex h-[24px] shrink-0 items-center gap-2 overflow-hidden border-b border-[var(--color-edge-1)] px-3 text-[10.5px]">
          <Icon name="clock" size={11} className="shrink-0 text-[var(--color-faint)]" />
          {state.cursorBlame == null ? (
            <span className="truncate text-[var(--color-faint)]">{t("code.blame.noLine")}</span>
          ) : state.cursorBlame.commit === "" ? (
            <span className="truncate text-[var(--color-amber-3)] italic">
              {t("code.blame.uncommittedHint")}
            </span>
          ) : (
            <>
              <span className="shrink-0 text-[var(--color-bone-2)]">{state.cursorBlame.author}</span>
              <span className="shrink-0 font-mono text-[var(--color-faint)]">
                {state.cursorBlame.commit.slice(0, 8)}
              </span>
              <span className="truncate text-[var(--color-muted-2)]">{state.cursorBlame.summary}</span>
              {state.cursorBlame.time > 0 && (
                <span className="ml-auto shrink-0 text-[var(--color-faint)]">
                  {relativeTime(new Date(state.cursorBlame.time).toISOString(), t)}
                </span>
              )}
            </>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 bg-[var(--color-ink-950)]">
        {state.file.isLoading && <Hint>{t("code.loadingFile")}</Hint>}
        {state.file.error != null && (
          <p className="px-4 py-2 text-[11.5px] leading-relaxed text-[var(--color-rose)]">
            {state.file.error instanceof Error
              ? state.file.error.message
              : t("code.loadFailed")}
          </p>
        )}
        {state.file.data !== undefined && (
          <CodeView
            content={content}
            path={path}
            readOnly={!editable}
            onChange={(value) => state.edit(path, value)}
            className="h-full overflow-auto"
            extensions={editorExtensions}
            // 行号只在它属于当前文件时才生效：符号列表记的是它自己那份文件的行，
            // 切标签之后拿它去跳会落到别的文件上。
            revealLine={state.revealTarget?.path === path ? state.revealTarget.line : undefined}
          />
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 语言服务器状态条                                                    */
/* ------------------------------------------------------------------ */

/**
 * 语言服务器的当前交代。
 *
 * 五种状态各自有话说，界面不能把它们混成一句"未就绪"：
 * 没探测到语言 / 探测到了但服务器没装 / 装好了但目录未信任 /
 * 正在启动或重启 / 已跑起来。用户看到的下一步动作完全不同。
 */
function LSPBar({ state }: { state: CodeState }) {
  const { t } = useTranslation();

  if (!state.workspaceRoot) return null;

  const detected = state.detectedLanguage;
  const session = state.lspSession;

  // 信任闸门优先于一切：没点头之前，别的都是"以后再说"。
  if (!state.trusted) {
    return (
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(19,32,39,0.6),rgba(12,21,26,0.7))] px-3 py-1.5">
        <Icon name="alert" size={12} className="mt-px shrink-0 text-[var(--color-muted-2)]" />
        <span className="text-[10.5px] leading-relaxed text-[var(--color-bone-2)]">
          {detected ? t("code.lsp.trustPrompt") : t("code.lsp.trustPromptNoLanguage")}
        </span>
        <button
          type="button"
          onClick={() => state.setTrusted(true)}
          disabled={state.trusting}
          className="ml-auto shrink-0 text-[10.5px] text-[var(--color-amber)] hover:underline disabled:opacity-40"
        >
          {t("code.lsp.allow")}
        </button>
        <button
          type="button"
          onClick={() => state.setTrusted(false)}
          disabled={state.trusting}
          className="shrink-0 text-[10.5px] text-[var(--color-muted-2)] hover:underline disabled:opacity-40"
        >
          {t("code.lsp.deny")}
        </button>
      </div>
    );
  }

  if (!detected) {
    return <LSPNote>{t("code.lsp.noLanguage")}</LSPNote>;
  }

  // 不静默下载：装不了的时候唯一出路就是把这条命令给出去，
  // 再给一个"装完重探"，否则这条提示会挂到窗口关掉为止。
  if (!detected.installed) {
    return (
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(19,32,39,0.6),rgba(12,21,26,0.7))] px-3 py-1.5">
        <Icon name="alert" size={12} className="mt-px shrink-0 text-[var(--color-amber)]" />
        <span className="min-w-0 text-[10.5px] leading-relaxed text-[var(--color-bone-2)]">
          {t("code.lsp.missingServer", { server: detected.server })}
          <code className="mt-1 block truncate font-mono text-[10.5px] text-[var(--color-amber)]">
            {detected.installHint}
          </code>
        </span>
        <button
          type="button"
          onClick={() => state.recheckLanguage()}
          className="ml-auto shrink-0 text-[10.5px] text-[var(--color-muted-2)] hover:underline"
        >
          {t("code.lsp.recheck")}
        </button>
      </div>
    );
  }

  if (state.lspError != null) {
    return (
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-edge-1)] bg-[rgba(232,163,58,0.1)] px-3 py-1.5">
        <Icon name="alert" size={12} className="mt-px shrink-0 text-[var(--color-amber)]" />
        <span className="min-w-0 text-[10.5px] leading-relaxed text-[var(--color-bone-2)]">
          {state.lspError}
        </span>
        <button
          type="button"
          onClick={() => state.restartLSP()}
          disabled={state.restartingLSP}
          className="ml-auto shrink-0 text-[10.5px] text-[var(--color-amber)] hover:underline disabled:opacity-40"
        >
          {t("common.retry")}
        </button>
      </div>
    );
  }

  if (state.lspStarting) {
    return <LSPNote>{t("code.lsp.starting", { server: detected.server })}</LSPNote>;
  }

  if (session?.state === "failed") {
    return (
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-edge-1)] bg-[rgba(232,163,58,0.1)] px-3 py-1.5">
        <Icon name="alert" size={12} className="mt-px shrink-0 text-[var(--color-amber)]" />
        <span className="min-w-0 text-[10.5px] leading-relaxed text-[var(--color-bone-2)]">
          {t("code.lsp.failed", { error: session.lastError })}
        </span>
        <button
          type="button"
          onClick={() => state.restartLSP()}
          disabled={state.restartingLSP}
          className="ml-auto shrink-0 text-[10.5px] text-[var(--color-amber)] hover:underline disabled:opacity-40"
        >
          {t("common.retry")}
        </button>
      </div>
    );
  }

  if (session?.state === "restarting") {
    return <LSPNote>{t("code.lsp.restarting", { count: session.restarts })}</LSPNote>;
  }

  // 进程在跑，但编辑器这边的协议连接没建起来：两件事是分开的，
  // 只报"服务器在运行"会让补全失灵显得毫无理由。
  if (session && state.lspClient == null && state.lspConnectError != null) {
    return (
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-edge-1)] bg-[rgba(232,163,58,0.1)] px-3 py-1.5">
        <Icon name="alert" size={12} className="mt-px shrink-0 text-[var(--color-amber)]" />
        <span className="min-w-0 text-[10.5px] leading-relaxed text-[var(--color-bone-2)]">
          {t("code.lsp.connectFailed", { server: detected.server, error: state.lspConnectError })}
        </span>
        <button
          type="button"
          onClick={() => state.restartLSP()}
          disabled={state.restartingLSP}
          className="ml-auto shrink-0 text-[10.5px] text-[var(--color-amber)] hover:underline disabled:opacity-40"
        >
          {t("common.retry")}
        </button>
      </div>
    );
  }

  if (session) {
    return (
      <LSPNote>
        {t("code.lsp.ready", { server: detected.server, language: detected.id })}
      </LSPNote>
    );
  }

  // 已信任、已装，但没有会话：可能被空闲回收了，也可能上一次拉起就没成功。
  // 给一个按钮而不是干等——用户没理由知道"下次编辑会自动拉起"。
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-edge-1)] px-3 py-1.5">
      <span aria-hidden className="shrink-0 text-[8px] text-[var(--color-faint)]">
        ●
      </span>
      <span className="min-w-0 truncate text-[10.5px] text-[var(--color-muted-2)]">
        {t("code.lsp.notStarted", { server: detected.server })}
      </span>
      <button
        type="button"
        onClick={() => state.startLSP()}
        disabled={state.lspStarting}
        className="ml-auto shrink-0 text-[10.5px] text-[var(--color-amber)] hover:underline disabled:opacity-40"
      >
        {t("code.lsp.start", { server: detected.server })}
      </button>
    </div>
  );
}

/** 状态条里那种只有一句话的行。 */
function LSPNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-edge-1)] px-3 py-1.5">
      <span aria-hidden className="shrink-0 text-[8px] text-[var(--color-faint)]">
        ●
      </span>
      <span className="min-w-0 truncate text-[10.5px] text-[var(--color-muted-2)]">{children}</span>
    </div>
  );
}

/** 面包屑：路径逐段显示，长路径靠 overflow 截断。 */
function Breadcrumb({ path }: { path: string }) {
  const segs = pathSegments(path);
  return (
    <div className="flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-[var(--color-muted-2)]">
      {segs.map((seg, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <span className="text-[var(--color-faint)]">/</span>}
          <span
            className={
              i === segs.length - 1
                ? "truncate text-[var(--color-bone-2)]"
                : "truncate text-[var(--color-faint)]"
            }
          >
            {seg}
          </span>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ⌘P 快速跳文件                                                       */
/* ------------------------------------------------------------------ */

/**
 * 文件快速跳转面板。
 *
 * 触发方式与所有主流编辑器一致：`⌘P` / `Ctrl+P`。它存在的理由是
 * **文件树在深目录下找不动**——用户记得文件名，但不想逐层展开。
 *
 * 搜索走 Go 侧的 SearchFiles（路径匹配），复用左栏的同一份数据源，
 * 因此这里不做第二次遍历。
 */
export function CodeQuickOpen({ state }: { state: CodeState }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 面板只在 Code 面可见时挂载，因此这里的全局监听不会干扰其他面。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isP = e.key.toLowerCase() === "p";
      if (isP && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        setQuery("");
        setCursor(0);
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 打开后聚焦输入框：否则用户得先点一下才能打字。
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // 独立的搜索：与左栏过滤框互不影响（两者可能同时有内容）。
  const search = useFileSearch(state.active?.id ?? null, query, open);
  const results = search.data ?? [];

  if (!open) return null;

  const choose = (path: string) => {
    state.openPath(path);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[cursor];
      if (hit) choose(hit.path);
    }
  };

  return (
    <div
      role="dialog"
      aria-label={t("code.quickOpen.title")}
      className="absolute inset-0 z-30 flex items-start justify-center bg-[rgba(6,10,13,0.55)] pt-[64px]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[520px] max-w-[86vw] overflow-hidden rounded-[9px] border border-[var(--color-edge-2)] bg-[var(--color-ink-900)] shadow-[0_18px_48px_rgba(0,0,0,0.5)]"
        // 点面板内部不该关闭面板。
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={t("code.quickOpen.placeholder")}
          aria-label={t("code.quickOpen.placeholder")}
          className="h-[38px] w-full border-b border-[var(--color-edge-1)] bg-transparent px-3 text-[12.5px] text-[var(--color-bone)] outline-none placeholder:text-[var(--color-faint)]"
        />
        <div className="max-h-[320px] overflow-auto py-1">
          {query.trim() === "" && <Hint>{t("code.quickOpen.hint")}</Hint>}
          {query.trim() !== "" && results.length === 0 && !search.isFetching && (
            <Hint>{t("code.noMatches", { query })}</Hint>
          )}
          {results.map((node, i) => (
            <button
              key={node.path}
              type="button"
              onClick={() => choose(node.path)}
              onMouseEnter={() => setCursor(i)}
              className={[
                "flex h-[27px] w-full items-center gap-2 px-3 text-left text-[11.5px]",
                i === cursor
                  ? "bg-[var(--color-ink-750)] text-[var(--color-bone)]"
                  : "text-[var(--color-muted)]",
              ].join(" ")}
            >
              <Icon name="file" size={12} className="shrink-0 text-[var(--color-faint)]" />
              <span className="truncate font-mono text-[11px]">{node.path}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 详情右侧的事实面板。 */export function CodeInspector({ state }: { state: CodeState }) {
  const { t } = useTranslation();
  const path = state.activePath ?? state.tabs[0]?.path ?? null;
  const node = useMemo(() => {
    if (!path) return null;
    return { path, language: languageOf(path) };
  }, [path]);

  // 行数与文件事实都以缓冲区为准：用户改了几行就该看到几行，
  // 而不是磁盘上那份旧内容的行数。
  const content = state.activeBuffer?.text ?? normalizeEol(state.file.data?.content ?? "");
  const lineCount = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;

  return (
    <aside
      aria-label={t("code.inspector.title")}
      className="flex w-[292px] shrink-0 flex-col border-l border-[var(--color-edge-1)] bg-[var(--color-ink-900)]"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-edge-1)] px-3 py-2.5">
        <div className="flex gap-0.5">
          <button
            type="button"
            className="h-[22px] rounded-[5px] bg-[var(--color-ink-750)] px-[7px] text-[11px] text-[var(--color-bone)]"
          >
            {t("code.inspector.tabFacts")}
          </button>
        </div>
        <button
          type="button"
          aria-label={t("code.inspector.close")}
          className="ml-auto text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]"
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pt-2.5 pb-6">
        <SectionLabel>{t("code.inspector.sectionFile")}</SectionLabel>
        <dl>
          <KV k={t("code.inspector.path")} v={node?.path ?? "—"} mono />
          <KV k={t("code.inspector.language")} v={languageLabel(node?.language ?? "", t)} />
          <KV k={t("code.inspector.lines")} v={String(lineCount)} />
        </dl>

        <SectionLabel>{t("code.inspector.sectionNext")}</SectionLabel>
        <span className="text-[11px] leading-relaxed text-[var(--color-muted-2)]">
          {t("code.inspector.nextHint")}
        </span>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* 小组件                                                              */
/* ------------------------------------------------------------------ */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 mb-1 text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase first:mt-0">
      {children}
    </p>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-[11px]">
      <dt className="shrink-0 text-[var(--color-muted-2)]">{k}</dt>
      <dd
        className={`truncate text-right text-[var(--color-bone-2)] ${mono ? "font-mono" : ""}`}
        title={v}
      >
        {v}
      </dd>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-[11.5px] leading-relaxed text-[var(--color-muted)]">{children}</p>;
}
