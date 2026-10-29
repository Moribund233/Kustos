import { useState } from "react";

import { DiffViewer, type DiffPayload } from "@/components/editor/diff-viewer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api/client";
import { useApiQuery } from "@/lib/api/hooks";
import { formatRelative } from "@/lib/datetime/format";
import { cn } from "@/lib/utils";

/** repository_browser_service.get_commits 的提交项。 */
interface GitCommit {
  sha: string;
  message: string;
  author: { name: string; email: string; date: string };
  date: string;
  parents: string[];
}

interface CommitsResponse {
  commits?: GitCommit[];
}

/** 单行摘要：提交信息第一行，空提交给占位。 */
function summaryOf(message: string): string {
  return message.split("\n")[0]?.trim() || "（无提交信息）";
}

/**
 * 文件提交历史。
 *
 * 左列是该文件的提交（`GET /commits?path=`），右列选中提交相对父提交的 diff
 * （`GET /diff?head=&base=&path=`）；只展示当前文件，避免把整仓改动塞进窄弹窗。
 */
export function FileHistoryDialog({
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
  const [selectedSha, setSelectedSha] = useState<string | null>(null);

  const historyQuery = useApiQuery<GitCommit[]>({
    queryKey: ["code-history", repoId, branch, path],
    enabled: open && !!repoId && !!path,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/commits", {
        params: {
          path: { repo_id: repoId },
          query: { ref: branch, path, page: 1, per_page: 50 },
        },
      });
      if (res.error) throw new Error("提交历史加载失败。");
      return (res.data as CommitsResponse | undefined)?.commits ?? [];
    },
  });

  const commits = historyQuery.data ?? [];
  const activeSha = selectedSha ?? commits[0]?.sha ?? null;
  const activeCommit = commits.find((commit) => commit.sha === activeSha) ?? null;

  const diffQuery = useApiQuery<DiffPayload>({
    queryKey: ["code-history-diff", repoId, activeSha, path],
    enabled: open && !!repoId && !!activeSha,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/diff", {
        params: {
          path: { repo_id: repoId },
          query: { head: activeSha ?? "", base: activeCommit?.parents?.[0], path } as never,
        },
      });
      if (res.error) throw new Error("差异加载失败。");
      return res.data as unknown as DiffPayload;
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1040px]">
        <DialogHeader>
          <DialogTitle>提交历史</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{path}</span> · {branch}
          </DialogDescription>
        </DialogHeader>

        <div className="grid h-[62vh] min-h-[360px] grid-cols-[280px_minmax(0,1fr)] gap-3">
          <aside
            className="border-edge-1 min-h-0 overflow-auto rounded-md border"
            aria-label="提交列表"
          >
            {historyQuery.isLoading ? (
              <p className="text-muted-2 p-3 text-[11.5px]">加载中…</p>
            ) : historyQuery.error ? (
              <button
                type="button"
                className="text-muted-2 hover:text-amber-2 w-full p-3 text-left text-[11.5px] hover:underline"
                onClick={() => void historyQuery.refetch()}
              >
                提交历史加载失败，点击重试
              </button>
            ) : commits.length === 0 ? (
              <p className="text-muted-2 p-3 text-[11.5px]">这个文件还没有提交。</p>
            ) : (
              <ul>
                {commits.map((commit) => (
                  <li key={commit.sha}>
                    <button
                      type="button"
                      onClick={() => setSelectedSha(commit.sha)}
                      className={cn(
                        "border-edge-1 block w-full border-b px-3 py-2 text-left transition-colors last:border-b-0",
                        commit.sha === activeSha ? "bg-ink-750/60" : "hover:bg-ink-800/50",
                      )}
                    >
                      <span className="text-bone-2 block truncate text-[11.5px] font-medium">
                        {summaryOf(commit.message)}
                      </span>
                      <span className="text-faint mt-1 flex items-center gap-2 font-mono text-[10px]">
                        <span>{commit.sha.slice(0, 7)}</span>
                        <span>{commit.author.name}</span>
                        <span className="ml-auto">{formatRelative(commit.date)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section
            className="border-edge-1 min-h-0 overflow-auto rounded-md border p-3"
            aria-label="提交差异"
          >
            {activeCommit ? (
              <>
                <header className="mb-2">
                  <p className="text-bone text-[12.5px] font-medium">
                    {summaryOf(activeCommit.message)}
                  </p>
                  <p className="text-faint mt-1 font-mono text-[10px]">
                    {activeCommit.sha.slice(0, 10)} · {activeCommit.author.name} ·{" "}
                    {formatRelative(activeCommit.date)}
                  </p>
                </header>
                {diffQuery.isLoading ? (
                  <p className="text-muted-2 text-[11.5px]">差异加载中…</p>
                ) : diffQuery.error ? (
                  <button
                    type="button"
                    className="text-muted-2 hover:text-amber-2 text-[11.5px] hover:underline"
                    onClick={() => void diffQuery.refetch()}
                  >
                    差异加载失败，点击重试
                  </button>
                ) : diffQuery.data ? (
                  <DiffViewer payload={diffQuery.data} />
                ) : null}
              </>
            ) : (
              <p className="text-faint grid h-full place-items-center text-[11.5px]">
                选择左侧一条提交查看差异。
              </p>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
