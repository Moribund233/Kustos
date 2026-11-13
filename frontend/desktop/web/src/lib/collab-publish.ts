/**
 * 协作草稿的发布：预览与提交。
 *
 * 协作保存一律落 `collab/draft-{branch}` 草稿分支，正式历史只在**显式发布**
 * 时产生一次 squash 提交。这条边界由服务端保证（`POST /{repo_id}/collab/publish`
 * 带 REPO_WRITE 与分支保护裁决），桌面端负责两件事：
 *
 *  1. 发布前把"要合进去的到底是什么"摊开——`GET /{repo_id}/compare` 给的是
 *     草稿分支相对目标分支的提交数与逐文件增删；
 *  2. 发布后把本地那份草稿引用同步回来，否则界面会一直显示"还有 N 次未发布"。
 *
 * 为什么预览值得一次网络往返：桌面端相对 Web 多做的就是这一步。草稿分支上
 * 可能是别人攒了一下午的保存，squash 进主分支前看不见内容等于盲签。
 */
import { useQuery } from "@tanstack/react-query";

import { api } from "@kustos/api";

import { collabDraftBranch } from "./collab";

/** 草稿分支里的一个文件。 */
export interface DraftFile {
  /** 仓库内相对路径（删除的文件取旧路径）。 */
  path: string;
  /** 单字母状态：A 新增 / M 修改 / D 删除 / R 重命名。 */
  status: string;
  additions: number;
  deletions: number;
}

/** 发布前预览：草稿分支相对目标分支待合入的内容。 */
export interface DraftPreview {
  /** 草稿侧领先的提交数（也就是会被压成一次提交的保存次数）。 */
  commitCount: number;
  files: DraftFile[];
  additions: number;
  deletions: number;
  /**
   * 草稿分支还不存在。
   *
   * 与"存在但没有差异"分开：前者说明这一段协作还没保存过，后者说明保存过的
   * 内容已经发布干净。两者对用户的含义完全不同，界面上不能合并成一句"没有变更"。
   */
  missingDraft: boolean;
}

/** 发布结果。 */
export interface DraftPublishResult {
  /** 发布提交的 SHA；没有可发布内容时为 null。 */
  commitId: string | null;
  /** 落点的工作分支。 */
  branch: string;
  /** 本次发布的文件路径。 */
  paths: string[];
}

export type CollabPublishOperation = "preview" | "publish";

/**
 * 发布链路上的请求错误。
 *
 * 除状态码外保留服务端给的 `error_code` 与 `detail`：
 * `collab_publish_conflict` 是本文件里唯一值得单独说话的失败——草稿与目标分支
 * 有并行修改时服务端整体拒绝，用户需要知道"是冲突，不是权限或网络"。
 */
export class CollabPublishError extends Error {
  readonly operation: CollabPublishOperation;
  readonly status: number;
  readonly code: string | null;
  readonly detail: string | null;

