/**
 * WebSocket 客户端。
 *
 * 后端的 WS 端点（`/ws/`、`/ws/notifications`、`/ws/repository/{id}`、`/ws/logs`）
 * 统一走 `Sec-WebSocket-Protocol: kustos-bearer, <jwt>` 做鉴权——token 放 URL query
 * 会被网关的 access_log 原样记录，因此这里只用握手头。
 */

/** 应用子协议名；后端按「JWT 形状 = 两段点分」在子协议列表里挑出 token。 */
export const WS_SUBPROTOCOL = "kustos-bearer";

export type WsStatus = "connecting" | "open" | "closed" | "error";

export interface WsClientOptions {
  /** 连接路径，如 `/ws/repository/12`。 */
  path: string;
  /**
   * 用户访问令牌，或取令牌的函数。
   *
   * 传函数时每次建连（含断线重连）都重新取值：访问令牌会轮换，
   * 固化成字符串会让长连接在令牌过期后重连失败。
   */
  token: string | (() => string | null);
  /** 连接建立后要发送的订阅消息。 */
  onOpen?: (send: (payload: unknown) => void) => void;
  /** 收到消息。 */
  onMessage?: (data: unknown) => void;
  /** 状态变化。 */
  onStatus?: (status: WsStatus) => void;
  /** 重连间隔（毫秒），指数退避的上限基数。 */
  reconnectDelay?: number;
  /** 断线后是否自动重连。 */
  reconnect?: boolean;
}

/**
 * 一个带重连的 WebSocket 连接。
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private closedByUser = false;
  private retryCount = 0;
  private reconnectTimer: number | null = null;
  private readonly options: WsClientOptions;

  constructor(options: WsClientOptions) {
    this.options = options;
  }

  /** 建立连接。 */
  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  /**
   * 发送消息。
   *
   * @param payload 可 JSON 序列化的负载
   */
  send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  /** 主动关闭并停止重连。 */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  /** 当前连接状态。 */
  get readyState(): number | null {
    return this.socket?.readyState ?? null;
  }

  private open(): void {
    this.options.onStatus?.("connecting");

    const token =
      typeof this.options.token === "function" ? this.options.token() : this.options.token;
    if (!token) {
      // 空令牌会让 [子协议, ""] 在构造时就抛 SyntaxError；调用方应等会话就绪再连
      this.options.onStatus?.("error");
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}${this.options.path}`;
    // token 走握手头，不进 URL
    const socket = new WebSocket(url, [WS_SUBPROTOCOL, token]);
    this.socket = socket;

    socket.onopen = () => {
      this.retryCount = 0;
      this.options.onStatus?.("open");
      this.options.onOpen?.((payload) => this.send(payload));
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        this.options.onMessage?.(JSON.parse(event.data));
      } catch {
        // 非 JSON 帧忽略，避免一条脏消息打断整条连接
      }
    };

    socket.onerror = () => {
      this.options.onStatus?.("error");
    };

    socket.onclose = () => {
      this.options.onStatus?.("closed");
      this.socket = null;
      if (!this.closedByUser && this.options.reconnect !== false) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    const base = this.options.reconnectDelay ?? 1000;
    // 指数退避，封顶 30 秒，避免网关重启期间把连接打满
    const delay = Math.min(base * 2 ** this.retryCount, 30_000);
    this.retryCount += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.open();
    }, delay);
  }
}

/**
 * 构造带鉴权子协议的 WebSocket 路径。
 *
 * @param path 连接路径
 * @returns 路径
 */
export function wsPath(path: string): string {
  return path.startsWith("/ws") ? path : `/ws${path}`;
}
