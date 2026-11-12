import { useQuery } from "@tanstack/react-query";

import { api } from "@kustos/api";

import { diffStats, parseUnifiedDiff, type DiffHunk } from "@/lib/unified-diff";

/**
 * PR 整体 diff 的数据层。
 *
 * 服务端把整个 PR 的改动拼成**一份** unified diff 文本（`diff`），另外给一份
 * 权威的文件清单（`files`）与总计（`stats`）。清单里**没有**每个文件的新增/
 * 删除行数，所以单文件计数只能从文本里自己数——界面要按文件折叠、要显示
 * `+N/-N` 徽标，就必须先把"一份文本"还原成"每个文件一段"，这正是本模块的职责。
 *
 * 收敛而不是校验：路径、状态、计数缺失时给安全默认值，输入再脏也不抛错。
 * 详情页白屏比某个数字不准更糟，而"某条记录字段不对"完全由服务端契约的那一次
 * 变更造成，不该让整个 PR 详情页跟着塌掉。
 *
 * 复用 `lib/unified-diff.ts` 而不是自己再写一个解析器：hunk 边界必须由 hunk 头
 * 里的行数决定（那里记着为什么），两套实现只会在边界行为上分叉。
 */

/**
 * diff 请求失败。
 *
 * 不复用 `pulls.ts` 的 `PullsRequestError`：它的 `operation` 是闭集且不含
 * `"diff"`，而那个文件不归这里改；为塞一个新取值去放宽别人的类型，等于让
 * 三个既有调用点失去穷尽性检查。抛自己的错误，`status` 与界面翻译键的约定
 * 与它保持一致（`pulls.errors.diff` 由界面查表）。
 */
export class PRDiffRequestError extends Error {
  constructor(readonly status: number) {
    super(`diff failed with HTTP ${status}`);
    this.name = "PRDiffRequestError";
  }
}

/**
 * diff 的查询键。
 *
 * 不自称 `pullsKeys.diff`：`pullsKeys` 里没有这个成员，而那个文件不在本次改动
 * 范围内。键的第一段仍用 `"pulls"`，让 diff 与 PR 详情共享同一个缓存域——按
 * `["pulls", repo]` 前缀统一失效时两者一起刷新，语义与它们的数据来源一致。
 */
export const prDiffKeys = {
  diff: (repoId: string, number: number) => ["pulls", repoId, "diff", number] as const,
};

/** 一个文件在 PR diff 里的完整呈现。 */
export interface DiffFile {
  /** 新路径；文件被删除时是旧路径。 */
  path: string;
  /** 仅重命名时有值，其余为 null。 */
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
  /** 服务端给的单字符状态码 A|M|D|R|C，未知为 "?"。 */
  statusCode: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** 二进制文件没有文本 diff。 */
  binary: boolean;
}

/** 一个 PR 的整体改动。 */
export interface PullRequestDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
  filesChanged: number;
  baseCommit: string | null;
  headCommit: string | null;
}

/* ------------------------------------------------------------------ */
/* 把一份 diff 文本切成每文件一段                                        */
/* ------------------------------------------------------------------ */

/** 服务端拼接多个文件时用的分隔行前缀。 */
const SECTION_PREFIX = "diff --git ";

/** git 用它表示"这一侧没有文件"（新增 / 删除文件的另一侧）。 */
const DEV_NULL = "/dev/null";

/** hunk 头：`@@ -旧起点,旧行数 +新起点,新行数 @@`。 */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** git 引号路径里会出现的单字符转义；八进制转义（`\NNN`）单独处理。 */
const ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
  "\\": "\\",
};

/** 去掉 git 的 `a/` / `b/` 方向前缀。只去一层：路径本身可能以 `a/` 开头。 */
function stripDirectionPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * 还原 git 的 C 风格引号路径。
 *
 * 路径含空格、引号或不可打印字符时 git 会把整条路径加引号并转义
 * （`"a/pa th"`）。不还原的话界面上会显示带引号和转义符的假路径，
 * 而且拿它去匹配 `files[]` 永远匹配不上。
 */
function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;

  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const escaped = body[i + 1];
    if (escaped === undefined) {
      out += char;
      continue;
    }
    if (escaped >= "0" && escaped <= "7") {
      let digits = "";
      let cursor = i + 1;
      while (
        cursor < body.length &&
        digits.length < 3 &&
        body[cursor] >= "0" &&
        body[cursor] <= "7"
      ) {
        digits += body[cursor];
        cursor += 1;
      }
      out += String.fromCharCode(Number.parseInt(digits, 8));
      i = cursor - 1;
      continue;
    }
    out += ESCAPES[escaped] ?? escaped;
    i += 1;
  }
  return out;
}

