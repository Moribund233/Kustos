import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";

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
  useDraftAhead,
  useHeadText,
  useCommit,
  useStage,
  useWorkingCopies,
  useWorkingCopyStatus,
  workingCopyKeys,
  type WorkingCopy,
} from "@/lib/working-copy";
import {
  collabDocumentKey,
  collabDraftBranch,
  collabEditorExtension,
  collabPeerCount,
  createCollabSession,
  saveCollabDocument,
  saveErrorIsKick,
  type CollabSession,
  type CollabStatus,
} from "@/lib/collab";
import { activePathCounts, connectionsFor, useActiveCollabDocs } from "@/lib/collab-active";
import {
  CollabPublishError,
  collabPublishKeys,
  emptyPreview,
  publishCollabDraft,
  useDraftPreview,
  type DraftPublishResult,
} from "@/lib/collab-publish";
import {
  isWritable,
  precheck,
  saveSemantics,
  transition,
  type DocMode,
  type PrecheckResolution,
  type PrecheckResult,
} from "@/lib/doc-mode";
import { matchRepository, useRepositories, useWorkingCopySlug } from "@/lib/repos";

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

/**
 * 网关广播的保存回执。
 *
 * 保存是异步落 Git 的，界面只能等这条广播才知道有没有真的存下来；
 * `commit_id` 为空表示内容与草稿分支一致，没有产生新提交。
 */
interface CollabSavedPayload {
  type?: string;
  docKey?: string;
  commit_id?: string;
  version?: number;
}

/**
 * 汇总 Code 面的状态；由外层装配进 Shell。
 *
 * userName 只用于协作感知层的光标标签：网关会用令牌里的身份盖章，
 * 这里传的只是本地显示名。
 */
