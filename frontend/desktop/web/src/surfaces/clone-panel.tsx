import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "@kustos/ui";

import { Icon } from "@/shell/icon";
import {
  cloneErrorText,
  clonePhaseLabel,
  joinPath,
  repoNameFromURL,
  useCancelClone,
  useCloneProgress,
  useCloneRemote,
  useGitStatus,
  usePickDirectory,
} from "@/lib/clone";
import { useRepositories, type Repository } from "@/lib/repos";

/**
 * 克隆面板：选来源、选目录、看进度、能取消。
 *
 * 独立成组件是因为它有两个入口：首次启动的引导第三步，以及 Working Copy 面
 * 里的"克隆仓库"。两处逻辑一模一样，复制一份只会让两边的默认目录算法慢慢分叉。
 *
 * 地址拼接与凭据注入都在 Go 侧：这里只传 `owner/repo` 或一个完整外部地址。
 */
export function ClonePanel({
  canSkip,
  onSkip,
  onDone,
}: {
  canSkip: boolean;
  onSkip: () => void;
  onDone: (dir: string) => void;
}) {
  const { t } = useTranslation();

  const repos = useRepositories();
  const git = useGitStatus();
  const clone = useCloneRemote();
  const cancelClone = useCancelClone();
  const pick = usePickDirectory();

  const [mode, setMode] = useState<"instance" | "url">("instance");
  const [picked, setPicked] = useState<Repository | null>(null);
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [cloningDir, setCloningDir] = useState<string | null>(null);

  // 两种来源共用一条"仓库名"：它决定克隆出来的目录叫什么。
  const repoName = picked ? (picked.path.split("/").pop() ?? picked.name) : repoNameFromURL(url);
  const targetDir = parent && repoName ? joinPath(parent, repoName) : "";

  const progress = useCloneProgress(cloningDir);

  const list = useMemo(() => {
    // 归档仓库默认不列：克隆一个只读归档是合法需求，但不是默认动作。
    return (repos.data ?? []).filter((r) => !r.isArchived);
  }, [repos.data]);

  const gitMissing = git.data != null && !git.data.available;
  const hasSource = mode === "instance" ? picked != null : url.trim() !== "";
  const canClone = hasSource && targetDir !== "" && !gitMissing && cloningDir == null;

  // 位置由用户指定，所以"还没填"要在界面上说清楚缺的是哪一半：没选目录时
  // 说"选一个位置"，选了目录但还没选仓库时说"先选仓库"。都笼统说成
  // "请先选择仓库"会让人以为目录已经有了。
  const dirText = targetDir
    ? targetDir
    : !parent
      ? t("onboarding.dirChoose")
      : t("onboarding.dirUnknown");

  const start = () => {
    if (!canClone || !targetDir) return;
    setCloningDir(targetDir);
    clone.mutate(
      {
        repoPath: mode === "instance" ? (picked?.path ?? "") : "",
        url: mode === "url" ? url.trim() : "",
        branch: mode === "instance" ? (picked?.defaultBranch ?? "") : "",
        dir: targetDir,
      },
      {
        onSuccess: () => {
          setCloningDir(null);
          onDone(targetDir);
        },
        onError: () => setCloningDir(null),
      },
    );
  };

  return (
    <div className="flex flex-col gap-2.5">
      {gitMissing && (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--color-rose)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-rose)_8%,transparent)] px-3 py-2">
          <p className="text-[12px] text-[var(--color-rose-2)]">{t("onboarding.gitMissing")}</p>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted">
            {t("onboarding.gitMissingHint")}
          </p>
        </div>
      )}
      {git.data?.available && (
        <p className="text-[10.5px] text-faint">
          {t("onboarding.gitVersion", { version: git.data.version })}
        </p>
      )}

      {/* 来源切换 */}
      <div className="flex gap-1">
        {(["instance", "url"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setPicked(null);
            }}
            className={[
              "rounded-[5px] border px-2 py-1 text-[11px]",
              mode === m
                ? "border-[rgba(242,174,91,0.45)] bg-[rgba(242,174,91,0.12)] text-[var(--color-amber-2)]"
                : "border-[var(--color-edge-2)] text-muted hover:text-bone-2",
            ].join(" ")}
          >
            {m === "instance" ? t("onboarding.fromInstance") : t("onboarding.fromURL")}
          </button>
        ))}
      </div>

      {mode === "instance" ? (
        <div className="max-h-[180px] overflow-y-auto rounded-md border border-[var(--color-edge-1)]">
          {repos.isLoading ? (
            <p className="px-3 py-2 text-[11.5px] text-faint">{t("onboarding.loadingRepos")}</p>
          ) : list.length === 0 ? (
            <p className="px-3 py-2 text-[11.5px] leading-relaxed text-faint">
              {t("onboarding.noRepos")}
            </p>
          ) : (
            list.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setPicked(r)}
                className={[
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px]",
                  r.id === picked?.id
                    ? "bg-[var(--color-ink-800)] text-bone"
                    : "text-muted hover:bg-[var(--color-ink-850)]",
                ].join(" ")}
              >
                <Icon name="book" size={12} />
                <span className="truncate">{r.path}</span>
                {r.isPublic && (
                  <span className="ml-auto shrink-0 text-[10px] text-faint">
                    {t("onboarding.publicRepo")}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      ) : (
        <div>
          <label htmlFor="clone-url" className="mb-1 block text-[11px] text-faint">
            {t("onboarding.urlLabel")}
          </label>
          <Input
            id="clone-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/owner/repo.git"
            spellCheck={false}
            className="font-mono text-[11.5px]"
          />
        </div>
      )}

      {/* 目标目录：位置由用户挑，仓库名由仓库决定 */}
      <div>
        <label className="mb-1 block text-[11px] text-faint">{t("onboarding.dirLabel")}</label>
        <div className="flex gap-2">
          <div className="flex h-9 min-w-0 flex-1 items-center rounded-md border border-[var(--color-edge-2)] px-3 font-mono text-[11px]">
            <span className={dirText === targetDir ? "truncate text-bone-2" : "truncate text-faint"}>
              {dirText}
            </span>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              pick.mutate(
                { title: t("onboarding.dirLabel"), start: parent ?? "" },
                { onSuccess: (chosen) => chosen && setParent(chosen) },
              )
            }
            disabled={pick.isPending}
          >
            {t("onboarding.pickDir")}
          </Button>
        </div>
      </div>

      {/* 进度 */}
      {progress && (
        <div className="rounded-md border border-[var(--color-edge-1)] px-3 py-2">
          <p className="text-[11px] text-bone-2">
            {clonePhaseLabel(progress.phase, t)}
            {progress.percent >= 0 && (
              <span className="ml-1.5 font-mono text-[10.5px] text-faint">{progress.percent}%</span>
            )}
          </p>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--color-ink-800)]">
            <div
              className="h-full bg-[var(--color-amber)] transition-[width] duration-300"
              style={{ width: `${progress.percent >= 0 ? progress.percent : 8}%` }}
            />
          </div>
        </div>
      )}

      {clone.isError && (
        <p className="text-[11px] leading-relaxed text-[var(--color-rose)]">
          {cloneErrorText(clone.error, t)}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        {cloningDir ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => cancelClone.mutate(cloningDir)}
            disabled={cancelClone.isPending}
          >
            {t("onboarding.cancelClone")}
          </Button>
        ) : (
          <Button type="button" onClick={start} disabled={!canClone}>
            {clone.isPending ? t("onboarding.cloning") : t("onboarding.clone")}
          </Button>
        )}
        {canSkip && !cloningDir && (
          <button
            type="button"
            onClick={onSkip}
            className="text-[11px] text-faint underline-offset-2 hover:text-bone hover:underline"
          >
            {t("onboarding.skip")}
          </button>
        )}
      </div>
      {canSkip && !cloningDir && <p className="text-[10.5px] text-faint">{t("onboarding.skipHint")}</p>}
    </div>
  );
}
