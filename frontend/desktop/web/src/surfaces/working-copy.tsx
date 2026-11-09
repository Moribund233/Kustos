import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/shell/icon";
import {
  useAddWorkingCopy,
  useCommit,
  useFetch,
  useFileDiff,
  useOpenInEditor,
  usePush,
  usePushCommand,
  useRevealInFileManager,
  useStage,
  useWorkingCopies,
  useWorkingCopyStatus,
  type WorkingCopy,
} from "@/lib/working-copy";
import { diffStats, parseUnifiedDiff } from "@/lib/unified-diff";

/**
 * Working Copy 面：仓库 → 变更 → diff → 暂存 → 提交。
 *
 * 结构对齐原型 `docs/prototype/desktop/working-copy.html`：
 *
 *   listcol
 *   ├ list-head（标题 + 计数 + 路径 + Changes/History/Stashes 分段）
 *   ├ wc-branch（分支 + ↑N/↓N chip）
 *   ├ list-scroll（Staged / Changes / Untracked 三段 + file-row）
 *   └ commitbar（textarea + 头像行 + Commit / Commit & push）
 *
 *   detail
 *   ├ detail-head（eyebrow + 大标题 + 元信息 + 右侧动作）
 *   └ detail-body（banner + diff 块 + Before you push）
 *
 *   insp（Facts/Blame）
 *
 * 这是桌面端相对 Web 最独特的一面：只有本机知道你的工作树长什么样。
 * 所有数据来自本地系统 git，**断网也能看、能暂存、能提交**。
 */

export interface WorkingCopyState {
  copies: WorkingCopy[];
  active: WorkingCopy | null;
  status: {
    branch: string;
    dirty: boolean;
    ahead: number;
    behind: number;
    changes: { path: string; origPath?: string; kind: string; staged: boolean; added: number; removed: number }[];
  } | null;
  loading: boolean;
  error: unknown;
  selectedPath: string | null;
  setSelectedPath: (p: string | null) => void;
  setActiveId: (id: string) => void;
  addPath: string;
  setAddPath: (p: string) => void;
  adding: boolean;
  setAdding: (v: boolean) => void;
  add: () => void;
  addingNow: boolean;
  addErr: unknown;
  stage: ReturnType<typeof useStage>;
  commit: ReturnType<typeof useCommit>;
  commitMessage: string;
  setCommitMessage: (v: string) => void;
  stagedSide: boolean;
  setStagedSide: (v: boolean) => void;
  diff: ReturnType<typeof useFileDiff>;
  selectedGroup: { path: string; origPath?: string; kind: string; staged: boolean; added: number; removed: number } | null;
  /** 主动重扫状态与 diff：工作树会被外部编辑器改动。 */
  refresh: () => void;
  refetching: boolean;
  /** 推送（凭证走系统 git 的 credential helper，不经服务端）。 */
  push: ReturnType<typeof usePush>;
  fetchRemote: ReturnType<typeof useFetch>;
  /** 在外部编辑器中打开选中文件。 */
  openInEditor: ReturnType<typeof useOpenInEditor>;
  revealInFileManager: ReturnType<typeof useRevealInFileManager>;
}

