import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { SkeletonText } from "@/components/kit/skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { formatRelative } from "@/lib/datetime/format";

interface DiscussionRow {
  id: string;
  author_username: string;
  content: string;
  file_path: string;
  line_number: number | null;
  branch: string | null;
  parent_id: string | null;
  resolved: boolean;
  created_at: string | null;
}

/**
 * 仓库讨论（文件行内评论）。
 *
 * 后端 `discussions` 是行级评论而非论坛帖：每条挂在文件（可选行号）上，
 * 支持解决/重开与删除。这里提供仓库级列表与新建入口，行内锚点仍在 diff
 * 视图里使用同一份数据。
 */
export function DiscussionsSection({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [filePath, setFilePath] = useState("");
  const [line, setLine] = useState("");
  const [content, setContent] = useState("");

  const listQuery = useApiQuery<DiscussionRow[]>({
    queryKey: ["discussions", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/discussions", {
        params: { path: { repo_id: repoId }, query: { include_resolved: true } },
      });
      if (res.error) throw new Error(t("settings.discussionLoadFailed"));
      return (Array.isArray(res.data) ? res.data : []) as DiscussionRow[];
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["discussions", repoId] });

  const createMutation = useApiMutation<void, void>(
    async () => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/discussions", {
        params: { path: { repo_id: repoId } },
        body: {
          content: content.trim(),
          file_path: filePath.trim(),
          line_number: line ? Number(line) : undefined,
        } as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("settings.discussionCreateFailed"));
      }
    },
    {
      onSuccess: () => {
        toast.success(t("settings.discussionCreated"));
        setContent("");
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const resolveMutation = useApiMutation<void, { id: string; resolved: boolean }>(
    async ({ id, resolved }) => {
      const res = await api.PATCH("/api/v1/repositories/{repo_id}/discussions/{comment_id}", {
        params: { path: { repo_id: repoId, comment_id: id } },
        body: { resolved } as never,
      });
      if (res.error) throw new Error(t("settings.resolveFailed"));
    },
    {
      onSuccess: () => {
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const deleteMutation = useApiMutation<void, string>(
    async (id) => {
      const res = await api.DELETE("/api/v1/repositories/{repo_id}/discussions/{comment_id}", {
        params: { path: { repo_id: repoId, comment_id: id } },
      });
      if (res.error) throw new Error(t("settings.discussionDeleteFailed"));
    },
    {
      onSuccess: () => {
        toast.success(t("settings.discussionDeleted"));
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const discussions = listQuery.data ?? [];

  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-base font-semibold">{t("settings.discussions")}</h2>
      <p className="text-muted-2 mt-1 text-xs">
        {t("settings.discussionsHint")}
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {listQuery.isLoading ? (
          <SkeletonText lines={3} />
        ) : discussions.length === 0 ? (
          <p className="text-muted-2 text-xs">{t("settings.noDiscussions")}</p>
        ) : (
          <ul className="border-edge-1 overflow-hidden rounded-md border">
            {discussions.map((item) => (
              <li key={item.id} className="border-edge-1 border-b px-3 py-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <span className="text-bone-2 text-xs font-medium">{item.author_username}</span>
                  <span className="text-faint font-mono text-2xs">
                    {item.file_path}
                    {item.line_number ? `:${item.line_number}` : ""}
                  </span>
                  <span className="text-faint text-2xs">{formatRelative(item.created_at ?? "")}</span>
                  {item.resolved ? (
                    <span className="text-sage text-2xs">{t("settings.resolved")}</span>
                  ) : null}
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      className="text-muted-2 hover:text-amber-2 text-2xs transition-colors"
                      onClick={() => resolveMutation.mutate({ id: item.id, resolved: !item.resolved })}
                    >
                      {item.resolved ? t("settings.reopen") : t("settings.resolve")}
                    </button>
                    <button
                      type="button"
                      aria-label={t("common.delete")}
                      className="text-muted-2 hover:text-rose transition-colors"
                      onClick={() => deleteMutation.mutate(item.id)}
                    >
                      <Trash2 className="size-[12px]" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <p className="text-muted mt-1 text-xs leading-relaxed whitespace-pre-wrap">
                  {item.content}
                </p>
              </li>
            ))}
          </ul>
        )}

        <div className="border-edge-1 flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center gap-2">
            <Input
              value={filePath}
              onChange={(event) => setFilePath(event.target.value)}
              placeholder={t("settings.filePath")}
              aria-label={t("settings.filePath")}
              className="h-8 font-mono text-xs"
            />
            <Input
              value={line}
              onChange={(event) => setLine(event.target.value)}
              placeholder={t("settings.lineNumber")}
              aria-label={t("settings.lineNumber")}
              className="h-8 w-28 text-xs"
            />
          </div>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={2}
            placeholder={t("settings.commentBody")}
            aria-label={t("settings.commentBody")}
            className="border-edge-2 bg-ink-950/60 text-bone placeholder:text-muted-2 focus:border-amber/40 min-h-[54px] w-full resize-none rounded-md border px-2.5 py-2 text-xs focus-visible:outline-none transition-colors"
          />
          <Button
            size="sm"
            className="self-start"
            onClick={() => createMutation.mutate()}
            disabled={!filePath.trim() || !content.trim() || createMutation.isPending}
          >
            {t("settings.createDiscussion")}
          </Button>
        </div>
      </div>
    </section>
  );
}