  constructor(
    operation: CollabPublishOperation,
    status: number,
    code: string | null = null,
    detail: string | null = null,
  ) {
    super(`${operation} failed with HTTP ${status}${code === null ? "" : ` (${code})`}`);
    this.name = "CollabPublishError";
    this.operation = operation;
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const collabPublishKeys = {
  /** 草稿分支相对目标分支的预览；键里带两个分支，换分支各自命中缓存。 */
  preview: (repoId: string | null, branch: string | null) =>
    ["collab-publish", repoId ?? "", branch ?? ""] as const,
};

/* ------------------------------------------------------------------ */
/* 响应收敛                                                            */
/* ------------------------------------------------------------------ */

/**
 * 逐字段读值助手在本仓库已有两份（`pulls.ts` / `pr-reviewers.ts`）。
 *
 * 这里只补真正用得到的两个：`compare` 与 `publish` 的响应在契约里都是
 * `unknown`，收敛必须自己写；而把所有助手提到公共模块是一次跨文件的
 * 重构，与本次接线无关，等契约整体重新生成时一并收编。
 */
function asRecord<T>(value: unknown): T | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as T;
}

/** 读非负整数；负数、NaN、非数字一律归零。 */
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 读非空字符串。 */
function asText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

interface RawDraftFile {
  old_path?: unknown;
  new_path?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
}

interface RawCompare {
  ahead_by?: unknown;
  files?: unknown;
  stats?: unknown;
}

/** 空的预览：草稿分支不存在，或还没算出来。 */
export function emptyPreview(missingDraft = false): DraftPreview {
  return { commitCount: 0, files: [], additions: 0, deletions: 0, missingDraft };
}

/**
 * 把 `compare` 的响应收敛成发布预览。
 *
 * 字段缺失一律按"没有"处理：预览是一次**只读**的判断，猜错会让人误发布，
 * 而少显示一个文件最坏也只是让人多点一次"发布"去看服务端的真实结果。
 */
export function toDraftPreview(raw: unknown): DraftPreview {
  const body = asRecord<RawCompare>(raw);
  if (body === null) return emptyPreview();

  const rows = Array.isArray(body.files) ? body.files : [];
  const files: DraftFile[] = [];
  for (const row of rows) {
    const record = asRecord<RawDraftFile>(row);
    if (record === null) continue;
    // 删除的文件只有旧路径；新增的只有新路径。两个都缺时这条没法展示，丢掉。
    const path = asText(record.new_path) ?? asText(record.old_path);
    if (path === null) continue;
    files.push({
      path,
      status: asText(record.status) ?? "M",
      additions: asCount(record.additions),
      deletions: asCount(record.deletions),
    });
  }

  const stats = asRecord<{ additions?: unknown; deletions?: unknown }>(body.stats);
  const additions =
    stats === null ? files.reduce((sum, f) => sum + f.additions, 0) : asCount(stats.additions);
  const deletions =
    stats === null ? files.reduce((sum, f) => sum + f.deletions, 0) : asCount(stats.deletions);

  return {
    commitCount: asCount(body.ahead_by),
    files,
    additions,
    deletions,
    missingDraft: false,
  };
}

/** 收敛发布结果。`commit_id` 为空表示没有可发布内容。 */
export function toDraftPublishResult(raw: unknown): DraftPublishResult {
  const body = asRecord<{ commit_id?: unknown; branch?: unknown; paths?: unknown }>(raw);
  const paths = Array.isArray(body?.paths)
    ? body.paths.filter((p): p is string => typeof p === "string" && p !== "")
    : [];
  return {
    commitId: asText(body?.commit_id),
    branch: asText(body?.branch) ?? "",
    paths,
  };
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

/** 从错误信封里取出 `error_code` 与 `detail`。 */
function readFailure(body: unknown): { code: string | null; detail: string | null } {
  const envelope = asRecord<{ detail?: unknown; error?: unknown }>(body);
  if (envelope === null) return { code: null, detail: null };
  const inner = asRecord<{ error_code?: unknown; message?: unknown }>(envelope.error);
  return {
    code: asText(inner?.error_code),
    detail: asText(envelope.detail) ?? asText(inner?.message),
  };
}

/**
 * 把一次失败响应收敛成 `CollabPublishError`。
 *
 * 优先读生成客户端已经解析好的 `error`：openapi-fetch 在响应体可解析时已经把它
 * 消费掉了，这时再 `response.json()` 只会抛"body already read"。
 */
async function toFailure(
  operation: CollabPublishOperation,
  response: Response,
  error: unknown,
): Promise<CollabPublishError> {
  let failure = readFailure(error);

  if (failure.code === null) {
    try {
      const body: unknown = await response.json().catch(() => null);
      const retry = readFailure(body);
      failure = { code: retry.code, detail: failure.detail ?? retry.detail };
    } catch {
      // 读不出错误码不该盖掉真正的状态码——那才是排查线索。
    }
  }

  return new CollabPublishError(operation, response.status, failure.code, failure.detail);
}

/** 草稿分支还没被创建：`compare` 找不到 head 引用，不是失败。 */
function isMissingDraft(failure: CollabPublishError): boolean {
  return failure.status === 404 && failure.code === "branch_ref_not_found";
}

/**
 * 拉取草稿分支相对目标分支的预览。
 *
 * 草稿分支不存在时返回 `missingDraft` 而不是抛错：没保存过草稿是常态，
 * 把它当成错误会让发布入口一直挂着一条红色提示。
 */
export async function fetchDraftPreview(
  repositoryId: string,
  branch: string,
): Promise<DraftPreview> {
  const { data, error, response } = await api.GET("/api/v1/repositories/{repo_id}/compare", {
    params: {
      path: { repo_id: repositoryId },
      query: { base: branch, head: collabDraftBranch(branch) },
    },
  });
  if (error || !response.ok) {
    const failure = await toFailure("preview", response, error);
    if (isMissingDraft(failure)) return emptyPreview(true);
    throw failure;
  }
  return toDraftPreview(data);
}

/**
 * 发布草稿：草稿侧全部变更 squash 成目标分支上的一次提交。
 *
 * 权限与分支保护都由服务端裁决，这里不预判：客户端拦不住别的入口，
 * 多一道本地判断只会让"界面允许但服务端拒绝"变成第二种失败形态。
 */
export async function publishCollabDraft(
  repositoryId: string,
  input: { branch: string; message?: string },
): Promise<DraftPublishResult> {
  const { data, error, response } = await api.POST(
    "/api/v1/repositories/{repo_id}/collab/publish",
    {
      params: { path: { repo_id: repositoryId } },
      body: { branch: input.branch, message: input.message ?? null },
    },
  );
  if (error || !response.ok) {
    throw await toFailure("publish", response, error);
  }
  return toDraftPublishResult(data);
}

/**
 * 订阅发布预览。
 *
 * `enabled` 由调用方决定何时取：协作模式下常开（徽标与状态条要显示"还有几次
 * 未发布"，本地引用可能落后服务端，只有服务端说得准），退出协作就关掉。
 *
 * 缓存时间取 10 秒、并在协作模式下 30 秒重取一次：草稿会随别人的保存前进，
 * 而这两个数字就写在界面上，久了会变成错的提示。
 */
export function useDraftPreview(
  repositoryId: string | null,
  branch: string | null,
  enabled: boolean,
  refetchInterval: number | false = false,
) {
  const repo = repositoryId ?? "";
  const name = branch ?? "";
  return useQuery({
    queryKey: collabPublishKeys.preview(repo, name),
    queryFn: () => fetchDraftPreview(repo, name),
    enabled: enabled && repo !== "" && name !== "",
    staleTime: 10_000,
    refetchInterval,
  });
}
