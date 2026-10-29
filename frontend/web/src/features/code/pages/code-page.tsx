import {
  Activity,
  BookOpen,
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code,
  Copy,
  Download,
  Eye,
  File as FileIcon,
  FolderOpen,
  GitBranch,
  GitFork,
  GitPullRequest,
  History,
  MessageSquare,
  Pencil,
  Search,
  Send,
  Settings,
  Star,
  Tag,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { CodeView } from "@/components/editor/code-view";
import { DiffViewer, type DiffPayload } from "@/components/editor/diff-viewer";
import { Lamp, RailBlock, Stage, type DockTab } from "@/components/kit/kit";
import { type CodeFile, type SymbolNode } from "@/features/code/types";
import { api } from "@/lib/api/client";
import { formatRelative } from "@/lib/datetime/format";
import { useApiQuery } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

interface CodePageProps {
  /** 当前查看的文件路径；覆盖 searchParams 的 ?path=。 */
  path?: string;
  /** 文件内容；传入时跳过 blob 请求直接渲染。 */
  content?: string;
  /** 当前提交的差异；存在时以 diff 视图展示。 */
  diff?: DiffPayload;
}

/* ------------------------------------------------------------------ */
/* 后端视图类型（repository_browser_controller 返回体均为 unknown，     */
/* 按控制器/服务层实际字段断言）                                        */
/* ------------------------------------------------------------------ */

/** GET /branches 的列表项（Branch 模型，只取用到的字段）。 */
interface BranchInfo {
  name: string;
  is_default?: boolean;
}

/** GET /tree 的单层条目；接口不递归，子目录展开时再按层拉取。 */
interface TreeEntry {
  name: string;
  type: "tree" | "blob";
  path: string;
  size?: number;
}

interface TreeResponse {
  entries: TreeEntry[];
  is_empty?: boolean;
}

/** GET /blob 的返回体。 */
interface BlobInfo {
  content: string;
  size: number;
  is_binary: boolean;
  language: string | null;
  /** 空仓库（无提交）时为 true。 */
  is_empty?: boolean;
}

/** GET /symbols 的返回体（符号为平铺列表）。 */
interface SymbolsResponse {
  symbols: { name: string; type: string; line: number }[];
}

/** GET /commits 的列表项。 */
interface CommitInfo {
  sha: string;
  message: string;
  author: { name: string; date: string };
}

interface CommitsResponse {
  commits?: CommitInfo[];
}

/** 超过该大小不进 CodeView，提示「文件过大」（blob 接口始终返回全文，这里做浏览器侧兜底）。 */
const MAX_VIEW_BYTES = 1024 * 1024;

async function fetchTree(repoId: string, ref: string, path: string): Promise<TreeResponse> {
  const res = await api.GET("/api/v1/repositories/{repo_id}/tree", {
    params: { path: { repo_id: repoId }, query: { ref, path } },
  });
  if (!res.data) throw new Error(res.error ? JSON.stringify(res.error) : "文件树加载失败");
  return res.data as TreeResponse;
}

/** 后端符号 type → 页面 SymbolNode kind。 */
function toSymbolNode(symbol: { name: string; type: string; line: number }): SymbolNode {
  const kind = symbol.type === "class" ? "class" : symbol.type === "function" ? "fn" : "const";
  return { kind, name: symbol.name, line: symbol.line };
}

/** 字节数转人类可读大小。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let index = -1;
  do {
    value /= 1024;
    index += 1;
  } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(1)} ${units[index]}`;
}

const PANEL_DOCK: DockTab[] = [
  { id: "symbols", icon: BookOpen, label: "符号", kicker: "本文件", ariaLabel: "本文件的符号大纲" },
  { id: "facts", icon: Activity, label: "文件事实", kicker: "本文件", ariaLabel: "文件事实与索引" },
  { id: "agent", icon: Bot, label: "Kustos Agent", kicker: "本文件", ariaLabel: "就这个文件提问" },
];

const QUIET_BTN =
  "text-muted hover:text-bone-2 inline-flex h-[26px] items-center gap-1 rounded px-[7px] text-[10px] transition-colors hover:bg-ink-800/60";

const TAB_BASE =
  "relative inline-flex h-[38px] items-center gap-[7px] px-[11px] text-[12px] font-medium transition-colors";

/**
 * 代码浏览页。
 *
 * 画布是页面本体（文件树 + 代码视图）；符号大纲、文件事实与 Agent
 * 提问浮在画布右缘的 Stage 面板里。数据来自 repository_browser_controller
 * （分支/文件树/blob/符号/提交），当前仓库取自 repo-store；文件选中
 * 状态由 ?path= 驱动，刷新可保留。传入 path/content/diff 时以传入内容覆盖。
 */
export function CodePage({ path, content, diff }: CodePageProps) {
  const { t } = useTranslation();
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const repo = useRepoStore((state) => state.current);
  const [searchParams, setSearchParams] = useSearchParams();

  const [branchOverride, setBranchOverride] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [branchOpen, setBranchOpen] = useState(false);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const repoId = repo?.id ?? "";
  const branch = branchOverride ?? repo?.default_branch ?? "";
  const selectedPath = path ?? searchParams.get("path") ?? "";

  // 切仓库/分支后旧展开路径可能不存在，清空避免残留报错
  useEffect(() => {
    setExpanded(new Set());
  }, [repoId, branch]);

  // 切仓库后旧分支名可能不存在，回落到新仓库默认分支
  useEffect(() => {
    setBranchOverride(null);
  }, [repoId]);

  // 选中文件的祖先目录自动展开，刷新后文件树能揭示 ?path=
  useEffect(() => {
    if (!selectedPath) return;
    const parts = selectedPath.split("/");
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let index = 1; index < parts.length; index += 1) {
        next.add(parts.slice(0, index).join("/"));
      }
      return next;
    });
  }, [selectedPath, setExpanded]);

  useEffect(() => {
    setCrumbs([
      { label: t("nav.code"), to: "/code" },
      ...(repo ? [{ label: repo.path }] : []),
      ...(selectedPath ? [{ label: selectedPath }] : []),
    ]);
  }, [setCrumbs, t, repo, selectedPath]);

  const branchesQuery = useApiQuery<BranchInfo[]>({
    queryKey: ["code", repoId, "branches"],
    enabled: !!repo,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/branches", {
        params: { path: { repo_id: repoId } },
      });
      if (!res.data) throw new Error(res.error ? JSON.stringify(res.error) : "分支列表加载失败");
      return res.data as BranchInfo[];
    },
  });

  const treeQuery = useApiQuery<TreeResponse>({
    queryKey: ["code", repoId, "tree", branch, ""],
    enabled: !!repo,
    queryFn: () => fetchTree(repoId, branch, ""),
  });

  const blobQuery = useApiQuery<BlobInfo>({
    queryKey: ["code", repoId, "blob", branch, selectedPath],
    enabled: !!repo && !!selectedPath && content === undefined,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/blob", {
        params: { path: { repo_id: repoId }, query: { path: selectedPath, ref: branch } },
      });
      if (!res.data) throw new Error(res.error ? JSON.stringify(res.error) : "文件内容加载失败");
      return res.data as BlobInfo;
    },
  });

  const symbolsQuery = useApiQuery<SymbolsResponse>({
    queryKey: ["code", repoId, "symbols", branch, selectedPath],
    enabled: !!repo && !!selectedPath,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/symbols", {
        params: { path: { repo_id: repoId }, query: { path: selectedPath, ref: branch } },
      });
      if (!res.data) throw new Error(res.error ? JSON.stringify(res.error) : "符号加载失败");
      return res.data as SymbolsResponse;
    },
  });

  // 文件的最近提交（commits?path= 只在第一页取第一条）
  const lastCommitQuery = useApiQuery<CommitInfo | null>({
    queryKey: ["code", repoId, "commits", branch, selectedPath],
    enabled: !!repo && !!selectedPath,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/commits", {
        params: { path: { repo_id: repoId }, query: { ref: branch, path: selectedPath, page: 1, per_page: 1 } },
      });
      const payload = res.data as CommitsResponse | undefined;
      return payload?.commits?.[0] ?? null;
    },
  });

  const blob = blobQuery.data;
  // 符号大纲点击后的目标行；切文件即失效，避免滚动到新文件的旧行号
  const [revealLine, setRevealLine] = useState<number | null>(null);
  useEffect(() => {
    setRevealLine(null);
  }, [selectedPath]);

  const file: CodeFile = {
    path: selectedPath,
    lang: blob?.language ?? "",
    size: blob ? formatBytes(blob.size) : "",
    content: content ?? blob?.content ?? "",
    symbols: (symbolsQuery.data?.symbols ?? []).map(toSymbolNode),
    diff,
  };
  const showDiff = diff !== undefined;
  const lineCount = useMemo(() => file.content.split("\n").length, [file.content]);

  /** 仓库没有提交（空仓库）：blob 与根树都会带 is_empty。 */
  const isEmptyRepo = (blob?.is_empty ?? false) || (treeQuery.data?.is_empty ?? false);

  if (!repo) {
    return (
      <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px] pb-20">
        <div className="border-edge-2 flex flex-col items-center gap-2 rounded-[10px] border py-24">
          <p className="text-bone-2 text-[13px] font-medium">还没有仓库</p>
          <p className="text-muted-2 max-w-[42ch] text-center text-[11.5px] leading-relaxed">
            在左侧边栏「新建」创建一个仓库，或用 git push 推送现有仓库，然后回到这里浏览代码。
          </p>
        </div>
      </div>
    );
  }

  const owner = repo.path.split("/")[0] ?? repo.path;
  const branchNames = branchesQuery.data?.map((item) => item.name) ?? [];
  if (branch && !branchNames.includes(branch)) branchNames.push(branch);
  // SSH clone 地址：git@<当前实例主机>:<owner>/<repo>.git
  const cloneUrl = `git@${window.location.host}:${repo.path}.git`;
  const lastCommit = lastCommitQuery.data ?? null;

  const toggleFolder = (dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const selectFile = (nextPath: string) => {
    setSearchParams({ path: nextPath });
  };

  return (
    <Stage
      dock={PANEL_DOCK}
      panel={(tab) => (
        <CodePanel
          tab={tab}
          file={file}
          lastCommit={lastCommit}
          symbolsQuery={symbolsQuery}
          onJumpToLine={setRevealLine}
        />
      )}
      className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px] pb-20"
    >
      {/* 仓库页头 */}
      <header className="border-edge-1 flex items-end justify-between gap-7 border-b pb-5">
        <div className="min-w-0">
          <p className="text-faint text-[10.5px] font-semibold tracking-[0.16em] uppercase">
            {owner} <span className="px-0.5">/</span> {repo.name}
          </p>
          <div className="mt-[7px] flex items-center gap-2.5">
            <h1 className="font-display text-bone text-[clamp(1.75rem,2.5vw,2.3rem)] leading-none font-medium tracking-tight">
              {repo.name}
            </h1>
            <span className="border-edge-2 text-muted inline-flex h-[19px] items-center rounded-full border px-[7px] text-[10px] font-medium">
              {repo.is_public ? "Public" : "Private"}
            </span>
          </div>
          {repo.description ? <p className="text-muted mt-[9px] text-[13.5px]">{repo.description}</p> : null}
          <p className="text-muted-2 mt-[7px] flex flex-wrap items-center gap-1.5 text-[10.5px]">
            <span>
              默认分支 <span className="font-mono">{repo.default_branch}</span>
            </span>
          </p>
        </div>
        <div className="flex flex-none items-center gap-[5px] pb-[3px]">
          <RepoStat icon={Star} value={repo.star_count} label="Stars" onClick={() => toast.info("Star 按仓库统计。")} />
          <RepoStat icon={GitFork} value={repo.fork_count} label="Forks" onClick={() => toast.info("Fork 按仓库统计。")} />
          <RepoStat icon={Eye} value={repo.watch_count} label="Watch" onClick={() => toast.info("订阅设置按用户生效。")} />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(cloneUrl);
              toast.info("Clone 地址已复制。");
            }}
            className="border-edge-2 bg-ink-750/55 hover:border-edge-3 hover:bg-ink-750 text-bone-2 ml-1 inline-flex h-[27px] items-center gap-[7px] rounded-md border px-2.5 text-[11px] font-medium transition-colors"
          >
            <Copy className="size-3" aria-hidden="true" />
            Clone
          </button>
        </div>
      </header>

      {/* 仓库标签页 */}
      <nav className="border-edge-1 mt-0.5 flex items-center gap-0.5 border-b" aria-label="仓库">
        <span aria-current="page" className={cn(TAB_BASE, "text-bone after:absolute after:right-2 after:bottom-[-1px] after:left-2 after:h-0.5 after:rounded-full after:bg-amber after:shadow-[0_0_10px_rgba(242,174,91,0.35)]")}>
          <Code className="size-[13px] text-amber" aria-hidden="true" />
          {t("nav.code")}
        </span>
        <Link to="/pull-requests" className={cn(TAB_BASE, "text-muted hover:bg-ink-800/35 hover:text-bone")}>
          <GitPullRequest className="size-[13px]" aria-hidden="true" />
          {t("nav.pullRequests")}
        </Link>
        <Link to="/issues" className={cn(TAB_BASE, "text-muted hover:bg-ink-800/35 hover:text-bone")}>
          <CircleDot className="size-[13px]" aria-hidden="true" />
          {t("nav.issues")}
        </Link>
        <Link to="/releases" className={cn(TAB_BASE, "text-muted hover:bg-ink-800/35 hover:text-bone")}>
          Releases
        </Link>
        <Link to="/chat" className={cn(TAB_BASE, "text-muted hover:bg-ink-800/35 hover:text-bone")}>
          <MessageSquare className="size-[13px]" aria-hidden="true" />
          {t("nav.chat")}
        </Link>
        <button type="button" onClick={() => toast.info("仓库设置需要 repo:admin 权限。")} className={cn(TAB_BASE, "text-muted hover:bg-ink-800/35 hover:text-bone")}>
          <Settings className="size-[13px]" aria-hidden="true" />
          设置
        </button>
      </nav>

      {/* 工具条：分支 / 路径 / 查找 */}
      <div className="border-edge-1 flex items-center gap-2.5 border-b py-[11px]">
        <div className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={branchOpen}
            onClick={() => setBranchOpen((open) => !open)}
            className="border-edge-2 bg-ink-900/70 hover:border-edge-3 hover:bg-ink-800 text-bone-2 inline-flex h-[30px] items-center gap-[7px] rounded-md border px-2.5 font-mono text-[10.5px] transition-colors"
          >
            <GitBranch className="size-[13px] text-amber" aria-hidden="true" />
            {branch}
            <ChevronDown className="text-muted-2 size-3" aria-hidden="true" />
          </button>
          {branchOpen ? (
            <>
              <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setBranchOpen(false)} />
              <div role="menu" className="border-edge-2 bg-ink-850 absolute top-[calc(100%+7px)] left-0 z-50 w-[238px] rounded-[10px] border p-[5px] shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
                <p className="text-muted-2 px-2 pt-1.5 pb-1 text-[9px] font-semibold tracking-[0.13em] uppercase">{t("code.branches")}</p>
                {branchesQuery.isPending ? (
                  <p className="text-muted-2 px-2 py-1.5 text-[10.5px]">加载中…</p>
                ) : branchesQuery.error ? (
                  <button
                    type="button"
                    onClick={() => void branchesQuery.refetch()}
                    className="text-muted-2 hover:text-amber-2 w-full rounded-[5px] px-[9px] py-[7px] text-left text-[11px] transition-colors hover:underline"
                  >
                    分支列表加载失败，点击重试
                  </button>
                ) : branchNames.length === 0 ? (
                  <p className="text-muted-2 px-2 py-1.5 text-[10.5px]">这个仓库还没有分支。</p>
                ) : (
                  branchNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setBranchOverride(name);
                        setBranchOpen(false);
                        toast.info(`正在查看 ${name}。`);
                      }}
                      className={cn(
                        "flex w-full items-center gap-[9px] rounded-[5px] px-[9px] py-[7px] text-left text-[11.5px] transition-colors",
                        name === branch ? "bg-ink-800/70 text-bone" : "text-bone-2 hover:bg-ink-800/70 hover:text-bone",
                      )}
                    >
                      <span className="truncate font-mono text-[10.5px]">{name}</span>
                      {name === repo.default_branch ? <span className="text-faint ml-auto font-mono text-[9px]">默认</span> : null}
                    </button>
                  ))
                )}
              </div>
            </>
          ) : null}
        </div>

        <div className="text-muted-2 flex min-w-0 items-center gap-1 overflow-hidden font-mono text-[10.5px] whitespace-nowrap" aria-label="文件路径">
          {(selectedPath || repo.path).split("/").map((part, index, parts) => (
            <span key={index} className={cn(index === parts.length - 1 && "text-bone-2")}>
              {index > 0 ? <span className="text-faint px-0.5">/</span> : null}
              {part}
            </span>
          ))}
        </div>

        <button
          type="button"
          onClick={() => filterRef.current?.focus()}
          className="text-muted hover:text-bone-2 ml-auto inline-flex h-[27px] items-center gap-1.5 rounded-md px-2 text-[10.5px] transition-colors hover:bg-ink-800/60"
        >
          <Search className="size-3" aria-hidden="true" />
          {t("code.findFile")}
        </button>
        <button
          type="button"
          aria-label={t("code.copyPath")}
          onClick={() => {
            void navigator.clipboard?.writeText(selectedPath);
            toast.info("文件路径已复制。");
          }}
          className="text-muted-2 hover:text-bone grid size-[30px] place-items-center rounded-md transition-colors hover:bg-ink-800"
        >
          <Copy className="size-[13px]" aria-hidden="true" />
        </button>
      </div>

      {/* 画布：文件树 + 代码视图 */}
      <div className="border-edge-2 bg-ink-900/70 mt-4 grid h-[calc(100vh-368px)] min-h-[560px] grid-cols-[232px_minmax(0,1fr)] overflow-hidden rounded-[10px] border">
        <aside className="border-edge-1 bg-[rgba(10,18,22,0.6)] flex min-h-0 flex-col overflow-auto border-r" aria-label={t("code.fileTree")}>
          <div className="border-edge-1 bg-ink-900 sticky top-0 z-[2] border-b p-[9px]">
            <div className="border-edge-2 bg-ink-950/60 focus-within:border-amber/40 flex h-[29px] items-center gap-1.5 rounded-md border px-2 transition-colors">
              <Search className="text-muted-2 size-[13px]" aria-hidden="true" />
              <input
                ref={filterRef}
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="过滤文件…"
                aria-label="过滤文件"
                autoComplete="off"
                className="text-bone min-w-0 flex-1 bg-transparent text-[10.5px] outline-none placeholder:text-muted-2"
              />
            </div>
          </div>
          <div className="flex-1 px-[5px] pt-[7px] pb-3">
            {treeQuery.isPending ? (
              <p className="text-muted-2 px-[7px] py-1 text-[10.5px]">加载中…</p>
            ) : treeQuery.error || !treeQuery.data ? (
              <button
                type="button"
                onClick={() => void treeQuery.refetch()}
                className="text-muted-2 hover:text-amber-2 w-full rounded px-[7px] py-1 text-left text-[10.5px] transition-colors hover:underline"
              >
                文件树加载失败，点击重试
              </button>
            ) : isEmptyRepo ? (
              <p className="text-muted-2 px-[7px] py-1 text-[10.5px]">仓库还没有提交。</p>
            ) : (
              <FileTreeRows
                entries={treeQuery.data.entries}
                repoId={repoId}
                branch={branch}
                expanded={expanded}
                currentPath={selectedPath}
                onToggleFolder={toggleFolder}
                onSelect={selectFile}
                query={filter.trim().toLowerCase()}
              />
            )}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="border-edge-1 bg-ink-850/50 flex flex-none flex-wrap items-center justify-between gap-2 border-b px-[13px] py-2.5">
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="text-bone-2 truncate font-mono text-[12px]">{selectedPath || repo.path}</span>
              <span className="text-muted-2 text-[10.5px]">
                {showDiff && file.diff
                  ? `+${file.diff.stats.additions} −${file.diff.stats.deletions} · ${file.diff.stats.files_changed} 个文件`
                  : selectedPath
                    ? `${lineCount} 行 · ${file.lang || "文本"}`
                    : "从左侧文件树选择一个文件。"}
              </span>
            </div>
            <div className="flex flex-none items-center gap-px">
              <button type="button" className={QUIET_BTN} onClick={() => toast.info("Web 编辑接口尚未提供。")}>
                <Pencil className="size-3" aria-hidden="true" />
                编辑
              </button>
              <button type="button" className={QUIET_BTN} onClick={() => toast.info("提交历史入口暂未提供。")}>
                <History className="size-3" aria-hidden="true" />
                {t("code.history")}
              </button>
              <button type="button" className={QUIET_BTN} onClick={() => toast.info("Blame 入口暂未提供。")}>
                <Eye className="size-3" aria-hidden="true" />
                {t("code.blame")}
              </button>
              <button
                type="button"
                className={QUIET_BTN}
                onClick={() => {
                  void navigator.clipboard?.writeText(file.content);
                  toast.info("原始内容已复制。");
                }}
              >
                <Download className="size-3" aria-hidden="true" />
                {t("code.raw")}
              </button>
            </div>
          </div>

          {showDiff && file.diff ? (
            <div className="bg-ink-950 min-h-0 flex-1 overflow-auto p-3">
              <DiffViewer payload={file.diff} />
            </div>
          ) : !selectedPath ? (
            <p className="text-muted-2 grid min-h-0 flex-1 place-items-center text-[12px]">从左侧文件树选择一个文件。</p>
          ) : blobQuery.isPending ? (
            <p className="text-muted-2 grid min-h-0 flex-1 place-items-center text-[12px]">正在加载文件…</p>
          ) : blobQuery.error || !blob ? (
            <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
              <p className="text-muted text-[12.5px]">文件内容加载失败：{blobQuery.error?.message}</p>
              <button
                type="button"
                onClick={() => void blobQuery.refetch()}
                className="border-edge-2 bg-ink-750/55 hover:border-edge-3 hover:bg-ink-750 text-bone-2 inline-flex h-[27px] items-center rounded-md border px-2.5 text-[11px] font-medium transition-colors"
              >
                重试
              </button>
            </div>
          ) : isEmptyRepo ? (
            <p className="text-muted-2 grid min-h-0 flex-1 place-items-center text-[12px]">仓库还没有提交。</p>
          ) : blob.is_binary ? (
            <p className="text-muted-2 grid min-h-0 flex-1 place-items-center text-[12px]">{t("code.binaryFile")}</p>
          ) : blob.size > MAX_VIEW_BYTES ? (
            <p className="text-muted-2 grid min-h-0 flex-1 place-items-center text-[12px]">{t("code.tooLarge")}</p>
          ) : (
            <CodeView
              content={file.content}
              path={file.path}
              className="min-h-0 flex-1"
              revealLine={revealLine ?? undefined}
            />
          )}

          <div className="border-edge-1 text-faint flex flex-none items-center gap-3.5 border-t px-3 py-2 font-mono text-[10px] tracking-[0.02em]">
            <span>UTF-8</span>
            <span>LF</span>
            <span>{file.lang}</span>
            <span className="ml-auto">{file.size}</span>
          </div>
        </div>
      </div>
    </Stage>
  );
}

