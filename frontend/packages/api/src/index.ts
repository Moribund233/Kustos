/**
 * Kustos 契约层入口。
 *
 * 只暴露"两端都需要、且与页面组合无关"的东西：OpenAPI 类型、带认证的请求
 * 客户端、查询封装。**不导出任何 TanStack Query 的组合式封装**——`staleTime`
 * 与持久化策略两端不同（桌面端要 SQLite + 长驻缓存），共享会迫使取交集。
 */
export type { paths, components, operations } from "./schema";
export {
  API_BASE_URL,
  api,
  configureAuth,
  getAccessToken,
  getRefreshToken,
  onAuthLost,
  refreshSession,
  setAccessToken,
  setRefreshToken,
  type ApiPaths,
  type RefreshTokenStore,
} from "./client";
export { useApiMutation, useApiQuery } from "./hooks";
