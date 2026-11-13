import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Events } from "@wailsio/runtime";

import {
  SystemService,
  WorkingCopyService,
} from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import type {
  CloneProgressEvent,
  CloneTarget,
} from "@/bindings/github.com/kustos/kustos-desktop/internal/services/models";
import { CloneProgress as CloneProgressEventName } from "@/bindings/events";
import { workingCopyKeys } from "@/lib/working-copy";

/**
 * 克隆的数据层。
 *
 * 两件事在这里收口：
 *   1. 地址拼接与凭据注入全在 Go 侧（`internal/git/clone.go`），
 *      前端只传 `owner/repo` 或一个完整的外部地址；
 *   2. clone 可能跑几分钟，进度靠 Wails 事件逐帧推来，不是等调用返回。
 */

export const cloneKeys = {
  git: ["git-status"] as const,
};

/**
 * 本机 git 是否可用。
 *
 * 桌面端不内置 git，所有读写都调系统 git。没有 git 时，报错会出现在"克隆"
 * 那一刻，看起来像网络或权限问题；在引导页先问一次，就能直接说"请先安装 git"。
 */
export function useGitStatus() {
  return useQuery({
    queryKey: cloneKeys.git,
    queryFn: () => SystemService.GitStatus(),
    // git 装没装不会在会话中途变；失败也没必要重试到把界面拖慢。
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** 打开系统目录选择框。取消时 Go 侧返回空串，这里归一成 null。 */
export function usePickDirectory() {
  return useMutation({
    mutationFn: async (vars: { title: string; start: string }) => {
      const picked = await SystemService.PickDirectory(vars.title, vars.start);
      return picked ? picked : null;
    },
  });
}

/**
 * 发起一次克隆。
 *
 * 成功后把新登记的副本设为活动仓库：用户刚拉下来的仓库就是他此刻想看的那个，
 * 让他再去列表里点一次只是多一步。
 */
export function useCloneRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: CloneTarget) => WorkingCopyService.CloneRemote(target),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workingCopyKeys.list });
    },
  });
}

/** 取消某个目标目录上正在进行的克隆。 */
export function useCancelClone() {
  return useMutation({
    mutationFn: (dir: string) => WorkingCopyService.CancelClone(dir),
  });
}

/**
 * 订阅某个目标目录的克隆进度。
 *
 * 按目录过滤：用户可能同时拉两个仓库，没有过滤时两个进度条会互相串。
 * `dir` 为空表示还没开始，此时不订阅。
 */
export function useCloneProgress(dir: string | null): CloneProgressEvent | null {
  const [progress, setProgress] = useState<CloneProgressEvent | null>(null);

  useEffect(() => {
    setProgress(null);
    if (!dir) return;

    const off = Events.On(CloneProgressEventName, (ev) => {
      const payload = ev.data as CloneProgressEvent | null;
      if (!payload || !samePath(payload.dir, dir)) return;
      setProgress(payload);
    });
    return off;
  }, [dir]);

  return progress;
}

/**
 * 把克隆失败的原因翻成界面能直接展示的一句话。
 *
 * 绑定层会给 Go 的 error 套一层 `RuntimeError: ` 前缀，而 Go 侧有些错误本身
 * 就带系统原文（`mkdir C:\Users\x\Kustos: Access is denied.`）。两者都不该原样
 * 出现在界面上：前者我们的内部术语，后者说出了哪条系统调用失败、却没说该
 * 怎么办。这里按可辨认的关键词换成"下一步做什么"，认不出来的才保留原文
 * （去前缀），毕竟有些失败只有 git 自己说得清。
 */
export function cloneErrorText(error: unknown, t: (key: string) => string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.replace(/^(RuntimeError|Error):\s*/i, "").trim();

  if (/access is denied|permission denied|errno 13/i.test(text)) {
    return t("onboarding.cloneNoPermission");
  }
  if (/目标目录已存在|already exists|not an empty directory/i.test(text)) {
    return t("onboarding.cloneTargetExists");
  }
  if (/未找到 git|git not found|executable file not found/i.test(text)) {
    return t("onboarding.gitMissing");
  }
  return text || t("onboarding.cloneFailedFallback");
}

/**
 * 比较两个本地路径是否指向同一处。
 *
 * 必须归一：Go 侧发来的 `dir` 经过 `filepath.Abs`，Windows 上会把 `/` 换成 `\`；
 * 前端手里的路径可能还是用户输入的原样。直接比字符串会让进度条永远收不到事件。
 * 大小写一并忽略——Windows 与默认的 macOS 文件系统都不区分大小写。
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 从仓库路径或 git 地址里猜出仓库名，作为克隆出来的目录名。
 *
 * 只取末段而不是完整地址：`https://host/owner/repo.git` → `repo`，
 * `owner/repo` → `repo`，`git@host:owner/repo.git` 同理。猜不出来就返回空串，
 * 调用方据此要求用户先选仓库，而不是拉到一个叫 `Kustos` 的目录里。
 */
export function repoNameFromURL(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const tail = cut >= 0 ? trimmed.slice(cut + 1) : "";
  // scp 风格 `git@host:owner/repo.git` 没有斜杠时，冒号后面才是路径。
  const candidate = tail || trimmed.slice(trimmed.lastIndexOf(":") + 1);
  const name = candidate.replace(/\.git$/i, "");
  return name === "." || name === ".." ? "" : name;
}

/**
 * 把父目录与仓库名拼成目标路径。
 *
 * 分隔符从父目录里读，而不是固定用 `/`：Windows 上 `C:\Users\me\Kustos` 后面
 * 接 `/notes` 会得到一个 git 自己也不认的混合路径。父目录里没有分隔符时
 * （相对路径或盘根）才回落到 `/`。
 */
export function joinPath(parent: string, name: string): string {
  const base = parent.trim().replace(/[\\/]+$/, "");
  if (!base) return "";
  if (!name) return base;
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base}${sep}${name}`;
}

/**
 * 把进度阶段翻成可读的说明。
 *
 * 不直接显示 `receiving`：用户要看的是"正在下载"，不是 git 的内部阶段名。
 * 交给调用方传翻译函数，避免这里硬编码中文。
 */
export function clonePhaseLabel(
  phase: CloneProgressEvent["phase"],
  t: (key: string) => string,
): string {
  switch (phase) {
    case "starting":
      return t("onboarding.clonePhaseStarting");
    case "counting":
      return t("onboarding.clonePhaseCounting");
    case "compressing":
      return t("onboarding.clonePhaseCompressing");
    case "receiving":
      return t("onboarding.clonePhaseReceiving");
    case "resolving":
      return t("onboarding.clonePhaseResolving");
    case "checkout":
      return t("onboarding.clonePhaseCheckout");
    default:
      return t("onboarding.clonePhaseStarting");
  }
}
