import { Tag } from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";

import { MarkdownEditor } from "@/components/editor/markdown-editor";
import { Chip, Lamp } from "@/components/kit/kit";
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
import { relativeTime } from "@/features/issue/api";
import { Markdown } from "@/lib/markdown/markdown";
import { cn } from "@/lib/utils";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

/**
 * Release 页。
 *
 * 列表与创建直接对接 release_controller（分页壳与 Issue 列表同构）。
 * 附件上传与单条详情暂未展开——那部分需要文件选择与上传进度，单独一轮做。
 */

/** 后端 release（release_service.build_release_response）。 */
interface ReleaseDto {
  id: string;
  release_number: number;
  tag_name: string;
  name: string;
  description: string | null;
  author: { id: string | null; username: string | null } | null;
  commit_hash: string | null;
  is_draft: boolean;
  is_prerelease: boolean;
  created_at: string | null;
  updated_at: string | null;
}

interface ReleasePage {
  items: ReleaseDto[];
  total: number;
  page: number;
  pages: number;
  has_next: boolean;
  has_prev: boolean;
}

/** 拉取 Release 列表；草稿需要显式请求，默认只列已发布。 */
async function fetchReleases(repoId: string, page: number, includeDrafts: boolean): Promise<ReleasePage> {
  const res = await api.GET("/api/v1/repositories/{repo_id}/releases", {
    params: {
      path: { repo_id: repoId },
      query: { page, limit: 20, include_drafts: includeDrafts },
    },
  });
  if (res.error) {
    const detail = (res.error as { detail?: string }).detail;
    throw new Error(detail ?? "Release 列表加载失败。");
  }
  const payload = res.data as Partial<ReleasePage> | null;
  return {
    items: payload?.items ?? [],
    total: payload?.total ?? 0,
    page: payload?.page ?? page,
    pages: payload?.pages ?? 0,
    has_next: payload?.has_next ?? false,
    has_prev: payload?.has_prev ?? false,
  };
}

/** 创建 Release；`create_git_tag` 让后端同时打标签。 */
async function createRelease(
  repoId: string,
  input: { tagName: string; name: string; description: string; isDraft: boolean; isPrerelease: boolean },
): Promise<ReleaseDto> {
  const res = await api.POST("/api/v1/repositories/{repo_id}/releases", {
    params: { path: { repo_id: repoId } },
    body: {
      tag_name: input.tagName,
      name: input.name,
      description: input.description || null,
      is_draft: input.isDraft,
      is_prerelease: input.isPrerelease,
      create_git_tag: true,
    },
  });
  if (res.error) {
    const detail = (res.error as { detail?: string }).detail;
    throw new Error(detail ?? "创建 Release 失败。");
  }
  return res.data as ReleaseDto;
}

