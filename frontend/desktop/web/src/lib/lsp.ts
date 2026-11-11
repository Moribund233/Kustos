import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { LSPService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import type {
  DetectedLanguage,
  LanguageHint,
  TrustState,
} from "@/bindings/github.com/kustos/kustos-desktop/internal/services/models";
import type { Info } from "@/bindings/github.com/kustos/kustos-desktop/internal/lsp/models";

/**
 * 本地智能相关的查询键。
 *
 * 按工作区根路径分组：信任与语言探测都是"这个目录"的事实，
 * 换仓库就该是另一份答案。
 */
export const lspKeys = {
  hints: ["lsp", "hints"] as const,
  detected: (root: string) => ["lsp", "detected", root] as const,
  trust: (root: string) => ["lsp", "trust", root] as const,
  sessions: ["lsp", "sessions"] as const,
};

/** 每种语言的服务器安装状态；界面据此显示安装命令。 */
export function useLanguageHints() {
  return useQuery({
    queryKey: lspKeys.hints,
    queryFn: () => LSPService.LanguageHints() as Promise<LanguageHint[] | null>,
    // 装完服务器要在设置里显式"重新探测"，所以这里的缓存不必定期失效。
    staleTime: Infinity,
  });
}

/** 按工作区里的 marker 探测该用哪种语言服务器。 */
export function useDetectedLanguage(root: string | null) {
  return useQuery({
    queryKey: lspKeys.detected(root ?? ""),
    queryFn: () => LSPService.DetectLanguage(root as string) as Promise<DetectedLanguage>,
    enabled: Boolean(root),
    staleTime: Infinity,
  });
}

/** 一个工作区是否已被信任运行语言服务器。 */
export function useWorkspaceTrust(root: string | null) {
  return useQuery({
    queryKey: lspKeys.trust(root ?? ""),
    queryFn: () => LSPService.TrustStatus(root as string) as Promise<TrustState>,
    enabled: Boolean(root),
    staleTime: Infinity,
  });
}

/**
 * 记录用户的信任决定。
 *
 * 撤销信任时 Go 侧会顺手停掉已跑起来的服务器，所以这里要让会话列表失效，
 * 否则界面还在显示一个已经不存在的会话。
 */
export function useSetWorkspaceTrust(root: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trusted: boolean) => LSPService.SetTrust(root as string, trusted),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: lspKeys.trust(root ?? "") });
      void qc.invalidateQueries({ queryKey: lspKeys.sessions });
    },
  });
}

/** 当前所有语言服务器会话。 */
export function useLSPSessions() {
  return useQuery({
    queryKey: lspKeys.sessions,
    queryFn: () => LSPService.Sessions() as Promise<Info[] | null>,
    // 会话状态会自己变（崩溃、重启、空闲回收），只靠手动刷新会长期显示旧值。
    refetchInterval: 5_000,
  });
}

/** 为一个工作区拉起语言服务器。 */
export function useEnsureLSP(root: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { root: string; language: string }) =>
      LSPService.Ensure(vars.root, vars.language) as Promise<Info>,
    onSuccess: () => void qc.invalidateQueries({ queryKey: lspKeys.sessions }),
  });
}

/** 手动重启某个工作区的语言服务器（换了版本、或卡住时用）。 */
export function useRestartLSP(root: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => LSPService.Restart(root as string) as Promise<Info>,
    onSuccess: () => void qc.invalidateQueries({ queryKey: lspKeys.sessions }),
  });
}

/** 取某个工作区当前那个会话；没有则返回 null。 */
export function sessionFor(
  sessions: Info[] | null | undefined,
  root: string | null,
): Info | null {
  if (!root || !sessions) return null;
  return sessions.find((s) => s.root === root) ?? null;
}
