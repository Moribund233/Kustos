import { create } from "zustand";

import {
  api,
  getRefreshToken,
  onAuthLost,
  refreshSession,
  setAccessToken,
  setRefreshToken,
} from "@/lib/api/client";

/** 当前登录用户（来源 GET /api/v1/users/me）。 */
export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  full_name: string | null;
  is_active: boolean;
  is_admin: boolean;
  avatar_url: string | null;
}

/** boot = 启动恢复会话中；anon = 未登录；authed = 已登录。 */
type AuthStatus = "boot" | "anon" | "authed";

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  /** 登录中标志，供表单禁用按钮。 */
  pending: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 启动时用 refresh token 恢复会话；无 refresh 或刷新失败转 anon。 */
  restore: () => Promise<void>;
  /** 拉取 /users/me 刷新本地用户信息。 */
  reloadMe: () => Promise<void>;
}

async function fetchMe(): Promise<AuthUser> {
  const res = await api.GET("/api/v1/users/me");
  if (!res.data) throw new Error("fetch me failed");
  // schema 对该响应未建模，按后端 user_service 的序列化字段取值
  return res.data as unknown as AuthUser;
}

/**
 * 会话状态仓。
 *
 * 令牌本体在 lib/api/client（内存 access + localStorage refresh），
 * 这里只保存用户资料与状态机；刷新失败事件由 client 广播、这里转 anon。
 */
export const useAuthStore = create<AuthState>()((set, get) => ({
  status: "boot",
  user: null,
  pending: false,

  login: async (username, password) => {
    set({ pending: true });
    try {
      const res = await api.POST("/api/v1/auth/login", { body: { username, password } });
      if (!res.data) {
        throw new Error(res.error ? JSON.stringify(res.error) : "login failed");
      }
      // 登录响应是扁平结构：用户字段 + token/refresh_token（不是 access_token）
      const payload = res.data as unknown as {
        token: string;
        refresh_token: string;
      };
      setAccessToken(payload.token);
      setRefreshToken(payload.refresh_token);
      set({ user: await fetchMe(), status: "authed" });
    } finally {
      set({ pending: false });
    }
  },

  logout: async () => {
    // 尽力而为：后端把访问/刷新家族一起吊销；失败也不影响本地清退
    try {
      await api.POST("/api/v1/auth/logout", {});
    } catch {
      /* 网络异常时仍要清本地会话 */
    }
    setAccessToken(null);
    setRefreshToken(null);
    set({ status: "anon", user: null });
  },

  restore: async () => {
    if (get().status !== "boot") return;
    if (!getRefreshToken()) {
      set({ status: "anon" });
      return;
    }
    // 刷新页后 access token 只在内存里没了，先用 refresh 换回来
    if (!(await refreshSession())) {
      set({ status: "anon" });
      return;
    }
    try {
      set({ user: await fetchMe(), status: "authed" });
    } catch {
      set({ status: "anon", user: null });
    }
  },

  reloadMe: async () => {
    if (get().status !== "authed") return;
    try {
      set({ user: await fetchMe() });
    } catch {
      /* 401 已由 client 的刷新链路处理，这里只做静默失败 */
    }
  },
}));

// 刷新失败（token 家族吊销/过期）→ 全局转未登录；路由守卫会把用户带回登录页
onAuthLost(() => {
  useAuthStore.setState({ status: "anon", user: null });
});
