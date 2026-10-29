import { http, HttpResponse } from "msw";

/**
 * 接口 mock。骨架阶段只有健康检查；
 * 真实用例按域拆分到 src/test/msw/handlers/<domain>.ts 并在这里合并。
 */
export const handlers = [http.get("/api/v1/health", () => HttpResponse.json({ status: "ok" }))];