/** 页头的仓库统计小按钮（Stars / Forks / Watch）。 */
function RepoStat({ icon: Icon, value, label, onClick }: { icon: LucideIcon; value: number; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="border-edge-1 text-muted hover:border-edge-2 hover:bg-ink-800/40 hover:text-bone-2 inline-flex h-[27px] items-center gap-[5px] rounded-md border px-[7px] text-[10.5px] transition-colors"
    >
      <Icon className="text-muted-2 size-3" aria-hidden="true" />
      <span className="font-mono">{value}</span>
    </button>
  );
}

interface FileTreeRowsProps {
  entries: TreeEntry[];
  repoId: string;
  branch: string;
  /** 已展开的目录路径集合；折叠状态存在页面层，切文件不丢失。 */
  expanded: Set<string>;
  currentPath: string;
  /** 过滤词（小写）；只作用于已加载的层级。 */
  query: string;
  onToggleFolder: (dirPath: string) => void;
  onSelect: (path: string) => void;
}

/**
 * 递归渲染文件树行。
 *
 * 后端 /tree 只返回单层，展开目录时由 FolderChildren 按层懒加载；
 * 过滤在每层内按名称匹配。
 */
function FileTreeRows({ entries, repoId, branch, expanded, currentPath, query, onToggleFolder, onSelect }: FileTreeRowsProps) {
  const visible = query ? entries.filter((entry) => entry.name.toLowerCase().includes(query)) : entries;

  return (
    <>
      {visible.map((entry) => {
        if (entry.type === "tree") {
          const isExpanded = expanded.has(entry.path);
          return (
            <Fragment key={entry.path}>
              <button
                type="button"
                aria-expanded={isExpanded}
                onClick={() => onToggleFolder(entry.path)}
                className="text-bone-2 hover:bg-ink-800/50 hover:text-bone flex h-[27px] w-full items-center gap-1.5 rounded px-[7px] text-left text-[11.5px] font-medium transition-colors"
              >
                <ChevronRight className={cn("text-faint size-3 shrink-0 transition-transform", isExpanded && "rotate-90")} aria-hidden="true" />
                <FolderOpen className="text-muted-2 size-[13px] shrink-0" aria-hidden="true" />
                <span className="truncate">{entry.name}</span>
              </button>
              {isExpanded ? (
                <div className="border-edge-1 ml-3 border-l pl-[7px]">
                  <FolderChildren
                    repoId={repoId}
                    branch={branch}
                    dirPath={entry.path}
                    expanded={expanded}
                    currentPath={currentPath}
                    query={query}
                    onToggleFolder={onToggleFolder}
                    onSelect={onSelect}
                  />
                </div>
              ) : null}
            </Fragment>
          );
        }

        const active = entry.path === currentPath;
        return (
          <button
            key={entry.path}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(entry.path)}
            className={cn(
              "flex h-[27px] w-full items-center gap-1.5 rounded px-[7px] text-left text-[11.5px] transition-colors",
              active ? "bg-amber/10 text-amber-2" : "text-muted hover:bg-ink-800/50 hover:text-bone-2",
            )}
          >
            <FileIcon className={cn("size-[13px] shrink-0", active ? "text-amber" : "text-muted-2")} aria-hidden="true" />
            <span className="truncate">{entry.path.split("/").pop()}</span>
          </button>
        );
      })}
    </>
  );
}

