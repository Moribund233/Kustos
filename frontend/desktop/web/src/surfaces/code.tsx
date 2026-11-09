import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/shell/icon";
import { CodeView } from "@kustos/editor";
import {
  languageLabel,
  languageOf,
  pathSegments,
  useDirectory,
  useFileContent,
  type TreeNode,
} from "@/lib/code";
import { useWorkingCopies, type WorkingCopy } from "@/lib/working-copy";

/**
 * Code 面：文件树 + 标签页 + 只读代码视图。
 *
 * 结构对齐原型 `docs/prototype/desktop/editor.html`：
 *
 *   listcol
 *   ├ list-head（标题 + 仓库路径 + 分段）
 *   └ tree（可展开的目录，每行带变更状态标记）
 *   detail
 *   ├ tabs（打开的标签页）
 *   ├ ed-bar（面包屑 + 语言 + 行数）
 *   └ code（行号 + 源码，等宽）
 *
 * 这一版是**只读查看器**。可编辑 + LSP + 模式徽标属于后续里程碑
 * （设计文档把 `code-view.tsx` 明确定位为"只读查看器"）。
 * 先把"能读懂一个仓库"这件事做扎实，比先塞一个半成品编辑器有用。
 */

export interface OpenTab {
  path: string;
  name: string;
}

export interface CodeParts {
  list: React.ReactNode;
  detail: React.ReactNode;
  inspector?: React.ReactNode;
  statusLeft: React.ReactNode;
  statusRight: React.ReactNode;
}

/** 汇总 Code 面的状态；由外层装配进 Shell。 */
export function useCodeSurface() {
  const copies = useWorkingCopies();
  const list = copies.data ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const active: WorkingCopy | null = list.find((c) => c.id === activeId) ?? list[0] ?? null;

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  const openFile = useCallback((node: TreeNode) => {
    setTabs((prev) => {
      if (prev.some((t) => t.path === node.path)) return prev;
      return [...prev, { path: node.path, name: node.name }];
    });
    setActivePath(node.path);
  }, []);

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

  const file = useFileContent(active?.id ?? null, activePath);

  return {
    copies: list,
    active,
    setActiveId: (id: string) => {
      setActiveId(id);
      setExpanded(new Set());
      setTabs([]);
      setActivePath(null);
    },
    expanded,
    toggleDir,
    openFile,
    tabs,
    closeTab,
    activePath,
    setActivePath,
    file,
  };
}

type CodeState = ReturnType<typeof useCodeSurface>;

/* ------------------------------------------------------------------ */
/* 左栏：文件树                                                        */
/* ------------------------------------------------------------------ */

export function CodeTree({ state }: { state: CodeState }) {
  const { t } = useTranslation();
  const id = state.active?.id ?? null;

  return (
    <section className="flex h-full flex-col" aria-label={t("code.fileTree")}>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <h1 className="text-[13px] font-medium text-[var(--color-bone)]">{t("code.title")}</h1>
          <span className="ml-auto truncate font-mono text-[10.5px] text-[var(--color-faint)]">
            {state.active ? baseName(state.active.path) : "—"}
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
                {baseName(c.path)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {!id && <Hint>{t("code.noRepository")}</Hint>}
        {id && (
          <TreeLevel
            workingCopyId={id}
            path=""
            depth={0}
            state={state}
          />
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--color-edge-1)] px-3 py-1.5 text-[10px] text-[var(--color-faint)]">
        {t("code.readOnlyHint")}
      </div>
    </section>
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
  const dir = useDirectory(workingCopyId, path);

  if (dir.isLoading) {
    return <Hint>{""}</Hint>;
  }
  if (dir.error != null) {
    return (
      <p className="px-3 py-1 text-[10.5px] text-[var(--color-rose)]">
        {dir.error instanceof Error ? dir.error.message : "读取失败"}
      </p>
    );
  }

  const nodes = dir.data ?? [];
  if (nodes.length === 0 && depth === 0) {
    return <Hint>这个仓库是空的。</Hint>;
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
  const content = state.file.data ?? "";
  const lines = content === "" ? [] : content.split("\n");
  // 文件末尾的换行会产生一个空行，界面上多一个空行号没有意义。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return (
    <>
      <div className="flex shrink-0 items-stretch overflow-auto border-b border-[var(--color-edge-1)] bg-[var(--color-ink-900)]">
        {state.tabs.map((tab) => {
          const on = tab.path === path;
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
                className="max-w-[180px] truncate"
              >
                {tab.name}
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

      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--color-edge-1)] bg-[var(--color-ink-950)] px-2.5">
        <Breadcrumb path={path} />
        <span className="ml-auto shrink-0 text-[10.5px] text-[var(--color-faint)]">
          {languageLabel(language)}
        </span>
        {state.file.data !== undefined && (
          <span className="shrink-0 text-[10.5px] text-[var(--color-faint)]">
            {t("code.lineCount", { count: lines.length })}
          </span>
        )}
      </div>

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
            content={state.file.data}
            path={path}
            readOnly
            className="h-full overflow-auto"
          />
        )}
      </div>
    </>
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

/** 详情右侧的事实面板。 */
export function CodeInspector({ state }: { state: CodeState }) {
  const { t } = useTranslation();
  const path = state.activePath ?? state.tabs[0]?.path ?? null;
  const node = useMemo(() => {
    if (!path) return null;
    return { path, language: languageOf(path) };
  }, [path]);

  const content = state.file.data ?? "";
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
          <KV k={t("code.inspector.language")} v={languageLabel(node?.language ?? "")} />
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

/** 取路径最后一段作为显示名（Windows 与 POSIX 分隔符都处理）。 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}




