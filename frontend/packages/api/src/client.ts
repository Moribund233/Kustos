import createClient from "openapi-fetch";

import type { paths } from "./schema";

/**
 * 契约层：OpenAPI 类型 + 请求客户端 + 查询封装。
 *
 * 与页面组合无关——Web 与桌面端共享这一层，各自决定如何组织页面。
 * 因此本文件**不依赖任何宿主框架**（i18next、React Router、Wails 运行时），
 * 宿主差异一律通过 `configureAuth` 注入。
 */

/**
 * 空字符串表示与页面同源（生产经网关访问 /api/v1）。
 *
 * 桌面端由 loopback bridge 提供同源 `/api`，因此同样留空——共享层不该知道
 * "我在 Web 还是桌面"，同源是两端的最小公约数。
 */
export const API_BASE_URL = import.meta.env?.VITE_API_URL ?? "";

/* ------------------------------------------------------------------ */
/* 宿主注入点                                                          */
/* ------------------------------------------------------------------ */

type AcceptLanguageProvider = () => string;

/**
 * 语言来源由宿主注入。
 *
 * 契约层不依赖 i18next 的实现细节：Web 用 i18next 的当前语言，桌面端可以有
 * 自己的语言策略（跟随系统、受实例限制等）。默认中文，与后端默认一致。
 */
let acceptLanguage: AcceptLanguageProvider = () => "zh-CN,zh;q=0.9";

/* ------------------------------------------------------------------ */
/* 令牌                                                               */
/* ------------------------------------------------------------------ */

/**
 * 访问令牌只存内存：刷新页面后由 refresh token 重新换发，
 * 不给 localStorage 留 XSS 窃取面。
 *
 * 桌面端的 refresh token 由 Go 侧存进系统 Keychain，永不出 Go 进程；
 * 桌面壳会在启动时通过绑定把 access token 交给 JS 内存，语义与本层一致。
 */
let accessToken: string | null = null;

/**
 * refresh token 的宿主持久化策略。
 *
 * Web 放 localStorage；桌面端**不应该用这个**——它会把 refresh 落到
 * WebView 存储里，违背"只存 Keychain"的约束。桌面端调用 `configureAuth`
 * 时用 `refreshStore` 换成内存实现，真正持久化交给 Go。
 */
export interface RefreshTokenStore {
  get: () => string | null;
  set: (token: string | null) => void;
}

const REFRESH_KEY = "kustos.refresh";

const localStorageRefreshStore: RefreshTokenStore = {
  get: () => (typeof localStorage === "undefined" ? null : localStorage.getItem(REFRESH_KEY)),
  set: (token) => {
    if (typeof localStorage === "undefined") return;
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  },
};

let refreshStore: RefreshTokenStore = localStorageRefreshStore;

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
  return refreshStore.get();
}

export function setRefreshToken(token: string | null): void {
  refreshStore.set(token);
}

/* ------------------------------------------------------------------ */
/* 401 → 刷新（single-flight）                                          */
/* ------------------------------------------------------------------ */

type AuthLostListener = () => void;
const authLostListeners = new Set<AuthLostListener>();

/** 订阅「刷新失败、会话失效」事件；登出/踢回登录页由订阅方处理。 */
export function onAuthLost(listener: AuthLostListener): () => void {
  authLostListeners.add(listener);
  return () => {
    authLostListeners.delete(listener);
  };
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
          "Accept-Language": acceptLanguage(),
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
  headers.set("Accept-Language", acceptLanguage());
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

export type ApiPaths = paths;

/**
 * 配置宿主持有的令牌与语言策略。
 *
 * @param options.refreshStore  refresh token 的持久化实现（桌面端传入内存实现，
 *                              真正持久化由 Go 侧 Keychain 负责）
 * @param options.acceptLanguage 返回当前 `Accept-Language` 头值的函数
 */
export function configureAuth(options: {
  refreshStore?: RefreshTokenStore;
  acceptLanguage?: AcceptLanguageProvider;
}): void {
  if (options.refreshStore) refreshStore = options.refreshStore;
  if (options.acceptLanguage) acceptLanguage = options.acceptLanguage;
}