/** 单个展开目录的子层内容：懒加载 + 按层缓存（queryKey 含目录路径）。 */
function FolderChildren({
  repoId,
  branch,
  dirPath,
  expanded,
  currentPath,
  query,
  onToggleFolder,
  onSelect,
}: Omit<FileTreeRowsProps, "entries"> & { dirPath: string }) {
  const dirQuery = useApiQuery<TreeResponse>({
    queryKey: ["code", repoId, "tree", branch, dirPath],
    queryFn: () => fetchTree(repoId, branch, dirPath),
  });

  if (dirQuery.isPending) return <p className="text-muted-2 px-[7px] py-1 text-[10.5px]">加载中…</p>;
  if (dirQuery.error || !dirQuery.data) {
    return (
      <button
        type="button"
        onClick={() => void dirQuery.refetch()}
        className="text-muted-2 hover:text-amber-2 w-full rounded px-[7px] py-1 text-left text-[10.5px] transition-colors hover:underline"
      >
        加载失败，点击重试
      </button>
    );
  }

  return (
    <FileTreeRows
      entries={dirQuery.data.entries}
      repoId={repoId}
      branch={branch}
      expanded={expanded}
      currentPath={currentPath}
      query={query}
      onToggleFolder={onToggleFolder}
      onSelect={onSelect}
    />
  );
}

