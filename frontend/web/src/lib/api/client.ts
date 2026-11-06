/**
 * 兼容层：转发到 `@kustos/api`。
 *
 * 契约层已抽到 `frontend/packages/api`（Shared with desktop）。这里保留原路径
 * 是为了让 `frontend/web` 在迁移期间**每一步都可构建**——文档要求抽取过程中
 * Web 的交付不能被打断。新代码请直接从 `@kustos/api` 导入。
 */
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
} from "@kustos/api/client";

import { configureAuth } from "@kustos/api/client";
import { currentAcceptLanguage } from "@/lib/i18n";

// Web 的语言来源是 i18next；桌面端有自己的策略，因此由宿主在此处注入。
configureAuth({ acceptLanguage: currentAcceptLanguage });
