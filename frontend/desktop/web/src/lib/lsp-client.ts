/**
 * 语言服务器客户端：WebSocket 传输 + 工作区实现 + React 接线。
 *
 * 分工是这样的：Go 侧管进程（启停、退避重启、上限），前端只管协议。
 * 中间那段 `ws ↔ stdio` 的转发在 bridge 的 `/lsp/attach` 上，所以这里
 * 拿到的每条消息都是纯 JSON——`@codemirror/lsp-client` 的 Transport 接口
 * 正好就是"发字符串、收字符串"，中间不需要再拼 `Content-Length` 头。
 *
 * 为什么不用默认的 `DefaultWorkspace`：它只认当前编辑器里的文件，跳定义
 * 跳到别的文件时会返回 null（用户按 F12 什么也不会发生），而且同一个文件
 * 打开两次会直接抛错。桌面端会切标签、会跨文件跳转，所以这里自己实现
 * 一份：`displayFile` 通过回调让 Code 面把目标文件开出来，等编辑器挂上
 * 再把结果交还给 lsp-client。
 */

import { useEffect, useRef, useState } from "react";
import type { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  LSPClient,
  LSPPlugin,
  Workspace,
  languageServerExtensions,
  type Transport,
  type WorkspaceFile,
} from "@codemirror/lsp-client";

import { relativePathFromUri, toFileUri } from "./lsp-uri";

/** 跳定义打开新文件时，等编辑器挂载的最长时间。 */
const DISPLAY_TIMEOUT = 2000;

/**
 * 把 WebSocket 包成 lsp-client 认的 Transport。
 *
 * 只做三件事：发字符串、把收到的字符串交给订阅者、维护订阅者集合。
 * 不在这里解析 JSON，也不在这里加 LSP 帧头——两件事 lsp-client 都会做，
 * 重复做只会让两边的约定互相打架。
 */
class WebSocketTransport implements Transport {
  private handlers = new Set<(value: string) => void>();

  constructor(private readonly socket: WebSocket) {
    this.socket.addEventListener("message", (event) => {
      // 服务端只会发文本帧；二进制帧出现在这里说明协议已经不对了，直接丢。
      if (typeof event.data !== "string" || event.data === "") return;
      for (const handler of this.handlers) handler(event.data);
    });
  }

  send(message: string): void {
    // 连接已关时静默丢弃：lsp-client 在断开后仍可能排一条通知，
    // 让它抛错只会把"服务器没了"变成一串未捕获异常。
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(message);
  }

  subscribe(handler: (value: string) => void): void {
    this.handlers.add(handler);
  }

  unsubscribe(handler: (value: string) => void): void {
    this.handlers.delete(handler);
  }
}

interface DesktopFile extends WorkspaceFile {
  view: EditorView;
}

/** `WorkspaceFileUpdate` 没有从包里导出，这里照结构声明。 */
interface FileUpdate {
  file: WorkspaceFile;
  prevDoc: Text;
  changes: ChangeSet;
}

class DesktopWorkspace extends Workspace {
  files: DesktopFile[] = [];

  private versions = new Map<string, number>();
  private waiting = new Map<string, ((view: EditorView | null) => void)[]>();

  constructor(
    client: LSPClient,
    private readonly root: string,
    private readonly onOpenFile: (relativePath: string) => void,
  ) {
    super(client);
  }

  private nextVersion(uri: string): number {
    const next = (this.versions.get(uri) ?? -1) + 1;
    this.versions.set(uri, next);
    return next;
  }

  private findFile(uri: string): DesktopFile | null {
    return this.files.find((file) => file.uri === uri) ?? null;
  }

