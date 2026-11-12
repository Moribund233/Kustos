import { useEffect, useState } from "react";

/**
 * 逐行评审草稿的本地持久化。
 *
 * 桌面端允许用户在 diff 的任意行上写意见，但服务端的接受方式决定了它**没法
 * 一次提交**：`POST .../comments` 一次只收一条
 * `{content, file_path?, line_number?, commit_hash?, parent_id?}`，
 * `POST .../reviews` 也只收一条 `{status, comment?}`。所以"写一堆意见、最后
 * 一起提交"只能拆成 N 次评论请求（也许再加一次评审请求）；拆开就意味着一律
 * 可能失败在中途，草稿必须先落在本地，关窗、重启之后还能接着用。
 *
 * 为什么是 localStorage 而不是 Go 侧的键值服务：桌面端桥接层目前没有暴露
 * 任意键值存储，新加一个就要重新生成 `bindings/`（生成物，改它等于改契约），
 * 收益远小于代价。i18n 的语言缓存已经是同一套做法（`LOCALE_STORAGE_KEY`），
 * 这里沿用它"`kustos.desktop.*`"的命名空间风格。
 *
 * 因为要能脱离浏览器验证，所有落盘逻辑都只依赖 `DraftStorage` 的三件事，
 * 不直接引用 `window`：测试传内存假实现即可。
 */

/** 一条本地评审草稿。 */
export interface ReviewDraft {
  id: string;
  /** 挂在哪一行；会话级评论（不挂行）为 null。 */
  lineNumber: number | null;
  /**
   * 挂在哪一个文件（仓库内相对路径）。
   *
   * 服务端把行级评论表达成"文件 + 行号"两个字段，只有行号没有文件是挂不上
   * 去的；会话级评论两者都空着。
   */
  filePath: string;
  content: string;
  /** ISO 时间串。 */
  createdAt: string;
}

/** 只需要 Storage 的三件事，便于测试时传假实现。 */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 全部作用域共用的唯一存储键。
 *
 * 值是**一个** JSON 对象 `Record<string, ReviewDraft[]>`，而不是"每个作用域
 * 一个键"：改一个作用域时先读出整张表、改完整体写回，一次 `setItem` 就落定，
 * 不会出现"删了旧的、还没写新的"那种中间态；代价是要记住别的作用域不能让
 * 它们被覆盖掉（见 `writeDrafts`）。
 */
export const REVIEW_DRAFTS_KEY = "kustos.desktop.review-drafts";

/**
 * 草稿作用域：同一个 PR 的草稿必须共享，不同实例/仓库/PR 必须隔离。
 *
 * 返回形如 `"<instanceId>|<repoId>|<prNumber>"`；instanceId 为 null 时用 `"-"`。
 * 三段缺一不可——桌面端可以同时连多个实例，同一台实例上不同仓库的 PR 编号
 * 还会重复（`pr_number` 是仓库内的序号），只用 PR 编号做键必然串稿。
 */
export function draftScope(instanceId: string | null, repoId: string, prNumber: number): string {
  // 空串与空白也按"没有实例"处理：否则会拼出 "|r1|42" 这种看不出缺了哪一段的
  // 键，写进存储后连排查都无从下手。
  const instance = instanceId !== null && instanceId.trim() !== "" ? instanceId.trim() : "-";
  // 编号只取整数部分：40.0 与 40 是同一个 PR，不该各存一份草稿。
  const number = Number.isFinite(prNumber) ? Math.trunc(prNumber) : 0;
  return `${instance}|${repoId.trim()}|${number}`;
}

/* ------------------------------------------------------------------ */
/* 读：把存储里的任意数据收敛成 ReviewDraft[]                          */
/* ------------------------------------------------------------------ */