/** 汇总 Working Copy 面的全部状态；由外层装配进 Shell。 */
export function useWorkingCopySurface(): WorkingCopyState {
  const copies = useWorkingCopies();
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [stagedSide, setStagedSide] = useState(false);

  const list = copies.data ?? [];
  const active = list.find((c) => c.id === activeId) ?? list[0] ?? null;
  const status = useWorkingCopyStatus(active?.id ?? null);

  const view = status.data
    ? {
        branch: status.data.branch,
        dirty: status.data.dirty,
        ahead: status.data.ahead,
        behind: status.data.behind,
        changes: (status.data.changes ?? []).map((c) => ({
          path: c.path,
          origPath: c.origPath,
          kind: String(c.kind),
          staged: c.staged,
          added: c.added,
          removed: c.removed,
        })),
      }
    : null;

  const changeList = view?.changes ?? [];
  const selectedGroup =
    changeList.find((c) => c.path === selectedPath) ?? changeList[0] ?? null;
  const effectiveStaged = selectedGroup ? selectedGroup.staged || stagedSide : stagedSide;

  const stage = useStage(active?.id ?? null);
  const commit = useCommit(active?.id ?? null);
  const diff = useFileDiff(active?.id ?? null, selectedGroup?.path ?? null, effectiveStaged);
  const addMutation = useAddWorkingCopy();
  const push = usePush(active?.id ?? null);
  const fetchRemote = useFetch(active?.id ?? null);
  const openInEditor = useOpenInEditor(active?.id ?? null);
  const revealInFileManager = useRevealInFileManager(active?.id ?? null);

  return {
    copies: list,
    active,
    status: view,
    loading: status.isLoading,
    error: status.error,
    selectedPath,
    setSelectedPath,
    setActiveId: (id: string) => {
      setActiveIdState(id);
      setSelectedPath(null);
    },
    addPath,
    setAddPath,
    adding,
    setAdding,
    add: () =>
      addMutation.mutate(addPath.trim(), {
        onSuccess: (wc: WorkingCopy) => {
          setAddPath("");
          setAdding(false);
          setActiveIdState(wc.id);
          setSelectedPath(null);
        },
      }),
    addingNow: addMutation.isPending,
    addErr: addMutation.error,
    stage,
    commit,
    commitMessage,
    setCommitMessage,
    stagedSide,
    setStagedSide,
    diff,
    selectedGroup,
    refresh: () => {
      void status.refetch();
      void copies.refetch();
      void diff.refetch();
    },
    refetching: status.isFetching,
    push,
    fetchRemote,
    openInEditor,
    revealInFileManager,
  };
}

/* ------------------------------------------------------------------ */
/* 左栏                                                                */
/* ------------------------------------------------------------------ */