  syncFiles(): readonly FileUpdate[] {
    const updates: FileUpdate[] = [];
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (changes.empty) continue;
      updates.push({ file, prevDoc: file.doc, changes });
      file.doc = file.view.state.doc;
      file.version = this.nextVersion(file.uri);
      plugin.clear();
    }
    return updates;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    // 同一个文件重复 open 是正常现象：React 严格模式下 effect 会跑两遍，
    // 编辑器实例也会重建。这里替换旧记录而不是抛错，否则一次重挂载就白屏。
    const existing = this.findFile(uri);
    if (existing) {
      this.files = this.files.filter((file) => file !== existing);
    }
    const file: DesktopFile = {
      uri,
      languageId,
      version: this.nextVersion(uri),
      doc: view.state.doc,
      view,
      getView: () => view,
    };
    this.files.push(file);
    this.client.didOpen(file);
    this.release(uri, view);
  }

  closeFile(uri: string, view: EditorView): void {
    const existing = this.files.find((file) => file.uri === uri && file.view === view);
    if (!existing) return;
    this.files = this.files.filter((file) => file !== existing);
    this.client.didClose(uri);
  }

  /**
   * 跳定义落到另一个文件时由 lsp-client 调用。
   *
   * 编辑器不在这一帧就能拿到（要先 setState、再由查询取内容、再挂载），
   * 所以这里返回一个待兑现的 Promise，等 `openFile` 真正发生时兑现；
   * 超时或不在仓库内就返回 null，让 lsp-client 老实什么都不做。
   */
  displayFile(uri: string): Promise<EditorView | null> {
    const existing = this.findFile(uri);
    if (existing) return Promise.resolve(existing.view);

    const relative = relativePathFromUri(this.root, uri);
    if (relative === null || relative === "") return Promise.resolve(null);

    return new Promise((resolve) => {
      const queue = this.waiting.get(uri) ?? [];
      const timer = window.setTimeout(() => {
        this.drop(uri, settle);
        resolve(null);
      }, DISPLAY_TIMEOUT);
      const settle = (view: EditorView | null) => {
        window.clearTimeout(timer);
        resolve(view);
      };
      queue.push(settle);
      this.waiting.set(uri, queue);
      this.onOpenFile(relative);
    });
  }

  private release(uri: string, view: EditorView): void {
    const queue = this.waiting.get(uri);
    if (!queue) return;
    this.waiting.delete(uri);
    for (const settle of queue) settle(view);
  }

  private drop(uri: string, settle: (view: EditorView | null) => void): void {
    const queue = this.waiting.get(uri);
    if (!queue) return;
    const rest = queue.filter((item) => item !== settle);
    if (rest.length === 0) this.waiting.delete(uri);
    else this.waiting.set(uri, rest);
  }
}

