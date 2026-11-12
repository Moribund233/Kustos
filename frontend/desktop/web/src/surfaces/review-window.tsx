import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/shell/icon";
import { WindowFrame } from "@/shell/window-frame";
import { relativeTime } from "@/lib/relative-time";
import { useRepositories, type Repository } from "@/lib/repos";
import { useActiveInstance } from "@/lib/session";
import { usePullRequest, PullsRequestError, type PullRequest, type PullRequestComment } from "@/lib/pulls";
import { usePullRequestDiff, PRDiffRequestError, type DiffFile, type PullRequestDiff } from "@/lib/pr-diff";
import {
  PRReviewError,
  useBranchProtection,
  useCreatePrComment,
  useCreatePrReview,
  usePullRequestReviewers,
  type BranchProtection,
  type ReviewerEntry,
} from "@/lib/pr-reviewers";
import { draftScope, useReviewDrafts, type ReviewDraft } from "@/lib/pr-drafts";
import { splitHunk, type SplitRow } from "@/lib/diff-split";
import { anchorLineNumber, collectNewLines } from "@/lib/diff-anchor";
import type { DiffHunk, DiffLine } from "@/lib/unified-diff";

/**
 * 评审窗：第二个窗口里的单 PR 视图。
 *
 * 与主窗口的 Pulls 面刻意不同：这里**没有左轨、没有列表栏**。评审窗是被"把某个
 * PR 拎出来单独看"这个动作打开的，它的上下文已经由 URL 片段里的仓库 + 编号固定，
 * 再放一层列表只会让用户以为能在窗口里切换 PR——那应该回主窗口做。
 *
 * 版式照原型的 `docs/prototype/desktop/review.html`：左侧是 PR 头 + 整份 diff +
 * 草稿条，右侧是 340px 的对话/检查面板（评审人、检查、评论），底部是合并闸口。
 * 原型里有、而这个平台没有后端支撑的部分（CI 检查记录、提交数）不画假数据：
 * 检查面板改为解释"本实例没有 CI"，检查项位置留空态。
 */
export function ReviewWindow({ prNumber, repoId }: { prNumber: number | null; repoId: string | null }) {
  const { t } = useTranslation();
  const repos = useRepositories();

  // 片段里带仓库是正常的（点"在新窗口中评审"时由主窗口写入）。旧片段只有编号，
  // 此时只有在**唯一一个仓库**下才没有歧义；仓库多于一就老实说找不到，
  // 而不是猜一个——猜错会把另一个仓库的同号 PR 显示出来。
  const resolvedRepoId =
    repoId ?? (repos.data && repos.data.length === 1 ? repos.data[0].id : null);

  return (
    <WindowFrame>
      {prNumber === null ? (
        <NoPullRequestSelected />
      ) : resolvedRepoId === null ? (
        <Center>
          {repos.isLoading ? t("common.loading") : t("reviewWindow.unresolvedRepo")}
        </Center>
      ) : (
        <ReviewSurface repoId={resolvedRepoId} prNumber={prNumber} repos={repos.data ?? []} />
      )}
    </WindowFrame>
  );
}

/**
 * 评审窗还没选中 PR 时的空态。
 *
 * 从托盘菜单直接唤出评审窗走的就是这条路径。这里说清两件事：这个窗口是干什么的
 * （单独看一个 PR），以及接下来该去哪（回主窗口的合并请求列表里挑）。
 * 不能退化成第二个主界面——那会让用户以为应用开错了窗。
 */
function NoPullRequestSelected() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
      <Icon name="pr" size={20} className="text-[var(--color-faint)]" />
      <p className="text-[13px] text-[var(--color-bone)]">{t("reviewWindow.emptyTitle")}</p>
      <p className="max-w-[42ch] text-[11.5px] leading-relaxed text-[var(--color-muted)]">
        {t("reviewWindow.emptyHint")}
      </p>
    </div>
  );
}

