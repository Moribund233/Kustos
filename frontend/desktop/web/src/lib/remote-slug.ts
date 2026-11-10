/**
 * 从 git remote 地址推导服务端仓库标识的纯函数。
 *
 * 单独成模块的理由：`repos.ts` 会 import Wails 的绑定（remote 地址由本机 git
 * 读取），而绑定在浏览器/单测环境里会装载运行时并打印环境警告。这里只含
 * 字符串处理，能被单测直接引用而不拉起那套运行时。
 */

/** 从 git remote 地址里解析出的仓库标识。 */
export interface RemoteSlug {
  owner: string;
  name: string;
}

/**
 * 从 git remote 地址里抽出 `owner/repo`。
 *
 * 支持桌面端真实会遇到的三种形态：
 *
 *   https://host/owner/repo.git
 *   ssh://git@host:2222/owner/repo.git
 *   git@host:owner/repo.git          （scp 风格，冒号是分隔符不是端口）
 *
 * Args:
 *
 *	remote: git remote get-url 的原始输出；空串或无法识别时返回 null
 *
 * Returns:
 *
 *	`{ owner, name }`；路径层级不足、或不是 git 形态时返回 null。
 *
 * 只取最后两段：自托管实例可能挂在子路径下（`/git/owner/repo`），
 * 而服务端的 `Repository.path` 恒为两段，多出来的前缀对不上号。
 */
export function parseRemoteSlug(remote: string | null | undefined): RemoteSlug | null {
  if (!remote) return null;
  const trimmed = remote.trim();
  if (trimmed === "") return null;

  let path = trimmed;

  // scp 风格（git@host:owner/repo）里没有 "//"，且冒号后面才是路径。
  // 不能先按 URL 解析：`new URL("git@host:owner/repo")` 会抛。
  if (!trimmed.includes("://")) {
    const colon = trimmed.indexOf(":");
    if (colon < 0) return null;
    path = trimmed.slice(colon + 1);
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    path = parsed.pathname;
  }

  const segments = path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== ".");

  if (segments.length < 2) return null;

  const name = stripGitSuffix(segments[segments.length - 1]);
  const owner = segments[segments.length - 2];
  if (owner === "" || name === "") return null;

  return { owner, name };
}

/** 去掉 `.git` 后缀；服务端的仓库名不含它。 */
function stripGitSuffix(name: string): string {
  return name.toLowerCase().endsWith(".git") ? name.slice(0, -4) : name;
}

/**
 * 在已列出的仓库里，按 slug 找一个匹配项。
 *
 * 先按精确 `path` 匹配，再按"仓库名相同"兜底：服务端的 owner 段来自用户名，
 * 而 remote 里的 owner 段在 fork 或改名场景下可能对不上。兜底只在**唯一**
 * 命中时返回，多义时宁可空手让用户去选，也不猜一个可能错的仓库。
 *
 * Args:
 *
 *	repos: 可见仓库列表
 *	slug:  从 remote 解析出的标识；为 null 时不做匹配
 *
 * Returns:
 *
 *	`matched` 为命中的仓库（无命中为 null）；`ambiguous` 表示有多个同名仓库
 *	且 owner 对不上——此时调用方应让用户自己选。
 */
export function matchRepository<T extends { name: string; path: string }>(
  repos: T[],
  slug: RemoteSlug | null,
): { matched: T | null; ambiguous: boolean } {
  if (!slug) return { matched: null, ambiguous: false };

  const wanted = `${slug.owner}/${slug.name}`.toLowerCase();
  const exact = repos.find((r) => r.path.toLowerCase() === wanted);
  if (exact) return { matched: exact, ambiguous: false };

  const byName = repos.filter((r) => r.name.toLowerCase() === slug.name.toLowerCase());
  if (byName.length === 1) return { matched: byName[0], ambiguous: false };
  return { matched: null, ambiguous: byName.length > 1 };
}
