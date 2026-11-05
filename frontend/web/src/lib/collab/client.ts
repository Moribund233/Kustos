/**
 * 协作网关（collab-gateway）接入。
 *
 * 网关是 Hocuspocus 的哑管道：CRDT 同步与感知由它负责，业务鉴权、文档加载、
 * 显式保存落 Git 全部回到 FastAPI。这里只负责建连接与把 Y.Doc 接到编辑器。
 */
import { HocuspocusProvider, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import * as Y from "yjs";

/**
 * Y.Doc 中共享文本的键名。
 *
 * 网关在 `onLoadDocument` / `onStoreDocument` / `collab-save` 里都按这个名字取值，
 * 客户端必须一致，否则网关拿到空文档。
 */
export const COLLAB_TEXT_KEY = "content";

/**
 * 协作光标色板：彼此可辨、叠在深色底上都够亮的低饱和色。
 * 按用户名哈希取色，同一用户每次进入拿到同一个颜色。
 */
const COLLAB_USER_COLORS = ["#83a9c4", "#86b79e", "#d98282", "#f2ae5b", "#b49ad6", "#6fb7ad"] as const;

/** 由用户名派生稳定的协作光标颜色。 */
export function collabUserColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return COLLAB_USER_COLORS[hash % COLLAB_USER_COLORS.length] ?? "#83a9c4";
}

/**
 * 构造协作网关的连接地址。
 *
 * @param baseUrl 站点基址；留空表示与页面同源（生产经网关反代 /ws/collab）
 * @returns WebSocket 地址
 */
export function collabWebSocketUrl(baseUrl = ""): string {
  const origin = baseUrl || window.location.origin;
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/collab";
  return url.toString();
}

/**
 * 构造网关认得的连接令牌。
 *
 * 网关的 `parseConnectionToken` 接受两种形态：JSON 字符串
 * （取 `access_token` / `token` 与 `invite_token`）或裸 JWT。
 * 走邀请链接进来的会话必须带上 `invite_token`，否则按普通登录用户鉴权会 403。
 *
 * @param accessToken 用户访问令牌
 * @param inviteToken 协作邀请令牌（可选）
 * @returns 连接令牌
 */
export function buildCollabToken(accessToken: string, inviteToken?: string): string {
  if (!inviteToken) return accessToken;
  return JSON.stringify({ access_token: accessToken, invite_token: inviteToken });
}

export interface CollabSessionOptions {
  /** 文档键，格式 `repository_id:branch:path`，后端会校验三段。 */
  documentName: string;
  /** 用户访问令牌。 */
  accessToken: string;
  /** 协作邀请令牌。 */
  inviteToken?: string;
  /** WebSocket 地址；留空表示同源。 */
  url?: string;
  /** 用户名，用于感知层的协作光标标签。 */
  username?: string;
  /** 协作光标颜色。 */
  color?: string;
  /** 连接状态回调。 */
  onStatus?: (status: CollabStatus) => void;
}

export type CollabStatus = "connecting" | "connected" | "disconnected" | "error";

/**
 * 一个协作会话。
 *
 * 持有 Y.Doc 与 Provider，调用方负责销毁。
 */
export interface CollabSession {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  /** 共享文本。名称与网关约定一致。 */
  text: Y.Text;
  destroy: () => void;
}

/**
 * 建立协作会话。
 *
 * @param options 会话参数
 * @returns 会话句柄
 */
export function createCollabSession(options: CollabSessionOptions): CollabSession {
  const doc = new Y.Doc();
  const text = doc.getText(COLLAB_TEXT_KEY);

  const configuration: HocuspocusProviderConfiguration = {
    url: options.url ?? collabWebSocketUrl(),
    name: options.documentName,
    token: buildCollabToken(options.accessToken, options.inviteToken),
    document: doc,
    onStatus: ({ status }) => {
      options.onStatus?.(status as CollabStatus);
    },
    // 鉴权失败时网关会关闭连接；这里只把状态透出去，不自行判定权限
    onAuthenticationFailed: () => {
      options.onStatus?.("error");
    },
  };

  const provider = new HocuspocusProvider(configuration);

  // awareness 广播本人的展示身份。网关会用连接令牌里的身份盖章 user.user_id/name
  // （防冒名），color/colorLight 保留客户端自带值，因此颜色由本端决定；
  // 不写的话所有人拿到同一个默认色，谁在编辑看不出来
  const name = options.username ?? "Anonymous";
  const color = options.color ?? collabUserColor(name);
  provider.awareness?.setLocalStateField("user", { name, color, colorLight: `${color}33` });

  return {
    doc,
    provider,
    text,
    destroy: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

/**
 * 请求网关显式保存，把当前文档内容存成一次草稿提交（落 `collab/draft-{branch}`）。
 *
 * 网关的 `onStateless` 只在收到 `collab-save` 时才落 Git，自动快照一律 no-op，
 * 因此保存必须由用户显式触发。工作分支只在显式发布
 * （`POST /{repo_id}/collab/publish`）时产生一次 squash 提交。
 *
 * @param provider 协作 Provider
 * @param message 提交说明
 */
export async function saveCollabDocument(
  provider: HocuspocusProvider,
  message: string,
): Promise<void> {
  provider.sendStateless(
    JSON.stringify({
      type: "collab-save",
      message,
    }),
  );
}

/**
 * 广播「跟我来」聚光信号。
 *
 * 只有有写权限的人能发起（网关会校验），其余成员据此跟随发起者的视口。
 *
 * @param provider 协作 Provider
 * @param on 是否开启跟随
 */
export async function spotlightCollabDocument(
  provider: HocuspocusProvider,
  on: boolean,
): Promise<void> {
  provider.sendStateless(
    JSON.stringify({
      type: "collab-spotlight",
      on,
    }),
  );
}
