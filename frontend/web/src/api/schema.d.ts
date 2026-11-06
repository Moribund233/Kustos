/**
 * 兼容层：OpenAPI 类型已迁到 `@kustos/api`。
 *
 * 保留此文件让既有 `@/api/schema` 引用在迁移期间继续可用；新代码直接从
 * `@kustos/api` 导入。生成脚本的产物目标是 `frontend/packages/api/src/schema.ts`。
 */
export type * from "@kustos/api/schema";