export function useCodeSurface(userName = "") {
  const { t } = useTranslation();
  const qc = useQueryClient();
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

  /* ---------------------------------------------------------------- */
  /* 协作                                                              */
  /* ---------------------------------------------------------------- */

  // 工作副本的远端决定它对得上哪个服务端仓库；对不上就没有可开的协作文档。
  const remoteSlug = useWorkingCopySlug(workingCopyId);
  const repoList = useRepositories();
  const repo = useMemo(
    () => matchRepository(repoList.data ?? [], remoteSlug.data ?? null).matched,
    [repoList.data, remoteSlug.data],
  );

  const copyStatus = useWorkingCopyStatus(workingCopyId);
  const localBranch = copyStatus.data?.branch ?? active?.branch ?? "";

  /**
   * 协作文档挂在**仓库默认分支**上，而不是本地当前分支。
   *
   * 共享编辑发生在大家共同的那条线上：本地停在自己的功能分支时，
   * 预检第一步就该要求先对齐，而不是悄悄在你的分支上开一份只有自己能看到的文档。
   */
  const collabBranch = repo?.defaultBranch ?? localBranch;
  /**
   * 本地视角的草稿领先数。
   *
   * 只用在**进入协作前**的预检里：那时不该为了一个提示去动网络，而"本地分支
   * 与草稿引用差多少"已经足够判断要不要先 fetch。
   */
  const draftAhead = useDraftAhead(workingCopyId, collabBranch);
  const activeDocs = useActiveCollabDocs(repo?.id ?? null);

  const [mode, setMode] = useState<DocMode>("disk");
  const [collab, setCollab] = useState<CollabSession | null>(null);
  const [collabStatus, setCollabStatus] = useState<CollabStatus | null>(null);
  const [collabError, setCollabError] = useState<string | null>(null);
  const [collabSaving, setCollabSaving] = useState(false);
  const [collabSaved, setCollabSaved] = useState<string | null>(null);
  const [peers, setPeers] = useState(0);
  const [precheckResult, setPrecheckResult] = useState<PrecheckResult | null>(null);
  const [precheckBusy, setPrecheckBusy] = useState(false);
  const [precheckError, setPrecheckError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  // 预检选了"先写盘"：保存是异步落地的，得等缓冲区不再脏再重新判定，
  // 否则紧接着调预检读到的还是旧的 dirty，对话框会原地再弹一次。
  const [pendingJoin, setPendingJoin] = useState(false);

  // 发布：预览对话框、发布中的忙态、结果与失败。
  //
  // 发布是**不可撤销**的动作（squash 进目标分支），所以它走一个独立的确认框：
  // 框里先摊开"要合进去的是什么"，而不是把按钮挂在编辑栏上一点就发。
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishMessage, setPublishMessage] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState<DraftPublishResult | null>(null);

  const stage = useStage(workingCopyId);
  const commit = useCommit(workingCopyId);
  // 预检的"本地有改动"要的是全量变更，与文件树用的那份共用缓存。
  const pendingChanges = useChangedFiles(workingCopyId, true);

  const collabKey = repo && activePath ? collabDocumentKey(repo.id, collabBranch, activePath) : "";

  /** 同一分支下每个路径有多少人在编辑；文件树的 live 圆点用它。 */
  const livePaths = useMemo(
    () => activePathCounts(activeDocs.data?.documents ?? [], collabBranch),
    [activeDocs.data, collabBranch],
  );

  const collabEnabled = mode !== "disk" && collabKey !== "";

  /**
   * 会话的生命周期由这一段独占。
   *
   * `mode` 决定"要不要连"，`collabKey` 决定"连哪一份"：进入协作只要把 mode
   * 从 disk 换掉，换文件则因键变化自动重连，退出时 cleanup 负责销毁。
   */
  useEffect(() => {
    if (!collabEnabled) return;
    setCollabStatus("connecting");
    setCollabError(null);
    const session = createCollabSession({
      documentName: collabKey,
      username: userName,
      onStatus: (status) => setCollabStatus(status),
      // 写入权限被吊销 / 被踢出会话：网关会断开连接，这里把模式降到观察态。
      // 只降不升——重新连一次自动变回 live 是错的，权限没了就不该再能写。
      onKicked: (reason) => {
        setCollabSaving(false);
        setCollabError(reason);
        setMode((current) => transition(current, "kick"));
        // 降级之后不能留一个"正在写"的编辑器：带走的光标会让别人以为还在改。
        setCollabSaved(null);
      },
      // 保存失败（只读、内容过大、后端 500）：保存中必须收尾，否则按钮一直转。
      onSaveError: (error) => {
        setCollabSaving(false);
        setCollabError(error === "" ? t("code.collab.saveFailed") : error);
        // 权限类失败同样要降级：界面上继续允许写，写出去的字永远发不到服务端。
        if (saveErrorIsKick(error)) setMode((current) => transition(current, "kick"));
      },
    });
    setCollab(session);
    return () => {
      session.destroy();
      setCollab(null);
      setCollabStatus(null);
      setCollabSaved(null);
      setPeers(0);
    };
  }, [collabEnabled, collabKey, userName, t]);

  // 在线人数（含自己）：感知层不可用时显示 0，而不是假装"1 人"。
  useEffect(() => {
    const awareness = collab?.provider.awareness;
    if (!awareness) return;
    const update = () => setPeers(collabPeerCount(awareness));
    update();
    awareness.on("change", update);
    return () => {
      awareness.off("change", update);
    };
  }, [collab]);

  /**
   * 共享文本的当前快照。
   *
   * 直接读 Y.Text，不缓存：编辑器挂载那一刻要拿到的正是"此刻"的共享文本。
   * yCollab 的同步插件不会用 Y.Text 初始化 CodeMirror，也不会把 CodeMirror
   * 写进 Y.Text——它只转达之后发生的变化。所以文档对不上的话，两份真相会各写各的，
   * 编辑器里的磁盘内容会被当成"本地新增"整段插进共享文本。挂载时对齐，之后才安全。
   */
  const collabText = useCallback(() => collab?.text.toString() ?? "", [collab]);

  // 网关的保存回执：只有真落了草稿提交，界面才敢说"已保存"。
  useEffect(() => {
    const provider = collab?.provider;
    if (!provider) return;
    const onStateless = (data: { payload?: string }) => {
      let message: CollabSavedPayload | null = null;
      try {
        message = JSON.parse(data.payload ?? "") as CollabSavedPayload;
      } catch {
        return;
      }
      if (message?.type !== "collab-saved" || message.docKey !== collabKey) return;
      setCollabSaving(false);
      setCollabSaved(message.commit_id ?? "");
      // 草稿分支刚前进了一次：不立刻失效，"发布"按钮上的计数会停在旧值上
      // （缓存 15 秒），用户看着一个灰按钮，以为自己的保存没算数。
      void qc.invalidateQueries({ queryKey: workingCopyKeys.draftAhead(workingCopyId ?? "", collabBranch) });
      void qc.invalidateQueries({ queryKey: collabPublishKeys.preview(repo?.id ?? "", collabBranch) });
    };
    provider.on("stateless", onStateless);
    return () => {
      provider.off("stateless", onStateless);
    };
  }, [collab, collabBranch, collabKey, qc, repo?.id, workingCopyId]);

  /** 进入协作：先跑四步预检，有问题摊开让用户决定，能过就直接连。 */
  const beginCollab = useCallback(() => {
    const result = precheck({
      localBranch,
      docBranch: collabBranch,
      changed: (pendingChanges.data ?? []).length > 0,
      // 缓冲区里没写盘的字 git 看不见，进协作会被共享文本顶掉，也算阻塞。
      unsaved: activeBuffer?.dirty ?? false,
      draftAhead: draftAhead.data ?? 0,
      peers: connectionsFor(activeDocs.data?.documents ?? [], collabKey),
      peersKnown: !(activeDocs.data?.degraded ?? false),
    });
    setPrecheckError(null);
    setCommitMessage(t("code.collab.defaultCommit", { path: activePath ?? "" }));
    // 四步都过就直接连：把"预检通过"也做成一个要点的对话框，只会让人以为有件事没做完。
    if (result.action === "blocked") {
      setPrecheckResult(result);
      return;
    }
    setPrecheckResult(null);
    setMode(transition("disk", "enter"));
  }, [
    activeBuffer?.dirty,
    activeDocs.data,
    activePath,
    pendingChanges.data,
    collabBranch,
    collabKey,
    draftAhead.data,
    localBranch,
    t,
  ]);

  /** 只读观察：连上、能看到别人改什么，但一个字也写不出去。 */
  const observeCollab = useCallback(() => {
    setPrecheckError(null);
    setMode("observe");
  }, []);

  /** 退出协作：live 的内容写回缓冲区标脏，由用户决定要不要落盘。 */
  const leaveCollab = useCallback(() => {
    const text = collab?.text.toString() ?? "";
    if (activePath && text !== "") {
      const saved = buffers[activePath]?.saved ?? "";
      // 改回原样就别标脏：退出协作不该把"没改动"的文件变成"待提交"。
      if (!sameText(text, saved)) edit(activePath, normalizeEol(text));
    }
    setMode(transition(mode, "leave"));
    setCollabSaved(null);
    setPrecheckResult(null);
  }, [activePath, buffers, collab, edit, mode]);

  /** 协作模式下的保存：存成草稿分支的一次提交，不碰工作树。 */
  const saveCollab = useCallback(() => {
    if (!collab || !activePath) return;
    if (collabStatus !== "connected") {
      // 断开时说"已保存"就是骗人：网关根本没收到这条请求。
      setCollabError(t("code.collab.notConnected"));
      return;
    }
    setCollabError(null);
    setCollabSaving(true);
    setCollabSaved(null);
    saveCollabDocument(collab.provider, t("code.collab.saveMessage", { path: activePath }));
  }, [activePath, collab, collabStatus, t]);

  /** 预检对话框里选定的处置。只做当下真能执行的几种。 */
  const resolvePrecheck = useCallback(
    async (resolution: PrecheckResolution) => {
      if (resolution === "observe") {
        observeCollab();
        return;
      }
      if (resolution === "save") {
        setPrecheckBusy(true);
        setPrecheckError(null);
        try {
          setPendingJoin(true);
          setPrecheckResult(null);
          // 缓冲区的内容只有写进磁盘，git 才看得见、提交才带得走。
          await saveActive();
        } catch (err) {
          setPendingJoin(false);
          setPrecheckError(err instanceof Error ? err.message : String(err));
        } finally {
          setPrecheckBusy(false);
        }
        return;
      }
      if (resolution !== "commit") return;

      const paths = (pendingChanges.data ?? []).map((c) => c.path);
      if (!workingCopyId || paths.length === 0) return;
      setPrecheckBusy(true);
      setPrecheckError(null);
      try {
        // 先全部暂存再提交：预检说的是"把本地改动收进提交"，
        // 不替用户挑选文件——挑哪些文件是他的决定，不是这一屏的。
        await stage.mutateAsync({ paths, staged: true });
        await commit.mutateAsync({ message: commitMessage.trim(), amend: false });
        setPrecheckResult(null);
        setMode(transition("disk", "enter"));
      } catch (err) {
        setPrecheckError(err instanceof Error ? err.message : String(err));
      } finally {
        setPrecheckBusy(false);
      }
    },
    [pendingChanges.data, beginCollab, commit, commitMessage, observeCollab, saveActive, stage, workingCopyId],
  );

  const closePrecheck = useCallback(() => {
    setPrecheckResult(null);
    setPrecheckError(null);
    setPendingJoin(false);
  }, []);

  // 写盘落地之后再进：缓冲区干净了才重新判预检，脏着判定只会原地弹回同一个对话框。
  useEffect(() => {
    if (!pendingJoin) return;
    if (activeBuffer?.dirty) return;
    setPendingJoin(false);
    if (conflict !== null) return;
    beginCollab();
  }, [pendingJoin, activeBuffer?.dirty, conflict, beginCollab]);

  /* ---------------------------------------------------------------- */
  /* 发布                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 预览：既是发布确认框的内容，也是"还有几次未发布"的唯一来源。
   *
   * 协作模式下常开并 30 秒重取：徽标上写着的数字错了会让人反复发布，
   * 而这个查询本身只是一次 compare，比读本地引用更准。
   */
  const preview = useDraftPreview(repo?.id ?? null, collabBranch, mode !== "disk", 30_000);

  /**
   * 界面上"还有几次未发布"的唯一来源。
   *
   * 不用 `DraftAhead` 的本地计数：它比的是本地已有的引用，而本地引用可能落后
   * 服务端——别人发布过、我还没 fetch，本地就会一直说"还有 5 次未发布"，
   * 点开预览却只有 2 次。两个数字打架时用户只会信更悲观的那个，然后反复发布。
   *
   * 没有预览数据时（刚进协作、还没打开过对话框）先退回本地计数：那时给出
   * 一个"可能不准"的数字，好过让徽标一直是灰的。
   */
  const pendingSaves = preview.data ? preview.data.commitCount : (draftAhead.data ?? 0);

  /** 打开发布确认框；顺手把默认提交信息填好。 */
  const openPublish = useCallback(() => {
    setPublishError(null);
    setPublished(null);
    setPublishMessage(t("code.collab.publishMessage", { branch: collabBranch }));
    setPublishOpen(true);
  }, [collabBranch, t]);

  const closePublish = useCallback(() => {
    setPublishOpen(false);
    setPublishError(null);
  }, []);

  /**
   * 发布草稿。
   *
   * 发布成功后**不**切回本地模式：用户可能正和别人一起写着，发布只是把攒下的
   * 保存落到正式历史，编辑会话不必为此中断。要停的是"草稿还有 N 次未发布"
   * 那条提示——它靠重取服务端预览来消除。
   */
  const publishDraft = useCallback(async () => {
    if (!repo || publishing) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await publishCollabDraft(repo.id, {
        branch: collabBranch,
        message: publishMessage.trim(),
      });
      setPublished(result);
      // 发布把草稿分支重置到了发布提交：上一次"已存成 b38e3bc4"指向的提交
      // 已经被 squash 掉，继续显示等于告诉用户草稿上还留着那个提交。
      setCollabSaved(null);
      // 草稿分支已被重置：立刻重取预览，界面上的"还有 N 次未发布"才会归零。
      // 等 30 秒的轮询太久——这段时间里用户会以为发布没生效，再点一次。
      await qc.invalidateQueries({ queryKey: collabPublishKeys.preview(repo.id, collabBranch) });
      void qc.invalidateQueries({ queryKey: workingCopyKeys.draftAhead(workingCopyId ?? "", collabBranch) });
      // 目标分支动了：工作副本侧的状态、diff 与真机上的引用都可能变。
      void qc.invalidateQueries({ queryKey: ["working-copy", workingCopyId ?? "", "status"] });
      void qc.invalidateQueries({ queryKey: workingCopyKeys.list });
    } catch (err) {
      // 冲突与权限失败的含义完全不同，不能塌成一句"发布失败"：
      // 前者要人先去解决并行修改，后者是权限不够。
      if (err instanceof CollabPublishError && err.code === "collab_publish_conflict") {
        setPublishError(t("code.collab.publishConflict", { detail: err.detail ?? "" }));
      } else if (err instanceof CollabPublishError && err.code === "collab_publish_no_common_ancestor") {
        setPublishError(t("code.collab.publishNoAncestor"));
      } else {
        setPublishError(
          err instanceof CollabPublishError && err.detail
            ? err.detail
            : err instanceof Error
              ? err.message
              : t("code.collab.publishFailed"),
        );
      }
    } finally {
      setPublishing(false);
    }
  }, [collabBranch, publishMessage, publishing, qc, repo, t, workingCopyId]);

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
    // 远端换了出处时要重新确认：界面得说清"为什么又问一遍"，
    // 否则用户会以为上次点的同意丢了。
    trustOriginChanged: trust.data?.originChanged ?? false,
    trustCurrentOrigin: trust.data?.currentOrigin ?? "",
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

    // 协作：模式、会话与预检。
    //
    // 模式是这三个状态里唯一由用户直接决定的东西（进入/退出）；其余都是它的
    // 派生结果——会话按文档键自动挂载销毁，保存语义由 `saveSemantics` 给出。
    mode,
    beginCollab,
    observeCollab,
    leaveCollab,
    saveCollab,
    collab,
    collabStatus,
    collabError,
    collabSaving,
    collabSaved,
    peers,
    /** 当前共享文本的快照，编辑器挂载与重建实例时用它对齐。 */
    collabText,
    /** 同一分支下各路径的在线人数，供文件树画 live 圆点。 */
    livePaths,
    /** 协作文档挂的分支（仓库默认分支）与它的草稿分支名。 */
    collabBranch,
    collabDraftBranch: collabDraftBranch(collabBranch),
    /**
     * 草稿分支上还有几次未发布的保存。
     *
     * 权威来源是服务端的 compare（`pendingSaves`），本地引用可能落后于它。
     */
    draftAhead: pendingSaves,
    collabReady: Boolean(repo) && activePath != null,
    precheck: precheckResult,
    precheckBusy,
    precheckError,
    commitMessage,
    setCommitMessage,
    resolvePrecheck,
    closePrecheck,
    /** ⌘S 的语义：由模式决定写盘、存草稿，还是什么都不写。 */
    saveMode: saveSemantics(mode),
    writable: mode === "disk" ? true : isWritable(mode),

    // 发布：草稿分支 squash 进目标分支。
    //
    // 与"存草稿"是两件事：存草稿只推进草稿分支，发布才会改正式历史。
    // 因此它有一个自己的确认框，里面摊开待合入的提交数与逐文件增删。
    openPublish,
    closePublish,
    publishOpen,
    publish: publishDraft,
    publishing,
    publishError,
    published,
    publishMessage,
    setPublishMessage,
    /** 草稿分支相对目标分支的待发布内容；没打开对话框时为空。 */
    preview: preview.data ?? emptyPreview(),
    previewLoading: preview.isLoading,
    previewError: preview.error instanceof Error ? preview.error.message : null,
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
          : state.mode === "live"
            ? t("code.collab.saveHint")
            : state.mode === "observe"
              ? t("code.collab.observeHint")
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
              {/* 有人正在这个文件上编辑：文件树里必须看得见，否则会两个人
                  闷头改同一份文件，直到保存时才发现对方也在。 */}
              {!node.isDir && (state.livePaths.get(node.path) ?? 0) > 0 && (
                <span
                  aria-label={t("code.collab.liveDot", { count: state.livePaths.get(node.path) ?? 0 })}
                  title={t("code.collab.liveDot", { count: state.livePaths.get(node.path) ?? 0 })}
                  className="ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-sage)]"
                />
              )}
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
  //
  // 协作的"观察"态同样只读：此时文档真相在别人的 Y.Doc 里，能看不能写。
  const editable = state.trusted && state.writable;
  // 文档真相在哪：disk 在磁盘缓冲区，live/observe 在共享文本里。
  const live = state.mode !== "disk";

  // ⌘S / Ctrl+S 保存。必须显式接管：WebView 的默认行为是弹"另存为"。
  //
  // 按下去做什么由模式决定：本地模式写盘，协作模式存草稿分支，观察模式什么也不做。
  // 同一条快捷键在两种模式下含义不同，所以徽标必须一直看得见。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "s") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      if (state.saveMode === "draft") {
        state.saveCollab();
        return;
      }
      if (state.saveMode === "none") return;
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
    const list = [cursorLineReporter((cursor) => state.setCursorLine(cursor.line))];
    // 行标与 blame 都是"本地文件对 HEAD"的读数：协作时文档真相在共享文本里，
    // 磁盘上那份是旧的，照着它画出来的标记会指着错误的位置，所以只在本地模式挂。
    if (state.mode === "disk") {
      list.push(diffGutter(state.diffSource, diffLabels));
      if (state.blameOn) list.push(blameGutter(state.blameSource, blameLabels));
    }
    // 协作的共享文本与远端光标只在会话活着时挂：会话一销毁，插件也得跟着走，
    // 否则编辑器会继续往一个已经没人同步的 Y.Text 里写。
    if (state.mode !== "disk" && state.collab) list.push(collabEditorExtension(state.collab));
    if (lspExtensions) list.push(...lspExtensions);
    return list;
  }, [
    state.diffSource,
    state.blameSource,
    state.blameOn,
    state.setCursorLine,
    state.mode,
    state.collab,
    diffLabels,
    blameLabels,
    lspExtensions,
  ]);

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
  // 行数跟着文档真相走：协作时缓冲区是旧的，报磁盘那份行数会跟屏幕上差几十行。
  const shown = live ? state.collabText() : content;
  const lines = shown === "" ? [] : shown.split("\n");
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
        {state.mode === "disk" &&
          state.headDiff != null &&
          state.headDiff.added + state.headDiff.removed > 0 && (
          <span className="shrink-0 font-mono text-[10.5px]">
            <span className="text-[var(--color-sage)]">+{state.headDiff.added}</span>{" "}
            <span className="text-[var(--color-rose)]">−{state.headDiff.removed}</span>
          </span>
        )}
        {/* 模式与协作开关：⌘S 在两种模式下含义不同（写盘 / 存草稿），
            所以"现在是什么模式"必须一直看得见，不能藏在菜单里。 */}
        {state.mode === "disk" ? (
          <button
            type="button"
            onClick={state.beginCollab}
            disabled={!state.trusted || !state.collabReady}
            title={
              !state.trusted
                ? t("code.untrustedHint")
                : !state.collabReady
                  ? t("code.collab.noRepository")
                  : t("code.collab.enterHint")
            }
            className={[
              "ml-auto h-[20px] shrink-0 rounded-[5px] border px-1.5 text-[10.5px]",
              state.trusted && state.collabReady
                ? "border-[var(--color-edge-2)] text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]"
                : "border-[var(--color-edge-1)] text-[var(--color-faint)] opacity-50",
            ].join(" ")}
          >
            {t("code.collab.enter")}
          </button>
        ) : (
          <span className="ml-auto flex h-[20px] shrink-0 items-center gap-1.5 rounded-[5px] border border-[var(--color-sky)] px-1.5 text-[10.5px] text-[var(--color-sky)]">
            <span
              aria-hidden
              className={[
                "h-1.5 w-1.5 rounded-full",
                state.mode === "observe"
                  ? "bg-[var(--color-muted-2)]"
                  : state.collabStatus === "connected"
                    ? "bg-[var(--color-sage)]"
                    : "bg-[var(--color-amber)]",
              ].join(" ")}
            />
            {state.mode === "observe" ? t("code.collab.observing") : t("code.collab.live")}
            {state.mode === "live" && state.peers > 0 && (
              <span className="text-[var(--color-muted-2)]">{t("code.collab.peers", { count: state.peers })}</span>
            )}
            <button type="button" onClick={state.leaveCollab} className="text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]">
              {t("code.collab.leave")}
            </button>
          </span>
        )}
        {state.mode === "disk" && (
          <button
            type="button"
            onClick={state.toggleBlame}
            title={t("code.blame.toggleHint")}
            className={[
              "h-[20px] shrink-0 rounded-[5px] border px-1.5 text-[10.5px]",
              state.blameOn
                ? "border-[var(--color-sky)] text-[var(--color-sky)]"
                : "border-[var(--color-edge-2)] text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]",
            ].join(" ")}
          >
            {t("code.blame.toggle")}
          </button>
        )}
        <span className="shrink-0 text-[10.5px] text-[var(--color-faint)]">
          {languageLabel(language, t)}
        </span>
        <span className="shrink-0 text-[10.5px] text-[var(--color-faint)]">
          {t("code.lineCount", { count: lines.length })}
        </span>
        {state.mode === "disk" ? (
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
        ) : (
          // 协作模式的保存是"存成草稿提交"：它不改工作树，所以也不看 dirty。
          <button
            type="button"
            onClick={state.saveCollab}
            disabled={state.mode !== "live" || state.collabSaving}
            title={
              state.mode !== "live"
                ? t("code.collab.observeHint")
                : state.collabStatus === "connected"
                  ? t("code.collab.saveHint")
                  : t("code.collab.notConnected")
            }
            className={[
              "h-[22px] shrink-0 rounded-[7px] border px-2 text-[10.5px]",
              state.mode === "live"
                ? "border-[var(--color-sky)] text-[var(--color-sky)] hover:bg-[rgba(131,169,196,0.12)]"
                : "border-[var(--color-edge-2)] text-[var(--color-bone-2)] opacity-40",
            ].join(" ")}
          >
            {state.collabSaving ? t("code.saving") : t("code.collab.saveDraft")}
          </button>
        )}
        {/* 发布：只有草稿分支上真有未发布的保存时才可用。
            入口常驻在协作模式里，而不是等攒够了才冒出来——用户需要知道
            "我存下的东西现在算在哪儿"。 */}
        {state.mode !== "disk" && (
          <button
            type="button"
            onClick={state.openPublish}
            disabled={!state.collabReady}
            title={
              state.draftAhead > 0
                ? t("code.collab.publishHint", { count: state.draftAhead })
                : t("code.collab.publishEmptyHint")
            }
            className={[
              "h-[22px] shrink-0 rounded-[7px] border px-2 text-[10.5px]",
              state.draftAhead > 0
                ? "border-[var(--color-sage)] text-[var(--color-sage)] hover:bg-[rgba(134,183,158,0.12)]"
                : "border-[var(--color-edge-2)] text-[var(--color-bone-2)] opacity-40",
            ].join(" ")}
          >
            {t("code.collab.publish")}
            {state.draftAhead > 0 && (
              <span className="ml-1 font-mono">{state.draftAhead}</span>
            )}
          </button>
        )}
      </div>

      {/* 协作现状：连接状态、在线人数、保存回执。
          断开时不能说"已保存"——网关根本没收到那条请求。 */}
      <CollabBar state={state} />

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
        {state.file.data !== undefined && live && state.collab === null && (
          <Hint>{t("code.collab.statusConnecting")}</Hint>
        )}
        {state.file.data !== undefined && (!live || state.collab !== null) && (
          <CodeView
            // 换文档模式就换一个新的编辑器实例：yCollab 的同步插件既不会用共享文本
            // 初始化 CodeMirror，也不会把 CodeMirror 写进共享文本。挂载时两边必须已经对齐，
            // 否则磁盘内容会被当成"本地新增"整段插进共享文档。
            key={live ? `collab:${path}` : `disk:${path}`}
            content={live ? state.collabText() : content}
            path={path}
            readOnly={!editable}
            // 协作模式不把编辑写回磁盘缓冲区：写回去就等于承认两份真相，
            // 退出协作时再把共享文本一次性交还缓冲区。
            onChange={live ? undefined : (value) => state.edit(path, value)}
            syncContent={!live}
            className="h-full overflow-auto"
            extensions={editorExtensions}
            // 行号只在它属于当前文件时才生效：符号列表记的是它自己那份文件的行，
            // 切标签之后拿它去跳会落到别的文件上。
            revealLine={state.revealTarget?.path === path ? state.revealTarget.line : undefined}
          />
        )}
      </div>

      {/* 预检对话框：只在按下"进入协作"之后出现，遮蔽整个编辑区——
          预检没过就动文档，等于先改再问。 */}
      <PrecheckDialog state={state} />

      {/* 发布确认框：发布会把草稿压成目标分支上的一次提交，改的是正式历史，
          所以先把"要合进去的是什么"摊开再让人点头。 */}
      <PublishDialog state={state} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 协作状态条与预检对话框                                              */
