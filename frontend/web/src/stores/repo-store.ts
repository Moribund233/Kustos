import { create } from "zustand";

import { api } from "@/lib/api/client";
import { useAuthStore } from "@/stores/auth-store";

/** 仓库摘要（GET /api/v1/repositories 的列表项，按后端 Repository 模型取字段）。 */
export interface RepoSummary {
  id: string;
  name: string;
  path: string;
  description: string | null;
  is_public: boolean;
  owner_id: string;
  default_branch: string;
  fork_count: number;
  star_count: number;
  watch_count: number;
  updated_at: string;
}

interface RepoState {
  repos: RepoSummary[];
  /** 当前仓库；列表为空或未选择时为 null，仓库级页面渲染空态。 */
  current: RepoSummary | null;
  loading: boolean;
  /** 拉取仓库列表；登录后由外壳触发。 */
  load: () => Promise<void>;
  /** 切换当前仓库（侧栏点击）。 */
  select: (id: string) => void;
}

/**
 * 仓库选择状态仓。
 *
 * 扁平路由阶段（/:owner/:repo 尚未落地）由这里充当「当前仓库」的唯一来源：
 * 侧栏仓库列表与代码/Issue/PR/Agent/聊天页共用，切换即全局生效。
 */
export const useRepoStore = create<RepoState>()((set, get) => ({
  repos: [],
  current: null,
  loading: false,

  load: async () => {
    if (useAuthStore.getState().status !== "authed") return;
    set({ loading: true });
    try {
      const res = await api.GET("/api/v1/repositories", {
        // 后端 OpenAPI 未给该端点建 query 模型，分页参数先以断言传入
        params: { query: { page: 1, limit: 100 } } as never,
      });
      const items = (res.data as { items?: RepoSummary[] } | undefined)?.items ?? [];
      const { current } = get();
      set({
        repos: items,
        // 列表刷新后当前仓库若已不存在（改名/删除/换账号），回落到第一个
        current: current && items.some((repo) => repo.id === current.id) ? current : (items[0] ?? null),
      });
    } finally {
      set({ loading: false });
    }
  },

  select: (id) => {
    const repo = get().repos.find((item) => item.id === id) ?? null;
    set({ current: repo });
  },
}));