/** `/lsp/attach` 的地址：与页面同源，因此不写死端口。 */
function attachURL(root: string): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/lsp/attach?root=${encodeURIComponent(root)}`;
}

export interface LSPClientOptions {
  /** 工作区根的绝对路径；为 null 时不连接。 */
  root: string | null;
  /** 语言服务器要求的 languageId（"go"、"typescript"）。 */
  language: string | null;
  /** 服务器是否已在跑。不在跑就不要建连接——握手会立刻失败。 */
  enabled: boolean;
  /** 跨文件跳转时把目标文件打开（传仓库内相对路径）。 */
  onOpenFile: (relativePath: string) => void;
}

export interface LSPClientState {
  client: LSPClient | null;
  error: string | null;
}

/**
 * 为一个工作区维持一条 LSP 连接。
 *
 * 连接的生命周期跟着"服务器是否在跑"走：进程被空闲回收、崩溃后重试用尽，
 * 这条 WebSocket 都会被对方关掉，因此重连由服务器状态驱动，不在这里无脑重试。
 */
export function useLSPClient({ root, language, enabled, onOpenFile }: LSPClientOptions): LSPClientState {
  const [client, setClient] = useState<LSPClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openFileRef = useRef(onOpenFile);

  openFileRef.current = onOpenFile;

  useEffect(() => {
    if (!enabled || !root || !language) {
      setClient(null);
      setError(null);
      return;
    }

    let disposed = false;
    let active: LSPClient | null = null;
    const socket = new WebSocket(attachURL(root));
    const transport = new WebSocketTransport(socket);

    const onOpen = () => {
      if (disposed) {
        socket.close();
        return;
      }
      active = new LSPClient({
        rootUri: toFileUri(root),
        extensions: languageServerExtensions(),
        workspace: (created) => new DesktopWorkspace(created, root, (path) => openFileRef.current(path)),
      });
      active.connect(transport);
      // 握手结果要落地：initialize 失败时界面上必须能说出原因，
      // 否则用户看到的只是"补全不动"。
      void active.initializing.then(
        () => {
          if (disposed) return;
          setClient(active);
          setError(null);
        },
        (reason: unknown) => {
          if (disposed) return;
          setClient(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", () => {
      if (!disposed) setError("语言服务器连接失败");
    });
    socket.addEventListener("close", () => {
      if (disposed) return;
      setClient(null);
    });

    return () => {
      disposed = true;
      setClient(null);
      active?.disconnect();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    };
  }, [root, language, enabled]);

  return { client, error };
}

/** LSP 的文档符号，摊平后带层级深度。 */
export interface FlatSymbol {
  name: string;
  detail: string;
  kind: number;
  /** 1 起：`documentSymbol` 给的是 0 起。 */
  line: number;
  depth: number;
}

interface RawSymbol {
  name?: string;
  detail?: string;
  kind?: number;
  range?: { start: { line: number } };
  location?: { range: { start: { line: number } } };
  selectionRange?: { start: { line: number } };
  children?: RawSymbol[];
}

/**
 * 把服务器返回的符号树摊平。
 *
 * 顺便兼容两种形态：`DocumentSymbol`（带 children、位置相对文件）与
 * `SymbolInformation`（扁平、位置在 location 里）。服务器按能力返回哪种
 * 都有可能，不兼容就得为每种语言写一份。
 */
export function flattenSymbols(items: unknown): FlatSymbol[] {
  const out: FlatSymbol[] = [];

  const walk = (node: RawSymbol, depth: number) => {
    const range = node.selectionRange ?? node.range ?? node.location?.range;
    out.push({
      name: node.name ?? "",
      detail: node.detail ?? "",
      kind: node.kind ?? 0,
      line: (range?.start.line ?? 0) + 1,
      depth,
    });
    for (const child of node.children ?? []) walk(child, depth + 1);
  };

  if (Array.isArray(items)) {
    for (const item of items) walk(item as RawSymbol, 0);
  }
  return out;
}

export interface DocumentSymbolsState {
  symbols: FlatSymbol[];
  loading: boolean;
  error: string | null;
}

/**
 * 拉当前文件的文档符号。
 *
 * 请求前必须先 `sync()`：`documentSymbol` 要的是服务器手里那份文档，
 * 用户刚敲的字还没发过去时，返回的位置会整体偏移。
 *
 * 符号列表是"左栏分段"的内容，只在那个分段可见时才拉——每次切标签都
 * 请求一次全量符号，在 gopls 上是实打实的开销。
 */
export function useDocumentSymbols(
  client: LSPClient | null,
  root: string | null,
  path: string | null,
  enabled: boolean,
): DocumentSymbolsState {
  const [state, setState] = useState<DocumentSymbolsState>({
    symbols: [],
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !client || !root || !path) {
      setState({ symbols: [], loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ symbols: [], loading: true, error: null });

    void (async () => {
      try {
        await client.initializing;
        client.sync();
        const result = await client.request("textDocument/documentSymbol", {
          textDocument: { uri: toFileUri(root, path) },
        });
        if (cancelled) return;
        setState({ symbols: flattenSymbols(result), loading: false, error: null });
      } catch (reason) {
        if (cancelled) return;
        setState({
          symbols: [],
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, root, path, enabled]);

  return state;
}
