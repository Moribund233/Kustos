/**
 * 协作感知：哪些文件正有人在编辑。
 *
 * 数据来自 `GET /api/v1/repositories/{id}/collab/active`。响应有意区分
 * `documents` 与 `degraded`：空清单既可能"确实没人在编辑"，也可能"感知不可用"。
 * 两者在界面上必须长得不一样——把降级当成"没人在线"，用户就会以为可以拿本地
 * 内容开新会话，而这恰好是设计里最危险的误判。
 *
 * 这里手写 `fetch` 而不是走 `@kustos/api`：契约层的 `schema.ts` 目前还没有这个
 * 端点（后端 213 条路径，生成物只有 178 条）。为一个端点整份重新生成会带进
 * 三十多条无关变更，先把请求写在这里并注明，等契约整体重新生成后再收编。
 */
import { useQuery } from "@tanstack/react-query";
import { getAccessToken } from "@kustos/api";

import { parseCollabDocumentKey } from "./collab";

export interface ActiveCollabDocument {
  /** 文档键 `repositoryId:branch:path`。 */
  docKey: string;
  /** 该文档当前的活跃连接数（多副本求和）。 */
  connections: number;
}

export interface ActiveCollabDocs {
  documents: ActiveCollabDocument[];
  /** 感知不可用；为真时不得据此判断"没人在线"。 */
  degraded: boolean;
}

export const collabActiveKeys = {
  active: (repositoryId: string | null) => ["collab-active", repositoryId ?? ""] as const,
};

/** 协作感知端点地址。 */
export function collabActiveUrl(repositoryId: string): string {
  return `/api/v1/repositories/${encodeURIComponent(repositoryId)}/collab/active`;
}

/** 拉取仓库当前活跃的协作文档清单。 */
export async function fetchActiveCollabDocs(repositoryId: string): Promise<ActiveCollabDocs> {
  const token = getAccessToken();
  const response = await fetch(collabActiveUrl(repositoryId), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const body = (await response.json()) as Partial<ActiveCollabDocs>;
  return {
    documents: Array.isArray(body.documents) ? body.documents : [],
    degraded: body.degraded === true,
  };
}

/**
 * 订阅某仓库的协作感知。
 *
 * 感知是"别人正在做什么"，只读且轻量，因此短轮询：桌面窗口一直持有焦点，
 * `refetchOnWindowFocus` 在这种情况下永远不会触发。
 */
export function useActiveCollabDocs(repositoryId: string | null) {
  return useQuery({
    queryKey: collabActiveKeys.active(repositoryId),
    queryFn: async () => (repositoryId ? fetchActiveCollabDocs(repositoryId) : { documents: [], degraded: false }),
    enabled: Boolean(repositoryId),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

/**
 * 把活跃文档清单收敛成"某分支下每个路径有多少人"。
 *
 * 只统计当前分支：界面上打开的是一棵分支快照的树，别的分支有人在编辑
 * 与这些文件无关，混进来会让圆点指向错误的行。
 */
export function activePathCounts(
  documents: readonly ActiveCollabDocument[],
  branch: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of documents) {
    const parsed = parseCollabDocumentKey(item.docKey);
    if (!parsed || parsed.branch !== branch) continue;
    const current = counts.get(parsed.path) ?? 0;
    counts.set(parsed.path, current + item.connections);
  }
  return counts;
}

/** 该文档上的连接数；不在清单里就是 0。 */
export function connectionsFor(documents: readonly ActiveCollabDocument[], docKey: string): number {
  const found = documents.find((item) => item.docKey === docKey);
  return found ? found.connections : 0;
}
