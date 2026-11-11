import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { WorkingCopyService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import type {
  BufferDraft,
  CodeLayout,
  FileText,
  TreeNode,
} from "@/bindings/github.com/kustos/kustos-desktop/internal/services/models";

/**
 * Code 面的数据层。
 *
 * 全部走本地系统 git + 文件系统，**不经过网络**：读自己的工作树不需要联网，
 * 这也是桌面端相对 Web 的核心优势之一。
 *
 * 路径一律是**相对仓库根**的斜杠路径。Go 侧会把它收敛在仓库内，
 * 越界路径直接拒绝——前端不承担这个校验责任，但也不该拼绝对路径。
 */

export const codeKeys = {
  tree: (id: string, path: string) => ["code", id, "tree", path] as const,
  file: (id: string, path: string) => ["code", id, "file", path] as const,
  text: (id: string, path: string) => ["code", id, "text", path] as const,
  changes: (id: string) => ["code", id, "changes"] as const,
  search: (id: string, query: string) => ["code", id, "search", query] as const,
  drafts: (id: string) => ["code", id, "drafts"] as const,
  layout: ["code", "layout"] as const,
};

/** 列举某一层目录。 */
export function useDirectory(workingCopyId: string | null, path: string, enabled = true) {
  return useQuery({
    queryKey: codeKeys.tree(workingCopyId ?? "", path),
    queryFn: async () => (await WorkingCopyService.ListTree(workingCopyId as string, path)) ?? [],
    enabled: Boolean(workingCopyId) && enabled,
    // 目录内容只随本机改动变化；工作区变动由显式刷新驱动。
    staleTime: 10_000,
  });
}

/** 变更文件列表（左栏"变更"分段）。 */
export function useChangedFiles(workingCopyId: string | null, enabled = true) {
  return useQuery({
    queryKey: codeKeys.changes(workingCopyId ?? ""),
    queryFn: async () => (await WorkingCopyService.ListChanges(workingCopyId as string)) ?? [],
    enabled: Boolean(workingCopyId) && enabled,
    staleTime: 5_000,
  });
}

/**
 * 按文件名/路径搜索。
 *
 * 加 200ms 去抖：每敲一个字就遍历一次全树，在大仓库上是肉眼可见的卡顿。
 */
export function useFileSearch(workingCopyId: string | null, query: string, enabled = true) {
  return useQuery({
    queryKey: codeKeys.search(workingCopyId ?? "", query),
    queryFn: async () =>
      (await WorkingCopyService.SearchFiles(workingCopyId as string, query, 200)) ?? [],
    enabled: Boolean(workingCopyId) && enabled && query.trim() !== "",
    staleTime: 10_000,
    // 搜索失败时保留上一次结果，避免边打字边闪烁。
    placeholderData: (prev) => prev,
  });
}

/** 读取单个文件。 */
export function useFileContent(workingCopyId: string | null, path: string | null) {
  return useQuery({
    queryKey: codeKeys.file(workingCopyId ?? "", path ?? ""),
    queryFn: () => WorkingCopyService.ReadFile(workingCopyId as string, path as string),
    enabled: Boolean(workingCopyId && path),
    staleTime: 10_000,
    // 读失败（二进制、过大）是确定的结果，重试没有意义。
    retry: false,
  });
}

/**
 * 读取单个文件（可编辑模式用），带回 mtime。
 *
 * 与 `useFileContent` 分开而不是合并：只读浏览不需要 mtime，
 * 而这个值只在"要写回磁盘"时才构成一份有意义的基准。
 */
export function useFileText(workingCopyId: string | null, path: string | null) {
  return useQuery({
    queryKey: codeKeys.text(workingCopyId ?? "", path ?? ""),
    queryFn: () =>
      WorkingCopyService.ReadText(workingCopyId as string, path as string) as Promise<FileText>,
    enabled: Boolean(workingCopyId && path),
    // 编辑期间磁盘可能被动过，但这个 hook 只负责"打开时读到什么"；
    // 实时比对由 StatText 与保存时的冲突检测负责。
    staleTime: 30_000,
    retry: false,
  });
}

/** 读取某工作副本下所有未保存的草稿。 */
export function useDrafts(workingCopyId: string | null) {
  return useQuery({
    queryKey: codeKeys.drafts(workingCopyId ?? ""),
    queryFn: () =>
      WorkingCopyService.ListDrafts(workingCopyId as string) as Promise<BufferDraft[]>,
    enabled: Boolean(workingCopyId),
    // 草稿只在启动或切换仓库时需要看一次，不做轮询。
    staleTime: Infinity,
  });
}

/**
 * 读取上次离开 Code 面时的布局（标签页、当前文件、展开的目录）。
 *
 * 只读一次：布局是"过去的快照"，同一个会话里没有别的写入者会改它，
 * 反复取只会让恢复逻辑在用户已经手动调整过标签之后又把它拽回去。
 */
export function useCodeLayout() {
  return useQuery({
    queryKey: codeKeys.layout,
    queryFn: () => WorkingCopyService.LoadCodeLayout() as Promise<CodeLayout>,
    staleTime: Infinity,
    // 读布局失败只意味着这次没有可恢复的东西，重试无意义。
    retry: false,
  });
}

/**
 * 直接写入布局，供去抖写回与关闭前兜底调用。
 *
 * 不经过 react-query：布局不是需要缓存与失效的查询结果，
 * 每次变化都整份覆盖，失败也不该把界面拖进错误态。
 */
export async function persistCodeLayout(layout: CodeLayout): Promise<void> {
  try {
    await WorkingCopyService.SaveCodeLayout(layout);
  } catch {
    // 存不下布局只影响下次打开时的标签，静默即可。
  }
}

/** 保存结果。 */
export interface SaveOutcome {
  /** 写入后的 mtime，作为下一次保存的新基准。 */
  mtime: number;
  /** 是否因为磁盘已被外部修改而被拒绝。 */
  conflict: boolean;
}

/**
 * 把编辑内容写回磁盘。
 *
 * `expectedMtime` 是打开文件时读到的 mtime；磁盘在那之后被动过时 Go 侧
 * 会拒绝写入并返回冲突，而不是静默覆盖。用户可以选择"强制保存"
 * （传 0）或先看差异。
 */
export function useSaveFile(workingCopyId: string | null) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (vars: {
      path: string;
      content: string;
      expectedMtime: number;
    }): Promise<SaveOutcome> => {
      try {
        const mtime = (await WorkingCopyService.WriteText(
          workingCopyId as string,
          vars.path,
          vars.content,
          vars.expectedMtime,
        )) as number;
        return { mtime, conflict: false };
      } catch (err) {
        if (isFileChanged(err)) return { mtime: 0, conflict: true };
        throw err;
      }
    },
    onSuccess: (outcome, vars) => {
      if (outcome.conflict) return;
      // 保存成功后磁盘内容变了：文件内容、变更列表与草稿都过期。
      void qc.invalidateQueries({ queryKey: codeKeys.text(workingCopyId ?? "", vars.path) });
      void qc.invalidateQueries({ queryKey: codeKeys.file(workingCopyId ?? "", vars.path) });
      void qc.invalidateQueries({ queryKey: codeKeys.changes(workingCopyId ?? "") });
      void qc.invalidateQueries({ queryKey: codeKeys.drafts(workingCopyId ?? "") });
    },
  });
}

