import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";

import { Chip } from "@/components/kit/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

/**
 * 仓库设置页。
 *
 * 只做能改的字段（名称 / 描述 / 可见性）：路径由 `owner/name` 决定，改名会牵动
 * 克隆地址与已有引用，交给后端冲突校验而不是在这里猜。保存后重拉仓库列表，
 * 侧栏与其它页面的仓库信息随之更新。
 */
export function RepositorySettingsPage() {
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const repo = useRepoStore((state) => state.current);
  const loadRepos = useRepoStore((state) => state.load);
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  // 切仓库时用新数据重填，避免把上一个仓库的字段带过来
  useEffect(() => {
    if (!repo) return;
    setName(repo.name);
    setDescription(repo.description ?? "");
    setIsPublic(repo.is_public);
    setCrumbs([{ label: repo.name }, { label: "设置" }]);
  }, [repo, setCrumbs]);

  const saveMutation = useApiMutation<
    { id: string },
    { name: string; description: string; is_public: boolean }
  >(
    async (input) => {
      const res = await api.PUT("/api/v1/repositories/{repo_id}", {
        params: { path: { repo_id: repo?.id ?? "" } },
        body: input,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "保存失败。");
      }
      return res.data as { id: string };
    },
    {
      onSuccess: async () => {
        toast.success("仓库设置已保存。");
        await loadRepos();
        void queryClient.invalidateQueries({ queryKey: ["repositories"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  if (!repo) {
    return (
      <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px]">
        <h1 className="font-display text-bone text-[clamp(1.7rem,2.6vw,2.3rem)] font-medium tracking-[-0.028em] leading-none">
          仓库设置
        </h1>
        <p className="text-muted-2 mt-4 text-[12px]">未选择仓库。请先在侧栏选择一个仓库。</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[860px] px-[34px] pt-[30px] pb-20">
      <header className="mb-6">
        <p className="text-faint text-[10.5px] font-semibold tracking-[0.16em] uppercase">{repo.path}</p>
        <h1 className="font-display text-bone mt-1.5 text-[clamp(1.7rem,2.6vw,2.3rem)] font-medium tracking-[-0.028em] leading-none">
          仓库设置
        </h1>
        <p className="text-muted-2 mt-2 text-[11.5px]">
          克隆地址与路径由 <span className="font-mono">{repo.path}</span> 决定，改名需在服务端确认无冲突。
        </p>
      </header>

      <div className="border-edge-2 bg-ink-900/50 flex flex-col gap-4 rounded-[12px] border p-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-muted-2 text-[10px] font-semibold tracking-[0.13em] uppercase">名称</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="仓库名称"
            placeholder="仓库名称"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-muted-2 text-[10px] font-semibold tracking-[0.13em] uppercase">描述</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-label="仓库描述"
            rows={3}
            placeholder="一句话说明这个仓库做什么"
            className="border-edge-2 bg-ink-950/60 text-bone placeholder:text-muted-2 focus:border-amber/40 min-h-[70px] w-full resize-none rounded-md border px-2.5 py-2 text-[12px] outline-none transition-colors"
          />
        </label>

        <div className="flex items-center gap-2">
          <span className="text-muted-2 text-[10px] font-semibold tracking-[0.13em] uppercase">可见性</span>
          <Chip active={isPublic} onClick={() => setIsPublic(true)}>
            公开
          </Chip>
          <Chip active={!isPublic} onClick={() => setIsPublic(false)}>
            私有
          </Chip>
        </div>

        <div className="border-edge-1 flex items-center gap-2 border-t pt-4">
          <Button
            size="sm"
            onClick={() =>
              saveMutation.mutate({ name: name.trim(), description: description.trim(), is_public: isPublic })
            }
            disabled={!name.trim() || saveMutation.isPending}
          >
            {saveMutation.isPending ? "保存中…" : "保存"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setName(repo.name);
              setDescription(repo.description ?? "");
              setIsPublic(repo.is_public);
            }}
          >
            重置
          </Button>
          <Link
            to="/code"
            className="text-muted-2 hover:text-amber-2 ml-auto text-[11px] transition-colors"
          >
            返回代码页 →
          </Link>
        </div>
      </div>
    </div>
  );
}
