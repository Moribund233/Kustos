import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { WorkingCopyService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import type { WorkingCopy } from "@/bindings/github.com/kustos/kustos-desktop/internal/store/models";
import type { Change } from "@/bindings/github.com/kustos/kustos-desktop/internal/git/models";

/**
 * 工作副本的数据层。
 *
 * 全部走 Go 侧的本地能力（系统 git），**不经过网络**：未提交的 diff 是本机
 * 事实，断网时也必须能看。这也是桌面端相对 Web 的核心优势之一。
 *
 * 这里不做任何乐观更新：暂存与提交的结果由 git 决定，界面必须反映真实状态。
 * 猜错的代价是用户以为改动已经进了暂存区。
 */

export const workingCopyKeys = {
  list: ["working-copies"] as const,
  status: (id: string) => ["working-copy", id, "status"] as const,
  diff: (id: string, path: string, staged: boolean) =>
    ["working-copy", id, "diff", path, staged] as const,
  branches: (id: string) => ["working-copy", id, "branches"] as const,
};

/** 已登记的工作副本列表。 */
export function useWorkingCopies() {
  return useQuery({
    queryKey: workingCopyKeys.list,
    queryFn: async () => (await WorkingCopyService.List()) ?? [],
    // 本机事实，变化只由本应用的写操作引起；留一点防抖给多窗口。
    staleTime: 5_000,
  });
}

/** 某个工作副本的实时状态。 */
export function useWorkingCopyStatus(id: string | null) {
  return useQuery({
    queryKey: workingCopyKeys.status(id ?? ""),
    queryFn: async () => WorkingCopyService.Status(id as string),
    enabled: Boolean(id),
    // 工作树随时可能被外部编辑器改动，缓存太久会让界面显示过期状态。
    // 真正昂贵的 git 调用由 Go 侧串行化，这里保留一个很短的窗口即可。
    staleTime: 2_000,
    refetchOnWindowFocus: true,
  });
}

/** 选中文件的 diff。 */
export function useFileDiff(id: string | null, path: string | null, staged: boolean) {
  return useQuery({
    queryKey: workingCopyKeys.diff(id ?? "", path ?? "", staged),
    queryFn: async () => WorkingCopyService.FileDiff(id as string, path as string, staged),
    enabled: Boolean(id && path),
    staleTime: 10_000,
  });
}

/** 添加工作副本（选目录后调用）。 */
export function useAddWorkingCopy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => WorkingCopyService.Add(path),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workingCopyKeys.list });
    },
  });
}

/** 移除工作副本记录（不删磁盘目录）。 */
export function useRemoveWorkingCopy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => WorkingCopyService.Remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workingCopyKeys.list });
    },
  });
}

/** 暂存 / 取消暂存。 */
export function useStage(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { paths: string[]; staged: boolean }) => {
      if (vars.staged) {
        await WorkingCopyService.Stage(id as string, vars.paths);
      } else {
        await WorkingCopyService.Unstage(id as string, vars.paths);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workingCopyKeys.status(id ?? "") });
      void qc.invalidateQueries({ queryKey: workingCopyKeys.list });
      // diff 也要重取：暂存与否决定读的是哪一侧的差异。
      void qc.invalidateQueries({ queryKey: ["working-copy", id ?? "", "diff"] });
    },
  });
}

/** 提交。 */
export function useCommit(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { message: string; amend: boolean }) =>
      WorkingCopyService.Commit(id as string, vars.message, vars.amend),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workingCopyKeys.status(id ?? "") });
      void qc.invalidateQueries({ queryKey: workingCopyKeys.list });
      void qc.invalidateQueries({ queryKey: ["working-copy", id ?? "", "diff"] });
    },
  });
}

/**
 * 推送。
 *
 * 凭证走系统 git 的 credential helper / SSH agent：桌面端不接触也不存储
 * 远端密码。因此这条路径既不需要服务端参与，也不需要额外的凭据界面。
 */
export function usePush(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (force: boolean) => WorkingCopyService.Push(id as string, force),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workingCopyKeys.status(id ?? "") });
      void qc.invalidateQueries({ queryKey: workingCopyKeys.list });
    },
  });
}

/** 拉取引用（不改工作区）。 */
export function useFetch(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => WorkingCopyService.Fetch(id as string),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workingCopyKeys.status(id ?? "") });
      void qc.invalidateQueries({ queryKey: workingCopyKeys.list });
    },
  });
}

/**
 * 取将要执行的 push 命令，供确认框展示。
 *
 * 破坏性操作必须让用户看到完整命令：`git push --force-with-lease` 这个词
 * 本身就能让人判断后果，而"确认强制推送？"不能。
 */
export function usePushCommand(id: string | null, force: boolean, enabled: boolean) {
  return useQuery({
    queryKey: ["working-copy", id ?? "", "push-command", force],
    queryFn: () => WorkingCopyService.PushCommand(id as string, force),
    enabled: Boolean(id) && enabled,
    staleTime: Infinity,
  });
}

/** 在外部编辑器中打开文件。 */
export function useOpenInEditor(id: string | null) {
  return useMutation({
    mutationFn: (path: string) => WorkingCopyService.OpenInEditor(id as string, path),
  });
}

/** 在文件管理器中定位文件。 */
export function useRevealInFileManager(id: string | null) {
  return useMutation({
    mutationFn: (path: string) => WorkingCopyService.RevealInFileManager(id as string, path),
  });
}

/** 变更的分组：界面要分别展示"已暂存"与"未暂存"两栏。 */
export interface ChangeGroups {
  staged: Change[];
  unstaged: Change[];
}

/** 按暂存状态分组。 */
export function groupChanges(changes: Change[] | null | undefined): ChangeGroups {
  const staged: Change[] = [];
  const unstaged: Change[] = [];
  for (const c of changes ?? []) {
    if (c.staged) staged.push(c);
    else unstaged.push(c);
  }
  return { staged, unstaged };
}

/** 变更类别对应的单字母状态码（对齐 git 习惯，用户一眼能认出）。 */
export function statusLetter(kind: Change["kind"]): string {
  switch (kind) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
    default:
      return "M";
  }
}


/** 路径最后一段，用于列表省略显示。 */
export function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/** 路径的父目录部分。 */
export function dirName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export type { WorkingCopy, Change };
