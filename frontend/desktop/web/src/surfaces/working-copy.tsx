import { useMemo, useState } from "react";

import { Button, Input } from "@kustos/ui";

import { useFileDiff, useStage, useCommit } from "@/lib/working-copy";
import { parseUnifiedDiff, diffStats } from "@/lib/unified-diff";

/**
 * Working Copy 面：仓库列表 → 变更列表 → diff → 暂存 / 提交。
 *
 * 这是桌面端相对 Web 最独特的一面：只有本机知道你的工作树长什么样——
 * 未提交的改动、当前分支、领先/落后。所有数据都来自本地系统 git，
 * 断网也能看、能暂存、能提交。
 *
 * 交互取舍（常驻工作台，不是一次访问）：
 * - 变更常驻左栏，选中即在右侧看 diff，不整页跳转；
 * - 暂存按"整文件"粒度，hunk 级暂存等 diff 选择稳定后再做；
 * - 提交信息就地输入，不弹二次对话框——提交是高频动作。
 */

interface WorkingCopyViewProps {
  /** 当前选中的工作副本 ID。 */
  workingCopyId: string | null;
  /** 该工作副本的实时状态（由外层查询后传入，避免重复请求）。 */
  status: {
    branch: string;
    dirty: boolean;
    ahead: number;
    behind: number;
    changes: { path: string; origPath?: string; kind: string; staged: boolean }[];
  } | null;
  loading: boolean;
  error: unknown;
  /** 选中路径由外层持有，这样左栏的变更列表与右栏的 diff 共享同一份选择。 */
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  /**
   * 渲染成两个片段：变更列表进左栏（仓库列表之下），diff 进右栏。
   *
   * 拆成片段而不是整页：三栏骨架属于外壳，surface 只负责内容。
   */
  children: (parts: { changesList: React.ReactNode; detail: React.ReactNode }) => React.ReactNode;
}

export function WorkingCopyView({
  workingCopyId,
  status,
  loading,
  error,
  selectedPath,
  onSelectPath,
  children,
}: WorkingCopyViewProps) {
  const [stagedSide, setStagedSide] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");

  const stage = useStage(workingCopyId);
  const commit = useCommit(workingCopyId);

  const changes = status?.changes ?? [];
  const stagedChanges = useMemo(() => changes.filter((c) => c.staged), [changes]);
  const unstagedChanges = useMemo(() => changes.filter((c) => !c.staged), [changes]);

  const selected = changes.find((c) => c.path === selectedPath) ?? changes[0] ?? null;
  // 暂存与否决定 diff 读哪一侧：文件已暂存时默认读暂存区，否则读工作区。
  const effectiveStaged = selected ? selected.staged || stagedSide : stagedSide;

  const diff = useFileDiff(workingCopyId, selected?.path ?? null, effectiveStaged);

  const submitCommit = () => {
    const message = commitMessage.trim();
    if (message === "" || stagedChanges.length === 0) return;
    commit.mutate({ message, amend: false }, { onSuccess: () => setCommitMessage("") });
  };

  if (!workingCopyId) {
    return (
      <>
        {children({
          changesList: <p className="px-3 py-2 text-[11px] text-muted">未选择仓库</p>,
          detail: (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="font-display text-lg text-bone">还没有工作副本</p>
              <p className="max-w-[46ch] text-[12px] leading-relaxed text-muted">
                添加一个本地 git 仓库开始。桌面端直接调用系统 git，工作树的改动、
                暂存与提交都在本机完成，不需要联网。
              </p>
            </div>
          ),
        })}
      </>
    );
  }

  if (loading) {
    const note = <p className="p-4 text-[12px] text-muted">正在读取工作树…</p>;
    return <>{children({ changesList: note, detail: note })}</>;
  }

  if (error != null) {
    const note = (
      <p className="p-4 text-[12px] text-[var(--color-rose)]">
        {error instanceof Error ? error.message : "读取工作树失败"}
      </p>
    );
    return <>{children({ changesList: note, detail: note })}</>;
  }

  return (
    <>
      {children({
        changesList: (
          <ChangesPane
            branch={status?.branch ?? ""}
            dirty={status?.dirty ?? false}
            ahead={status?.ahead ?? 0}
            behind={status?.behind ?? 0}
            staged={stagedChanges}
            unstaged={unstagedChanges}
            selectedPath={selected?.path ?? null}
            onSelect={onSelectPath}
            onStage={(path, toStaged) => stage.mutate({ paths: [path], staged: toStaged })}
            staging={stage.isPending}
            commitMessage={commitMessage}
            onCommitMessage={setCommitMessage}
            onCommit={submitCommit}
            committing={commit.isPending}
            commitError={commit.error}
          />
        ),
        detail: (
          <DiffPane
            path={selected?.path ?? null}
            raw={diff.data ?? ""}
            loading={diff.isLoading}
            staged={effectiveStaged}
            onToggleSide={() => setStagedSide((v) => !v)}
            hasBothSides={Boolean(selected?.staged)}
          />
        ),
      })}
    </>
  );
}

