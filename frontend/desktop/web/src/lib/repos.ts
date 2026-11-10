import { useQuery } from "@tanstack/react-query";

import { api } from "@kustos/api";
import { WorkingCopyService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import { matchRepository, parseRemoteSlug, type RemoteSlug } from "./remote-slug";
export { matchRepository };

/**
 * 仓库数据层：把"本机工作副本"与"服务端仓库"对上号。
 *
 * 桌面端的 PR 与 Issue 面都需要一个 `repo_id` 才能取数，而这个 id 只有服务端
 * 知道。本地只有工作副本路径与它的 git remote——两者之间唯一的可靠桥梁是
 * remote 地址里的 `owner/repo` 片段。
 *
 * 因此这里的职责很窄：列仓库、按 slug 解析仓库、从 remote 地址里抽出 slug。
 * **不做可见性推断**——能看到哪些仓库由服务端裁决（`app/core/permissions.py`），
 * 列表接口已经按查看者过滤过了，桌面端不再筛一遍。
 */

/**
 * 带 HTTP 状态码的请求错误。
 *
 * 抛**结构**而不是现成文案：数据层拿不到 i18n 上下文，写死中文会让英文界面
 * 里冒出中文。状态码本身必须保留——"HTTP 403" 对排查很关键，
 * 而"加载失败"四个字没有信息量。
 */
export class RepoRequestError extends Error {
  constructor(
    readonly operation: "list" | "byPath",
    readonly status: number,
  ) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "RepoRequestError";
  }
}

export const repoKeys = {
  list: ["repos", "list"] as const,
  bySlug: (owner: string, name: string) => ["repos", "by-slug", owner, name] as const,
  remoteSlug: (workingCopyId: string) => ["repos", "remote-slug", workingCopyId] as const,
};

/** 一个服务端仓库。字段与后端 `build_repo_response` 一一对应。 */
export interface Repository {
  id: string;
  name: string;
  /** 服务端路径，固定为 `owner/repo`。 */
  path: string;
  description: string | null;
  isPublic: boolean;
  defaultBranch: string;
  isArchived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface RawRepository {
  id?: unknown;
  name?: string;
  path?: string;
  description?: string | null;
  is_public?: boolean;
  default_branch?: string;
  is_archived?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

/** 把服务端的 snake_case 响应收敛成前端结构。 */
function toRepository(raw: RawRepository): Repository {
  return {
    // id 是 UUID 字符串。用 String() 兜住服务端把它序列化成别的类型的情况——
    // 这个值要直接拼进 URL，类型不对时拼接结果是 "undefined" 而不是报错，
    // 那会让请求打到一个必然 404 的地址上。
    id: raw.id === undefined || raw.id === null ? "" : String(raw.id),
    name: raw.name ?? "",
    path: raw.path ?? "",
    description: raw.description ?? null,
    isPublic: raw.is_public ?? false,
    defaultBranch: raw.default_branch ?? "master",
    isArchived: raw.is_archived ?? false,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}

/**
 * 列出当前账号可见的仓库。
 *
 * 这个接口在契约里没有精确的响应类型（`unknown`），因此在这里按后端的
 * `build_repo_response` 收敛；服务端改字段时以它为准。
 */export function useRepositories() {
  return useQuery({
    queryKey: repoKeys.list,
    queryFn: async () => {
      const { data, error, response } = await api.GET("/api/v1/repositories", {});
      if (error || !response.ok) {
        throw new RepoRequestError("list", response.status);
      }
      // 后端直接返回数组；包成 { items } 的形态是分页接口才有的。
      const payload = data as RawRepository[] | { items?: RawRepository[] } | undefined;
      const rows = Array.isArray(payload) ? payload : (payload?.items ?? []);
      return rows.map(toRepository).filter((r) => r.id !== "");
    },
    // 常驻应用：切 surface 不该重新拉。仓库列表在一小时内几乎不变。
    staleTime: 5 * 60_000,
  });
}

/** 按 `owner/repo` 解析单个仓库；slug 为空时不发请求。 */
export function useRepositoryBySlug(slug: { owner: string; name: string } | null) {
  const owner = slug?.owner ?? "";
  const name = slug?.name ?? "";
  return useQuery({
    queryKey: repoKeys.bySlug(owner, name),
    enabled: owner !== "" && name !== "",
    queryFn: async () => {
      const { data, error, response } = await api.GET("/api/v1/repo/{owner}/{repo}", {
        params: { path: { owner, repo: name } },
      });
      if (error || !response.ok) {
        throw new RepoRequestError("byPath", response.status);
      }
      return toRepository((data ?? {}) as RawRepository);
    },
    staleTime: 5 * 60_000,
  });
}

export { parseRemoteSlug };
export type { RemoteSlug };

/**
 * 从某个工作副本的 git remote 推导服务端仓库标识。
 *
 * remote 地址由本机 git 读取（走 Go 侧，不经网络），解析在本层完成。
 *
 * Args:
 *
 *	workingCopyId: 工作副本 ID；为 null 时不发请求
 *
 * Returns:
 *
 *	`owner/repo` 标识；没有工作副本、没有 remote 或地址无法识别时为 null。
 *	null 是正常的——用户可能还没接远端，此时界面退回仓库列表让用户自己选。
 */
export function useWorkingCopySlug(workingCopyId: string | null) {
  const id = workingCopyId ?? "";
  return useQuery({
    queryKey: repoKeys.remoteSlug(id),
    enabled: id !== "",
    queryFn: async () => {
      const upstream = await WorkingCopyService.RemoteInfo(id);
      return parseRemoteSlug(upstream?.url ?? "");
    },
    // remote 地址只在用户改了 git 配置时才变，常驻期间不必反复读。
    staleTime: 10 * 60_000,
  });
}