/* ------------------------------------------------------------------ */

/**
 * 协作的当前交代。
 *
 * 断开不等于退出：编辑还能继续，改动攒在本地 Y.Doc 里，重连后自动合并。
 * 所以断线用琥珀色"离线，改动还在本地"表达，而不是红色错误——
 * 红条会让人以为刚写的东西丢了。
 */
function CollabBar({ state }: { state: CodeState }) {
  const { t } = useTranslation();

  if (state.mode === "disk") return null;

  let text: string;
  let tone = "text-[var(--color-muted-2)]";
  if (state.collabError) {
    text = state.collabError;
    tone = "text-[var(--color-rose)]";
  } else if (state.collabStatus === "error") {
    text = t("code.collab.statusError");
    tone = "text-[var(--color-rose)]";
  } else if (state.collabStatus === "disconnected") {
    text = t("code.collab.statusOffline");
    tone = "text-[var(--color-amber-3)]";
  } else if (state.collabStatus === "connecting") {
    text = t("code.collab.statusConnecting");
  } else {
    text = state.mode === "observe" ? t("code.collab.statusObserving") : t("code.collab.statusLive");
  }

  return (
    <div className="flex h-[24px] shrink-0 items-center gap-2 border-b border-[var(--color-edge-1)] bg-[var(--color-ink-850)] px-3 text-[10.5px]">
      <Icon name="users" size={11} className="shrink-0 text-[var(--color-faint)]" />
      <span className={`truncate ${tone}`}>{text}</span>
      {/* 草稿比本地领先时提醒一句：不阻断，但不说的话发布时会莫名其妙多出几条提交。 */}
      {state.draftAhead > 0 && (
        <span className="shrink-0 text-[var(--color-amber-3)]">
          {t("code.collab.draftPending", { count: state.draftAhead })}
        </span>
      )}
      {/* 保存只落草稿分支：这里把分支名写出来，免得下次打开工作副本面找不到东西。 */}
      <span className="ml-auto shrink-0 font-mono text-[var(--color-faint)]">
        {t("code.collab.draftBranch", { branch: state.collabDraftBranch })}
      </span>
      {state.collabSaved !== null && (
        <span className="shrink-0 text-[var(--color-sage)]">
          {state.collabSaved === ""
            ? t("code.collab.savedNothing")
            : t("code.collab.savedDraft", { commit: state.collabSaved.slice(0, 8) })}
        </span>
      )}
    </div>
  );
}

