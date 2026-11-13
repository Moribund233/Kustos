/**
 * 协作会话接入。
 *
 * 协作网关是 Hocuspocus 的哑管道：CRDT 同步与感知由它负责，鉴权、文档播种与
 * 显式保存落 Git 都回到 FastAPI。桌面端与 Web 走同一个网关，只是连接地址
 * 经 loopback bridge 反代，因此这里只关心"连上、绑定共享文本、把状态透出去"。
 *
 * 桌面端**不**把内容写回磁盘：`live` 模式下文档的真相在 Y.Doc 里，⌘S 是把
 * 内容存成草稿提交（落 `collab/draft-{branch}`），而不是写工作树。这条边界
 * 是设计里写死的——两份真相同时写必然漂移。
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Extension } from "@codemirror/state";
import { getAccessToken } from "@kustos/api";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";

/**
 * Y.Doc 里共享文本的键名。
 *
 * 网关在加载、保存与 `collab-save` 里都按这个名字取值，客户端必须一致，
 * 否则网关拿到的是空文档。
 */
export const COLLAB_TEXT_KEY = "content";

/**
 * 协作光标色板：彼此可辨、叠在深色底上都够亮的低饱和色。
 *
 * 与 Web 端同一套色，同一个用户名在两端的颜色一致，截图对照时不会错位。
 */
const COLLAB_USER_COLORS = ["#83a9c4", "#86b79e", "#d98282", "#f2ae5b", "#b49ad6", "#6fb7ad"] as const;

/** 由用户名派生稳定的协作光标颜色。 */
export function collabUserColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return COLLAB_USER_COLORS[hash % COLLAB_USER_COLORS.length] ?? "#83a9c4";
}

/**
 * 构造文档键。
 *
 * 后端把 `docKey` 拆成三段并逐段校验，因此路径里的分隔符不能破坏结构：
 * 仓库 id 与分支名都不含 `:`，路径放在最后一段，可以随便带分隔符。
 */
export function collabDocumentKey(repositoryId: string, branch: string, path: string): string {
  return `${repositoryId}:${branch}:${path}`;
}

export interface CollabDocumentKey {
  repositoryId: string;
  branch: string;
  path: string;
}

/** 拆解文档键；结构不对时返回 null（网关也会拒绝，但界面需要先能判断）。 */
export function parseCollabDocumentKey(key: string): CollabDocumentKey | null {
  // 只切前两处：路径本身可以带冒号，切成再多的段就拼不回去了。
  const first = key.indexOf(":");
  if (first <= 0) return null;
  const second = key.indexOf(":", first + 1);
  if (second <= first + 1) return null;
  const path = key.slice(second + 1);
  if (path === "") return null;
  return {
    repositoryId: key.slice(0, first),
    branch: key.slice(first + 1, second),
    path,
  };
}

/**
 * 构造协作网关的 WebSocket 地址。
 *
 * 桌面端页面由 loopback bridge 提供，`/ws/collab` 已在白名单里（bridge 用
 * `httputil.ReverseProxy` 透传升级请求），因此与 Web 端一样"同源改协议"即可。
 *
 * @param origin 站点基址；留空表示与页面同源
 */
export function collabSocketUrl(origin = ""): string {
  const base = origin || window.location.origin;
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/collab";
  return url.toString();
}

/** 草稿分支名，与网关约定一致（工作分支只在显式发布时才产生提交）。 */
export function collabDraftBranch(branch: string): string {
  return `collab/draft-${branch}`;
}

export type CollabStatus = "connecting" | "connected" | "disconnected" | "error";

/**
 * 网关关闭连接时给出的信号。
 *
 * 权限被吊销（网关侧 `connection.close({code: 4403})`）时服务端其实只发了一条
 * CLOSE 消息，客户端把它合成 `code: 1000` + 原始 reason。因此**不能只看状态码**：
 * 真正的判据是 reason 里那句"写入权限已吊销"，4403 / 4003 只作为将来的兼容。
 * 这里把这些判断收成一个纯函数，因为猜错的方向很危险——把普通断线当成被踢，
 * 用户会以为自己的权限没了；反过来，被踢了还继续当 live 编辑，写的字永远发不出去。
 */
export function collabKickReason(event: { code?: number; reason?: string } | null | undefined): string | null {
  const reason = (event?.reason ?? "").trim();
  const code = event?.code ?? 0;
  if (code === 4403 || code === 4003) return reason;
  // 网关与 app 的文案（"写入权限已吊销" / "已被移出协作会话"）。
  if (/吊销|移出协作|已被踢|权限已撤销/i.test(reason)) return reason;
  // 英文部署下的兜底；只认明确表达"权限没了"的说法，普通断开不在此列。
  if (/revoked|kicked|permission denied/i.test(reason)) return reason;
  return null;
}

/** 网关广播的保存失败回执里，哪些是"权限没了"（要转观察态）。 */
export function saveErrorIsKick(error: string | null | undefined): boolean {
  return /移出协作|吊销|已被踢|kicked|revoked/i.test(error ?? "");
}

export interface CollabSessionOptions {
  /** 文档键，`repositoryId:branch:path`。 */
  documentName: string;
  /** 访问令牌；缺省取 `@kustos/api` 内存里的当前令牌。 */
  accessToken?: string;
  /** 用户名，用于感知层的协作光标标签。 */
  username?: string;
  /** WebSocket 地址；留空表示同源。 */
  url?: string;
  /** 连接状态回调。 */
  onStatus?: (status: CollabStatus) => void;
  /** 被网关赶出会话（写入权限吊销 / 被踢）：界面要据此转只读观察。 */
  onKicked?: (reason: string) => void;
  /** 保存失败的回执文案：不处理的话"保存中"会一直转下去。 */
  onSaveError?: (error: string) => void;
  /**
   * 服务端的初始文档已经合并进来。
   *
   * 与 `onStatus` 的 `connected` 不是一回事：socket 连上时服务端的 Yjs 状态
   * 可能还没同步完。在这之前往共享文本里写东西，本地的插入会与服务端随后
   * 合并进来的内容叠成一段重复文本（实测行数翻倍）。要改写共享文本先等这个。
   */
  onSynced?: () => void;
}

