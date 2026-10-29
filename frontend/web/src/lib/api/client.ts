import createClient from "openapi-fetch";

import type { paths } from "@/api/schema";
import { currentAcceptLanguage } from "@/lib/i18n";

/** 空字符串表示与页面同源（生产经网关访问 /api/v1）。 */
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "";

/**
 * 访问令牌只存内存：刷新页面后由 refresh token 重新换发，
 * 不给 localStorage 留 XSS 窃取面。
 */
let accessToken: string | null = null;

const REFRESH_KEY = "kustos.refresh";

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * 读取当前访问令牌。
 *
 * 实时通道握手要把令牌放进 `Sec-WebSocket-Protocol`，无法复用 openapi 客户端
 * 的中间件，因此单独开放只读入口；写入仍只允许 `setAccessToken`。
 */
export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setRefreshToken(token: string | null): void {
  if (token) localStorage.setItem(REFRESH_KEY, token);
  else localStorage.removeItem(REFRESH_KEY);
}

/* ------------------------------------------------------------------ */
/* 401 → 刷新（single-flight）                                          */
/* ------------------------------------------------------------------ */

type AuthLostListener = () => void;
const authLostListeners = new Set<AuthLostListener>();

/** 订阅「刷新失败、会话失效」事件；登出/踢回登录页由订阅方处理。 */
export function onAuthLost(listener: AuthLostListener): () => void {
  authLostListeners.add(listener);
  return () => authLostListeners.delete(listener);
}

/** 并发 401 共用一次刷新：后端 refresh 轮换带重用检测，并发刷新会触发 family 吊销。 */
let refreshing: Promise<boolean> | null = null;

/** 用 refresh token 换发新令牌对；并发调用共用一次请求（重用检测见后端）。 */
export function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return false;
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept-Language": currentAcceptLanguage(),
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) {
        setAccessToken(null);
        setRefreshToken(null);
        return false;
      }
      const data = (await res.json()) as { access_token: string; refresh_token: string };
      setAccessToken(data.access_token);
      setRefreshToken(data.refresh_token);
      return true;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/**
 * 补齐请求头。
 *
 * 两件事都在 fetch 层做（openapi 客户端的 `use` 中间件在部分版本里不生效）：
 * - `Accept-Language`：后端据此翻译错误消息，缺失时回落中文；
 * - `Content-Type`：客户端会把 body 序列化成 JSON 文本，字符串 body 浏览器默认
 *   按 text/plain 发，FastAPI 会把它当非对象解析并返回 422。
 *   multipart 上传全部走原生 fetch，不经过这里。
 *
 * 注意 openapi 客户端调用的是 `fetch(request)`（单个 Request 对象），因此必须
 * 继承 Request 自带的头，重建 Headers 会把原有的 Content-Type 一起丢掉。
 */
function withHeaders(input: RequestInfo | URL, init: RequestInit | undefined): RequestInit {
  const request = input instanceof Request ? input : null;
  const headers = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));

  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const hasBody = init?.body != null || Boolean(request?.body);

  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept-Language", currentAcceptLanguage());
  if (method !== "GET" && method !== "HEAD" && hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return { ...init, headers };
}

/** 带认证的 fetch：注入 Bearer；401 时刷新一次并重试原请求，刷新失败广播会话失效。 */
const authorizedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const isAuthEndpoint = url.includes("/api/v1/auth/");

  const res = await fetch(input, withHeaders(input, init));
  if (res.status !== 401 || isAuthEndpoint) return res;

  if (await refreshSession()) {
    return fetch(input, withHeaders(input, init));
  }
  setAccessToken(null);
  setRefreshToken(null);
  authLostListeners.forEach((listener) => listener());
  return res;
};

export const api = createClient<paths>({
  baseUrl: API_BASE_URL,
  fetch: authorizedFetch,
});

/**
 * 给每个请求补上当前语言的 `Accept-Language`。
 *
 * 后端据此翻译错误消息（`detail`），不传时回落到默认中文，会出现英文界面配中文报错。
 * 这里在请求发出前才取值，因此切换语言后无需重建 client。
 */
export type ApiPaths = paths;