/**
 * 进入协作前的四步预检（分支对齐 → 本地改动 → 在线草稿 → 在线人数）。
 *
 * 只摆出当下真能执行的处置：把本地改动提交、或只读观察。切分支、stash、
 * 放弃改动在桌面端还没有对应能力，画一个点了没反应的按钮比不给入口更糟，
 * 所以这里只写一句话，让人回工作副本面或本地 git 去处理。
 */
function PrecheckDialog({ state }: { state: CodeState }) {
  const { t } = useTranslation();
  const result = state.precheck;
  if (!result) return null;

  const needsCommit = result.issues.some((i) => i.code === "local-changes");
  const needsBranch = result.issues.some((i) => i.code === "branch-mismatch");
  const needsSave = result.issues.some((i) => i.code === "unsaved-buffer");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(6,9,11,0.62)] p-6">
      <div className="w-[460px] max-w-full rounded-[10px] border border-[var(--color-edge-2)] bg-[var(--color-ink-900)] p-4 shadow-2xl">
        <p className="text-[13px] text-[var(--color-bone)]">{t("code.collab.precheckTitle")}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-muted)]">
          {t("code.collab.precheckHint")}
        </p>

        <ul className="mt-3 space-y-2">
          {result.issues.map((issue) => (
            <li key={issue.code} className="flex items-start gap-2">
              <Icon
                name={
                  issue.code === "branch-mismatch"
                    ? "branch"
                    : issue.code === "local-changes"
                      ? "git-commit"
                      : issue.code === "unsaved-buffer"
                        ? "edit"
                        : issue.code === "draft-ahead"
                          ? "clock"
                          : "users"
                }
                size={12}
                className={`mt-px shrink-0 ${issue.blocking ? "text-[var(--color-amber)]" : "text-[var(--color-muted-2)]"}`}
              />
              <span className="text-[11px] leading-relaxed text-[var(--color-bone-2)]">
                {issue.code === "branch-mismatch" && t("code.collab.issueBranch")}
                {issue.code === "local-changes" && t("code.collab.issueLocal", { count: issue.count ?? 0 })}
                {issue.code === "unsaved-buffer" && t("code.collab.issueUnsaved")}
                {issue.code === "draft-ahead" && t("code.collab.issueDraft", { count: issue.count ?? 0 })}
                {issue.code === "peers-unknown" && t("code.collab.issuePeersUnknown")}
              </span>
            </li>
          ))}
        </ul>

        {needsCommit && (
          <label className="mt-3 block">
            <span className="text-[10.5px] text-[var(--color-faint)]">{t("code.collab.commitMessage")}</span>
            <input
              value={state.commitMessage}
              onChange={(e) => state.setCommitMessage(e.target.value)}
              className="mt-1 h-[26px] w-full rounded-[6px] border border-[var(--color-edge-2)] bg-[var(--color-ink-950)] px-2 text-[11px] text-[var(--color-bone)] outline-none focus:border-[var(--color-amber)]"
            />
          </label>
        )}

        {(needsBranch || needsCommit) && (
          <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--color-faint)]">
            {needsBranch ? t("code.collab.manualBranchHint") : t("code.collab.manualCommitHint")}
          </p>
        )}
        {state.precheckError != null && (
          <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--color-rose)]">{state.precheckError}</p>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={state.closePrecheck}
            className="h-[26px] rounded-[7px] border border-[var(--color-edge-2)] px-2.5 text-[11px] text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]"
          >
            {t("code.collab.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void state.resolvePrecheck("observe")}
            className="h-[26px] rounded-[7px] border border-[var(--color-edge-2)] px-2.5 text-[11px] text-[var(--color-bone-2)] hover:text-[var(--color-bone)]"
          >
            {t("code.collab.observeOnly")}
          </button>
          {needsSave && (
            <button
              type="button"
              disabled={state.precheckBusy}
              onClick={() => void state.resolvePrecheck("save")}
              className="h-[26px] rounded-[7px] border border-[var(--color-amber)] px-2.5 text-[11px] text-[var(--color-amber)] hover:bg-[rgba(242,174,91,0.12)] disabled:opacity-40"
            >
              {state.precheckBusy ? t("code.collab.saving") : t("code.collab.saveAndJoin")}
            </button>
          )}
          {needsCommit && (
            <button
              type="button"
              disabled={state.precheckBusy || state.commitMessage.trim() === ""}
              onClick={() => void state.resolvePrecheck("commit")}
              className="h-[26px] rounded-[7px] border border-[var(--color-amber)] px-2.5 text-[11px] text-[var(--color-amber)] hover:bg-[rgba(232,163,58,0.12)] disabled:opacity-40"
            >
              {state.precheckBusy ? t("code.collab.committing") : t("code.collab.commitAndJoin")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 发布确认框。
 *
 * 桌面端相对 Web 多做的正是这一步：发布前把草稿分支相对目标分支的内容摊开
 * （提交数、逐文件增删）。草稿上可能是别人攒了一下午的保存，squash 进主分支
 * 前看不见内容就是盲签。发布成功后框不自动关——用户需要看到"发布到哪、
 * 落了哪些文件"，那正是这次动作的唯一凭据。
 */
function PublishDialog({ state }: { state: CodeState }) {
  const { t } = useTranslation();
  const preview = state.preview;
  const done = state.published !== null;

  if (!state.publishOpen) return null;

  // 没有待发布内容时不该让"发布"可点：服务端会返回 commit_id=null，
  // 那是一次什么都没发生的往返，而按钮看着像失败了。
  //
  // 但**预览失败时不能锁按钮**：读不出预览是网络或权限问题，不代表草稿是空的。
  // 把两者混成"没东西可发"，用户会以为自己的保存在别处，或者干脆放弃发布。
  const nothingToPublish =
    state.previewError == null &&
    !state.previewLoading &&
    preview.commitCount === 0 &&
    preview.files.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(6,9,11,0.62)] p-6">
      <div className="flex max-h-full w-[520px] max-w-full flex-col rounded-[10px] border border-[var(--color-edge-2)] bg-[var(--color-ink-900)] p-4 shadow-2xl">
        <p className="text-[13px] text-[var(--color-bone)]">{t("code.collab.publishTitle")}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-muted)]">
          {t("code.collab.publishHintDetail", { branch: state.collabBranch })}
        </p>

        {/* 待合入的内容：提交数 + 逐文件增删。 */}
        <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-[7px] border border-[var(--color-edge-1)] bg-[var(--color-ink-950)]">
          {state.previewLoading && (
            <p className="px-3 py-2 text-[11px] text-[var(--color-muted-2)]">
              {t("code.collab.previewLoading")}
            </p>
          )}
          {state.previewError != null && (
            <p className="px-3 py-2 text-[11px] text-[var(--color-rose)]">{state.previewError}</p>
          )}
          {!state.previewLoading && state.previewError == null && preview.missingDraft && (
            <p className="px-3 py-2 text-[11px] leading-relaxed text-[var(--color-muted-2)]">
              {t("code.collab.previewMissingDraft", { draft: state.collabDraftBranch })}
            </p>
          )}
          {!state.previewLoading && state.previewError == null && !preview.missingDraft && (
            <>
              <div className="flex items-center gap-2 border-b border-[var(--color-edge-1)] px-3 py-1.5 text-[10.5px]">
                <span className="text-[var(--color-bone-2)]">
                  {t("code.collab.previewCommits", { count: preview.commitCount })}
                </span>
                <span className="font-mono text-[var(--color-sage)]">+{preview.additions}</span>
                <span className="font-mono text-[var(--color-rose)]">−{preview.deletions}</span>
                <span className="ml-auto text-[var(--color-faint)]">
                  {t("code.collab.previewFiles", { count: preview.files.length })}
                </span>
              </div>
              {preview.files.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-[var(--color-muted-2)]">
                  {t("code.collab.previewEmpty")}
                </p>
              ) : (
                <ul className="divide-y divide-[var(--color-edge-1)]">
                  {preview.files.map((file) => (
                    <li key={file.path} className="flex items-center gap-2 px-3 py-1 text-[10.5px]">
                      <span className="w-3 shrink-0 font-mono text-[var(--color-amber)]">
                        {file.status}
                      </span>
                      <span className="truncate text-[var(--color-bone-2)]">{file.path}</span>
                      <span className="ml-auto shrink-0 font-mono text-[var(--color-sage)]">
                        +{file.additions}
                      </span>
                      <span className="w-8 shrink-0 text-right font-mono text-[var(--color-rose)]">
                        −{file.deletions}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <label className="mt-3 block">
          <span className="text-[10.5px] text-[var(--color-faint)]">
            {t("code.collab.publishCommitMessage")}
          </span>
          <input
            value={state.publishMessage}
            onChange={(e) => state.setPublishMessage(e.target.value)}
            className="mt-1 h-[26px] w-full rounded-[6px] border border-[var(--color-edge-2)] bg-[var(--color-ink-950)] px-2 text-[11px] text-[var(--color-bone)] outline-none focus:border-[var(--color-sage)]"
          />
        </label>

        {state.publishError != null && (
          <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--color-rose)]">
            {state.publishError}
          </p>
        )}
        {done && (
          <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--color-sage)]">
            {state.published?.commitId
              ? t("code.collab.publishDone", {
                  branch: state.published.branch,
                  commit: state.published.commitId.slice(0, 8),
                  count: state.published.paths.length,
                })
              : t("code.collab.publishNothing")}
          </p>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={state.closePublish}
            className="h-[26px] rounded-[7px] border border-[var(--color-edge-2)] px-2.5 text-[11px] text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]"
          >
            {done ? t("code.collab.close") : t("code.collab.cancel")}
          </button>
          {!done && (
            <button
              type="button"
              disabled={state.publishing || nothingToPublish || state.publishMessage.trim() === ""}
              onClick={() => void state.publish()}
              title={nothingToPublish ? t("code.collab.publishEmptyHint") : t("code.collab.publishSubmitHint")}
              className="h-[26px] rounded-[7px] border border-[var(--color-sage)] px-2.5 text-[11px] text-[var(--color-sage)] hover:bg-[rgba(134,183,158,0.12)] disabled:opacity-40"
            >
              {state.publishing ? t("code.collab.publishing") : t("code.collab.publishConfirm", { branch: state.collabBranch })}
            </button>
          )}
        </div>
      </div>
    </div>
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
    // 远端换出处时要说清"为什么又问一遍"：不解释的话，用户会以为上次的
    // 同意丢了，或者干脆把所有仓库都点一遍允许。
    let prompt: string;
    if (state.trustDecided && state.trustOriginChanged) {
      prompt = state.trustCurrentOrigin
        ? t("code.lsp.trustPromptOriginChanged", { origin: state.trustCurrentOrigin })
        : t("code.lsp.trustPromptOriginChangedNoOrigin");
    } else if (detected) {
      prompt = t("code.lsp.trustPrompt");
    } else {
      prompt = t("code.lsp.trustPromptNoLanguage");
    }
    return (
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(19,32,39,0.6),rgba(12,21,26,0.7))] px-3 py-1.5">
        <Icon name="alert" size={12} className="mt-px shrink-0 text-[var(--color-muted-2)]" />
        <span className="min-w-0 text-[10.5px] leading-relaxed text-[var(--color-bone-2)]">
          {prompt}
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

  // 行数与文件事实都以**文档真相**为准：本地模式是缓冲区（用户改了几行就该看到几行），
  // 协作模式是共享文本——磁盘那份是旧的，照着它报行数会跟屏幕上差几十行。
  const content = state.mode === "disk"
    ? (state.activeBuffer?.text ?? normalizeEol(state.file.data?.content ?? ""))
    : state.collabText();
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
