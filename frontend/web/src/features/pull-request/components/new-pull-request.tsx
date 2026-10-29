import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";

/** GET /branches 的列表项（分支名 + 保护标志）。 */
interface BranchRow {
  name: string;
  is_default?: boolean;
  is_protected?: boolean;
}

const SELECT_CLASS =
  "border-edge-2 bg-ink-950/60 text-bone focus:border-amber/40 h-9 w-full rounded-md border px-2.5 text-[12px] outline-none transition-colors";

/**
 * 新建 Pull Request。
 *
 * 源/目标分支来自仓库分支列表；目标默认仓库默认分支，源默认第一个非默认分支。
 * 创建成功后跳到该 PR 详情（列表轮询在父页面）。
 */
export function NewPullRequestButton({
  repoId,
  defaultBranch,
}: {
  repoId: string;
  defaultBranch: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        新建 Pull Request
      </Button>
      <NewPullRequestDialog
        repoId={repoId}
        defaultBranch={defaultBranch}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export function NewPullRequestDialog({
  repoId,
  defaultBranch,
  open,
  onOpenChange,
}: {
  repoId: string;
  defaultBranch: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sourceBranch, setSourceBranch] = useState("");
  const [targetBranch, setTargetBranch] = useState(defaultBranch);

  const branchesQuery = useApiQuery<BranchRow[]>({
    queryKey: ["branches", repoId],
    enabled: open && !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/branches", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error("分支列表加载失败。");
      return (Array.isArray(res.data) ? res.data : []) as BranchRow[];
    },
  });

  // 打开时重置表单；分支列表到达后仅在源分支仍为空时预填，避免覆盖用户已输入
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setTargetBranch(defaultBranch);
    setSourceBranch("");
  }, [open, defaultBranch]);

  useEffect(() => {
    if (!open) return;
    const branches = branchesQuery.data ?? [];
    const candidate = branches.find((branch) => branch.name !== defaultBranch)?.name ?? "";
    setSourceBranch((prev) => prev || candidate);
  }, [open, defaultBranch, branchesQuery.data]);

  const createMutation = useApiMutation<number, void>(
    async () => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/pull-requests", {
        params: { path: { repo_id: repoId } },
        body: {
          title: title.trim(),
          description: description.trim() || null,
          source_branch: sourceBranch,
          target_branch: targetBranch,
        } as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "创建 Pull Request 失败。");
      }
      const payload = res.data as { pr_number?: number } | undefined;
      if (!payload?.pr_number) throw new Error("创建成功但未返回 PR 编号。");
      return payload.pr_number;
    },
    {
      onSuccess: (prNumber) => {
        toast.success(`Pull Request #${prNumber} 已创建。`);
        void queryClient.invalidateQueries({ queryKey: ["pull-requests", repoId] });
        onOpenChange(false);
        navigate(`/pull-requests?pr=${prNumber}`);
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const branches = branchesQuery.data ?? [];
  const canSubmit =
    !!title.trim() && !!sourceBranch && !!targetBranch && sourceBranch !== targetBranch;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>新建 Pull Request</DialogTitle>
          <DialogDescription>
            源分支与目标分支不能相同；差异与合并条件由后端计算。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="标题"
            aria-label="PR 标题"
          />
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            placeholder="描述（Markdown）…"
            aria-label="PR 描述"
            className="border-edge-2 bg-ink-950/60 text-bone placeholder:text-muted-2 focus:border-amber/40 min-h-[90px] w-full resize-none rounded-md border px-2.5 py-2 text-[12px] transition-colors outline-none"
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-muted-2 text-[10px] font-semibold tracking-[0.13em] uppercase">
                源分支
              </span>
              <select
                value={sourceBranch}
                onChange={(event) => setSourceBranch(event.target.value)}
                className={SELECT_CLASS}
                aria-label="源分支"
              >
                <option value="">选择分支…</option>
                {branches
                  .filter((branch) => branch.name !== targetBranch)
                  .map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-muted-2 text-[10px] font-semibold tracking-[0.13em] uppercase">
                目标分支
              </span>
              <select
                value={targetBranch}
                onChange={(event) => setTargetBranch(event.target.value)}
                className={SELECT_CLASS}
                aria-label="目标分支"
              >
                {branches
                  .filter((branch) => branch.name !== sourceBranch)
                  .map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {branches.length > 0 && branches.every((branch) => branch.name === defaultBranch) ? (
            <p className="text-amber-2 text-[11px]">只有默认分支。先推送一个分支，才能发起 PR。</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canSubmit || createMutation.isPending}
          >
            {createMutation.isPending ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
