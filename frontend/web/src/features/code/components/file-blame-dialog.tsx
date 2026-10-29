import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api/client";
import { useApiQuery } from "@/lib/api/hooks";
import { formatRelative } from "@/lib/datetime/format";

/** repository_browser_service.get_blame 的出参。 */
interface BlameHunk {
  final_start_line_number: number;
  lines_in_hunk: number;
  final_commit_id: string;
  commit: {
    sha: string;
    summary: string;
    author: { name: string; email: string; date: string };
  };
}

interface BlameResponse {
  path: string;
  ref: string;
  hunks: BlameHunk[];
}

/**
 * 文件行级追溯。
 *
 * 后端按 hunk 聚合（同一提交的连续行合并成一段），这里直接按段展示
 * 「行号区间 → 作者 / 提交摘要 / 时间」，不再逐行渲染，避免长文件卡顿。
 */
export function FileBlameDialog({
  repoId,
  branch,
  path,
  open,
  onOpenChange,
}: {
  repoId: string;
  branch: string;
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const blameQuery = useApiQuery<BlameResponse>({
    queryKey: ["code-blame", repoId, branch, path],
    enabled: open && !!repoId && !!path,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/blame", {
        params: { path: { repo_id: repoId }, query: { path, ref: branch } },
      });
      if (res.error) throw new Error(t("code.blameLoadFailed"));
      return res.data as unknown as BlameResponse;
    },
  });

  const hunks = blameQuery.data?.hunks ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[860px]">
        <DialogHeader>
          <DialogTitle>{t("code.blameTitle")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{path}</span> · {branch}
          </DialogDescription>
        </DialogHeader>

        <div className="border-edge-1 max-h-[62vh] min-h-[240px] overflow-auto rounded-md border">
          {blameQuery.isLoading ? (
            <p className="text-muted-2 p-3 text-[11.5px]">{t("common.loading")}</p>
          ) : blameQuery.error ? (
            <button
              type="button"
              className="text-muted-2 hover:text-amber-2 w-full p-3 text-left text-[11.5px] hover:underline"
              onClick={() => void blameQuery.refetch()}
            >
              {t("code.blameLoadFailed")}
            </button>
          ) : hunks.length === 0 ? (
            <p className="text-muted-2 p-3 text-[11.5px]">{t("code.noBlameLines")}</p>
          ) : (
            <ul>
              {hunks.map((hunk) => {
                const start = hunk.final_start_line_number;
                const end = start + hunk.lines_in_hunk - 1;
                return (
                  <li
                    key={`${hunk.final_commit_id}-${start}`}
                    className="border-edge-1 flex items-start gap-3 border-b px-3 py-2 last:border-b-0"
                  >
                    <span className="text-faint mt-0.5 w-[74px] shrink-0 font-mono text-[10.5px]">
                      {start === end ? `L${start}` : `L${start}-${end}`}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-bone-2 block truncate text-[11.5px]">
                        {hunk.commit.summary}
                      </span>
                      <span className="text-faint mt-0.5 block font-mono text-[10px]">
                        {hunk.commit.sha.slice(0, 7)} · {hunk.commit.author.name} ·{" "}
                        {formatRelative(hunk.commit.author.date)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