interface CodePanelProps {
  tab: DockTab;
  file: CodeFile;
  lastCommit: CommitInfo | null;
  symbolsQuery: ReturnType<typeof useApiQuery<SymbolsResponse>>;
  /** 符号点击后滚动到对应行。 */
  onJumpToLine: (line: number) => void;
}

/** Stage 右缘面板：符号大纲 / 文件事实 / Agent 提问。 */
function CodePanel({ tab, file, lastCommit, symbolsQuery, onJumpToLine }: CodePanelProps) {
  if (tab.id === "facts") return <FactsPane file={file} lastCommit={lastCommit} />;
  if (tab.id === "agent") return <AgentPane path={file.path} />;
  return <SymbolsPane file={file} symbolsQuery={symbolsQuery} onJump={onJumpToLine} />;
}

/** 符号面板：本文件的符号大纲。 */
function SymbolsPane({
  file,
  symbolsQuery,
  onJump,
}: {
  file: CodeFile;
  symbolsQuery: ReturnType<typeof useApiQuery<SymbolsResponse>>;
  onJump: (line: number) => void;
}) {
  const jump = (node: SymbolNode) => onJump(node.line);

  return (
    <RailBlock>
      <div className="mb-2.5 flex items-center gap-[9px]">
        <h3 className="text-muted-2 text-[10px] font-semibold tracking-[0.15em] uppercase">符号大纲</h3>
        <span className="rounded-full bg-bone/[0.06] px-1.5 font-mono text-[10px] leading-[15px] text-muted-2">{file.symbols.length}</span>
      </div>
      {!file.path ? (
        <p className="text-muted-2 text-[11px]">先在文件树里选择一个文件。</p>
      ) : symbolsQuery.isPending ? (
        <p className="text-muted-2 text-[11px]">正在提取符号…</p>
      ) : symbolsQuery.error ? (
        <button
          type="button"
          onClick={() => void symbolsQuery.refetch()}
          className="text-muted-2 hover:text-amber-2 text-[11px] transition-colors hover:underline"
        >
          符号加载失败，点击重试
        </button>
      ) : file.symbols.length === 0 ? (
        <p className="text-muted-2 text-[11px]">这个文件没有可识别的符号。</p>
      ) : (
        <div className="flex flex-col gap-[3px]">
          {file.symbols.map((node) => (
            <SymbolNodeRow key={`${node.name}-${node.line}`} node={node} onJump={jump} />
          ))}
        </div>
      )}
    </RailBlock>
  );
}