export function WorkingCopyList({
  state,
}: {
  state: ReturnType<typeof useWorkingCopySurface>;
}) {
  const { t } = useTranslation();
  const [seg, setSeg] = useState<"changes" | "history" | "stashes">("changes");
  const changes = state.status?.changes ?? [];
  const staged = useMemo(() => changes.filter((c) => c.staged), [changes]);
  const unstaged = useMemo(
    () => changes.filter((c) => !c.staged && c.kind !== "untracked"),
    [changes],
  );
  const untracked = useMemo(() => changes.filter((c) => c.kind === "untracked"), [changes]);
  const total = changes.length;

  return (
    <section className="flex h-full flex-col" aria-label={t("workingCopy.title")}>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <h1 className="text-[13px] font-medium text-[var(--color-bone)]">{t("workingCopy.title")}</h1>
          <span className="text-[11px] text-[var(--color-amber)] tabular-nums">{total}</span>
          <span className="ml-auto truncate font-mono text-[10.5px] text-[var(--color-faint)]">
            {state.active?.path ?? "—"}
          </span>
        </div>
        <div className="mt-2 flex gap-0.5 rounded-[7px] border border-[var(--color-edge-1)] bg-[rgba(8,13,16,0.55)] p-0.5">
          {(
            [
              ["changes", t("workingCopy.segments.changes")],
              ["history", t("workingCopy.segments.history")],
              ["stashes", t("workingCopy.segments.stashes")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSeg(id)}
              className={[
                "h-[22px] flex-1 rounded-[5px] text-[11px] whitespace-nowrap",
                seg === id
                  ? "bg-[var(--color-ink-750)] text-[var(--color-bone)] shadow-[inset_0_1px_0_rgba(240,231,216,0.045)]"
                  : "text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 分支条：常驻显式当前分支与领先/落后。 */}
      <div className="flex shrink-0 items-center gap-[7px] border-b border-[var(--color-edge-1)] px-3 py-1.5 text-[11px]">
        <Icon name="branch" size={13} className="text-[var(--color-muted-2)]" />
        <span className="truncate text-[var(--color-bone-2)]">
          {state.status?.branch || "—"}
        </span>
        <span className="ml-auto inline-flex h-[18px] items-center rounded-[4px] bg-[var(--color-sage-wash)] px-1.5 text-[10.5px] text-[var(--color-sage)] tabular-nums">
          ↑{state.status?.ahead ?? 0}
        </span>
        <span className="inline-flex h-[18px] items-center rounded-[4px] border border-[var(--color-edge-1)] px-1.5 text-[10.5px] text-[var(--color-muted-2)] tabular-nums">
          ↓{state.status?.behind ?? 0}
        </span>
        {/* 工作树会被外部编辑器改动，必须给一个主动重扫的入口。 */}
        <button
          type="button"
          onClick={state.refresh}
          disabled={state.refetching}
          aria-label="重新扫描工作树"
          title="重新扫描工作树"
          className="ml-1 text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)] disabled:opacity-40"
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.loading && <Hint>{t("workingCopy.loading")}</Hint>}
        {!state.loading && state.error != null && (
          <Hint tone="rose">{errorText(state.error)}</Hint>
        )}

        {!state.loading && state.error == null && total === 0 && (
          <Hint>{t("workingCopy.clean")}</Hint>
        )}

        {seg !== "changes" && total >= 0 && (
          <Hint>
            {t("workingCopy.notLoaded", { segment: seg === "history" ? t("workingCopy.segments.history") : t("workingCopy.segments.stashes") })}
          </Hint>
        )}

        {seg === "changes" && staged.length > 0 && (
          <GroupLabel label="Staged" n={staged.length} tone="sage" />
        )}
        {seg === "changes" &&
          staged.map((c) => (
            <FileRow
              key={`s-${c.path}`}
              change={c}
              active={c.path === state.selectedGroup?.path}
              onSelect={() => state.setSelectedPath(c.path)}
              action="取消暂存"
              onAction={() => state.stage.mutate({ paths: [c.path], staged: false })}
              disabled={state.stage.isPending}
            />
          ))}

        {seg === "changes" && unstaged.length > 0 && (
          <GroupLabel label="Changes" n={unstaged.length} />
        )}
        {seg === "changes" &&
          unstaged.map((c) => (
            <FileRow
              key={`c-${c.path}`}
              change={c}
              active={c.path === state.selectedGroup?.path}
              onSelect={() => state.setSelectedPath(c.path)}
              action="暂存"
              onAction={() => state.stage.mutate({ paths: [c.path], staged: true })}
              disabled={state.stage.isPending}
            />
          ))}

        {seg === "changes" && untracked.length > 0 && (
          <GroupLabel label="Untracked" n={untracked.length} />
        )}
        {seg === "changes" &&
          untracked.map((c) => (
            <FileRow
              key={`u-${c.path}`}
              change={c}
              active={c.path === state.selectedGroup?.path}
              onSelect={() => state.setSelectedPath(c.path)}
              action="暂存"
              onAction={() => state.stage.mutate({ paths: [c.path], staged: true })}
              disabled={state.stage.isPending}
            />
          ))}

        {/* 添加仓库：没有仓库时是唯一入口，有仓库时藏在底部。 */}
        <div className="border-t border-[var(--color-edge-1)] px-3 py-2">
          {!state.adding ? (
            <button
              type="button"
              onClick={() => state.setAdding(true)}
              className="w-full rounded-[7px] border border-dashed border-[var(--color-edge-2)] py-1.5 text-[11px] text-[var(--color-muted-2)] hover:border-[var(--color-amber)] hover:text-[var(--color-bone-2)]"
            >
              + {t("workingCopy.addRepo")}
            </button>
          ) : (
            <div className="flex flex-col gap-1">
              <input
                value={state.addPath}
                onChange={(e) => state.setAddPath(e.target.value)}
                placeholder="/path/to/repo"
                autoFocus
                className="h-6 rounded-[5px] border border-[var(--color-edge-2)] bg-[var(--color-ink-850)] px-2 font-mono text-[11px] text-[var(--color-bone)] outline-none focus:border-[var(--color-amber)]"
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={state.addingNow || state.addPath.trim() === ""}
                  onClick={state.add}
                  className="h-6 flex-1 rounded-[5px] border border-[rgba(242,174,91,0.45)] bg-[linear-gradient(180deg,rgba(242,174,91,0.22),rgba(201,122,50,0.18))] text-[11px] text-[var(--color-amber-2)] disabled:opacity-40"
                >
                  {state.addingNow ? "加入中…" : "加入"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    state.setAdding(false);
                    state.setAddPath("");
                  }}
                  className="h-6 rounded-[5px] border border-[var(--color-edge-2)] px-2 text-[11px] text-[var(--color-muted-2)]"
                >
                  取消
                </button>
              </div>
              {state.addErr != null && (
                <p className="text-[10.5px] leading-relaxed text-[var(--color-rose)]">
                  {errorText(state.addErr)}
                </p>
              )}
            </div>
          )}
        </div>

        {/* 仓库切换：多仓库并存是常态。 */}
        {state.copies.length > 1 && (
          <div className="border-t border-[var(--color-edge-1)]">
            <GroupLabel label="仓库" n={state.copies.length} />
            {state.copies.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => state.setActiveId(c.id)}
                className={[
                  "flex w-full items-center gap-2 py-1.5 pr-3 pl-2.5 text-left text-[11px]",
                  c.id === state.active?.id
                    ? "bg-[var(--color-ink-800)] text-[var(--color-bone)]"
                    : "text-[var(--color-muted)] hover:bg-[var(--color-ink-850)]",
                ].join(" ")}
              >
                <Icon name="folder" size={12} />
                <span className="truncate">{c.path.split(/[\\/]/).pop() || c.path}</span>
                {c.dirty && (
                  <span className="ml-auto text-[10px] text-[var(--color-amber)]">●</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <CommitBar state={state} />
    </section>
  );
}

function CommitBar({ state }: { state: ReturnType<typeof useWorkingCopySurface> }) {
  const { t } = useTranslation();
  const staged = (state.status?.changes ?? []).filter((c) => c.staged);

  return (
    <div className="shrink-0 border-t border-[var(--color-edge-1)] p-2.5">
      <label className="mb-1 block text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase">{t("workingCopy.commitMessage")}</label>
      <textarea
        value={state.commitMessage}
        onChange={(e) => state.setCommitMessage(e.target.value)}
        rows={2}
        placeholder={t("workingCopy.commitMessagePlaceholder")}
        className="w-full resize-none rounded-[5px] border border-[var(--color-edge-2)] bg-[var(--color-ink-850)] px-2 py-1.5 text-[11.5px] leading-relaxed text-[var(--color-bone)] outline-none focus:border-[var(--color-amber)]"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="grid h-[22px] w-[22px] place-items-center rounded-full border border-[var(--color-edge-2)] bg-[var(--color-ink-800)] text-[9.5px] text-[var(--color-bone-2)]">
          YO
        </span>
        <span className="text-[10.5px] text-[var(--color-muted-2)]">
          {t("workingCopy.commitTarget", { branch: state.status?.branch || "—" })}
        </span>
        <span className="ml-auto inline-flex h-[18px] items-center rounded-[4px] bg-[var(--color-amber-wash)] px-1.5 text-[10px] text-[var(--color-amber)]">
          {t("workingCopy.stagedFiles", { count: staged.length })}
        </span>
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <button
          type="button"
          disabled={
            state.commit.isPending ||
            state.commitMessage.trim() === "" ||
            staged.length === 0
          }
          onClick={() =>
            state.commit.mutate(
              { message: state.commitMessage.trim(), amend: false },
              { onSuccess: () => state.setCommitMessage("") },
            )
          }
          className="h-[26px] flex-1 rounded-[7px] border border-[var(--color-edge-2)] bg-[var(--color-ink-800)] text-[11.5px] text-[var(--color-bone-2)] hover:text-[var(--color-bone)] disabled:opacity-40"
        >
          {state.commit.isPending ? t("workingCopy.committing") : t("workingCopy.commit")}
        </button>
        {/* 提交推送：先提交（若有暂存内容），再推送。
            凭证走系统 git，桌面端不接触远端密码。 */}
        <button
          type="button"
          disabled={state.push.isPending || (staged.length === 0 && !state.status?.ahead)}
          onClick={() => {
            const message = state.commitMessage.trim();
            if (message !== "" && staged.length > 0) {
              state.commit.mutate(
                { message, amend: false },
                {
                  onSuccess: () => {
                    state.setCommitMessage("");
                    state.push.mutate(false);
                  },
                },
              );
              return;
            }
            state.push.mutate(false);
          }}
          className="h-[26px] flex-1 rounded-[7px] border border-[rgba(242,174,91,0.45)] bg-[linear-gradient(180deg,rgba(242,174,91,0.22),rgba(201,122,50,0.18))] text-[11.5px] text-[var(--color-amber-2)] disabled:opacity-40"
        >
          {state.push.isPending ? t("workingCopy.pushing") : t("workingCopy.commitAndPush")}
        </button>
      </div>
      {state.commit.error != null && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--color-rose)]">
          {errorText(state.commit.error)}
        </p>
      )}
      {state.push.error != null && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--color-rose)]">
          {errorText(state.push.error)}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 右栏                                                                */
/* ------------------------------------------------------------------ */

export function WorkingCopyDetail({
  state,
}: {
  state: ReturnType<typeof useWorkingCopySurface>;
}) {
  const { t } = useTranslation();
  const path = state.selectedGroup?.path ?? null;
  const parsed = useMemo(() => parseUnifiedDiff(state.diff.data ?? ""), [state.diff.data]);
  const stats = useMemo(() => diffStats(parsed), [parsed]);

  if (!path) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[15px] text-[var(--color-bone)]">工作树是干净的</p>
        <p className="max-w-[46ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
          没有未提交的改动。改动出现在这里后，可以逐个文件暂存并提交。
          这些改动只存在于本机，队友看不到，直到你推送。
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-5 pt-[13px] pb-[11px]">
        <div className="flex items-center gap-[7px] text-[10px] tracking-[0.14em] text-[var(--color-faint)] uppercase">
          <span>{t("workingCopy.label")}</span>
          <span>·</span>
          <span>{labelOf(state.selectedGroup?.kind ?? "")}</span>
          <span className="ml-auto inline-flex items-center gap-1.5 tracking-normal normal-case">
            <button
              type="button"
              disabled={!state.selectedGroup?.staged}
              onClick={() => state.setStagedSide(!state.stagedSide)}
              className="h-[22px] rounded-[7px] border border-[var(--color-edge-2)] px-2 text-[10.5px] text-[var(--color-bone-2)] disabled:opacity-40"
            >
              {state.selectedGroup?.staged && state.stagedSide ? "看工作区" : "看暂存区"}
            </button>
            <button
              type="button"
              disabled={!state.selectedGroup || state.openInEditor.isPending}
              title={t("workingCopy.openInEditor")}
              onClick={() =>
                state.selectedGroup &&
                state.openInEditor.mutate(state.selectedGroup.path)
              }
              className="h-[22px] rounded-[7px] border border-[var(--color-edge-2)] px-2 text-[10.5px] text-[var(--color-bone-2)] hover:border-[var(--color-edge-3)] disabled:opacity-40"
            >
              {t("workingCopy.openInEditor")}
            </button>
            <button
              type="button"
              disabled
              title="放弃改动的确认流程待补"
              className="h-[22px] rounded-[7px] border border-[var(--color-edge-2)] px-2 text-[10.5px] opacity-40"
            >
              放弃
            </button>
            <button
              type="button"
              onClick={() =>
                state.selectedGroup &&
                state.stage.mutate({
                  paths: [state.selectedGroup.path],
                  staged: !state.selectedGroup.staged,
                })
              }
              className="h-[22px] rounded-[7px] border border-[rgba(242,174,91,0.45)] bg-[linear-gradient(180deg,rgba(242,174,91,0.22),rgba(201,122,50,0.18))] px-2 text-[10.5px] text-[var(--color-amber-2)]"
            >
              {state.selectedGroup?.staged ? "取消暂存整个文件" : "暂存整个文件"}
            </button>
          </span>
        </div>
        <h2 className="mt-1 truncate font-mono text-[15px] font-medium tracking-[-0.01em] text-[var(--color-bone)]">
          {path}
        </h2>
        <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-[var(--color-muted-2)]">
          <span className="inline-flex h-[18px] items-center rounded-[4px] bg-[var(--color-sage-wash)] px-1.5 text-[var(--color-sage)]">
            +{stats.added}
          </span>
          <span className="inline-flex h-[18px] items-center rounded-[4px] bg-[var(--color-rose-wash)] px-1.5 text-[var(--color-rose)]">
            −{stats.removed}
          </span>
          {state.selectedGroup?.staged && <span>· 已在暂存区</span>}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-[74ch]">
          <div className="mb-3.5 flex items-start gap-[9px] rounded-[7px] border border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(19,32,39,0.5),rgba(12,21,26,0.62))] px-3 py-2">
            <Icon name="lock" size={13} className="mt-px shrink-0 text-[var(--color-muted-2)]" />
            <span className="text-[11px] leading-relaxed text-[var(--color-muted)]">
              这些改动只在你的机器上。推送之前，队友看不到任何内容。
            </span>
          </div>

          <div className="overflow-hidden rounded-[7px] border border-[var(--color-edge-1)] bg-[rgba(6,9,11,0.4)] font-mono text-[11px] leading-[1.62]">
            <div className="flex items-center gap-2 border-b border-[var(--color-edge-1)] bg-[var(--color-ink-850)] px-2.5 py-[5px] font-sans text-[10.5px] text-[var(--color-muted-2)]">
              <Icon name="file" size={12} />
              <span className="truncate font-mono">{path}</span>
              <span className="text-[var(--color-sage)]">+{stats.added}</span>
              <span className="text-[var(--color-rose)]">−{stats.removed}</span>
            </div>

            {state.diff.isLoading && <p className="p-3 text-[11px] text-[var(--color-muted)]">正在读取差异…</p>}
            {!state.diff.isLoading && parsed.note !== "" && (
              <p className="p-3 text-[11px] text-[var(--color-muted)]">{parsed.note}</p>
            )}

            {parsed.hunks.map((hunk, hi) => (
              <div key={hi}>
                <div className="flex items-center gap-2 bg-[rgba(131,169,196,0.07)] px-2.5 py-[3px] text-[10.5px] text-[var(--color-sky)]">
                  <span>{hunk.header}</span>
                  <button
                    type="button"
                    disabled
                    title="逐 hunk 暂存需要把 patch 按块写入索引，等 DiffService 支持后开放"
                    className="ml-auto rounded-[5px] border border-[var(--color-edge-2)] px-1.5 text-[10px] opacity-40"
                  >
                    暂存此块
                  </button>
                </div>
                {hunk.lines.map((line, li) => (
                  <div key={li} className="flex whitespace-pre">
                    <span className="w-10 shrink-none pr-2.5 text-right text-[var(--color-faint)] select-none">
                      {line.oldLine ?? ""}
                    </span>
                    <span className="w-10 shrink-none pr-2.5 text-right text-[var(--color-faint)] select-none">
                      {line.newLine ?? ""}
                    </span>
                    <span
                      className={
                        line.kind === "add"
                          ? "w-3 shrink-none text-[var(--color-sage)] select-none"
                          : line.kind === "remove"
                            ? "w-3 shrink-none text-[var(--color-rose)] select-none"
                            : "w-3 shrink-none text-[var(--color-faint)] select-none"
                      }
                    >
                      {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
                    </span>
                    <span
                      className={
                        line.kind === "add"
                          ? "bg-[var(--color-sage-wash)] pr-3 text-[var(--color-sage-2)]"
                          : line.kind === "remove"
                            ? "bg-[var(--color-rose-wash)] pr-3 text-[var(--color-rose-2)]"
                            : "pr-3 text-[var(--color-bone-2)]"
                      }
                    >
                      {line.text === "" ? "\u00a0" : line.text}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <p className="mt-4 mb-1 text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase">
            Before you push
          </p>
          <div className="rounded-[7px] border border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(23,38,46,0.72),rgba(14,24,29,0.82))] px-3 py-2">
            <p className="text-[11px] leading-relaxed text-[var(--color-muted-2)]">
              本地验证会在推送前显示这里。它需要 FileService 与任务执行能力，
              目前还没接入。
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

/** 详情右侧的事实面板。 */
export function WorkingCopyInspector({
  state,
}: {
  state: ReturnType<typeof useWorkingCopySurface>;
}) {
  const { t } = useTranslation();
  const changes = state.status?.changes ?? [];
  const stagedCount = changes.filter((c) => c.staged).length;

  return (
    <aside
      aria-label={t("workingCopy.inspector.title")}
      className="flex w-[292px] shrink-0 flex-col border-l border-[var(--color-edge-1)] bg-[var(--color-ink-900)]"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-edge-1)] px-3 py-2.5">
        <div className="flex gap-0.5">
          <button
            type="button"
            className="h-[22px] rounded-[5px] bg-[var(--color-ink-750)] px-[7px] text-[11px] text-[var(--color-bone)]"
          >{t("workingCopy.inspector.tabFacts")}</button>
          <button
            type="button"
            className="h-[22px] rounded-[5px] px-[7px] text-[11px] text-[var(--color-muted-2)]"
          >{t("workingCopy.inspector.tabBlame")}</button>
        </div>
        <button
          type="button"
          aria-label={t("workingCopy.inspector.close")}
          className="ml-auto text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]"
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pt-2.5 pb-6">
        <SectionLabel>{t("workingCopy.inspector.sectionFile")}</SectionLabel>
        <dl>
          <KV k={t("workingCopy.inspector.path")} v={state.selectedGroup?.path ?? "—"} mono />
          <KV k={t("workingCopy.inspector.change")} v={labelOf(state.selectedGroup?.kind ?? "")} />
          <KV k={t("workingCopy.inspector.staged")} v={state.selectedGroup?.staged ? "是" : "否"} />
        </dl>

        <SectionLabel>{t("workingCopy.inspector.sectionLocal")}</SectionLabel>
        <dl>
          <KV k={t("workingCopy.inspector.stagedFiles")} v={`${stagedCount} / ${changes.length}`} />
          <KV k={t("workingCopy.inspector.branch")} v={state.status?.branch || "—"} mono />
          <KV k={t("workingCopy.inspector.aheadBehind")} v={`${state.status?.ahead ?? 0} / ${state.status?.behind ?? 0}`} />
        </dl>

        <SectionLabel>{t("workingCopy.inspector.sectionNext")}</SectionLabel>
        <div className="flex flex-col gap-1.5">
          {/* 拉取：只更新远端引用，不动工作区。 */}
          <button
            type="button"
            disabled={state.fetchRemote.isPending}
            onClick={() => state.fetchRemote.mutate()}
            className="h-[26px] rounded-[7px] border border-[var(--color-edge-2)] bg-[var(--color-ink-800)] text-[11px] text-[var(--color-bone-2)] hover:border-[var(--color-edge-3)] hover:text-[var(--color-bone)] disabled:opacity-40"
          >
            {state.fetchRemote.isPending ? t("workingCopy.fetching") : t("workingCopy.fetch")}
          </button>

          {/* 推送：普通推送直接执行，凭证由系统 git 处理。 */}
          <button
            type="button"
            disabled={state.push.isPending}
            onClick={() => state.push.mutate(false)}
            className="h-[26px] rounded-[7px] border border-[var(--color-edge-2)] bg-[var(--color-ink-800)] text-[11px] text-[var(--color-bone-2)] hover:border-[var(--color-edge-3)] hover:text-[var(--color-bone)] disabled:opacity-40"
          >
            {state.push.isPending ? t("workingCopy.pushing") : t("workingCopy.push")}
          </button>

          {/* 强制推送是破坏性操作：先展示将要执行的完整命令再确认。
              "确认强制推送？"无法让人判断后果，完整命令可以。 */}
          <ForcePushBlock state={state} />

          <span className="text-[10.5px] leading-relaxed text-[var(--color-faint)]">
            {t("workingCopy.inspector.nextHint")}
          </span>
        </div>
      </div>
    </aside>
  );
}

/** 强制推送：两段式确认，并显示完整命令。 */
function ForcePushBlock({ state }: { state: ReturnType<typeof useWorkingCopySurface> }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const cmd = usePushCommand(state.active?.id ?? null, true, confirming);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="h-[26px] rounded-[7px] border border-[color-mix(in_srgb,var(--color-rose)_35%,transparent)] text-[11px] text-[var(--color-rose)] hover:bg-[var(--color-rose-wash)]"
      >
        {t("workingCopy.forcePush")}
      </button>
    );
  }

  return (
    <div className="rounded-[7px] border border-[color-mix(in_srgb,var(--color-rose)_40%,transparent)] bg-[var(--color-rose-wash)] p-2">
      <p className="mb-1 text-[10.5px] leading-relaxed text-[var(--color-rose-2)]">
        {t("workingCopy.forcePushWarning")}
      </p>
      <code className="mb-1.5 block truncate rounded bg-[rgba(6,9,11,0.5)] px-1.5 py-1 font-mono text-[10px] text-[var(--color-bone-2)]">
        {cmd.data ?? "git push --force-with-lease"}
      </code>
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={state.push.isPending}
          onClick={() =>
            state.push.mutate(true, { onSettled: () => setConfirming(false) })
          }
          className="h-[24px] flex-1 rounded-[5px] border border-[color-mix(in_srgb,var(--color-rose)_45%,transparent)] text-[10.5px] text-[var(--color-rose-2)] disabled:opacity-40"
        >
          {state.push.isPending ? t("workingCopy.pushing") : t("workingCopy.confirmForcePush")}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="h-[24px] flex-1 rounded-[5px] border border-[var(--color-edge-2)] text-[10.5px] text-[var(--color-muted-2)]"
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 小组件                                                              */
/* ------------------------------------------------------------------ */

function GroupLabel({ label, n, tone }: { label: string; n: number; tone?: "sage" }) {
  return (
    <p
      className={[
        "flex items-center gap-1.5 px-3 pt-[11px] pb-[5px] text-[9.5px] tracking-[0.15em] uppercase",
        tone === "sage" ? "text-[var(--color-sage)]" : "text-[var(--color-faint)]",
      ].join(" ")}
    >
      {label}
      <span className="tracking-normal text-[var(--color-muted-2)]">{n}</span>
    </p>
  );
}

function FileRow({
  change,
  active,
  onSelect,
  action,
  onAction,
  disabled,
}: {
  change: { path: string; origPath?: string; kind: string; added: number; removed: number };
  active: boolean;
  onSelect: () => void;
  action: string;
  onAction: () => void;
  disabled: boolean;
}) {
  return (
    <div
      className={[
        "group flex h-[27px] items-center gap-[7px] border-l-2 pr-2.5 pl-2 text-[11.5px]",
        active
          ? "border-l-[var(--color-amber)] bg-[var(--color-ink-800)] text-[var(--color-bone)]"
          : "border-l-transparent text-[var(--color-muted)] hover:bg-[var(--color-ink-850)]",
      ].join(" ")}
    >
      <Icon name="file" size={12} className="shrink-0 text-[var(--color-muted-2)]" />
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <span className="block truncate font-mono text-[11px]">
          {change.path}
          {change.origPath && (
            <span className="text-[var(--color-faint)]"> ← {change.origPath}</span>
          )}
        </span>
      </button>
      {/* 每行的增删统计：原型在列表层就给出改动量，用户不必逐个点开看。 */}
      {change.added + change.removed > 0 && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          {change.added > 0 && (
            <span className="text-[var(--color-sage)]">+{change.added}</span>
          )}
          {change.added > 0 && change.removed > 0 && " "}
          {change.removed > 0 && (
            <span className="text-[var(--color-rose)]">−{change.removed}</span>
          )}
        </span>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={onAction}
        aria-label={`${action} ${change.path}`}
        className="shrink-0 rounded-[4px] border border-[var(--color-edge-2)] px-1 text-[10px] text-[var(--color-faint)] opacity-0 group-hover:opacity-100 hover:border-[var(--color-amber)] hover:text-[var(--color-bone)] focus:opacity-100 disabled:opacity-40"
      >
        {action}
      </button>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 mb-1 text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase first:mt-0">
      {children}
    </p>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-[11px]">
      <dt className="shrink-0 text-[var(--color-muted-2)]">{k}</dt>
      <dd
        className={`truncate text-right text-[var(--color-bone-2)] ${mono ? "font-mono" : ""}`}
        title={v}
      >
        {v}
      </dd>
    </div>
  );
}

function Hint({ children, tone }: { children: React.ReactNode; tone?: "rose" }) {
  return (
    <p
      className={[
        "px-3 py-4 text-[11.5px] leading-relaxed",
        tone === "rose" ? "text-[var(--color-rose)]" : "text-[var(--color-muted)]",
      ].join(" ")}
    >
      {children}
    </p>
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "操作失败";
}

/** 变更类别的中文说明。 */
function labelOf(kind: string): string {
  switch (kind) {
    case "added":
      return "新增";
    case "deleted":
      return "删除";
    case "renamed":
      return "重命名";
    case "untracked":
      return "未跟踪";
    case "conflicted":
      return "冲突";
    case "modified":
      return "修改";
    default:
      return kind || "—";
  }
}









