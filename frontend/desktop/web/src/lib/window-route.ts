/**
 * 窗口路由：决定当前这个窗口显示什么内容。
 *
 * 为什么不靠全局状态：多窗口下全局状态由"最后写入者"胜出——主窗口打开 PR #1
 * 的评审窗之后，再点 PR #2 的"在窗口中打开"，全局变量会变成 2，于是两个窗口
 * 都显示 #2。内容标识必须随窗口自己走，也就是放在它自己的 URL 里。
 *
 * 片段形如 `#/review/42`。片段不参与服务端路径匹配，因此不会影响 bridge 的
 * 同源与白名单判定。
 */

/** 当前窗口要显示的内容。 */
export type WindowRoute =
  | { kind: "main" }
  | { kind: "review"; prNumber: number };

/** 解析 URL 片段。 */
export function parseWindowRoute(hash: string): WindowRoute {
  // 去掉前导的 `#`，再按 `/` 切。空片段表示主窗口。
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const parts = raw.split("/").filter((p) => p !== "");
  if (parts.length < 2) return { kind: "main" };

  const [scope, value] = parts;
  if (scope !== "review") return { kind: "main" };

  const prNumber = Number(decodeURIComponent(value));
  // 编号必须是正整数：解析失败时退回主界面，而不是显示一个不存在的 PR。
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { kind: "main" };

  return { kind: "review", prNumber };
}

/** 当前窗口的片段（在浏览器环境里安全读取）。 */
export function currentWindowRoute(): WindowRoute {
  if (typeof window === "undefined") return { kind: "main" };
  return parseWindowRoute(window.location.hash);
}