/**
 * 从 `--- a/<path>` / `+++ b/<path>` 标记行里取路径。
 *
 * 优先用标记行而不是 `diff --git a/X b/Y`：后者的两个路径之间没有分隔符，
 * 路径含空格时切点有歧义（`a/my notes.md b/my notes.md` 按空白切会截断在
 * 第一个空格）；标记行只有一个路径，切起来没有歧义。
 *
 * `/dev/null` 返回 null——它表示"这一侧没有文件"，不是路径。
 */
function markerPath(line: string, prefix: "--- " | "+++ "): string | null {
  if (!line.startsWith(prefix)) return null;

  const raw = line.slice(prefix.length).trimEnd();
  const quoted = raw.startsWith('"');
  let value = unquotePath(raw);
  // 非 git 的 diff 生成器会在路径后补一个 tab 加时间戳；git 自己不加。
  // 引号内的 tab 是路径本身的字符，不能切。
  if (!quoted) {
    const tab = value.indexOf("\t");
    if (tab >= 0) value = value.slice(0, tab);
  }
  if (value === "" || value === DEV_NULL) return null;

  return stripDirectionPrefix(value);
}

/** 从 `diff --git a/X b/Y` 里猜新路径；仅在标记行缺失时兜底。 */
function gitHeaderPath(line: string): string | null {
  const rest = line.slice(SECTION_PREFIX.length).trim();
  if (rest === "") return null;

  // 带引号的形态：两个引号串各占一段，边界确定。
  const quotedPair = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quotedPair) {
    const right = stripDirectionPrefix(unquotePath(quotedPair[2]));
    return right === "" ? null : right;
  }

  // 无引号：` b/` 是唯一锚点。优先挑让两侧路径一致的那个切点（同路径的
  // 修改/新增最常见），没有一致的就取第一个，其余情况交给调用方的顺序兜底。
  let firstCandidate: string | null = null;
  for (let i = rest.indexOf(" b/"); i >= 0; i = rest.indexOf(" b/", i + 1)) {
    const left = rest.slice(0, i);
    const right = rest.slice(i + 3);
    if (right === "") continue;
    if (firstCandidate === null) firstCandidate = right;
    if (stripDirectionPrefix(left) === right) return right;
  }
  return firstCandidate;
}

/** 一个文件的原始段落：文本行 + 三种候选路径。 */
interface RawSection {
  lines: string[];
  newPath: string | null;
  oldPath: string | null;
  gitPath: string | null;
}

/** 段落的展示路径：新路径优先，删除文件退回旧路径，再兜底 diff 头。 */
function sectionPath(section: RawSection): string {
  return section.newPath ?? section.oldPath ?? section.gitPath ?? "";
}

/**
 * 扫描整份 diff 文本，按 `diff --git` 切成段落。
 *
 * 段边界只认 `diff --git ` 行，且只在**当前 hunk 已经读满**时才认。后者是关键：
 * hunk 里一行被删除的 SQL/Lua 注释在 diff 里正是 `--- 旧注释`，按 `--- ` 前缀
 * 切段会把一个文件劈成两段并丢掉后续内容（`unified-diff.ts` 里同一个坑的
 * 另一半）。同理，hunk 内容行永远带一个 `+` / `-` / 空格前缀，所以"行首就是
 * `diff --git `"只可能出现在段落之间——两道判定互为兜底。
 */
function collectSections(raw: string): RawSection[] {
  if (raw.trim() === "") return [];

  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  // 当前 hunk 还各差多少行才算读完（取自 hunk 头）。
  let oldLeft = 0;
  let newLeft = 0;

  for (const rawLine of raw.split("\n")) {
    // CRLF 归一：Windows 上未规范化的 diff 每行尾部带 `\r`，混进段落文本后
    // 是不可见字符，会让路径匹配与复制出来的内容都带上它。
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const inHunk = oldLeft > 0 || newLeft > 0;

    if (!inHunk && line.startsWith(SECTION_PREFIX)) {
      current = { lines: [], newPath: null, oldPath: null, gitPath: gitHeaderPath(line) };
      sections.push(current);
      oldLeft = 0;
      newLeft = 0;
      continue;
    }

    // 第一个 `diff --git` 之前的游离内容不属于任何文件（服务端不会产出，
    // 但输入是外部数据，不能假设它一定规范）。
    if (!current) continue;

    current.lines.push(line);

    if (inHunk) {
      // hunk 内一律按内容行处理，不套文件头规则。
      if (line.startsWith("+")) {
        newLeft -= 1;
      } else if (line.startsWith("-")) {
        oldLeft -= 1;
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file"：提示性质，不占行数。
      } else {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }

    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      // 省略行数（`@@ -1 +1 @@`）表示 1 行，不是 0 行。
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }

    // hunk 之外才是文件头区段，这里才收路径标记。
    if (current.newPath === null) current.newPath = markerPath(line, "+++ ");
    if (current.oldPath === null) current.oldPath = markerPath(line, "--- ");
  }

  return sections;
}

