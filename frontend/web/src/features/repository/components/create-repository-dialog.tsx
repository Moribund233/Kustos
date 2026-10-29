import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Chip } from "@/components/kit/kit";
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
import { useApiMutation } from "@/lib/api/hooks";
import { useRepoStore, type RepoSummary } from "@/stores/repo-store";

/**
 * 新建仓库弹窗。
 *
 * 仓库路径由后端按 `用户名/仓库名` 生成，前端不拼路径；创建成功后重拉仓库
 * 列表并切到新仓库的代码页，避免用户还要再点一次侧栏。
 */
export function CreateRepositoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const load = useRepoStore((state) => state.load);
  const select = useRepoStore((state) => state.select);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  // 关闭后清空，避免下次打开残留上次输入
  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setIsPublic(false);
    }
  }, [open]);

  const createMutation = useApiMutation<
    RepoSummary,
    { name: string; description: string; is_public: boolean }
  >(
    async (input) => {
      const res = await api.POST("/api/v1/repositories", { body: input as never });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "创建仓库失败。");
      }
      return res.data as unknown as RepoSummary;
    },
    {
      onSuccess: async (repo) => {
        toast.success(`仓库 ${repo.path} 已创建。`);
        await load();
        select(repo.id);
        onOpenChange(false);
        navigate("/code");
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || createMutation.isPending) return;
    createMutation.mutate({ name: trimmed, description: description.trim(), is_public: isPublic });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>新建仓库</DialogTitle>
          <DialogDescription>
            路径由后端生成（<span className="font-mono">用户名/仓库名</span>），创建后即可用 git
            push 推送内容。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="仓库名"
            aria-label="仓库名"
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="一句话说明这个仓库做什么"
            aria-label="仓库描述"
            className="border-edge-2 bg-ink-950/60 text-bone placeholder:text-muted-2 focus:border-amber/40 min-h-[70px] w-full resize-none rounded-md border px-2.5 py-2 text-[12px] transition-colors outline-none"
          />
          <div className="flex items-center gap-2">
            <span className="text-muted-2 text-[10px] font-semibold tracking-[0.13em] uppercase">
              可见性
            </span>
            <Chip active={isPublic} onClick={() => setIsPublic(true)}>
              公开
            </Chip>
            <Chip active={!isPublic} onClick={() => setIsPublic(false)}>
              私有
            </Chip>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!name.trim() || createMutation.isPending}>
            {createMutation.isPending ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
