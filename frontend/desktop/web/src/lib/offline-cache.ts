/**
 * 离线缓存的数据层。
 *
 * 桌面端是常驻进程，断网时不该只剩一片空白：Inbox 列表、PR 与 Issue 的详情
 * 都已经取回来过，那些内容存在本地库里，重开或断网时先拿它顶上。
 *
 * 三条克制的规则：
 *
 *  1. **只缓存只读数据**。能写的东西（草稿、提交）另有自己的表——用"恢复一份
 *     旧 JSON"冒充写成功，等于静默的数据丢失；
 *  2. **在线结果优先**。缓存只在请求失败时回落，不拿它覆盖新数据；
 *  3. **回落要说出来**。界面必须标明"这是什么时候的数据"，否则用户会拿几天前
 *     的 Inbox 当作现在的状态。
 */
import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { OfflineCacheService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";

/** 一份从缓存读回来的内容。 */
export interface CachedSnapshot<T> {
  data: T;
  /** 取回时刻（毫秒）。界面用它说明"这份数据是什么时候的"。 */
  fetchedAt: number;
}

/**
 * 把一份查询结果写进本地缓存。
 *
 * 失败静默：缓存写不进去不该影响正在做的事——它只是一份兜底。
 *
 * Args:
 *
 *	key:     缓存键
 *	value:   要缓存的响应（会被 JSON 序列化）
 */
export async function cacheSnapshot(key: string, value: unknown): Promise<void> {
  try {
    await OfflineCacheService.Put(key, JSON.stringify(value));
  } catch {
    // 缓存是兜底，写不进去不影响主路径。
  }
}

/**
 * 从本地缓存读一份内容。
 *
 * Args:
 *
 *	key:    缓存键
 *	parse:  把 JSON 还原成调用方的形状；抛错即视为未命中
 *
 * Returns:
 *
 *	命中时的内容与取回时间；未命中、过期或内容无法还原时为 null。
 *
 * 内容还原失败按未命中处理而不是抛错：缓存的格式可能随版本变化，
 * 一份读不懂的旧数据不该让整屏报错。
 */
export async function readSnapshot<T>(
  key: string,
  parse: (raw: unknown) => T,
): Promise<CachedSnapshot<T> | null> {
  try {
    // 绑定层把 Go 的多返回值展开成 `[entry, found]` 元组，不是带字段的对象。
    const [entry, found] = await OfflineCacheService.Get(key);
    if (!found || entry == null) return null;
    const raw: unknown = JSON.parse(entry.payload);
    return { data: parse(raw), fetchedAt: Number(entry.fetchedAt) || 0 };
  } catch {
    return null;
  }
}

/**
 * 订阅查询成功并把结果写进缓存。
 *
 * Args:
 *
 *	enabled: 会话就绪后才开始记；未登录时拉到的都是错误响应，缓存它没有意义。
 *
 * 挂在 QueryClient 的缓存事件上而不是逐个查询里加 onSuccess：
 * 需要缓存的查询有十几处，逐个接线一定会漏几个，而"漏掉的那个断网就空白"
 * 是最难被发现的失败。
 */
export function useOfflineCacheWriter(enabled: boolean): void {
  const qc = useQueryClient();
  // 是否要缓存某个查询由 queryKey 决定：只认带 surface 前缀的那几个只读列表。
  const writing = useRef(new Map<string, string>());
  writing.current = cacheableQueries(qc);

  useEffect(() => {
    if (!enabled) return;
    return qc.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const { action, query } = event;
      if (action.type !== "success") return;
      const key = writing.current.get(query.queryHash);
      if (key === undefined) return;
      void cacheSnapshot(key, query.state.data);
    });
  }, [enabled, qc]);
}

/**
 * 选出需要缓存的查询，并把它们的 queryHash 映射成缓存键。
 *
 * 为什么按 hash 映射而不是逐处传 key：queryHash 是 React Query 自己算的稳定
 * 标识，用它做键可以保证"同一个查询每次落到同一个缓存条目"；手写 key 一旦
 * 与查询参数不一致，就会把 A 的响应写到 B 的缓存里。
 *
 * Args:
 *
 *	qc: 查询客户端
 *
 * Returns:
 *
 *	`queryHash → 缓存键` 的映射。
 */
export function cacheableQueries(qc: QueryClient): Map<string, string> {
  const map = new Map<string, string>();
  for (const query of qc.getQueryCache().getAll()) {
    const key = cacheKeyFor(query.queryKey);
    if (key !== null) map.set(query.queryHash, key);
  }
  return map;
}

/**
 * 判断一个 queryKey 是否值得缓存，并给出它的缓存键。
 *
 * Args:
 *
 *	queryKey: React Query 的查询键
 *
 * Returns:
 *
 *	缓存键；不该缓存时返回 null。
 *
 * 只认 Inbox、PR、Issue 三类只读列表与详情。工作副本与代码相关的东西
 * **刻意不缓存**：它们要么是本机就能现算的（git 状态），要么内容来自磁盘，
 * 缓存一份反而会与真实文件打架。
 */
export function cacheKeyFor(queryKey: readonly unknown[]): string | null {
  const [head, second] = queryKey;
  if (typeof head !== "string") return null;
  switch (head) {
    case "inbox":
      return `inbox:${JSON.stringify(queryKey.slice(1))}`;
    case "pulls":
      return `pulls:${JSON.stringify(queryKey.slice(1))}`;
    case "issues":
      return `issues:${JSON.stringify(queryKey.slice(1))}`;
    default:
      // `pr-reviewers` 之类的附带数据跟着详情走，单独缓存没有意义。
      void second;
      return null;
  }
}