/**
 * 只把 diff 文本切成"每个文件一段"，供上层单独渲染或做统计。
 *
 * 段落文本**包含**该文件的 `diff --git` 头：二进制标记（`Binary files ...`）
 * 就落在头区段里，切掉的段落再交给 `parseUnifiedDiff` 时会丢失这个信息。
 *
 * 路径取不到时给空串而不是猜一个——猜错的路径会把 hunk 挂到别的文件上，
 * 这种错比"路径为空"更难被发现。
 */
export function splitDiffByFile(raw: string): Array<{ path: string; chunk: string }> {
  return collectSections(raw).map((section) => ({
    path: sectionPath(section),
    chunk: section.lines.join("\n"),
  }));
}

/* ------------------------------------------------------------------ */
/* 响应收敛：snake_case → camelCase                                    */
/* ------------------------------------------------------------------ */

/** 读字符串字段；类型不符时回落。 */
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** 读可空字符串字段。空串按"没有值"处理，避免界面渲染出一个空壳。 */
function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 读"不可能为负"的计数。
 *
 * 负数是明显不成立的值（行数、文件数不可能小于 0），按缺失处理并交给调用方
 * 用实际统计兜底；照抄一个负数会让界面显示 `+-3`。
 */
function asCount(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  // 服务端偶有把计数序列化成字符串的历史，接受数字形式的字符串。
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return fallback;
}

/** 数组字段；不是数组时按空列表处理。 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 服务端对象字段；不是对象（含 null 与数组）时按"没有"处理。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 过滤出成形的对象条目：标量条目连字段都读不到，留着读不出任何值。 */
function recordsOnly(value: unknown): Record<string, unknown>[] {
  return asArray(value).filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

/** 服务端 `files[].status` → 前端枚举。未知取值落 unknown，界面按灰色处理。 */
function toStatus(value: unknown): DiffFile["status"] {
  switch (asString(value).trim().toLowerCase()) {
    case "added":
      return "added";
    case "modified":
      return "modified";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    default:
      return "unknown";
  }
}

/**
 * 服务端 `files[].status_code` → 单字符状态码。
 *
 * 优先用服务端给的值（它与 `git diff --name-status` 一致，是别人也认的写法）；
 * 缺失或不合法时按 `status` 反推，界面上的 A/M/D 徽标因此不会突然变成空。
 */
function toStatusCode(value: unknown, status: DiffFile["status"]): string {
  const text = asString(value).trim().toUpperCase();
  if (text.length === 1 && "AMDRC".includes(text)) return text;

  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    default:
      return "?";
  }
}

/**
 * 匹配用的路径归一化：只抹掉 `./` 与开头的 `/`，不改动展示值。
 *
 * 反斜杠一并归一成 `/`：diff 文本里的路径恒为 `/`，而清单里的路径在某些
 * 生成路径上会带 Windows 分隔符——不归一的话这类文件会永远匹配不上段落，
 * 界面表现为"文件在，但一行差异都没有"。
 */
function normalizePath(path: string): string {
  let out = path.trim().replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  if (out.startsWith("/")) out = out.slice(1);
  return out;
}

/** 已收敛、待与 diff 段落配对的一条文件记录。 */
interface PlannedFile {
  path: string;
  oldPath: string | null;
  status: DiffFile["status"];
  statusCode: string;
}

/** 全空的整体 diff：输入完全不成形时用它，保证调用方永远拿得到同一个形状。 */
function emptyDiff(): PullRequestDiff {
  return {
    files: [],
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    baseCommit: null,
    headCommit: null,
  };
}

/**
 * 把服务端的原始响应收敛成前端结构。
 *
 * 文件清单与顺序以 `files[]` 为准（它是服务端算出来的权威列表，diff 文本只是
 * 内容的载体）：按清单逐条去文本里取自己那一段，取不到就保留空 hunk 的空壳，
 * 而不是把这条记录丢掉——"这个文件没有可显示的差异"和"这个文件被改了但我
 * 没显示"在界面上是两件事。
 *
 * 单文件计数一律用 `diffStats(parseUnifiedDiff(chunk))` 现算：契约里每个文件
 * 没有行数，且用总数去摊也摊不出来（删除文件只贡献删除行）。
 */
