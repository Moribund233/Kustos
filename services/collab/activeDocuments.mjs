/**
 * 活跃协作文档清单 (协作感知的数据来源)
 *
 * 桌面端需要在"进入协作之前"就知道哪些文件正有人编辑, 用于文件树 live 圆点与
 * 进入前的预警。网关的 connectionsByDoc 是本副本内存里的实时连接计数, 因此
 * 由网关暴露一个只读 HTTP 端点, 由 app 侧聚合后对外提供。
 *
 * 拓扑 (app → 网关, 与既有 auth/doc/save 反向):
 *   app GET /api/v1/collaboration/active  → 本模块 HTTP 端点 → {documents: [...]}
 * 鉴权沿用服务间共享密钥 (X-Collab-Internal-Secret), 未配置密钥时整体 503,
 * 与 collab_internal_controller 的"安全默认"保持一致。
 *
 * 边界:
 *   - 只回连接数与 docKey, **不含任何身份信息** (身份仍走 awareness);
 *   - 计数是**本副本**维度: 多副本部署时由 app 逐副本累加, 本模块不合并;
 *   - 只读, 不修改任何连接状态。
 */
import http from "node:http";

export const INTERNAL_SECRET_HEADER = "X-Collab-Internal-Secret";
export const INTERNAL_SECRET_ENV = "KUSTOS_COLLAB_INTERNAL_SECRET";

/** 端点路径: 仅供 app 内部调用, 不经网关对外暴露 */
export const ACTIVE_PATH = "/internal/active";

/** docKey 首段即 repository_id, 用于按仓库过滤 */
function repositoryOf(docKey) {
  const index = docKey.indexOf(":");
  return index === -1 ? docKey : docKey.slice(0, index);
}

/**
 * 从 connectionsByDoc 生成活跃文档清单。
 *
 * @param {Map<string, number>} byDoc 本副本的 docKey -> 连接数
 * @param {{ repositoryId?: string }} [options] 限定仓库; 缺省返回全部
 * @returns {{ docKey: string, connections: number }[]} 按 docKey 升序, 便于前端稳定比较
 */
export function listActiveDocuments(byDoc, { repositoryId } = {}) {
  if (!(byDoc instanceof Map)) return [];
  const wanted = repositoryId ? String(repositoryId).toLowerCase() : null;

  const items = [];
  for (const [docKey, raw] of byDoc) {
    const connections = Number(raw);
    // 计数异常 (<=0 / NaN) 一律忽略: 这些文档此刻没有活跃编辑者
    if (!Number.isFinite(connections) || connections <= 0) continue;
    if (wanted && repositoryOf(docKey).toLowerCase() !== wanted) continue;
    items.push({ docKey, connections });
  }
  return items.sort((a, b) => (a.docKey < b.docKey ? -1 : a.docKey > b.docKey ? 1 : 0));
}

/** 时序安全比较, 避免密钥前缀被逐字节试探 */
function secretMatches(provided, expected) {
  const a = Buffer.from(String(provided ?? ""), "utf-8");
  const b = Buffer.from(String(expected ?? ""), "utf-8");
  return a.length === b.length && a.equals(b);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    // 内部端点: 不缓存, 不返回任何 CORS 头 (只接受服务间调用)
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * 构造请求处理器 (可独立单测, 不占端口)。
 *
 * @param {object} options
 * @param {Map<string, number>} options.byDoc 实时连接计数 (引用, 随连接变化)
 * @param {string} options.secret 共享密钥; 空表示未启用
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void}
 */
export function createActiveDocumentsHandler({ byDoc, secret }) {
  return (req, res) => {
    if (!String(secret ?? "").trim()) {
      sendJson(res, 503, { detail: "协作内部 API 未启用", error_code: "collab_internal_disabled" });
      return;
    }
    if (!secretMatches(req.headers[INTERNAL_SECRET_HEADER.toLowerCase()], secret)) {
      sendJson(res, 401, { detail: "内部密钥校验失败", error_code: "collab_invalid_internal_secret" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== ACTIVE_PATH) {
      sendJson(res, 404, { detail: "not found" });
      return;
    }

    const repositoryId = url.searchParams.get("repository_id") ?? undefined;
    sendJson(res, 200, { documents: listActiveDocuments(byDoc, { repositoryId }) });
  };
}

/**
 * 在独立端口上监听活跃文档端点。
 *
 * 独立于 WS 端口与健康检查端口: 健康检查只回 ok, 不宜混入需要鉴权的数据面。
 *
 * @param {object} options
 * @param {Map<string, number>} options.byDoc 实时连接计数
 * @param {string} [options.secret] 共享密钥, 缺省读环境变量
 * @param {number} [options.port] 端口; 0 表示由系统分配 (测试用)
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startActiveDocumentsServer({ byDoc, secret, port }) {
  const expected = (secret ?? process.env[INTERNAL_SECRET_ENV] ?? "").trim();
  const handler = createActiveDocumentsHandler({ byDoc, secret: expected });

  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port ?? Number(process.env.ACTIVE_PORT || 4446), "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // 残留 keep-alive 连接会让 close 挂起, 主动断开
        server.closeAllConnections?.();
      }),
  };
}
