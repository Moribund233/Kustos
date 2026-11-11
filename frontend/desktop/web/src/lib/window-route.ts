/**
 * 窗口路由：决定当前这个窗口显示什么内容。
 *
 * 为什么不靠全局状态：多窗口下全局状态由"最后写入者"胜出——主窗口打开 PR #1
 * 的评审窗之后，再点 PR #2 的"在窗口中打开"，全局变量会变成 2，于是两个窗口
 * 都显示 #2。内容标识必须随窗口自己走，也就是放在它自己的 URL 里。
 *
 * 片段形如 `#/review/42`（评审窗显示某个 PR）或 `#/review`（评审窗还没指定
 * PR，例如从托盘直接唤出）。片段不参与服务端路径匹配，因此不会影响 bridge 的
 * 同源与白名单判定。
 */

/** 当前窗口要显示的内容。 */
export type WindowRoute =
  | { kind: "main" }
  | { kind: "review"; prNumber: number | null };

/** 解析 URL 片段。 */
export function parseWindowRoute(hash: string): WindowRoute {
  // 去掉前导的 `#`，再按 `/` 切。空片段表示主窗口。
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const parts = raw.split("/").filter((p) => p !== "");
  if (parts.length < 1) return { kind: "main" };

  const [scope, value] = parts;
  if (scope !== "review") return { kind: "main" };

  // `#/review` 没有编号：这是"评审窗，但还没选中 PR"。
  // 不能退化成主窗口——从托盘唤出的评审窗本来就是这种状态，退化成主窗口
  // 会让用户看到第二个 Inbox，而不是一个说明"去选个 PR"的评审窗。
  if (value === undefined) return { kind: "review", prNumber: null };

  const prNumber = Number(decodeURIComponent(value));
  // 编号必须是正整数：解析失败时退回"未选中 PR"，而不是显示一个不存在的 PR。
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { kind: "review", prNumber: null };

  return { kind: "review", prNumber };
}

/** 当前窗口的片段（在浏览器环境里安全读取）。 */
export function currentWindowRoute(): WindowRoute {
  if (typeof window === "undefined") return { kind: "main" };
  return parseWindowRoute(window.location.hash);
}

/**
 * 订阅片段变化，返回取消订阅函数。
 *
 * 已有的评审窗被换内容时，Go 侧走的是 `SetURL`（整页重新导航），但那一次
 * 导航发生在另一个窗口里；同窗口内改片段（例如将来在同一评审窗里切换 PR）
 * 只会触发 `hashchange`，组件不会重挂载。两条路径都要能被感知到。
 *
 * Args:
 *
 *	onChange: 片段变化后的回调
 *
 * Returns:
 *
 *	取消订阅函数；非浏览器环境下是空操作。
 */
export function onWindowRouteChange(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