/** 评审窗主体：左 diff、右面板、底草稿条。 */
function ReviewSurface({
  repoId,
  prNumber,
  repos,
}: {
  repoId: string;
  prNumber: number;
  repos: Repository[];
}) {
  const { t } = useTranslation();
  const instance = useActiveInstance();
  const detail = usePullRequest(repoId, prNumber);
  const diff = usePullRequestDiff(repoId, prNumber);
  const reviewers = usePullRequestReviewers(repoId, prNumber);

  const pr = detail.data ?? null;
  const protection = useBranchProtection(repoId, pr?.targetBranch ?? null);

  const scope = draftScope(instance.data?.id ?? null, repoId, prNumber);
  const drafts = useReviewDrafts(scope);
  const createComment = useCreatePrComment(repoId, prNumber);
  const createReview = useCreatePrReview(repoId, prNumber);

  // 已看/未看纯属本地阅读状态：服务端没有这个字段，也没有同步它的通道，
  // 因此只活在这个窗口的这一次渲染里（和原型的说明一致）。
  const [viewed, setViewed] = useState<Record<string, boolean>>({});
  const [split, setSplit] = useState(false);
  const [editing, setEditing] = useState<{ filePath: string; lineNumber: number | null } | null>(null);
  const [draftText, setDraftText] = useState("");
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState<"idle" | "submitting" | "replying" | "verdict">("idle");
  const [banner, setBanner] = useState<{ tone: "sage" | "rose"; text: string } | null>(null);

  const comments = useMemo(() => {
    const list = pr?.comments ?? [];
    // 详情接口的 comments 没有排序（joinedload 直出），按时间正序排一次，
    // 否则同一条时间线在不同窗口里顺序可能不同。缺时间的排在最后。
    return [...list].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }, [pr]);

  const repoLabel = useMemo(() => {
    const repo = repos.find((r) => r.id === repoId);
    return repo?.path ?? repo?.name ?? "";
  }, [repos, repoId]);

  if (detail.isLoading) return <Center>{t("pulls.loading")}</Center>;

  if (!pr) {
    return <Center>{errorText(detail.error, t, `#${prNumber}`)}</Center>;
  }

  const isOpen = pr.status === "open";

  const submitDrafts = async (): Promise<void> => {
    if (drafts.drafts.length === 0) return;
    setBusy("submitting");
    setBanner(null);
    try {
      // 逐条发：服务端的评论端点没有批量形态，且逐条发能保留各自的文件与行号。
      for (const draft of drafts.drafts) {
        await createComment.mutateAsync({
          content: draft.content,
          filePath: draft.filePath === "" ? null : draft.filePath,
          lineNumber: draft.lineNumber,
          // 行号只有挂在某个提交上才稳定；用 diff 的 head 提交，评审意见因此
          // 指向用户当时看到的那一版。
          commitHash: diff.data?.headCommit ?? null,
        });
      }
      const count = drafts.drafts.length;
      drafts.clear();
      setBanner({ tone: "sage", text: t("reviewWindow.submitted", { count }) });
    } catch (error) {
      setBanner({ tone: "rose", text: t("reviewWindow.submitFailed", { error: describeError(error) }) });
    } finally {
      setBusy("idle");
    }
  };

  const submitReply = async (): Promise<void> => {
    const text = replyText.trim();
    if (text === "") return;
    setBusy("replying");
    setBanner(null);
    try {
      await createComment.mutateAsync({ content: text, filePath: null, lineNumber: null });
      setReplyText("");
    } catch (error) {
      setBanner({ tone: "rose", text: t("reviewWindow.commentFailed", { error: describeError(error) }) });
    } finally {
      setBusy("idle");
    }
  };

  const submitVerdict = async (status: "approved" | "changes_requested"): Promise<void> => {
    setBusy("verdict");
    setBanner(null);
    try {
      await createReview.mutateAsync({ status, comment: null });
      setBanner({
        tone: "sage",
        text: t("reviewWindow.verdictSubmitted", {
          verdict: status === "approved" ? t("reviewWindow.approve") : t("reviewWindow.requestChanges"),
        }),
      });
    } catch (error) {
      // 自评被服务端拦下是最常见的一种失败，单独说明，别退化成 "HTTP 400"。
      const selfApprove = error instanceof PRReviewError && error.code === "pr_self_approve_forbidden";
      setBanner({
        tone: "rose",
        text: selfApprove
          ? t("reviewWindow.selfApprove")
          : t("reviewWindow.verdictFailed", { error: describeError(error) }),
      });
    } finally {
      setBusy("idle");
    }
  };

  const addDraft = (): void => {
    if (editing === null) return;
    const text = draftText.trim();
    if (text === "") return;
    drafts.add({ filePath: editing.filePath, lineNumber: editing.lineNumber, content: text });
    setDraftText("");
    setEditing(null);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col border-r border-[var(--color-edge-1)]">
        <ReviewHead
          pr={pr}
          repoLabel={repoLabel}
          diff={diff.data ?? null}
          split={split}
          onToggleSplit={() => {
            setSplit((v) => !v);
          }}
        />

        {banner && (
          <div
            className={
              banner.tone === "sage"
                ? "shrink-0 border-b border-[var(--color-edge-1)] bg-[rgba(134,183,158,0.10)] px-5 py-2 text-[11px] text-[var(--color-sage-2)]"
                : "shrink-0 border-b border-[var(--color-edge-1)] bg-[rgba(217,130,130,0.10)] px-5 py-2 text-[11px] text-[var(--color-rose-2)]"
            }
          >
            {banner.text}
          </div>
        )}

        <DiffDocument
          diff={diff.data ?? null}
          loading={diff.isLoading}
          error={diff.error}
          split={split}
          viewed={viewed}
          onToggleViewed={(path) => {
            setViewed((prev) => ({ ...prev, [path]: !prev[path] }));
          }}
          comments={comments}
          drafts={drafts.drafts}
          editable={isOpen}
          editing={editing}
          draftText={draftText}
          onDraftText={setDraftText}
          onStartComment={(filePath, lineNumber) => {
            setEditing({ filePath, lineNumber });
            setDraftText("");
          }}
          onCancelComment={() => {
            setEditing(null);
            setDraftText("");
          }}
          onAddDraft={addDraft}
          onDeleteDraft={drafts.remove}
        />

        {isOpen && drafts.drafts.length > 0 && (
          <DraftBar
            count={drafts.drafts.length}
            busy={busy === "submitting"}
            onDiscard={drafts.clear}
            onSubmit={() => void submitDrafts()}
          />
        )}
      </div>

      <ReviewSide
        pr={pr}
        reviewers={reviewers.data ?? []}
        protection={protection.data ?? null}
        comments={comments}
        drafts={drafts.drafts}
        isOpen={isOpen}
        busy={busy}
        replyText={replyText}
        onReplyText={setReplyText}
        onSubmitReply={() => void submitReply()}
        onVerdict={(status) => void submitVerdict(status)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 左栏：PR 头                                                         */
/* ------------------------------------------------------------------ */

/**
 * PR 头。
 *
 * 章位数（原型的 "3 commits"）不显示：这个平台没有"PR 里的提交数"这个查询，
 * 编一个数字比空着更糟。增删行数取自 diff 的总计，是真实数据。
 */
function ReviewHead({
  pr,
  repoLabel,
  diff,
  split,
  onToggleSplit,
}: {
  pr: PullRequest;
  repoLabel: string;
  diff: PullRequestDiff | null;
  split: boolean;
  onToggleSplit: () => void;
}) {
  const { t } = useTranslation();
  const hasHunks = diff !== null && diff.files.some((f) => f.hunks.length > 0);

  return (
    <div className="shrink-0 border-b border-[var(--color-edge-1)] px-5 pt-[13px] pb-[11px]">
      <div className="flex items-center gap-[7px] text-[10px] tracking-[0.14em] text-[var(--color-faint)] uppercase">
        <span>{t("reviewWindow.eyebrow")}</span>
        <span>·</span>
        <span className="font-mono tracking-normal normal-case">{repoLabel}</span>
        <span className="ml-auto flex items-center gap-[6px] tracking-normal normal-case">
          {diff && (
            <>
              <span className="rounded-[4px] bg-[var(--color-ink-800)] px-[6px] py-[1px] font-mono text-[10px] text-[var(--color-sage)]">
                +{diff.additions}
              </span>
              <span className="rounded-[4px] bg-[var(--color-ink-800)] px-[6px] py-[1px] font-mono text-[10px] text-[var(--color-rose)]">
                −{diff.deletions}
              </span>
            </>
          )}
          {hasHunks && (
            <button
              type="button"
              onClick={onToggleSplit}
              className="flex items-center gap-[5px] rounded-[5px] border border-[var(--color-edge-2)] px-[7px] py-[2px] text-[10.5px] text-[var(--color-muted-2)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-bone-2)]"
            >
              <Icon name="diff" size={11} />
              {split ? t("reviewWindow.unifiedView") : t("reviewWindow.splitView")}
            </button>
          )}
        </span>
      </div>

      <h1 className="mt-1 text-[15px] font-medium tracking-[-0.01em] text-[var(--color-bone)]">
        {pr.title}
      </h1>

      <div className="mt-[6px] flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-muted-2)]">
        <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-[var(--color-ink-700)] text-[9px] text-[var(--color-bone-2)]">
          {initials(pr.author?.username ?? "")}
        </span>
        <span className="text-[var(--color-bone-2)]">{pr.author?.username ?? "—"}</span>
        <span className="text-[var(--color-faint)]">{t("reviewWindow.targetPrefix")}</span>
        <span className="font-mono text-[var(--color-bone-2)]">{pr.targetBranch}</span>
        <span className="font-mono text-[10px] text-[var(--color-faint)]">
          {pr.sourceBranch} → {pr.targetBranch}
        </span>
        {pr.isDraft && <Chip tone="amber">{t("pulls.draft")}</Chip>}
        {pr.status !== "open" && <Chip>{pr.status}</Chip>}
        <span className="ml-auto text-[10px] text-[var(--color-faint)]">
          {relativeTime(pr.createdAt, t)}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 左栏：diff 文档                                                     */
/* ------------------------------------------------------------------ */

/** 整份改动：每个文件一段，行内可留意见。 */
function DiffDocument({
  diff,
  loading,
  error,
  split,
  viewed,
  onToggleViewed,
  comments,
  drafts,
  editable,
  editing,
  draftText,
  onDraftText,
  onStartComment,
  onCancelComment,
  onAddDraft,
  onDeleteDraft,
}: {
  diff: PullRequestDiff | null;
  loading: boolean;
  error: unknown;
  split: boolean;
  viewed: Record<string, boolean>;
  onToggleViewed: (path: string) => void;
  comments: PullRequestComment[];
  drafts: ReviewDraft[];
  editable: boolean;
  editing: { filePath: string; lineNumber: number | null } | null;
  draftText: string;
  onDraftText: (text: string) => void;
  onStartComment: (filePath: string, lineNumber: number | null) => void;
  onCancelComment: () => void;
  onAddDraft: () => void;
  onDeleteDraft: (id: string) => void;
}) {
  const { t } = useTranslation();

  if (loading) {
    return <Center>{t("reviewWindow.diffLoading")}</Center>;
  }

  if (error != null) {
    return <Center>{t("reviewWindow.diffFailed", { error: diffErrorText(error) })}</Center>;
  }

  if (!diff || diff.files.length === 0) {
    return <Center>{t("pulls.noBody")}</Center>;
  }

  const emptyFiles = diff.files.filter((f) => f.hunks.length === 0).length;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {diff.files.map((file, index) => (
        <DiffFileBlock
          key={`${file.path}:${String(index)}`}
          file={file}
          first={index === 0}
          split={split}
          viewed={viewed[file.path] === true}
          onToggleViewed={() => {
            onToggleViewed(file.path);
          }}
          comments={comments.filter((c) => c.filePath === file.path)}
          drafts={drafts.filter((d) => d.filePath === file.path)}
          editable={editable}
          editing={editing?.filePath === file.path ? editing : null}
          draftText={draftText}
          onDraftText={onDraftText}
          onStartComment={(lineNumber) => {
            onStartComment(file.path, lineNumber);
          }}
          onCancelComment={onCancelComment}
          onAddDraft={onAddDraft}
          onDeleteDraft={onDeleteDraft}
        />
      ))}

      {emptyFiles > 0 && (
        <div className="px-[14px] py-3">
          <div className="flex items-start gap-2 rounded-[6px] border border-[var(--color-edge-1)] bg-[rgba(19,32,39,0.35)] px-3 py-[7px] text-[11px] text-[var(--color-muted)]">
            <Icon name="diff" size={12} className="mt-px shrink-0 text-[var(--color-faint)]" />
            <span>{t("reviewWindow.noTextDiff", { count: emptyFiles })}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** 单个文件：文件头 + 各 hunk + 行内意见。 */
function DiffFileBlock({
  file,
  first,
  split,
  viewed,
  onToggleViewed,
  comments,
  drafts,
  editable,
  editing,
  draftText,
  onDraftText,
  onStartComment,
  onCancelComment,
  onAddDraft,
  onDeleteDraft,
}: {
  file: DiffFile;
  first: boolean;
  split: boolean;
  viewed: boolean;
  onToggleViewed: () => void;
  comments: PullRequestComment[];
  drafts: ReviewDraft[];
  editable: boolean;
  editing: { filePath: string; lineNumber: number | null } | null;
  draftText: string;
  onDraftText: (text: string) => void;
  onStartComment: (lineNumber: number | null) => void;
  onCancelComment: () => void;
  onAddDraft: () => void;
  onDeleteDraft: (id: string) => void;
}) {
  const { t } = useTranslation();

  /** 行号 → 挂在这一行下面的东西（已提交的评论 + 本机草稿）。 */
  const anchors = useMemo(() => {
    const map = new Map<number, { comments: PullRequestComment[]; drafts: ReviewDraft[] }>();
    for (const comment of comments) {
      if (comment.lineNumber === null) continue;
      const slot = map.get(comment.lineNumber) ?? { comments: [], drafts: [] };
      slot.comments.push(comment);
      map.set(comment.lineNumber, slot);
    }
    for (const draft of drafts) {
      if (draft.lineNumber === null) continue;
      const slot = map.get(draft.lineNumber) ?? { comments: [], drafts: [] };
      slot.drafts.push(draft);
      map.set(draft.lineNumber, slot);
    }
    return map;
  }, [comments, drafts]);

  /** 没有行号的评论/草稿挂在文件末尾——它们确实属于这个文件。 */
  const looseComments = comments.filter((c) => c.lineNumber === null);
  const looseDrafts = drafts.filter((d) => d.lineNumber === null);

  /**
   * 本文件在新文件侧出现过的所有行号。
   *
   * 用来消解锚点冲突：整行删除的旧行号与整行新增的新行号可以同号
   * （`-旧` 的 oldLine=1 与 `+新` 的 newLine=1），若直接用
   * `newLine ?? oldLine` 当锚点，一条评论会同时挂在两行下面渲染两次。
   * 判定逻辑在 `diff-anchor.ts` 里，有回归用例覆盖。
   */
  const newLines = useMemo(() => collectNewLines(file.hunks), [file.hunks]);

  return (
    <div>
      <div
        className={
          first
            ? "flex items-center gap-2 bg-[var(--color-ink-850)] px-3 py-[6px] text-[11px] text-[var(--color-muted)]"
            : "flex items-center gap-2 border-t border-[var(--color-edge-1)] bg-[var(--color-ink-850)] px-3 py-[6px] text-[11px] text-[var(--color-muted)]"
        }
      >
        <Icon name="file" size={12} className="shrink-0 text-[var(--color-faint)]" />
        <span className="truncate font-mono text-[11px] text-[var(--color-bone-2)]">
          {file.oldPath !== null ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="font-mono text-[10.5px] text-[var(--color-sage)]">+{file.additions}</span>
        <span className="font-mono text-[10.5px] text-[var(--color-rose)]">−{file.deletions}</span>
        <span className="ml-auto flex items-center gap-[6px]">
          <span className="font-mono text-[10px] text-[var(--color-faint)]">{file.statusCode}</span>
          <button
            type="button"
            onClick={onToggleViewed}
            title={t("reviewWindow.viewedHint")}
            className={
              viewed
                ? "rounded-[4px] bg-[rgba(134,183,158,0.14)] px-[6px] py-[1px] text-[10px] text-[var(--color-sage-2)]"
                : "rounded-[4px] bg-[var(--color-ink-800)] px-[6px] py-[1px] text-[10px] text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]"
            }
          >
            {viewed ? t("reviewWindow.viewed") : t("reviewWindow.notViewed")}
          </button>
        </span>
      </div>

      {file.binary ? (
        <div className="px-3 py-2 font-mono text-[11px] text-[var(--color-faint)]">
          {t("reviewWindow.noTextDiff", { count: 1 })}
        </div>
      ) : (
        file.hunks.map((hunk, hunkIndex) => (
          <HunkBlock
            key={`${hunk.header}:${String(hunkIndex)}`}
            hunk={hunk}
            split={split}
            anchors={anchors}
            newLines={newLines}
            editable={editable}
            editing={editing}
            draftText={draftText}
            onDraftText={onDraftText}
            onStartComment={onStartComment}
            onCancelComment={onCancelComment}
            onAddDraft={onAddDraft}
            onDeleteDraft={onDeleteDraft}
          />
        ))
      )}

      {(looseComments.length > 0 || looseDrafts.length > 0) && (
        <div>
          {looseComments.map((comment) => (
            <InlineNote
              key={comment.id}
              who={comment.author?.username ?? "—"}
              text={comment.content}
              time={relativeTime(comment.createdAt, t)}
            />
          ))}
          {looseDrafts.map((draft) => (
            <InlineNote
              key={draft.id}
              who={t("reviewWindow.draftWho")}
              text={draft.content}
              draft
              onDelete={() => {
                onDeleteDraft(draft.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 一个 hunk：头 + 单栏或两栏的行。 */
function HunkBlock({
  hunk,
  split,
  anchors,
  newLines,
  editable,
  editing,
  draftText,
  onDraftText,
  onStartComment,
  onCancelComment,
  onAddDraft,
  onDeleteDraft,
}: {
  hunk: DiffHunk;
  split: boolean;
  anchors: Map<number, { comments: PullRequestComment[]; drafts: ReviewDraft[] }>;
  newLines: Set<number>;
  editable: boolean;
  editing: { filePath: string; lineNumber: number | null } | null;
  draftText: string;
  onDraftText: (text: string) => void;
  onStartComment: (lineNumber: number | null) => void;
  onCancelComment: () => void;
  onAddDraft: () => void;
  onDeleteDraft: (id: string) => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => (split ? splitHunk(hunk) : null), [hunk, split]);

  /**
   * 一行对应的锚点行号（见 `diff-anchor.ts`）。
   *
   * 评论挂在「新文件侧的行号」上，因为提交时后端拿到的就是这个行号。
   * 删除行没有新行号，但它的旧行号可能与某个新增行同号，此时让给新文件
   * 侧那一行，删除行不占用（返回 null 表示不挂任何东西，否则同一条评论
   * 会在两行下面各渲染一次）。
   */
  const anchorLine = (line: DiffLine | null | undefined): number | null =>
    anchorLineNumber(line, newLines);

  /** 一行的下方锚点：已提交评论、草稿、以及正在写的表单。 */
  const anchorOf = (lineNumber: number | null) => {
    const slot = lineNumber === null ? undefined : anchors.get(lineNumber);
    return (
      <>
        {slot?.comments.map((comment) => (
          <InlineNote
            key={comment.id}
            who={comment.author?.username ?? "—"}
            text={comment.content}
            time={relativeTime(comment.createdAt, t)}
          />
        ))}
        {slot?.drafts.map((draft) => (
          <InlineNote
            key={draft.id}
            who={t("reviewWindow.draftWho")}
            text={draft.content}
            draft
            onDelete={() => {
              onDeleteDraft(draft.id);
            }}
          />
        ))}
        {editing !== null && editing.lineNumber === lineNumber && (
          <DraftEditor
            text={draftText}
            onChange={onDraftText}
            onCancel={onCancelComment}
            onAdd={onAddDraft}
          />
        )}
      </>
    );
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 bg-[rgba(131,169,196,0.07)] px-[9px] py-[3px] font-mono text-[10.5px] text-[var(--color-sky)]">
        <span className="truncate">{hunk.header}</span>
      </div>

      {rows === null
        ? hunk.lines.map((line, index) => {
            const anchor = anchorLine(line);
            return (
              <UnifiedLine
                key={`${String(index)}`}
                line={line}
                editable={editable && anchor !== null}
                onClick={() => {
                  onStartComment(anchor);
                }}
                below={anchorOf(anchor)}
              />
            );
          })
        : rows.map((row, index) => {
            const anchor = anchorLine(row.right) ?? anchorLine(row.left);
            return (
              <SplitLine
                key={`${String(index)}`}
                row={row}
                editable={editable && anchor !== null}
                onClick={() => {
                  onStartComment(anchor);
                }}
                below={anchorOf(anchor)}
              />
            );
          })}
    </div>
  );
}

/** 单栏的一行：旧行号、新行号、符号、内容。 */
function UnifiedLine({
  line,
  editable,
  onClick,
  below,
}: {
  line: DiffLine;
  editable: boolean;
  onClick: () => void;
  below: React.ReactNode;
}) {
  const { t } = useTranslation();
  const tone =
    line.kind === "add"
      ? "bg-[rgba(134,183,158,0.10)] text-[var(--color-sage-2)]"
      : line.kind === "remove"
        ? "bg-[rgba(217,130,130,0.10)] text-[var(--color-rose-2)]"
        : "text-[var(--color-muted)]";
  const sign = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";

  return (
    <>
      <div
        className={`group flex whitespace-pre ${tone}`}
        onClick={editable && line.kind !== "meta" ? onClick : undefined}
        role={editable && line.kind !== "meta" ? "button" : undefined}
        title={editable && line.kind !== "meta" ? t("reviewWindow.lineComment") : undefined}
        tabIndex={editable && line.kind !== "meta" ? -1 : undefined}
      >
        <span className="w-10 shrink-0 pr-[10px] text-right text-[var(--color-faint)] select-none">
          {line.oldLine ?? ""}
        </span>
        <span className="w-10 shrink-0 pr-[10px] text-right text-[var(--color-faint)] select-none">
          {line.newLine ?? ""}
        </span>
        <span className="w-3 shrink-0 text-center select-none">{sign}</span>
        <span className="min-w-0 flex-1 pr-3">{line.text}</span>
      </div>
      {below}
    </>
  );
}

/** 两栏的一行：左栏是旧文件，右栏是新文件。 */
function SplitLine({
  row,
  editable,
  onClick,
  below,
}: {
  row: SplitRow;
  editable: boolean;
  onClick: () => void;
  below: React.ReactNode;
}) {
  const { t } = useTranslation();

  if (row.meta !== null) {
    return (
      <>
        <div className="px-[9px] font-mono text-[10.5px] text-[var(--color-faint)]">{row.meta.text}</div>
        {below}
      </>
    );
  }

  const cell = (line: DiffLine | null, side: "old" | "new") => {
    if (line === null) {
      return (
        <div className="flex min-w-0 flex-1 bg-[rgba(8,13,16,0.45)]">
          <span className="w-10 shrink-0" />
          <span className="min-w-0 flex-1" />
        </div>
      );
    }
    const tone =
      line.kind === "add"
        ? "bg-[rgba(134,183,158,0.10)] text-[var(--color-sage-2)]"
        : line.kind === "remove"
          ? "bg-[rgba(217,130,130,0.10)] text-[var(--color-rose-2)]"
          : "text-[var(--color-muted)]";
    const sign = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
    return (
      <div className={`flex min-w-0 flex-1 whitespace-pre ${tone}`}>
        <span className="w-10 shrink-0 pr-[10px] text-right text-[var(--color-faint)] select-none">
          {side === "old" ? (line.oldLine ?? "") : (line.newLine ?? "")}
        </span>
        <span className="w-3 shrink-0 text-center select-none">{sign}</span>
        <span className="min-w-0 flex-1 pr-3">{line.text}</span>
      </div>
    );
  };

  return (
    <>
      <div
        className={`flex ${editable ? "cursor-pointer" : ""}`}
        onClick={editable ? onClick : undefined}
        role={editable ? "button" : undefined}
        title={editable ? t("reviewWindow.lineComment") : undefined}
        tabIndex={editable ? -1 : undefined}
      >
        {cell(row.left, "old")}
        <span className="w-px shrink-0 bg-[var(--color-edge-1)]" />
        {cell(row.right, "new")}
      </div>
      {below}
    </>
  );
}

/** 行内意见块：原型里的 `.inline-note`。 */
function InlineNote({
  who,
  text,
  time,
  draft,
  onDelete,
}: {
  who: string;
  text: string;
  time?: string;
  draft?: boolean;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex gap-2 border-y border-[var(--color-edge-1)] bg-[rgba(21,35,42,0.34)] px-3 py-[9px]">
      <span className="mt-[1px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-[var(--color-ink-700)] text-[9px] text-[var(--color-bone-2)]">
        {initials(who)}
      </span>
      <div className="min-w-0 flex-1 text-[11.5px] text-[var(--color-muted)]">
        <p className="mb-[2px] flex items-center gap-2 text-[10.5px] text-[var(--color-faint)]">
          <span>{who}</span>
          {time && <span>{time}</span>}
          {draft && <Chip tone="amber">{t("reviewWindow.draftChip")}</Chip>}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={t("reviewWindow.deleteDraft")}
              title={t("reviewWindow.deleteDraft")}
              className="ml-auto text-[var(--color-faint)] hover:text-[var(--color-rose)]"
            >
              <Icon name="trash" size={11} />
            </button>
          )}
        </p>
        <p className="leading-[1.6] whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}

/** 写一条行内意见的表单。 */
function DraftEditor({
  text,
  onChange,
  onCancel,
  onAdd,
}: {
  text: string;
  onChange: (text: string) => void;
  onCancel: () => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="border-y border-[var(--color-edge-2)] bg-[var(--color-ink-850)] px-3 py-2">
      <textarea
        value={text}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        rows={3}
        autoFocus
        placeholder={t("reviewWindow.commentPlaceholder")}
        className="w-full resize-none rounded-[5px] border border-[var(--color-edge-2)] bg-[var(--color-ink-900)] px-2 py-1.5 text-[11.5px] text-[var(--color-bone-2)] outline-none placeholder:text-[var(--color-faint)] focus:border-[var(--color-edge-3)]"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onAdd}
          disabled={text.trim() === ""}
          className="rounded-[5px] bg-[var(--color-amber-3)] px-2.5 py-[3px] text-[10.5px] text-[var(--color-ink-1000)] disabled:opacity-40"
        >
          {t("reviewWindow.commentAdd")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[5px] px-2 py-[3px] text-[10.5px] text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)]"
        >
          {t("reviewWindow.commentCancel")}
        </button>
        <span className="ml-auto text-[10px] text-[var(--color-faint)]">
          {t("reviewWindow.draftsSavedHint")}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 左栏底部：草稿条                                                    */
/* ------------------------------------------------------------------ */

/**
 * 草稿条。
 *
 * 原型这里是「Save drafts」+「Submit review」。本实现的草稿在每次添加时就已经
 * 落盘（`lib/pr-drafts.ts` 每条都写 localStorage），再放一个"保存"按钮点了没反应
 * 反而是骗人的；因此这一格换成"丢弃草稿"，另一格照原型提交。
 */
function DraftBar({
  count,
  busy,
  onDiscard,
  onSubmit,
}: {
  count: number;
  busy: boolean;
  onDiscard: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 items-center gap-[9px] border-t border-[rgba(242,174,91,0.24)] bg-[rgba(242,174,91,0.08)] px-3 py-[9px] text-[11px] text-[var(--color-amber-2)]">
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--color-amber)]" />
      <span>{t("reviewWindow.draftsKept", { count })}</span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={onDiscard}
        className="rounded-[5px] border border-[rgba(242,174,91,0.3)] px-2.5 py-[3px] text-[10.5px] text-[var(--color-amber-2)] hover:bg-[rgba(242,174,91,0.12)]"
      >
        {t("reviewWindow.draftsDiscard")}
      </button>
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy}
        className="rounded-[5px] bg-[var(--color-amber-3)] px-2.5 py-[3px] text-[10.5px] text-[var(--color-ink-1000)] disabled:opacity-50"
      >
        {busy ? t("reviewWindow.submitting") : t("reviewWindow.draftsSubmit", { count })}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 右栏：对话与检查                                                    */
/* ------------------------------------------------------------------ */

/**
 * 右栏面板。
 *
 * 顺序照原型：评审人 → 检查 → 评论 → 回复框，底部是合并闸口。原型里这一栏还
 * 有一个"在窗口中打开"的外部图标按钮；评审窗本身就在独立窗口里，把对话搬到
 * 主窗口没有对应动作可做，因此不做这个按钮——留一个点了没反应的图标更糟。
 */
function ReviewSide({
  pr,
  reviewers,
  protection,
  comments,
  drafts,
  isOpen,
  busy,
  replyText,
  onReplyText,
  onSubmitReply,
  onVerdict,
}: {
  pr: PullRequest;
  reviewers: ReviewerEntry[];
  protection: BranchProtection | null;
  comments: PullRequestComment[];
  drafts: ReviewDraft[];
  isOpen: boolean;
  busy: "idle" | "submitting" | "replying" | "verdict";
  replyText: string;
  onReplyText: (text: string) => void;
  onSubmitReply: () => void;
  onVerdict: (status: "approved" | "changes_requested") => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"conversation" | "checks">("conversation");

  // 会话级评论（没有挂到某一行上的）才是"对话"；行内意见留在左侧 diff 里。
  const thread = comments.filter((c) => c.filePath === null);
  // 服务端偶尔给出 reviewer 为 null 的评审请求（账号已删除等）；这种条目没有
  // 可显示的姓名，也没有可投的票，过滤掉比渲染一个空白的评审人更诚实。
  const named = reviewers.filter(
    (r): r is ReviewerEntry & { reviewer: NonNullable<ReviewerEntry["reviewer"]> } => r.reviewer !== null,
  );
  const approvalCount = named.filter((r) => r.state === "approved").length;
  const changesCount = named.filter((r) => r.state === "changes_requested").length;
  const pendingCount = named.filter((r) => r.state === "pending").length;

  return (
    <aside aria-label={t("reviewWindow.sideTitle")} className="flex w-[340px] shrink-0 flex-col bg-[var(--color-ink-900)]">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-edge-1)] px-3 py-[7px]">
        <button
          type="button"
          onClick={() => {
            setTab("conversation");
          }}
          className={
            tab === "conversation"
              ? "rounded-[5px] bg-[var(--color-ink-800)] px-2 py-[3px] text-[11px] text-[var(--color-bone-2)]"
              : "rounded-[5px] px-2 py-[3px] text-[11px] text-[var(--color-faint)] hover:text-[var(--color-muted)]"
          }
        >
          {t("reviewWindow.tabConversation")}
        </button>
        <button
          type="button"
          onClick={() => {
            setTab("checks");
          }}
          className={
            tab === "checks"
              ? "rounded-[5px] bg-[var(--color-ink-800)] px-2 py-[3px] text-[11px] text-[var(--color-bone-2)]"
              : "rounded-[5px] px-2 py-[3px] text-[11px] text-[var(--color-faint)] hover:text-[var(--color-muted)]"
          }
        >
          {t("reviewWindow.tabChecks")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-[14px] pt-3 pb-5">
        {tab === "conversation" ? (
          <>
            <SectionLabel>{t("reviewWindow.sectionReviewers")}</SectionLabel>
            {named.length === 0 ? (
              <p className="py-1 text-[11px] text-[var(--color-faint)]">{t("reviewWindow.noReviewers")}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {named.map((entry) => (
                  <li key={entry.reviewer.id} className="flex items-center gap-[7px]">
                    <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-[var(--color-ink-700)] text-[9px] text-[var(--color-bone-2)]">
                      {initials(entry.reviewer.username)}
                    </span>
                    <span className="truncate text-[11.5px] text-[var(--color-muted)]">
                      {entry.reviewer.username}
                    </span>
                    <span className="ml-auto shrink-0">
                      <ReviewerChip entry={entry} />
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <SectionLabel className="mt-4">{t("reviewWindow.sectionConversation")}</SectionLabel>
            {thread.length === 0 ? (
              <p className="py-1 text-[11px] text-[var(--color-faint)]">{t("reviewWindow.noComments")}</p>
            ) : (
              thread.map((comment) => (
                <div
                  key={comment.id}
                  className="flex gap-[9px] border-b border-[var(--color-edge-1)] py-[10px] last:border-b-0"
                >
                  <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-[var(--color-ink-700)] text-[9px] text-[var(--color-bone-2)]">
                    {initials(comment.author?.username ?? "")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-1.5 text-[11px] text-[var(--color-faint)]">
                      <strong className="font-medium text-[var(--color-bone-2)]">
                        {comment.author?.username ?? "—"}
                      </strong>
                      <span>·</span>
                      <span>{relativeTime(comment.createdAt, t)}</span>
                    </p>
                    <p className="mt-[3px] text-[12px] leading-[1.6] whitespace-pre-wrap text-[var(--color-muted)]">
                      {comment.content}
                    </p>
                  </div>
                </div>
              ))
            )}

            {isOpen && (
              <div className="mt-2">
                <textarea
                  value={replyText}
                  onChange={(e) => {
                    onReplyText(e.target.value);
                  }}
                  rows={2}
                  placeholder={t("reviewWindow.replyPlaceholder")}
                  className="w-full resize-none rounded-[5px] border border-[var(--color-edge-2)] bg-[var(--color-ink-950)] px-2 py-1.5 text-[11.5px] text-[var(--color-bone-2)] outline-none placeholder:text-[var(--color-faint)] focus:border-[var(--color-edge-3)]"
                />
                <button
                  type="button"
                  onClick={onSubmitReply}
                  disabled={busy === "replying" || replyText.trim() === ""}
                  className="mt-1.5 flex items-center gap-[5px] rounded-[5px] border border-[var(--color-edge-2)] px-2.5 py-[3px] text-[10.5px] text-[var(--color-muted-2)] hover:bg-[var(--color-ink-800)] disabled:opacity-40"
                >
                  <Icon name="send" size={11} />
                  {t("reviewWindow.replySend")}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <SectionLabel>{t("reviewWindow.sectionChecks")}</SectionLabel>
            {/* 这个平台没有 CI：不画假的检查行，直接说明为什么这里是空的。 */}
            <p className="py-1 text-[11px] leading-relaxed text-[var(--color-faint)]">
              {t("reviewWindow.noChecks")}
            </p>

            <SectionLabel className="mt-4">{t("reviewWindow.protectionTitle")}</SectionLabel>
            {protection === null ? (
              <p className="py-1 text-[11px] text-[var(--color-faint)]">{t("reviewWindow.noProtection")}</p>
            ) : (
              <ul className="flex flex-col gap-[5px]">
                {protection.isProtected && (
                  <li className="flex items-center gap-[7px] text-[11px] text-[var(--color-muted)]">
                    <Icon name="shield" size={13} className="shrink-0 text-[var(--color-sky)]" />
                    {t("reviewWindow.protectedBranch")}
                  </li>
                )}
                {protection.requireCodeReview && (
                  <li className="flex items-center gap-[7px] text-[11px] text-[var(--color-muted)]">
                    <Icon name="users" size={13} className="shrink-0 text-[var(--color-muted-2)]" />
                    {t("reviewWindow.requireCodeReview")}
                  </li>
                )}
                {protection.requireStatusChecks && (
                  <li className="flex items-center gap-[7px] text-[11px] text-[var(--color-muted)]">
                    <Icon name="check-circle" size={13} className="shrink-0 text-[var(--color-sage)]" />
                    {t("reviewWindow.requireStatusChecks")}
                  </li>
                )}
                {!protection.isProtected &&
                  !protection.requireCodeReview &&
                  !protection.requireStatusChecks && (
                    <li className="py-1 text-[11px] text-[var(--color-faint)]">
                      {t("reviewWindow.noProtection")}
                    </li>
                  )}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--color-edge-1)] bg-[var(--color-ink-900)] px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-[6px] border border-[var(--color-edge-1)] bg-[rgba(19,32,39,0.4)] px-2.5 py-[6px] text-[11px] text-[var(--color-muted)]">
          <Icon name="alert" size={12} className="shrink-0 text-[var(--color-amber)]" />
          <span>{t("reviewWindow.verdict")}</span>
        </div>

        {isOpen ? (
          <div className="mt-2 flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => {
                onVerdict("approved");
              }}
              disabled={busy !== "idle"}
              className="w-full rounded-[5px] bg-[var(--color-sage)] px-2 py-[5px] text-[11px] font-medium text-[var(--color-ink-1000)] disabled:opacity-50"
            >
              {t("reviewWindow.approve")}
            </button>
            <button
              type="button"
              onClick={() => {
                onVerdict("changes_requested");
              }}
              disabled={busy !== "idle"}
              className="w-full rounded-[5px] border border-[var(--color-edge-2)] px-2 py-[5px] text-[11px] text-[var(--color-rose-2)] hover:bg-[var(--color-ink-800)] disabled:opacity-50"
            >
              {t("reviewWindow.requestChanges")}
            </button>
          </div>
        ) : (
          <p className="mt-[6px] text-center text-[10px] text-[var(--color-faint)]">
            {pr.status === "merged" ? t("pulls.segments.merged") : t("pulls.segments.closed")}
          </p>
        )}

        <p className="mt-[6px] text-center text-[10px] text-[var(--color-faint)]">
          {t("reviewWindow.sectionReviewers")}
          {" · "}
          {t("reviewWindow.reviewerApproved")} {approvalCount}
          {changesCount > 0 && ` · ${t("reviewWindow.reviewerChanges")} ${String(changesCount)}`}
          {pendingCount > 0 && ` · ${t("reviewWindow.reviewerPending")} ${String(pendingCount)}`}
          {drafts.length > 0 && ` · ${t("reviewWindow.reviewerDrafts", { count: drafts.length })}`}
        </p>
      </div>
    </aside>
  );
}

/** 评审人状态徽标。 */
function ReviewerChip({ entry }: { entry: ReviewerEntry }) {
  const { t } = useTranslation();
  if (entry.state === "approved") {
    return <Chip tone="sage">{t("reviewWindow.reviewerApproved")}</Chip>;
  }
  if (entry.state === "changes_requested") {
    return <Chip tone="rose">{t("reviewWindow.reviewerChanges")}</Chip>;
  }
  return <Chip>{t("reviewWindow.reviewerPending")}</Chip>;
}

/* ------------------------------------------------------------------ */
/* 小组件                                                              */
/* ------------------------------------------------------------------ */

/** 徽标。原型里是一个通用的 `.chip`，这里按 tone 分三色。 */
function Chip({ tone, children }: { tone?: "sage" | "rose" | "amber"; children: React.ReactNode }) {
  const base = "rounded-[4px] px-[6px] py-[1px] text-[10px]";
  if (tone === "sage") return <span className={`${base} bg-[rgba(134,183,158,0.14)] text-[var(--color-sage-2)]`}>{children}</span>;
  if (tone === "rose") return <span className={`${base} bg-[rgba(217,130,130,0.14)] text-[var(--color-rose-2)]`}>{children}</span>;
  if (tone === "amber") return <span className={`${base} bg-[rgba(242,174,91,0.14)] text-[var(--color-amber-2)]`}>{children}</span>;
  return <span className={`${base} bg-[var(--color-ink-800)] text-[var(--color-muted-2)]`}>{children}</span>;
}

/** 段落标签：原型里的 `.section-label`。 */
function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={`mb-1.5 text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase ${className ?? ""}`}
    >
      {children}
    </p>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="max-w-[46ch] text-[12px] leading-relaxed text-[var(--color-muted)]">{children}</p>
    </div>
  );
}

/** 名字首字母，用于 18px 的圆形头像位。 */
function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "?";
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

/** diff 请求错误 → 可读文案。 */
function diffErrorText(error: unknown): string {
  if (error instanceof PRDiffRequestError) return `HTTP ${String(error.status)}`;
  if (error instanceof Error && error.message !== "") return error.message;
  return "—";
}

/** 任意错误 → 可读文案（用于提示条）。 */
function describeError(error: unknown): string {
  if (error instanceof PRReviewError) {
    return error.code === null ? `HTTP ${String(error.status)}` : `${error.code} (HTTP ${String(error.status)})`;
  }
  if (error instanceof PullsRequestError) return `HTTP ${String(error.status)}`;
  if (error instanceof Error && error.message !== "") return error.message;
  return "—";
}

/**
 * 把请求错误渲染成可读文案。
 *
 * 结构化错误按操作类型查翻译键，并保留 HTTP 状态码——"HTTP 403" 对排查
 * 很关键，而一句"加载失败"没有信息量。
 */
function errorText(
  error: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
  fallback: string,
): string {
  if (error instanceof PullsRequestError) {
    return t(`pulls.errors.${error.operation}`, { status: error.status });
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return t("pulls.detailFailed", { number: fallback });
}
