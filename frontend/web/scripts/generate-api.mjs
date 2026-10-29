/**
 * 从后端 OpenAPI 生成类型。
 *
 * 用法：
 *   pnpm api:generate                       # 默认读 http://127.0.0.1:8001/openapi.json
 *   OPENAPI_URL=... pnpm api:generate        # 指定地址
 *   OPENAPI_FILE=./openapi.json pnpm api:generate   # 从本地文件读
 *
 * 产物是 src/api/schema.d.ts，勿手改；接口变更后重新生成。
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";

const DEFAULT_URL = "http://127.0.0.1:8001/openapi.json";
const OUTPUT = fileURLToPath(new URL("../src/api/schema.d.ts", import.meta.url));

async function loadSchema() {
  if (process.env.OPENAPI_FILE) {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(process.env.OPENAPI_FILE, "utf8"));
  }
  const url = process.env.OPENAPI_URL ?? DEFAULT_URL;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`拉取 OpenAPI 失败：${url} → ${response.status}`);
  }
  return response.json();
}

const schema = await loadSchema();
const ast = await openapiTS(schema);
await writeFile(OUTPUT, astToString(ast), "utf8");
console.log(`已生成 ${OUTPUT}`);