/**
 * 判断一个错误是不是"磁盘文件已被外部修改"。
 *
 * Go 侧用哨兵错误 `ErrFileChanged`，经绑定层传到 JS 会变成带消息的 Error。
 * 这里按消息片段识别：绑定层不保证保留错误类型，而错误的**语义**必须
 * 传递到界面，否则用户会看到一句通用的失败提示而不知道该选哪个动作。
 */
export function isFileChanged(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(ErrFileChangedHint);
}

/** 与 Go 侧 ErrFileChanged 文案对应的识别片段。 */
const ErrFileChangedHint = "文件已被外部修改";

/** 记录一份未保存的草稿（崩溃恢复用）。 */
export function useSaveDraft(workingCopyId: string | null) {
  return useMutation({
    mutationFn: (vars: { path: string; content: string; baseMtime: number }) =>
      WorkingCopyService.SaveDraft(
        workingCopyId as string,
        vars.path,
        vars.content,
        vars.baseMtime,
      ),
  });
}

/** 放弃一份草稿。 */
export function useDiscardDraft(workingCopyId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) =>
      WorkingCopyService.DiscardDraft(workingCopyId as string, path),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: codeKeys.drafts(workingCopyId ?? "") });
    },
  });
}
/**
 * 按扩展名推断语言，用于决定是否做高亮。
 *
 * 只覆盖常见的几类：通用高亮器的价值在这个量级上已经递减，
 * 更深的能力（补全、诊断、跳转）由 LSP 提供，而不是继续堆扩展名映射。
 */
export function languageOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();

  // 少数文件名本身就是语言信号。
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  if (lower === "cargo.toml" || lower === "go.mod") return "toml";

  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    go: "go",
    py: "python",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    rb: "ruby",
    php: "php",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    css: "css",
    scss: "scss",
    html: "html",
    vue: "vue",
    svelte: "svelte",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    md: "markdown",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ps1: "powershell",
    ini: "ini",
    conf: "ini",
    env: "ini",
  };
  return map[ext] ?? "";
}

/**
 * 语言显示名（详情栏用）。
 *
 * 语言名本身是**专有名词**（TypeScript、Go、Rust），不翻译；
 * 但"无法识别语言"这一档是普通描述，必须走翻译键——写死中文会让
 * 英文界面里突然冒出一句中文。
 *
 * Args:
 *
 *	language: `detectLanguage` 的返回值
 *	t:        翻译函数，由调用方的 useTranslation 提供
 */
export function languageLabel(language: string, t: (key: string) => string): string {
  if (language === "" || language === "text") return t("code.plainText");
  const labels: Record<string, string> = {
    typescript: "TypeScript",
    javascript: "JavaScript",
    go: "Go",
    python: "Python",
    rust: "Rust",
    java: "Java",
    kotlin: "Kotlin",
    ruby: "Ruby",
    php: "PHP",
    c: "C",
    cpp: "C++",
    csharp: "C#",
    swift: "Swift",
    css: "CSS",
    scss: "SCSS",
    html: "HTML",
    vue: "Vue",
    svelte: "Svelte",
    json: "JSON",
    yaml: "YAML",
    toml: "TOML",
    xml: "XML",
    markdown: "Markdown",
    sql: "SQL",
    shell: "Shell",
    powershell: "PowerShell",
    ini: "INI",
    dockerfile: "Dockerfile",
    makefile: "Makefile",
  };
  return labels[language] ?? language;
}

/** 把路径按层拆开，用于面包屑。 */
export function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export type { TreeNode };
