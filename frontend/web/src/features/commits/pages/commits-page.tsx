import { useEffect, useState } from "react";
import { GitCompare } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DiffViewer, type DiffPayload } from "@/components/editor/diff-viewer";
import { RailBlock, Stage, type DockTab } from "@/components/kit/kit";
import { SkeletonCodeLines, SkeletonRows } from "@/components/kit/skeletons";
import { RepoTabs } from "@/components/layout/repo-tabs";
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
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

interface CommitRow {
  sha: string;
  message: string;
  author: { name: string; email: string; date: string };
  date: string;
  parents: string[];
}

interface BranchRow {
  name: string;
  is_default?: boolean;
}

interface CompareResult extends DiffPayload {
  base?: string;
  head?: string;
  ahead_by?: number;
  behind_by?: number;
  commits?: CommitRow[];
}

const PER_PAGE = 30;

/**
 * 提交页：按分支翻页查看提交，点击行看该提交相对父提交的 diff。
 * 对比（base...head）收在右缘浮窗里，结果开宽弹窗，避免占一个 tab。
 */
export function CommitsPage() {
  const { t } = useTranslation();
  const repo = useRepoStore((state) => state.current);
  const [branch, setBranch] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CommitRow | null>(null);
  const setCrumbs = useUiStore((state) => state.setCrumbs);

  useEffect(() => {
    setCrumbs([{ label: repo?.name ?? "—" }, { label: t("nav.commits") }]);
  }, [setCrumbs, repo?.name, t]);

  const repoId = repo?.id ?? "";
  const ref = branch ?? repo?.default_branch ?? "";

  const branchesQuery = useApiQuery<BranchRow[]>({
    queryKey: ["branches", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/branches", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error(t("commits.branchLoadFailed"));
      return (Array.isArray(res.data) ? res.data : []) as BranchRow[];
    },
  });

  const commitsQuery = useApiQuery<CommitRow[]>({
    queryKey: ["repo-commits", repoId, ref, page],
    enabled: !!repoId && !!ref,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/commits", {
        params: { path: { repo_id: repoId }, query: { ref, page, per_page: PER_PAGE } },
      });
      if (res.error) throw new Error(t("commits.loadFailed"));
      return (res.data as { commits?: CommitRow[] } | undefined)?.commits ?? [];
    },
  });

  const commits = commitsQuery.data ?? [];

  return (
    <>
    <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[30px] pb-20">
      <header className="border-edge-1 flex items-end justify-between gap-7 border-b pb-5">
        <div className="min-w-0">
          <p className="text-faint text-xs font-semibold tracking-[0.16em] uppercase">
            {repo?.path ?? "—"}
          </p>
          <h1 className="font-display text-bone mt-[7px] text-[clamp(1.75rem,2.5vw,2.3rem)] leading-none font-medium tracking-tight">
            {repo?.name ?? t("commits.title")}
          </h1>
          <p className="text-muted-2 mt-2 text-xs">
            {repo?.description || t("commits.hint")}
          </p>
        </div>
      </header>

      <RepoTabs />

      <div className="mt-4 flex items-center gap-2.5">
        <label className="text-muted-2 text-2xs font-semibold tracking-[0.13em] uppercase">
          {t("commits.branch")}
        </label>
        <select
          value={ref}
          onChange={(event) => {
            setBranch(event.target.value);
            setPage(1);
          }}
          aria-label={t("commits.branch")}
          className="border-edge-2 bg-ink-950/60 text-bone focus:border-amber/40 h-8 rounded-md border px-2 font-mono text-xs focus-visible:outline-none"
        >
          {(branchesQuery.data ?? []).map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
          {!branchesQuery.data?.length ? <option value={ref}>{ref}</option> : null}
        </select>
        <span className="text-faint ml-auto font-mono text-2xs">
          {t("commits.page", { page })}
        </span>
      </div>

      <Stage
        dock={DOCK(t)}
        panel={(tab) =>
          tab.id === "compare" ? (
            <ComparePanel repoId={repoId} defaultBranch={repo?.default_branch ?? "main"} />
          ) : null
        }
        className="mt-3"
      >
      <div className="border-edge-2 bg-ink-900/55 overflow-hidden rounded-[10px] border">
        {commitsQuery.isLoading ? (
          <SkeletonRows rows={8} leading="none" meta={false} rowClassName="px-3 py-2.5" />
        ) : commitsQuery.error ? (
          <button
            type="button"
            onClick={() => void commitsQuery.refetch()}
            className="text-muted-2 hover:text-amber-2 w-full p-4 text-left text-xs hover:underline"
          >
            {t("commits.loadFailed")}
          </button>
        ) : commits.length === 0 ? (
          <p className="text-muted-2 p-4 text-xs">{t("commits.empty")}</p>
        ) : (
          <ul>
            {commits.map((commit) => (
              <li key={commit.sha}>
                <button
                  type="button"
                  onClick={() => setSelected(commit)}
                  className="border-edge-1 hover:bg-ink-800/45 flex w-full items-center gap-3 border-b px-3 py-2.5 text-left transition-colors last:border-b-0"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-bone-2 block truncate text-xs font-medium">
                      {commit.message.split("\n")[0]}
                    </span>
                    <span className="text-faint mt-0.5 flex items-center gap-2 font-mono text-2xs">
                      <span>{commit.sha.slice(0, 7)}</span>
                      <span>{commit.author.name}</span>
                      <span className="text-muted-2">{formatRelative(commit.date)}</span>
                    </span>
                  </span>
                  <span className="text-faint text-2xs">{commit.parents.length > 1 ? "merge" : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPage((value) => Math.max(1, value - 1))}
          disabled={page <= 1}
        >
          {t("commits.prev")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPage((value) => value + 1)}
          disabled={commits.length < PER_PAGE}
        >
          {t("commits.next")}
        </Button>
      </div>
      </Stage>
    </div>

      {selected ? (
        <CommitDialog
          repoId={repoId}
          commit={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function DOCK(t: (key: string) => string): DockTab[] {
  return [{ id: "compare", icon: GitCompare, label: t("commits.compare"), kicker: t("commits.compareKicker") }];
}

/** 对比浮窗：选 base/head，展示 ahead 与变更规模，差异在宽弹窗里看。 */
function ComparePanel({ repoId, defaultBranch }: { repoId: string; defaultBranch: string }) {
  const { t } = useTranslation();
  const [base, setBase] = useState(defaultBranch);
  const [head, setHead] = useState(defaultBranch);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const branchesQuery = useApiQuery<BranchRow[]>({
    queryKey: ["branches", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/branches", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error(t("commits.branchLoadFailed"));
      return (Array.isArray(res.data) ? res.data : []) as BranchRow[];
    },
  });

  const runCompare = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await api.GET("/api/v1/repositories/{repo_id}/compare", {
        params: { path: { repo_id: repoId }, query: { base, head } },
      });
      if (res.error) throw new Error(t("commits.compareFailed"));
      setResult(res.data as unknown as CompareResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("commits.compareFailed"));
    } finally {
      setPending(false);
    }
  };

  const branches = branchesQuery.data ?? [];

  return (
    <RailBlock>
      <div className="mb-2.5 flex items-center gap-[9px]">
        <h3 className="text-muted-2 text-2xs font-semibold tracking-[0.15em] uppercase">
          {t("commits.compare")}
        </h3>
      </div>
      <div className="flex flex-col gap-2">
        {[
          { label: t("commits.base"), value: base, onChange: setBase },
          { label: t("commits.head"), value: head, onChange: setHead },
        ].map((field) => (
          <label key={field.label} className="flex flex-col gap-1">
            <span className="text-faint text-2xs font-semibold tracking-[0.12em] uppercase">
              {field.label}
            </span>
            <select
              value={field.value}
              onChange={(event) => field.onChange(event.target.value)}
              className="border-edge-2 bg-ink-950/60 text-bone h-8 rounded-md border px-2 font-mono text-xs focus-visible:outline-none"
            >
              {branches.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <Button size="sm" onClick={() => void runCompare()} disabled={!base || !head || base === head || pending}>
          {pending ? t("common.loading") : t("commits.runCompare")}
        </Button>
        {error ? <p className="text-rose text-xs">{error}</p> : null}
        {result ? (
          <div className="border-edge-1 mt-1 flex flex-col gap-1 rounded-md border p-2 text-xs">
            <p className="text-muted-2">
              {t("commits.ahead", { count: result.ahead_by ?? 0 })}
            </p>
            <p className="text-muted-2">
              {t("commits.files", { count: result.stats?.files_changed ?? 0 })} ·{" "}
              <span className="text-sage">+{result.stats?.additions ?? 0}</span>{" "}
              <span className="text-rose">−{result.stats?.deletions ?? 0}</span>
            </p>
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              {t("commits.viewDiff")}
            </Button>
          </div>
        ) : null}
      </div>

      {open && result ? (
        <Dialog open onOpenChange={(next) => (next ? undefined : setOpen(false))}>
          <DialogContent className="max-w-[1100px]">
            <DialogHeader>
              <DialogTitle>{t("commits.compareTitle", { base, head })}</DialogTitle>
              <DialogDescription>{t("commits.compareHint")}</DialogDescription>
            </DialogHeader>
            <div className="max-h-[62vh] overflow-auto">
              <DiffViewer payload={result} />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("common.close")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </RailBlock>
  );
}

/** 单条提交：相对父提交的 diff，初始提交与空树对比。 */
function CommitDialog({ repoId, commit, onClose }: { repoId: string; commit: CommitRow; onClose: () => void }) {
  const { t } = useTranslation();
  const diffQuery = useApiQuery<DiffPayload>({
    queryKey: ["commit-diff", repoId, commit.sha],
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/diff", {
        params: {
          path: { repo_id: repoId },
          query: { head: commit.sha, base: commit.parents[0] } as never,
        },
      });
      if (res.error) throw new Error(t("code.diffLoadFailed"));
      return res.data as unknown as DiffPayload;
    },
  });

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-[1100px]">
        <DialogHeader>
          <DialogTitle>{commit.message.split("\n")[0]}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{commit.sha.slice(0, 10)}</span> · {commit.author.name} ·{" "}
            {formatRelative(commit.date)}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[62vh] overflow-auto">
          {diffQuery.isLoading ? (
            <SkeletonCodeLines lines={8} className="p-3" />
          ) : diffQuery.error ? (
            <p className="text-rose text-xs">{t("code.diffLoadFailed")}</p>
          ) : diffQuery.data ? (
            <DiffViewer payload={diffQuery.data} />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