export interface CollabSession {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  text: Y.Text;
  destroy: () => void;
}

/** 文档同步状态：`synced` 之前服务端的初始内容还没到，别动共享文本。 */
export interface CollabSyncState {
  synced: boolean;
}

/**
 * 建立协作会话。
 *
 * 令牌取 `@kustos/api` 内存里的访问令牌：它由 Go 侧在登录/恢复会话时交给 JS，
 * 从不落 WebView 存储，协作连接因此不需要另开一条取令牌的路。
 */
export function createCollabSession(options: CollabSessionOptions): CollabSession {
  const token = options.accessToken ?? getAccessToken() ?? "";
  const doc = new Y.Doc();
  const text = doc.getText(COLLAB_TEXT_KEY);

  const provider = new HocuspocusProvider({
    url: options.url ?? collabSocketUrl(),
    name: options.documentName,
    token,
    document: doc,
    onStatus: ({ status }) => {
      options.onStatus?.(status as CollabStatus);
    },
    // 鉴权失败时网关会关连接；这里只把状态透出去，权限判定留给后端
    onAuthenticationFailed: ({ reason }) => {
      // 被踢的人下一次鉴权就会拿到 403，与"令牌过期"必须分开：前者是权限没了，
      // 后者换一次令牌还能继续。只有前者该切观察态。
      const kicked = collabKickReason({ reason });
      if (kicked !== null) options.onKicked?.(kicked);
      options.onStatus?.("error");
    },
    onClose: ({ event }) => {
      // 权限被吊销时网关发的是 CLOSE 消息 + 原始 reason，客户端合成成 1000，
      // 因此这里靠 reason 判定；普通的网络断开不含这些字样，不会误判。
      const kicked = collabKickReason(event);
      if (kicked !== null) options.onKicked?.(kicked);
    },
    // 服务端的初始文档合并完成。改写共享文本必须等到这一刻：socket 连上时
    // 两边的 Yjs 状态可能还差着一次同步，此时写入会与随后合并进来的内容叠成
    // 一段重复文本。
    onSynced: () => {
      options.onSynced?.();
    },
  });

  // 保存失败的回执：网关回 `collab-save-error` 时不广播成功，界面必须收尾，
  // 否则"保存中"会一直转，用户以为还在写。
  provider.on("stateless", ({ payload }: { payload?: string }) => {
    let message: { type?: string; docKey?: string; error?: string } | null = null;
    try {
      message = JSON.parse(payload ?? "") as { type?: string; docKey?: string; error?: string };
    } catch {
      return;
    }
    if (message?.type !== "collab-save-error" || message.docKey !== options.documentName) return;
    options.onSaveError?.(message.error ?? "");
  });

  // awareness 广播本人的展示身份。网关用令牌里的身份盖章 user_id 与 name（防冒名），
  // color 保留客户端自带值——不写的话所有人拿到同一个默认色，谁在编辑看不出来。
  const name = options.username && options.username !== "" ? options.username : "—";
  const color = collabUserColor(name);
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
 * 当前文档上的在线人数（含自己）。
 *
 * 感知层不可用时返回 0：界面据此不显示人数，而不是显示"1 人"假装一切正常。
 */
export function collabPeerCount(awareness: unknown): number {
  const states = (awareness as { getStates?: () => Map<number, unknown> } | null)?.getStates?.();
  return states ? states.size : 0;
}

/**
 * 请求网关把当前内容存成一次草稿提交。
 *
 * 网关的自动快照只写 Redis，不提交 Git；保存必须由用户显式触发，
 * 这样才能控制草稿分支上的提交粒度。
 */
export function saveCollabDocument(provider: HocuspocusProvider, message: string): void {
  provider.sendStateless(JSON.stringify({ type: "collab-save", message }));
}

/**
 * 用本地内容重写共享文本（「以本地为准」开新会话）。
 *
 * 网关的初始内容来自服务端分支，本地没提交的内容它看不见；要让"本地这份"
 * 成为会话的起点，只能在连上之后把共享文本整体换掉，再存成一次草稿提交
 * （可回滚——草稿分支上的提交不会自己跑到工作分支上）。
 *
 * 必须在**连上之后**做：连上之前改的是本地 Y.Doc，服务端状态同步进来时
 * 会与本地的插入合并成一段谁也没写过的文本。连上之后改则是正常的更新，
 * 服务端照单全收。
 *
 * 调用方必须先确认没人在线：替换会顶掉文档里已有的内容。
 */
export function replaceCollabText(session: CollabSession, text: string): boolean {
  const current = session.text.toString();
  if (current === text) return false;
  session.doc.transact(() => {
    session.text.delete(0, session.text.length);
    session.text.insert(0, text);
  });
  return true;
}

/**
 * 把共享文本与远端光标接进编辑器。
 *
 * 撤销历史仍归 CodeMirror 自己：共用一份 history 会让"撤销我刚敲的这行"
 * 变成"撤销所有人刚才的输入"。
 */
export function collabEditorExtension(session: CollabSession): Extension {
  const awareness = session.provider.awareness;
  if (!awareness) return [];
  // awareness 的类型来自 y-protocols，与本仓库没有直接依赖关系，按入参收窄即可。
  return yCollab(session.text, awareness as unknown as Parameters<typeof yCollab>[1]);
}