/** 符号树行：类带轻微底色与子级缩进，函数/常量平铺。 */
function SymbolNodeRow({ node, onJump }: { node: SymbolNode; onJump: (node: SymbolNode) => void }) {
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => onJump(node)}
        className={cn(
          "flex h-6 w-full items-center gap-[7px] rounded px-1.5 text-left transition-colors hover:bg-ink-800/55 hover:text-bone-2",
          node.kind === "class" ? "bg-bone/[0.03] text-bone-2" : "text-muted",
        )}
      >
        {node.kind === "class" ? (
          <BookOpen className="size-3 shrink-0 text-amber-3" aria-hidden="true" />
        ) : node.kind === "const" ? (
          <Tag className="text-faint size-3 shrink-0" aria-hidden="true" />
        ) : (
          <Braces className="text-faint size-3 shrink-0" aria-hidden="true" />
        )}
        <span className={cn("truncate font-mono", node.kind === "class" ? "text-[11px] font-medium" : "text-[10px]")}>{node.name}</span>
        <span className="text-faint ml-auto font-mono text-[10px]">{node.line}</span>
      </button>
      {node.children?.length ? (
        <div className="border-edge-2 ml-[10px] flex flex-col gap-px border-l pb-1 pl-[9px]">
          {node.children.map((child) => (
            <SymbolNodeRow key={`${child.name}-${child.line}`} node={child} onJump={onJump} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 文件事实面板：最近提交（commits?path=）+ 语言/大小（blob）。 */
function FactsPane({ file, lastCommit }: { file: CodeFile; lastCommit: CommitInfo | null }) {
  const provenance = [
    {
      key: "最近变更",
      value: lastCommit ? (
        <>
          <span className="font-mono">{lastCommit.sha.slice(0, 7)}</span> · {formatRelative(lastCommit.author?.date)}
          <br />
          {lastCommit.message.split("\n")[0]}
        </>
      ) : (
        "—"
      ),
    },
    { key: "作者", value: lastCommit?.author?.name ?? "—" },
    { key: "语言", value: file.lang || "—" },
    { key: "大小", value: file.size || "—" },
  ];

  return (
    <RailBlock title="来源">
      <dl>
        {provenance.map((item) => (
          <div key={item.key} className="border-edge-1 border-t py-[7px] first:border-t-0 first:pt-0">
            <dt className="text-faint text-[9.5px] font-semibold tracking-[0.12em] uppercase">{item.key}</dt>
            <dd className="text-bone-2 mt-0.5 text-[11.5px] leading-[1.45]">{item.value}</dd>
          </div>
        ))}
      </dl>
    </RailBlock>
  );
}

/**
 * Agent 面板：就当前文件发起一次 Agent 运行。
 *
 * 仓库问答没有独立端点，创建走 agent_controller 的作业接口；作业的推进、
 * 工具轨迹与写工具审批都在 Agent 控制台承载，这里只负责发起并跳过去。
 */
function AgentPane({ path }: { path: string }) {
  const repo = useRepoStore((state) => state.current);
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState(`解释 ${path} 的职责、调用方与关键实现。`);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const text = prompt.trim();
    if (!repo || !text || pending) return;
    setPending(true);
    try {
      const res = await api.POST("/api/v1/repositories/{repo_id}/agent/jobs", {
        params: { path: { repo_id: repo.id } },
        body: { prompt: text, model: null },
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail ?? "创建 Agent 运行失败。";
        throw new Error(detail);
      }
      const job = res.data as { id?: string } | undefined;
      toast.success("已创建 Agent 运行，正在打开控制台。");
      navigate(job?.id ? `/agent?job=${job.id}` : "/agent");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建 Agent 运行失败。");
    } finally {
      setPending(false);
    }
  };

  return (
    <RailBlock>
      <div className="flex items-center gap-2">
        <span className="border-amber/30 bg-amber/10 text-amber grid size-[25px] shrink-0 place-items-center rounded-full border" aria-hidden="true">
          <Bot className="size-[13px]" />
        </span>
        <div className="min-w-0">
          <strong className="text-bone-2 block text-[11.5px] font-semibold leading-tight">Kustos Agent</strong>
          <span className="text-muted-2 block text-[10px]">
            {repo ? `在 ${repo.path} 上运行` : "尚未选择仓库"}
          </span>
        </div>
        <Lamp tone={pending ? "warn" : "neutral"} live={pending} className="ml-auto" />
      </div>
      <form
        className="mt-2.5 flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          rows={3}
          aria-label="就这个文件提问"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={`就 ${path} 提问…`}
          className="border-edge-2 bg-ink-900/70 text-bone focus:border-amber/40 min-h-[58px] resize-none rounded-md border p-2 text-[10.5px] outline-none transition-colors placeholder:text-muted-2"
        />
        <button
          type="submit"
          disabled={!repo || !prompt.trim() || pending}
          className="bg-amber border-amber hover:bg-amber-2 hover:border-amber-2 inline-flex h-[27px] items-center justify-center gap-[7px] rounded-md border px-2.5 text-[10.5px] font-semibold text-ink-950 transition-colors disabled:pointer-events-none disabled:opacity-60"
        >
          <Send className="size-3" aria-hidden="true" />
          {pending ? "正在创建…" : "询问 Kustos"}
        </button>
      </form>
      <div className="border-edge-1 mt-2.5 flex flex-col gap-1.5 border-t pt-2.5">
        <p className="text-muted-2 text-[10px] leading-[1.5]">
          运行会在 Agent 控制台继续，工具轨迹与审批都在那边。
        </p>
      </div>
      <p className="text-muted-2 mt-3 text-[10px] leading-[1.5]">写入类工具会暂停等待审批；批准前该面板只读。</p>
    </RailBlock>
  );
}