/** 左栏：分支信息 + 暂存/未暂存两段变更列表。 */
function ChangesPane({
  branch,
  dirty,
  ahead,
  behind,
  staged,
  unstaged,
  selectedPath,
  onSelect,
  onStage,
  staging,
  commitMessage,
  onCommitMessage,
  onCommit,
  committing,
  commitError,
}: {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  staged: { path: string; kind: string }[];
  unstaged: { path: string; kind: string }[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onStage: (path: string, toStaged: boolean) => void;
  staging: boolean;
  commitMessage: string;
  onCommitMessage: (v: string) => void;
  onCommit: () => void;
  committing: boolean;
  commitError: unknown;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {staged.length === 0 && unstaged.length === 0 && (
          <p className="px-3 py-4 text-[12px] leading-relaxed text-muted">
            工作树是干净的。改点文件后回到这里，或按 ⌘R 重新扫描。
          </p>
        )}

        {staged.length > 0 && (
          <ChangeSection
            title="已暂存"
            items={staged}
            selectedPath={selectedPath}
            onSelect={onSelect}
            actionLabel="取消暂存"
            onAction={(p) => onStage(p, false)}
            disabled={staging}
          />
        )}
        {unstaged.length > 0 && (
          <ChangeSection
            title="未暂存"
            items={unstaged}
            selectedPath={selectedPath}
            onSelect={onSelect}
            actionLabel="暂存"
            onAction={(p) => onStage(p, true)}
            disabled={staging}
          />
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--color-edge-1)] p-2">
        <Input
          value={commitMessage}
          onChange={(e) => onCommitMessage(e.target.value)}
          placeholder="提交信息"
          className="mb-1.5 h-7 text-[12px]"
        />
        <Button
          size="sm"
          className="h-7 w-full text-[12px]"
          disabled={commitMessage.trim() === "" || staged.length === 0 || committing}
          onClick={onCommit}
        >
          {committing ? "提交中…" : `提交${staged.length > 0 ? ` (${staged.length})` : ""}`}
        </Button>
        {commitError != null && (
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-rose)]">
            {commitError instanceof Error ? commitError.message : "提交失败"}
          </p>
        )}
      </div>
    </div>
  );
}

/** 一段变更（已暂存或未暂存）。 */
function ChangeSection({
  title,
  items,
  selectedPath,
  onSelect,
  actionLabel,
  onAction,
  disabled,
}: {
  title: string;
  items: { path: string; kind: string }[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  actionLabel: string;
  onAction: (path: string) => void;
  disabled: boolean;
}) {
  return (
    <section>
      <h3 className="sticky top-0 bg-ink-900 px-3 py-1 text-[10px] font-medium tracking-wide text-faint uppercase">
        {title} · {items.length}
      </h3>
      {items.map((c) => (
        <div
          key={c.path}
          className={[
            "group flex items-center gap-1.5 border-b border-[var(--color-edge-1)] pr-1 pl-3",
            c.path === selectedPath ? "bg-[var(--color-ink-800)]" : "hover:bg-[var(--color-ink-850)]",
          ].join(" ")}
        >
          <button
            type="button"
            onClick={() => onSelect(c.path)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
          >
            <span className="w-3 shrink-0 text-[10px] text-[var(--color-amber-500)]">
              {statusLetterOf(c.kind)}
            </span>
            <span className="truncate text-[12px] text-bone-2">{c.path}</span>
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAction(c.path)}
            aria-label={`${actionLabel} ${c.path}`}
            className="shrink-0 rounded border border-[var(--color-edge-2)] px-1 text-[10px] text-faint hover:border-[var(--color-amber-600)] hover:text-bone disabled:opacity-40"
          >
            {actionLabel}
          </button>
        </div>
      ))}
    </section>
  );
}

/** 右栏：diff。 */
function DiffPane({
  path,
  raw,
  loading,
  staged,
  onToggleSide,
  hasBothSides,
}: {
  path: string | null;
  raw: string;
  loading: boolean;
  staged: boolean;
  onToggleSide: () => void;
  hasBothSides: boolean;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(raw), [raw]);
  const stats = useMemo(() => diffStats(parsed), [parsed]);

  if (!path) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-display text-lg text-bone">工作树是干净的</p>
        <p className="max-w-[42ch] text-[12px] leading-relaxed text-muted">
          没有未提交的改动。改动出现在这里后，可以逐个文件暂存并提交。
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-edge-1)] px-3 py-1.5">
        <span className="truncate text-[12px] text-bone">{path}</span>
        <div className="flex-1" />
        <span className="text-[11px] text-[var(--color-sage-400)]">+{stats.added}</span>
        <span className="text-[11px] text-[var(--color-rose)]">−{stats.removed}</span>
        {hasBothSides && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={onToggleSide}
          >
            {staged ? "看工作区" : "看暂存区"}
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && <p className="p-4 text-[12px] text-muted">正在读取差异…</p>}
        {!loading && parsed.note !== "" && (
          <p className="p-4 text-[12px] text-muted">{parsed.note}</p>
        )}
        {!loading &&
          parsed.hunks.map((hunk, hi) => (
            <div key={hi} className="border-b border-[var(--color-edge-1)]">
              <div className="bg-[var(--color-ink-850)] px-3 py-0.5 font-mono text-[10px] text-faint">
                {hunk.header}
              </div>
              <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.55]">
                <tbody>
                  {hunk.lines.map((line, li) => (
                    <tr
                      key={li}
                      className={
                        line.kind === "add"
                          ? "bg-[color-mix(in_srgb,var(--color-sage-500)_12%,transparent)]"
                          : line.kind === "remove"
                            ? "bg-[color-mix(in_srgb,var(--color-rose)_12%,transparent)]"
                            : undefined
                      }
                    >
                      <td className="w-10 shrink-0 pr-2 text-right align-top text-[10px] text-faint select-none">
                        {line.oldLine ?? ""}
                      </td>
                      <td className="w-10 shrink-0 pr-2 text-right align-top text-[10px] text-faint select-none">
                        {line.newLine ?? ""}
                      </td>
                      <td className="w-3 shrink-0 align-top text-faint select-none">
                        {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
                      </td>
                      <td className="whitespace-pre-wrap break-all pr-3 text-bone-2">
                        {line.text === "" ? "\u00a0" : line.text}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>
    </div>
  );
}

/** 变更类别对应的单字母状态码。 */
function statusLetterOf(kind: string): string {
  switch (kind) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
    default:
      return "M";
  }
}