/** 取对象；不是对象（含 null 与数组）时返回 null。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 取非空字符串；空白串按"没有值"处理，避免界面渲染出一个看不见的条目。 */
function asText(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

/**
 * 读行号：只认正整数。
 *
 * 0、负数、小数、字符串形式的数字一律降级为 null（会话级评论）。行号是服务端
 * 用来定位的，猜一个"大概是 7"比不定位更危险——评论会挂到别人那行下面。
 */
function asLineNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * 收敛一条草稿。任何一个必填字段不成形就整条丢掉。
 *
 * 丢一条也疼，但存储被外部写坏时只剩两种选择：丢掉坏的那条，或者让整个评审
 * 窗口在读草稿时抛错。前者少一条意见，后者一条都用不了。
 */
function toDraft(value: unknown): ReviewDraft | null {
  const record = asRecord(value);
  if (record === null) return null;

  const id = asText(record.id);
  const content = asText(record.content);
  if (id === null || content === null) return null;

  return {
    id,
    lineNumber: asLineNumber(record.lineNumber),
    // filePath / createdAt 不是定位用的关键字段，类型不对时给空串即可：
    // 正文是用户手写的，不能因为一个附属字段坏了就把整条扔掉。
    filePath: typeof record.filePath === "string" ? record.filePath : "",
    content,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
  };
}

/**
 * 读出整个键对应的作用域表。
 *
 * 任何损坏（键不存在、不是 JSON、JSON 不是对象）都收敛成空表而不是抛错：
 * 这份数据是本机缓存，丢了最坏的结果是重写一次意见，而白屏会连着把已经提交
 * 的评论一起挡在界面外面。
 */
function readAll(storage: DraftStorage): Record<string, unknown> {
  let raw: string | null;
  try {
    raw = storage.getItem(REVIEW_DRAFTS_KEY);
  } catch {
    // 私有模式下越权访问也会抛；按"没有草稿"处理。
    return {};
  }
  if (raw === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  return asRecord(parsed) ?? {};
}

/** 把整张作用域表写回；表空了就删键，不留 `{}` 这种空壳。 */
function writeAll(storage: DraftStorage, all: Record<string, unknown>): void {
  try {
    if (Object.keys(all).length === 0) {
      storage.removeItem(REVIEW_DRAFTS_KEY);
      return;
    }
    storage.setItem(REVIEW_DRAFTS_KEY, JSON.stringify(all));
  } catch {
    // 配额满 / 存储被禁用：写不进去不该让评审窗口崩掉。草稿仍在 React 状态里，
    // 本次会话能继续用，只是关窗后留不住。
  }
}

/** 读一个作用域的全部草稿；任何损坏都收敛成空数组而不是抛错。 */
export function readDrafts(storage: DraftStorage, scope: string): ReviewDraft[] {
  const entry = readAll(storage)[scope];
  if (!Array.isArray(entry)) return [];

  const drafts: ReviewDraft[] = [];
  for (const item of entry) {
    const draft = toDraft(item);
    if (draft !== null) drafts.push(draft);
  }
  return drafts;
}

/** 覆盖写一个作用域；空数组时删掉这个作用域，整张表空了就连键一起删。 */
export function writeDrafts(storage: DraftStorage, scope: string, drafts: ReviewDraft[]): void {
  // 先读后改：别的作用域必须原样带回去，否则切换 PR 就会抹掉另一个 PR 的草稿。
  const all = readAll(storage);
  const normalized = drafts
    .map(toDraft)
    .filter((draft): draft is ReviewDraft => draft !== null);

  if (normalized.length === 0) {
    delete all[scope];
  } else {
    all[scope] = normalized;
  }
  writeAll(storage, all);
}

/* ------------------------------------------------------------------ */
/* 写：校验、id 与时间                                                  */
/* ------------------------------------------------------------------ */

/**
 * 校验正文。
 *
 * 空笔记不是草稿：存下去只会在 diff 上留一个看不见的标记，用户点开是一片
 * 空白，也不知道是自己没写还是丢了。抛的是普通 Error 而不是界面文案——文案
 * 由调用方按语言查表（与 `pulls.ts` 里 `PullsRequestError` 的分工一致）。
 */
function requireContent(content: string): string {
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("draft content must not be empty");
  }
  // 不 trim 再存：用户手写的换行与缩进是他要的排版，校验只看"有没有内容"。
  return content;
}

/** 兜底一个可用的时间：`Invalid Date` 调 `toISOString()` 会抛。 */
function usableDate(now: Date): Date {
  return Number.isNaN(now.getTime()) ? new Date() : now;
}

/** 进程内计数器，只在拿不到 `crypto.randomUUID` 的环境里参与生成 id。 */
let idCounter = 0;

/**
 * 生成草稿 id。
 *
 * 优先用 `crypto.randomUUID()`（多窗口并发写同一条草稿时也能错开）；它不在
 * 安全上下文里可能直接抛异常，因此带兜底：时间戳 + 计数器已经足够区分同一个
 * 窗口内连续新增的草稿，而"同一个窗口里两次调用落在同一毫秒"正是靠计数器拆开的。
 */
function newId(): string {
  const webCrypto = typeof globalThis === "object" ? globalThis.crypto : undefined;
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === "function") {
    try {
      return webCrypto.randomUUID();
    } catch {
      // 非安全上下文 / 老 WebKit：往下走兜底。
    }
  }
  idCounter += 1;
  return `draft-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** 新增一条草稿，返回写入后的完整列表。 */
export function addDraft(
  storage: DraftStorage,
  scope: string,
  input: { filePath: string; lineNumber: number | null; content: string },
  now: Date = new Date(),
): ReviewDraft[] {
  const content = requireContent(input.content);
  const drafts = readDrafts(storage, scope);
  drafts.push({
    id: newId(),
    lineNumber: asLineNumber(input.lineNumber),
    filePath: typeof input.filePath === "string" ? input.filePath : "",
    content,
    createdAt: usableDate(now).toISOString(),
  });
  writeDrafts(storage, scope, drafts);
  return drafts;
}

/** 改一条草稿的正文，返回写入后的完整列表。 */
export function updateDraft(
  storage: DraftStorage,
  scope: string,
  id: string,
  content: string,
): ReviewDraft[] {
  // 先校验正文再找 id：空正文本身就是调用方的错，与这条草稿还在不在无关。
  const next = requireContent(content);
  const drafts = readDrafts(storage, scope);
  const index = drafts.findIndex((draft) => draft.id === id);
  // 界面手里的列表可能已经过期（另一个窗口删掉了这条），找不到就原样返回：
  // 为一次陈旧的 UI 事件把评审窗口炸掉不值得。
  if (index === -1) return drafts;

  drafts[index] = { ...drafts[index], content: next };
  writeDrafts(storage, scope, drafts);
  return drafts;
}

/** 删一条草稿，返回写入后的完整列表。 */
export function removeDraft(storage: DraftStorage, scope: string, id: string): ReviewDraft[] {
  const drafts = readDrafts(storage, scope);
  const kept = drafts.filter((draft) => draft.id !== id);
  // 重复删除（双击、两个窗口同时删）是正常操作，不是错误。
  if (kept.length === drafts.length) return drafts;

  writeDrafts(storage, scope, kept);
  return kept;
}

/** 清空一个作用域。 */
export function clearDrafts(storage: DraftStorage, scope: string): void {
  writeDrafts(storage, scope, []);
}

/* ------------------------------------------------------------------ */
/* 浏览器侧存储：拿不到就退化成内存                                     */
/* ------------------------------------------------------------------ */

/** 内存兜底：私有模式下至少本次会话内草稿还能用。 */
function memoryStore(): DraftStorage {
  const cells = new Map<string, string>();
  return {
    getItem: (key) => cells.get(key) ?? null,
    setItem: (key, value) => {
      cells.set(key, value);
    },
    removeItem: (key) => {
      cells.delete(key);
    },
  };
}

/**
 * 探测并包装 `window.localStorage`。
 *
 * 它"存在"不代表能用：私有模式下 getter 可用、写入抛 `QuotaExceededError`，
 * 有的环境连 getter 本身都抛。因此先探一次写（用一个临时键，不碰真实数据），
 * 失败就整体退化成内存存储——宁可草稿活不过关窗，也不要评审窗口直接白屏。
 */
function resolveBrowserStorage(): DraftStorage {
  const fallback = memoryStore();
  if (typeof window === "undefined") return fallback;

  try {
    const native: Storage | null = window.localStorage;
    if (native === null) return fallback;

    const probeKey = `${REVIEW_DRAFTS_KEY}.probe`;
    native.setItem(probeKey, "1");
    native.removeItem(probeKey);

    // 每次调用都再兜一层：探针通过之后仍可能因为配额写满而抛。
    return {
      getItem: (key) => {
        try {
          return native.getItem(key);
        } catch {
          return null;
        }
      },
      setItem: (key, value) => {
        try {
          native.setItem(key, value);
        } catch {
          // 写不进去就让本次会话的状态顶着，不向上抛。
        }
      },
      removeItem: (key) => {
        try {
          native.removeItem(key);
        } catch {
          // 同上：删不掉也不影响内存里的当前列表。
        }
      },
    };
  } catch {
    return fallback;
  }
}

let cachedStore: DraftStorage | null = null;

/** 取本窗口的存储实现；一个窗口有没有可用存储不会中途变，因此只解析一次。 */
function browserDraftStorage(): DraftStorage {
  if (cachedStore !== null) return cachedStore;
  const store = resolveBrowserStorage();
  cachedStore = store;
  return store;
}

/* ------------------------------------------------------------------ */
/* React 侧                                                            */
/* ------------------------------------------------------------------ */

/**
 * React 侧的状态封装。
 *
 * 返回当前的草稿列表与四个写操作；写操作立刻落盘并触发重渲染。落盘先于
 * setState——先写存储再更新界面，才能保证"界面上看到的"就是"重启后还在的"。
 *
 * 正文校验的错误原样抛给调用方：界面需要在提交前提示"意见不能为空"，
 * 吞掉异常只会让用户以为写下来了。
 */
export function useReviewDrafts(scope: string): {
  drafts: ReviewDraft[];
  add: (input: { filePath: string; lineNumber: number | null; content: string }) => void;
  update: (id: string, content: string) => void;
  remove: (id: string) => void;
  clear: () => void;
} {
  const store = browserDraftStorage();
  const [drafts, setDrafts] = useState<ReviewDraft[]>(() => readDrafts(store, scope));

  // scope 变了要重读：切换 PR 时沿用上一个 PR 的草稿，会把意见挂到别的行上。
  useEffect(() => {
    setDrafts(readDrafts(store, scope));
  }, [scope, store]);

  return {
    drafts,
    add: (input) => {
      setDrafts(addDraft(store, scope, input));
    },
    update: (id, content) => {
      setDrafts(updateDraft(store, scope, id, content));
    },
    remove: (id) => {
      setDrafts(removeDraft(store, scope, id));
    },
    clear: () => {
      clearDrafts(store, scope);
      setDrafts([]);
    },
  };
}