export function toPullRequestDiff(raw: unknown): PullRequestDiff {
  const payload = asRecord(raw);
  if (!payload) return emptyDiff();

  const diffText = asString(payload.diff);
  const sections = collectSections(diffText);
  const used = sections.map(() => false);

  /** 按路径取段落；同一路径在文本里只可能有一段，取过即标记占用。 */
  const takeByPath = (path: string): RawSection | null => {
    const wanted = normalizePath(path);
    if (wanted === "") return null;
    for (let i = 0; i < sections.length; i += 1) {
      if (used[i]) continue;
      if (normalizePath(sectionPath(sections[i])) === wanted) {
        used[i] = true;
        return sections[i];
      }
    }
    return null;
  };

  /** 顺序兜底：路径对不上时按文本顺序配对，总比让整段内容消失好。 */
  const takeFirstUnused = (): RawSection | null => {
    for (let i = 0; i < sections.length; i += 1) {
      if (!used[i]) {
        used[i] = true;
        return sections[i];
      }
    }
    return null;
  };

  const planned: PlannedFile[] = [];
  for (const entry of recordsOnly(payload.files)) {
    const status = toStatus(entry.status);
    // 契约里只有 renamed 会带 old_path（deleted 也是 null），这里照契约收紧，
    // 免得界面对一个删除文件画出"改名"箭头。
    const oldPath = status === "renamed" ? asNullableString(entry.old_path) : null;
    const path = asString(entry.path) || oldPath || "";
    // 既没有新路径也没有旧路径的条目在界面上渲染不出任何东西，直接丢弃。
    if (path === "") continue;
    planned.push({ path, oldPath, status, statusCode: toStatusCode(entry.status_code, status) });
  }

  const chunks: Array<string | null> = planned.map(() => null);
  const unmatched: number[] = [];
  planned.forEach((file, index) => {
    const section = takeByPath(file.path);
    if (section) chunks[index] = section.lines.join("\n");
    else unmatched.push(index);
  });
  for (const index of unmatched) {
    const section = takeFirstUnused();
    if (!section) break;
    chunks[index] = section.lines.join("\n");
  }

  const files: DiffFile[] = planned.map((file, index) => {
    const parsed = parseUnifiedDiff(chunks[index] ?? "");
    const stats = diffStats(parsed);
    return {
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      statusCode: file.statusCode,
      // 二进制没有文本行，parseUnifiedDiff 已经给出空 hunk；计数归零是它的
      // 语义（不是"统计失败"）。
      additions: parsed.binary ? 0 : stats.added,
      deletions: parsed.binary ? 0 : stats.removed,
      hunks: parsed.hunks,
      binary: parsed.binary,
    };
  });

  // 服务端没给文件清单时（字段缺失或为空）退化成"按文本自己列"：这时候
  // 丢掉整份 diff 等于详情页一片空白，而文本本身就是完整的。
  if (planned.length === 0) {
    for (let i = 0; i < sections.length; i += 1) {
      const chunk = sections[i].lines.join("\n");
      const parsed = parseUnifiedDiff(chunk);
      const stats = diffStats(parsed);
      files.push({
        path: sectionPath(sections[i]),
        oldPath: null,
        status: "unknown",
        statusCode: "?",
        additions: parsed.binary ? 0 : stats.added,
        deletions: parsed.binary ? 0 : stats.removed,
        hunks: parsed.hunks,
        binary: parsed.binary,
      });
    }
  }

  const derivedAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const derivedDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const stats = asRecord(payload.stats);

  // 总计以服务端的 `stats` 为准：它是 base..head 上算的，包含被截断/超大文件
  // 之类文本里看不到的部分，比前端从文本求和更接近"这个 PR 改了多少"。
  // 缺失或不成立时再用逐文件之和兜底。
  return {
    files,
    additions: stats ? asCount(stats.additions, derivedAdditions) : derivedAdditions,
    deletions: stats ? asCount(stats.deletions, derivedDeletions) : derivedDeletions,
    filesChanged: stats ? asCount(stats.files_changed, files.length) : files.length,
    baseCommit: asNullableString(payload.base_commit),
    headCommit: asNullableString(payload.head_commit),
  };
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/**
 * 单个 PR 的整体 diff。
 *
 * 与 `usePullRequest` 同构：`repoId` 为空或编号非正时不发请求（桌面端要先把
 * 本机工作副本对到服务端仓库），错误抛 `PRDiffRequestError` 交给界面的错误态。
 *
 * diff 可能很大而内容在 PR 的生命周期里基本不变（推新提交才会变），缓存窗口
 * 与详情页其它数据保持一致，避免一次会话里反复拉同一份文本。
 */
export function usePullRequestDiff(repoId: string | null, number: number | null) {
  const repo = repoId ?? "";
  const prNumber = number ?? 0;

  return useQuery({
    queryKey: prDiffKeys.diff(repo, prNumber),
    enabled: repo !== "" && prNumber > 0,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        "/api/v1/repositories/{repo_id}/pull-requests/{pr_number}/diff",
        { params: { path: { repo_id: repo, pr_number: prNumber } } },
      );
      if (error || !response.ok) {
        throw new PRDiffRequestError(response.status);
      }
      return toPullRequestDiff(data);
    },
    staleTime: 60_000,
  });
}
