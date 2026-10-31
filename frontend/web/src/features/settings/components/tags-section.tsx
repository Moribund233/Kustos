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

/** GET /tags 的行。 */
interface TagRow {
  name: string;
  message?: string | null;
  commit_hash?: string | null;
}

/**
 * Git 标签管理。
 *
 * 标签是按仓库存储的 git ref；创建时可写附注信息（为空则是轻量标签）。
 * Release 会引用同名标签，删除标签前后端会做引用检查。
 */
export function TagsSection({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  const tagsQuery = useApiQuery<TagRow[]>({
    queryKey: ["tags", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/tags", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error(t("settings.tagLoadFailed"));
      return (Array.isArray(res.data) ? res.data : []) as TagRow[];
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["tags", repoId] });

  const createMutation = useApiMutation<void, void>(
    async () => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/tags", {
        params: { path: { repo_id: repoId } },
        body: { name: name.trim(), message: message.trim() || null } as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("settings.tagCreateFailed"));
      }
    },
    {
      onSuccess: () => {
        toast.success(t("settings.tagCreated"));
        setName("");
        setMessage("");
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const deleteMutation = useApiMutation<void, string>(
    async (tagName) => {
      const res = await api.DELETE("/api/v1/repositories/{repo_id}/tags/{tag_name}", {
        params: { path: { repo_id: repoId, tag_name: tagName } },
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("settings.tagDeleteFailed"));
      }
    },
    {
      onSuccess: () => {
        toast.success(t("settings.tagDeleted"));
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const tags = tagsQuery.data ?? [];

  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-base font-semibold">{t("settings.tags")}</h2>
      <p className="text-muted-2 mt-1 text-xs">{t("settings.tagsHint")}</p>

      <div className="mt-4 flex flex-col gap-2">
        {tagsQuery.isLoading ? (
          <SkeletonText lines={3} />
        ) : tags.length === 0 ? (
          <p className="text-muted-2 text-xs">{t("settings.noTags")}</p>
        ) : (
          <ul className="border-edge-1 overflow-hidden rounded-md border">
            {tags.map((tag) => (
              <li
                key={tag.name}
                className="border-edge-1 flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
              >
                <span className="text-bone-2 font-mono text-xs">{tag.name}</span>
                <span className="text-faint min-w-0 flex-1 truncate text-xs">{tag.message ?? ""}</span>
                <span className="text-faint font-mono text-2xs">
                  {tag.commit_hash ? tag.commit_hash.slice(0, 7) : "—"}
                </span>
                <button
                  type="button"
                  aria-label={t("common.delete")}
                  className="text-muted-2 hover:text-rose transition-colors"
                  onClick={() => deleteMutation.mutate(tag.name)}
                >
                  <Trash2 className="size-[13px]" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("settings.tagName")}
            aria-label={t("settings.tagNameLabel")}
            className="h-8 font-mono text-xs"
          />
          <Input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={t("settings.tagMessage")}
            aria-label={t("settings.tagMessage")}
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            onClick={() => createMutation.mutate()}
            disabled={!name.trim() || createMutation.isPending}
          >
            {t("common.create")}
          </Button>
        </div>
      </div>
    </section>
  );
}
