import { useQuery } from "@tanstack/react-query";

import { WorkingCopyService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import type { TreeNode } from "@/bindings/github.com/kustos/kustos-desktop/internal/services/models";

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
  changes: (id: string) => ["code", id, "changes"] as const,
  search: (id: string, query: string) => ["code", id, "search", query] as const,
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
 * 按扩展名推断语言，用于决定是否做高亮。
 *
 * 只覆盖常见的几类：通用高亮器的价值在这个量级上已经递减，
 * 而"整个编辑器"是 M3 的事——这一版是只读查看器。
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