export function ReleasesPage() {
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const repo = useRepoStore((state) => state.current);
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const repoId = repo?.id ?? "";

  useEffect(() => {
    setCrumbs([{ label: repo?.name ?? "—" }, { label: "Releases" }]);
  }, [setCrumbs, repo?.name]);

  const listQuery = useApiQuery<ReleasePage>({
    queryKey: ["releases", repoId, page, includeDrafts],
    enabled: !!repoId,
    queryFn: () => fetchReleases(repoId, page, includeDrafts),
  });

  const createMutation = useApiMutation<
    ReleaseDto,
    { tagName: string; name: string; description: string; isDraft: boolean; isPrerelease: boolean }
  >((input) => createRelease(repoId, input), {
    onSuccess: (release) => {
      toast.success(`Release ${release.tag_name} 已创建。`);
      void queryClient.invalidateQueries({ queryKey: ["releases", repoId] });
      setCreateOpen(false);
    },
    onError: (error) => toast.error(error.message),
  });

  if (!repo) {
    return (
      <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px]">
        <h1 className="font-display text-bone text-[clamp(1.7rem,2.6vw,2.3rem)] font-medium tracking-[-0.028em] leading-none">
          Release
        </h1>
        <p className="text-muted-2 mt-4 text-[12px]">未选择仓库。请先在侧栏选择一个仓库。</p>
      </div>
    );
  }

  const releases = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px] pb-20">
      <header className="mb-[22px] flex items-end justify-between gap-8">
        <div className="min-w-0">
          <p className="text-faint text-[10.5px] font-semibold tracking-[0.16em] uppercase">{repo.name}</p>
          <div className="mt-1.5 flex items-center gap-3">
            <h1 className="font-display text-bone text-[clamp(1.7rem,2.6vw,2.3rem)] font-medium tracking-[-0.028em] leading-none">
              Release
            </h1>
            <span className="border-edge-2 text-muted inline-flex h-[19px] items-center rounded-full border px-2 font-mono text-[10px]">
              {total}
            </span>
          </div>
          <nav className="mt-3 flex items-center gap-2 text-[11px]" aria-label="仓库页">
            <Link to="/code" className="text-muted-2 hover:text-amber-2 transition-colors">
              {repo.path}
            </Link>
            <span className="text-faint">/</span>
            <span className="text-bone-2">Releases</span>
          </nav>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Chip
            active={includeDrafts}
            onClick={() => {
              setIncludeDrafts((value) => !value);
              setPage(1);
            }}
          >
            包含草稿
          </Chip>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            新建 Release
          </Button>
        </div>
      </header>

      <div className="border-edge-2 bg-ink-900/50 overflow-hidden rounded-[12px] border">
        <div className="border-edge-2 flex items-center gap-2.5 border-b px-4 py-2.5">
          <Lamp tone={releases.length ? "good" : "neutral"} />
          <span className="text-muted-2 font-mono text-[10px]">
            {listQuery.isLoading ? "加载中…" : `显示 ${releases.length} / 共 ${total} 条`}
          </span>
          <span className="from-edge-1 ml-auto h-px flex-1 bg-gradient-to-r to-transparent" aria-hidden="true" />
        </div>

        {listQuery.isError ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <p className="text-bone-2 text-[12px] font-medium">Release 列表加载失败。</p>
            <p className="text-muted-2 text-[10.5px]">{listQuery.error?.message}</p>
            <Button size="sm" variant="secondary" onClick={() => void listQuery.refetch()}>
              重试
            </Button>
          </div>
        ) : releases.length === 0 && !listQuery.isLoading ? (
          <p className="text-muted-2 px-4 py-12 text-center text-[11.5px]">
            还没有发布版本。新建一个 Release 会同时打上 Git 标签。
          </p>
        ) : (
          <ul>
            {releases.map((release) => (
              <li key={release.id} className="border-edge-1 border-b px-4 py-3.5 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-amber-2 inline-flex items-center gap-1.5 font-mono text-[12px]">
                    <Tag className="size-[13px]" aria-hidden="true" />
                    {release.tag_name}
                  </span>
                  <span className="text-bone-2 text-[13px] font-medium">{release.name}</span>
                  {release.is_draft ? (
                    <span className="border-edge-2 text-muted-2 inline-flex h-[17px] items-center rounded-full border px-1.5 text-[9px]">
                      草稿
                    </span>
                  ) : null}
                  {release.is_prerelease ? (
                    <span className="border-amber/30 bg-amber/10 text-amber-2 inline-flex h-[17px] items-center rounded-full border px-1.5 text-[9px]">
                      预发布
                    </span>
                  ) : null}
                  <span className="text-faint ml-auto font-mono text-[9.5px]">
                    #{release.release_number} · {release.author?.username ?? "unknown"} ·{" "}
                    {relativeTime(release.created_at)}
                  </span>
                </div>
                {release.description ? (
                  <div className={cn("text-muted mt-2 max-w-[80ch] text-[11.5px] leading-[1.6]")}>
                    <Markdown content={release.description} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="border-edge-2 text-faint flex items-center gap-2 border-t px-4 py-2 font-mono text-[10px]">
          <button
            type="button"
            disabled={!listQuery.data?.has_prev}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            className="hover:text-bone disabled:opacity-40"
          >
            上一页
          </button>
          <span>
            {listQuery.data?.page ?? page} / {Math.max(listQuery.data?.pages ?? 1, 1)}
          </span>
          <button
            type="button"
            disabled={!listQuery.data?.has_next}
            onClick={() => setPage((value) => value + 1)}
            className="hover:text-bone disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>

      <CreateReleaseDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        pending={createMutation.isPending}
        onSubmit={(input) => createMutation.mutate(input)}
      />
    </div>
  );
}

/** 新建 Release 弹窗：标签名 + 标题 + 说明（Markdown）+ 草稿/预发布。 */
function CreateReleaseDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (input: {
    tagName: string;
    name: string;
    description: string;
    isDraft: boolean;
    isPrerelease: boolean;
  }) => void;
}) {
  const [tagName, setTagName] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDraft, setIsDraft] = useState(false);
  const [isPrerelease, setIsPrerelease] = useState(false);

  const submit = () => {
    if (!tagName.trim() || !name.trim() || pending) return;
    onSubmit({ tagName: tagName.trim(), name: name.trim(), description, isDraft, isPrerelease });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>新建 Release</DialogTitle>
          <DialogDescription>标签名必填；后端会同时创建同名 Git 标签。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={tagName}
            onChange={(event) => setTagName(event.target.value)}
            placeholder="v0.1.0"
            aria-label="标签名"
          />
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="标题"
            aria-label="标题"
          />
          <div className="border-edge-2 bg-ink-950/45 overflow-hidden rounded-md border">
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              placeholder="发布说明（Markdown）…"
              className="text-bone px-2.5 py-2 text-[11px]"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Chip active={isDraft} onClick={() => setIsDraft((value) => !value)}>
              草稿
            </Chip>
            <Chip active={isPrerelease} onClick={() => setIsPrerelease((value) => !value)}>
              预发布
            </Chip>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!tagName.trim() || !name.trim() || pending}>
            {pending ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
