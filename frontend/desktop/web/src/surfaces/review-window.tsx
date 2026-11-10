import { useTranslation } from "react-i18next";

import { Icon } from "@/shell/icon";
import { relativeTime } from "@/lib/relative-time";
import { usePullRequest, PullsRequestError } from "@/lib/pulls";
import { useRepositories } from "@/lib/repos";
import { WindowFrame } from "@/shell/window-frame";

/**
 * 评审窗：第二个窗口里的单 PR 视图。
 *
 * 与主窗口的 Pulls 面刻意不同：这里**没有左轨、没有列表栏**。评审窗是被
 * "把某个 PR 拎出来单独看"这个动作打开的，它的上下文已经由 URL 片段里的
 * 编号固定，再放一层列表只会让用户以为能在窗口里切换 PR——那应该回主窗口做。
 *
 * 仓库仍然要解析：PR 编号只在某个仓库内唯一。评审窗不跟随主窗口的选中仓库
 * （多窗口下全局状态由最后写入者胜出），因此这里独立取列表并按编号找第一个
 * 能命中的仓库。
 */
export function ReviewWindow({ prNumber }: { prNumber: number }) {
  const repos = useRepositories();

  // 逐个仓库试取这个编号的 PR。仓库数通常是个位数，且查询结果会被缓存，
  // 因此这里不做"先猜一个仓库"的额外推断——猜错会显示另一个 PR。
  const candidates = repos.data ?? [];

  return (
    <WindowFrame>
      <ReviewBody prNumber={prNumber} repoIds={candidates.map((r) => r.id)} reposLoading={repos.isLoading} />
    </WindowFrame>
  );
}

/**
 * 评审窗正文。
 *
 * 取数策略：对候选仓库依次尝试，第一个成功返回的即采用。用多个 usePullRequest
 * 会违反 hooks 规则（数量随仓库数变化），因此这里只对"第一个仓库"发请求，
 * 失败时给出明确的仓库选择提示——宁可让用户点一下，也不在本地猜。
 */
function ReviewBody({
  prNumber,
  repoIds,
  reposLoading,
}: {
  prNumber: number;
  repoIds: string[];
  reposLoading: boolean;
}) {
  const { t } = useTranslation();
  const repoId = repoIds[0] ?? null;
  const detail = usePullRequest(repoId, prNumber);

  if (reposLoading) {
    return <Center>{t("common.loading")}</Center>;
  }

  if (repoIds.length === 0) {
    return <Center>{t("pulls.noRepo")}</Center>;
  }

  const pr = detail.data;
  if (!pr) {
    if (detail.isLoading) return <Center>{t("pulls.loading")}</Center>;
    return (
      <Center>
        {errorText(detail.error, t, `#${prNumber}`)}
      </Center>
    );
  }

  const comments = pr.comments ?? [];

  return (
    <>
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-5 pt-[13px] pb-[11px]">
        <div className="flex items-center gap-[7px] text-[10px] tracking-[0.14em] text-[var(--color-faint)] uppercase">
          <Icon name="pr" size={11} />
          <span>#{pr.number}</span>
          <span>·</span>
          <span>{pr.status}</span>
          <span className="ml-auto tracking-normal normal-case">
            {relativeTime(pr.createdAt, t)}
          </span>
        </div>
        <h1 className="mt-1 text-[15px] font-medium tracking-[-0.01em] text-[var(--color-bone)]">
          {pr.title}
        </h1>
        <p className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--color-muted-2)]">
          <span className="truncate">{pr.sourceBranch}</span>
          <Icon name="chevron-right" size={10} className="shrink-0" />
          <span className="truncate">{pr.targetBranch}</span>
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-[74ch]">
          <div className="mb-3.5 flex items-start gap-[9px] rounded-[7px] border border-[var(--color-edge-1)] bg-[linear-gradient(180deg,rgba(19,32,39,0.5),rgba(12,21,26,0.62))] px-3 py-2">
            <Icon name="lock" size={13} className="mt-px shrink-0 text-[var(--color-muted-2)]" />
            <span className="text-[11px] leading-relaxed text-[var(--color-muted)]">
              {t("pulls.readOnlyHint")}
            </span>
          </div>

          {pr.description ? (
            <p className="text-[12.5px] leading-[1.6] whitespace-pre-wrap text-[var(--color-bone-2)]">
              {pr.description}
            </p>
          ) : (
            <p className="text-[11.5px] text-[var(--color-faint)]">{t("pulls.noBody")}</p>
          )}

          <p className="mt-5 mb-1 text-[9.5px] tracking-[0.15em] text-[var(--color-faint)] uppercase">
            {t("pulls.sectionComments")}
            {comments.length > 0 && <span className="ml-1.5 tracking-normal">{comments.length}</span>}
          </p>

          {comments.length === 0 ? (
            <p className="py-1 text-[11.5px] text-[var(--color-faint)]">{t("pulls.noComments")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-[7px] border border-[var(--color-edge-1)] bg-[rgba(12,21,26,0.5)] px-3 py-2"
                >
                  <p className="flex items-center gap-2 text-[10.5px] text-[var(--color-muted-2)]">
                    <span>{c.author?.username ?? "—"}</span>
                    {c.filePath && (
                      <span className="truncate font-mono text-[10px]">
                        {c.filePath}
                        {c.lineNumber ? `:${c.lineNumber}` : ""}
                      </span>
                    )}
                    <span className="ml-auto shrink-0">{relativeTime(c.createdAt, t)}</span>
                  </p>
                  <p className="mt-1 text-[12px] leading-[1.55] whitespace-pre-wrap text-[var(--color-bone-2)]">
                    {c.content}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="max-w-[46ch] text-[12px] leading-relaxed text-[var(--color-muted)]">{children}</p>
    </div>
  );
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
