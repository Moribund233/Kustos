/**
 * 活跃文档清单单元测试
 *
 * 协作感知 (/api/v1/repositories/{id}/collab/active) 的数据来源:
 * 网关把本副本的 connectionsByDoc 暴露成 HTTP, 由 app 聚合多副本后对外提供。
 * 这里只测网关侧的纯函数与 HTTP 端点契约, 不启动 Hocuspocus:
 *   - docKey 归属过滤 (只认同一个 repository_id, 防止跨仓串数据);
 *   - 清单只含 connections > 0 的文档, 且不含任何身份信息;
 *   - 未配置内部密钥时端点整体 503 (与 app 侧 "安全默认" 对称)。
 */
import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createActiveDocumentsHandler,
  listActiveDocuments,
  startActiveDocumentsServer,
} from "../activeDocuments.mjs";

const REPO = "11111111-1111-1111-1111-111111111111";
const OTHER_REPO = "22222222-2222-2222-2222-222222222222";
const SECRET = "test-internal-secret";

function docs(entries) {
  return new Map(entries);
}

describe("listActiveDocuments", () => {
  it("只返回有活跃连接的文档", () => {
    const byDoc = docs([
      [`${REPO}:main:a.py`, 2],
      [`${REPO}:main:b.py`, 0],
      [`${REPO}:dev:c.py`, 1],
    ]);

    expect(listActiveDocuments(byDoc)).toEqual([
      { docKey: `${REPO}:main:a.py`, connections: 2 },
      { docKey: `${REPO}:dev:c.py`, connections: 1 },
    ]);
  });

  it("按仓库过滤, 不混入其他仓库的文档", () => {
    const byDoc = docs([
      [`${REPO}:main:a.py`, 2],
      [`${OTHER_REPO}:main:a.py`, 5],
    ]);

    const result = listActiveDocuments(byDoc, { repositoryId: REPO });
    expect(result).toEqual([{ docKey: `${REPO}:main:a.py`, connections: 2 }]);
  });

  it("仓库过滤接受大小写不同的 UUID 写法", () => {
    const byDoc = docs([[`${REPO}:main:a.py`, 1]]);
    const result = listActiveDocuments(byDoc, { repositoryId: REPO.toUpperCase() });
    expect(result).toHaveLength(1);
  });

  it("空清单返回空数组", () => {
    expect(listActiveDocuments(docs([]))).toEqual([]);
    expect(listActiveDocuments(docs([["garbage", 3]]))).toEqual([]);
  });

  it("结果不含身份信息 (只有 docKey 与连接数)", () => {
    const byDoc = docs([[`${REPO}:main:a.py`, 3]]);
    const [item] = listActiveDocuments(byDoc, { repositoryId: REPO });
    expect(Object.keys(item).sort()).toEqual(["connections", "docKey"]);
  });

  it("按 docKey 稳定排序, 便于前端去抖比较", () => {
    const byDoc = docs([
      [`${REPO}:main:z.py`, 1],
      [`${REPO}:main:a.py`, 2],
      [`${REPO}:main:m.py`, 1],
    ]);
    const keys = listActiveDocuments(byDoc).map((d) => d.docKey);
    expect(keys).toEqual([...keys].sort());
  });

  it("忽略非正数与非数值计数", () => {
    const byDoc = docs([
      [`${REPO}:main:a.py`, -1],
      [`${REPO}:main:b.py`, "x"],
      [`${REPO}:main:c.py`, 1],
    ]);
    expect(listActiveDocuments(byDoc)).toEqual([
      { docKey: `${REPO}:main:c.py`, connections: 1 },
    ]);
  });
});

describe("createActiveDocumentsHandler", () => {
  function call(handler, { url = "/internal/active", headers = {} } = {}) {
    return new Promise((resolve) => {
      const req = { url, headers };
      const res = {
        statusCode: 0,
        body: "",
        headers: {},
        writeHead(code, hdrs) {
          this.statusCode = code;
          this.headers = hdrs || {};
        },
        end(chunk) {
          this.body += chunk ?? "";
          resolve({ status: this.statusCode, body: this.body });
        },
      };
      handler(req, res);
    });
  }

  it("未配置密钥时整体 503 (安全默认)", async () => {
    const handler = createActiveDocumentsHandler({ byDoc: docs([]), secret: "" });
    const res = await call(handler);
    expect(res.status).toBe(503);
  });

  it("密钥不匹配返回 401", async () => {
    const handler = createActiveDocumentsHandler({
      byDoc: docs([[`${REPO}:main:a.py`, 1]]),
      secret: SECRET,
    });
    const res = await call(handler, { headers: { "x-collab-internal-secret": "wrong" } });
    expect(res.status).toBe(401);
  });

  it("密钥匹配返回该仓库的活跃文档", async () => {
    const handler = createActiveDocumentsHandler({
      byDoc: docs([
        [`${REPO}:main:a.py`, 2],
        [`${OTHER_REPO}:main:z.py`, 9],
      ]),
      secret: SECRET,
    });
    const res = await call(handler, {
      url: `/internal/active?repository_id=${REPO}`,
      headers: { "x-collab-internal-secret": SECRET },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      documents: [{ docKey: `${REPO}:main:a.py`, connections: 2 }],
    });
  });

  it("缺少 repository_id 时返回全部仓库的活跃文档", async () => {
    const handler = createActiveDocumentsHandler({
      byDoc: docs([
        [`${REPO}:main:a.py`, 1],
        [`${OTHER_REPO}:main:z.py`, 2],
      ]),
      secret: SECRET,
    });
    const res = await call(handler, {
      headers: { "x-collab-internal-secret": SECRET },
    });
    expect(JSON.parse(res.body).documents).toHaveLength(2);
  });

  it("非预期路径返回 404", async () => {
    const handler = createActiveDocumentsHandler({ byDoc: docs([]), secret: SECRET });
    const res = await call(handler, {
      url: "/internal/other",
      headers: { "x-collab-internal-secret": SECRET },
    });
    expect(res.status).toBe(404);
  });
});

describe("startActiveDocumentsServer", () => {
  let server = null;

  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  it("监听端口后可被真实 HTTP 请求访问", async () => {
    server = await startActiveDocumentsServer({
      byDoc: docs([[`${REPO}:main:a.py`, 3]]),
      secret: SECRET,
      port: 0,
    });

    const { port } = server;
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: `/internal/active?repository_id=${REPO}`,
          headers: { "x-collab-internal-secret": SECRET },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, data }));
        }
      );
      req.on("error", reject);
      req.end();
    });

    expect(body.status).toBe(200);
    expect(JSON.parse(body.data).documents).toEqual([
      { docKey: `${REPO}:main:a.py`, connections: 3 },
    ]);
  });

  it("关闭后端口不再可连", async () => {
    const srv = await startActiveDocumentsServer({
      byDoc: docs([]),
      secret: SECRET,
      port: 0,
    });
    const { port } = srv;
    await srv.close();
    server = null;

    await expect(
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: "/internal/active" },
          resolve
        );
        req.on("error", reject);
        req.end();
      })
    ).rejects.toThrow();
  });
});
