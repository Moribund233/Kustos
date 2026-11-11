/**
 * 磁盘路径与 LSP `file://` URI 的互转。
 *
 * 单独成模块、不依赖任何运行时：语言服务器用它认文件，跳定义、诊断、
 * 重命名全靠这个映射对得上，而写错的表现是"什么都返回空"，不是报错。
 * 纯函数就能把两个方向都钉死，所以这里有单测。
 *
 * Windows 的盘符路径要写成 `file:///D:/proj/a.ts`：`file://` 之后的第一段
 * 是主机名，本机路径要留一个空主机名，于是第三个斜杠不能省。
 */

/** 统一成 `/` 分隔，`file://` URI 不认反斜杠。 */
function toSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** 是不是 Windows 盘符路径（`D:/...`）。 */
function hasDriveLetter(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path);
}

/**
 * 单段百分号编码。
 *
 * 空格、中文、`#`、`?` 在 URI 里都会被误读，必须编码；但盘符的冒号
 * （`D:`）要留着——`%3A` 虽然合法，却是多数语言服务器不认的写法。
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ":");
}

/**
 * 把工作区根与仓库内相对路径拼成 `file://` URI。
 *
 * 相对路径为空时返回根本身的 URI（`rootUri` 用得上）。
 */
export function toFileUri(root: string, relativePath = ""): string {
  const base = toSlashes(root).replace(/\/+$/, "");
  const rel = toSlashes(relativePath).replace(/^\/+/, "");
  const full = rel === "" ? base : `${base}/${rel}`;
  // 本机路径必须以 `/` 开头，才能得到 `file:///D:/...` 这种三段斜杠。
  const absolute = full.startsWith("/") ? full : `/${full}`;
  const encoded = absolute
    .split("/")
    .map((segment, index) => (index === 0 ? segment : encodeSegment(segment)))
    .join("/");
  return `file://${encoded}`;
}

/** 逐段解码：整串 `decodeURIComponent` 会把编码过的分隔符也放出来。 */
function decodePath(encoded: string): string {
  return encoded
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // 半截编码（用户手输的、日志里截断的）原样保留，总比抛出去强。
        return segment;
      }
    })
    .join("/");
}

/**
 * 把 `file://` URI 还原成仓库内相对路径；不在该根下时返回 null。
 *
 * 返回 null 而不是抛错：调用方拿到 URI 的地方（跳定义结果、诊断）
 * 本来就可能指向仓库外的文件（标准库、依赖包），那不是错误。
 */
export function relativePathFromUri(root: string, uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  const decoded = decodePath(uri.slice("file://".length)).replace(/^\/+/, "");
  const base = toSlashes(root)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (base === "") return null;

  // Windows 上盘符大小写不敏感，`d:/` 与 `D:/` 是同一个目录；
  // POSIX 上则必须逐字比较，否则会把大小写不同的两个目录混成一个。
  const windowsLike = hasDriveLetter(base) || hasDriveLetter(decoded);
  const left = windowsLike ? decoded.toLowerCase() : decoded;
  const right = windowsLike ? base.toLowerCase() : base;

  if (left === right) return "";
  if (!left.startsWith(`${right}/`)) return null;
  return decoded.slice(base.length + 1);
}
