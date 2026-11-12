import { describe, expect, it } from "vitest";

import {
  PRDiffRequestError,
  prDiffKeys,
  splitDiffByFile,
  toPullRequestDiff,
} from "@/lib/pr-diff";
import { diffStats, parseUnifiedDiff } from "@/lib/unified-diff";

/**
 * PR 整体 diff 的纯逻辑测试。
 *
 * 服务端给的是"一份拼接文本 + 一份文件清单"，而界面要按文件折叠、要显示
 * `+N/-N` 徽标——把两者配起来并对上号就是这里唯一能脱离网络验证的部分。
 * 配错了不会白屏，只会把某个文件的差异挂到别的文件上，这种错比崩溃难发现，
 * 所以用例都直接断言"文件 → 段落"的对应关系，而不只看总数。
 */

/**
 * 一段两文件的合成 diff：一个修改（带 hunk），一个新增。
 *
 * 这就是服务端拼接后的真实形态——`diff` 是多个 `diff --git` 段首尾相接，
 * 段与段之间没有额外分隔。
 */
const TWO_FILES = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 3f9c1a2..b7d4e55 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 22;",
  "+const c = 3;",
  " export {};",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..e69de29",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+line one",
  "+line two",
].join("\n");

/** 与 `TWO_FILES` 对应的权威文件清单（顺序即渲染顺序）。 */
const TWO_FILES_LIST = [
  { status: "modified", path: "src/app.ts", old_path: null, status_code: "M" },
  { status: "added", path: "src/new.ts", old_path: null, status_code: "A" },
];

/** 覆盖契约里那 5 个键的完整响应。 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    diff: TWO_FILES,
    files: TWO_FILES_LIST,
    stats: { files_changed: 2, additions: 4, deletions: 1, total_changes: 5 },
    base_commit: "aaaa1111",
    head_commit: "bbbb2222",
    ...overrides,
  };
}

describe("toPullRequestDiff 的文件与顺序", () => {
  it("按服务端 files[] 的顺序输出，并给每个文件挂上自己那一段 hunk", () => {
    // 顺序是服务端的权威排序；按 diff 文本的自有顺序渲染会让文件列表与
    // "改动 N 个文件"的计数对不上。
    const diff = toPullRequestDiff(payload());

    expect(diff.files.map((f) => f.path)).toEqual(["src/app.ts", "src/new.ts"]);
    expect(diff.files.map((f) => f.status)).toEqual(["modified", "added"]);
    expect(diff.files.map((f) => f.statusCode)).toEqual(["M", "A"]);
    expect(diff.files.every((f) => f.binary === false)).toBe(true);

    // 关键：hunk 必须挂在**对的那个**文件上，不能是"两段随便配两段"。
    expect(diff.files[0].hunks).toHaveLength(1);
    expect(diff.files[0].hunks[0].header).toBe("@@ -1,3 +1,4 @@");
    expect(diff.files[1].hunks[0].header).toBe("@@ -0,0 +1,2 @@");
    expect(diff.files[1].hunks[0].lines.map((l) => l.text)).toEqual(["line one", "line two"]);
  });

  it("单文件计数等于该文件段落的 diffStats（契约里 files[] 没有行数）", () => {
    // 每个文件的新增/删除只能从文本里数；用总数去摊是摊不出来的
    // （删除文件只贡献删除行），所以逐文件断言。
    const diff = toPullRequestDiff(payload());
    const chunks = splitDiffByFile(TWO_FILES);
    expect(chunks).toHaveLength(2);

    diff.files.forEach((file) => {
      const chunk = chunks.find((c) => c.path === file.path);
      expect(chunk, `缺少 ${file.path} 的段落`).toBeDefined();
      const expected = diffStats(parseUnifiedDiff(chunk?.chunk ?? ""));
      expect(file.additions).toBe(expected.added);
      expect(file.deletions).toBe(expected.removed);
      // 徽标上显示的 `+N/-N` 与折叠后展开的内容必须一致。
      expect(file.additions + file.deletions).toBe(expected.added + expected.removed);
    });

    expect(diff.files[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(diff.files[1]).toMatchObject({ additions: 2, deletions: 0 });
  });

  it("总计采信服务端 stats，并带上 base/head commit", () => {
    // `stats` 是 base..head 上算的，比前端从文本求和更接近"这个 PR 改了多少"。
    const diff = toPullRequestDiff(payload());
    expect(diff.additions).toBe(4);
    expect(diff.deletions).toBe(1);
    expect(diff.filesChanged).toBe(2);
    expect(diff.baseCommit).toBe("aaaa1111");
    expect(diff.headCommit).toBe("bbbb2222");
  });

  it("重命名文件带 oldPath，其余文件的 oldPath 一律为 null", () => {
    // 契约里 old_path 只在 renamed 时非空；照抄它会让删除文件也画出改名箭头。
    const diff = toPullRequestDiff(
      payload({
        diff: [
          "diff --git a/old/name.ts b/new/name.ts",
          "similarity index 90%",
          "rename from old/name.ts",
          "rename to new/name.ts",
          "--- a/old/name.ts",
          "+++ b/new/name.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
        files: [
          {
            status: "renamed",
            path: "new/name.ts",
            old_path: "old/name.ts",
            status_code: "R",
          },
        ],
      }),
    );

    expect(diff.files[0]).toMatchObject({
      path: "new/name.ts",
      oldPath: "old/name.ts",
      status: "renamed",
      statusCode: "R",
      additions: 1,
      deletions: 1,
    });
  });
});

describe("toPullRequestDiff 与文本不匹配的文件", () => {
  it("files[] 里有、diff 文本里没有段落（二进制）时保留该条，hunks 为空", () => {
    // 二进制文件根本不产出文本 diff。把这条记录丢掉的话，用户会以为
    // "这个 PR 只改了一个文件"，而统计里明明写着两个。
    const diff = toPullRequestDiff(
      payload({
        diff: [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
        files: [
          { status: "modified", path: "src/app.ts", old_path: null, status_code: "M" },
          { status: "modified", path: "assets/logo.png", old_path: null, status_code: "M" },
        ],
        stats: { files_changed: 2, additions: 1, deletions: 1, total_changes: 2 },
      }),
    );

    expect(diff.files.map((f) => f.path)).toEqual(["src/app.ts", "assets/logo.png"]);
    expect(diff.files[0].hunks).toHaveLength(1);
    expect(diff.files[1].hunks).toEqual([]);
    expect(diff.files[1].additions).toBe(0);
    expect(diff.files[1].deletions).toBe(0);
  });

  it("段落被标记为二进制时 binary 为 true 且不给 hunk", () => {
    // 二进制没有可着色内容，渲染 hunk 只会得到一块空白。
    const diff = toPullRequestDiff(
      payload({
        diff: [
          "diff --git a/logo.png b/logo.png",
          "index 000..111 100644",
          "Binary files a/logo.png and b/logo.png differ",
        ].join("\n"),
        files: [{ status: "modified", path: "logo.png", old_path: null, status_code: "M" }],
      }),
    );

    expect(diff.files[0]).toMatchObject({ path: "logo.png", binary: true, hunks: [] });
    expect(diff.files[0].additions).toBe(0);
    expect(diff.files[0].deletions).toBe(0);
  });

  it("段落按路径对不上时退回顺序配对，内容不丢", () => {
    // 匹配失败就丢段落的话，界面会显示"文件被改了"却一行差异都没有。
    const diff = toPullRequestDiff(
      payload({
        diff: [
          "diff --git a/dir/one.ts b/dir/one.ts",
          "--- a/dir/one.ts",
          "+++ b/dir/one.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
        // 服务端回的是相对仓库根的路径，文本里却带了别的写法：按路径配不上。
        files: [{ status: "modified", path: "one.ts", old_path: null, status_code: "M" }],
      }),
    );

    expect(diff.files[0].path).toBe("one.ts");
    expect(diff.files[0].hunks).toHaveLength(1);
    expect(diff.files[0].additions).toBe(1);
  });
});

describe("toPullRequestDiff 对特殊路径的处理", () => {
  it("删除文件（`+++ /dev/null`）的 path 取旧路径", () => {
    // 删除文件的"当前路径"就是它被删前的路径；取不到就等于界面上少一个文件，
    // 而 `/dev/null` 从来不是用户能操作的路径。
    const diff = toPullRequestDiff(
      payload({
        diff: [
          "diff --git a/legacy/old.ts b/legacy/old.ts",
          "deleted file mode 100644",
          "index 3f9c1a2..0000000",
          "--- a/legacy/old.ts",
          "+++ /dev/null",
          "@@ -1,2 +0,0 @@",
          "-gone one",
          "-gone two",
        ].join("\n"),
        files: [{ status: "deleted", path: "legacy/old.ts", old_path: null, status_code: "D" }],
        stats: { files_changed: 1, additions: 0, deletions: 2, total_changes: 2 },
      }),
    );

    expect(diff.files[0]).toMatchObject({
      path: "legacy/old.ts",
      oldPath: null,
      status: "deleted",
      statusCode: "D",
      additions: 0,
      deletions: 2,
    });
  });

  it("路径含空格时不截断（`diff --git a/X b/Y` 按空白切是歧义的）", () => {
    // 路径从 `+++ b/<path>` 行取：那里只有一个路径，没有切点歧义。
    // 若从 `diff --git` 行按空白切，`docs/my notes.md` 会被截成 `docs/my`，
    // 于是清单里的这个文件永远配不上段落，界面上它一行差异都没有。
    const diff = toPullRequestDiff(
      payload({
        diff: [
          "diff --git a/docs/my notes.md b/docs/my notes.md",
          "index 111..222 100644",
          "--- a/docs/my notes.md",
          "+++ b/docs/my notes.md",
          "@@ -1,2 +1,3 @@",
          " # 标题",
          "+补充说明",
          " 结尾",
        ].join("\n"),
        files: [
          { status: "modified", path: "docs/my notes.md", old_path: null, status_code: "M" },
        ],
      }),
    );

    expect(diff.files[0].path).toBe("docs/my notes.md");
    expect(diff.files[0].hunks).toHaveLength(1);
    expect(diff.files[0].additions).toBe(1);
  });

  it("含空格的路径在 splitDiffByFile 里同样完整", () => {
    const chunks = splitDiffByFile(
      [
        "diff --git a/docs/my notes.md b/docs/my notes.md",
        "--- a/docs/my notes.md",
        "+++ b/docs/my notes.md",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/b.txt b/b.txt",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -1 +1 @@",
        "-c",
        "+d",
      ].join("\n"),
    );

    expect(chunks.map((c) => c.path)).toEqual(["docs/my notes.md", "b.txt"]);
  });
});

describe("splitDiffByFile 的切段规则", () => {
  it("hunk 内以 `--` 开头的内容行不会被当成文件头切开", () => {
    // 这是 `unified-diff.ts` 里同一个坑的另一半：被删除的 SQL/Lua 注释在 diff
    // 里正是 `--- 注释`，按 `--- ` 前缀切段会把它当成下一个文件的 `--- a/x`，
    // 于是当前文件被劈成两段、后续内容整段丢失。段边界只能由 `diff --git` 行
    // 认定，而且只在 hunk 行数读满之后才认。
    const raw = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,4 +1,3 @@",
      " -- 保留的注释",
      " select 1;",
      "--- 被删掉的注释",
      " select 2;",
      "diff --git a/r.sql b/r.sql",
      "--- a/r.sql",
      "+++ b/r.sql",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");

    const chunks = splitDiffByFile(raw);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.path)).toEqual(["q.sql", "r.sql"]);
    // 第一个段落里那两行注释都还在，且第二个段落只有它自己的 hunk。
    expect(chunks[0].chunk).toContain("-- 保留的注释");
    expect(chunks[0].chunk).toContain("-- 被删掉的注释");
    expect(chunks[1].chunk).not.toContain("select 1;");
    expect(diffStats(parseUnifiedDiff(chunks[0].chunk))).toEqual({ added: 0, removed: 1 });
  });

  it("段落文本保留 `diff --git` 头（二进制标记就在头区段里）", () => {
    // 去掉头区段的话，`Binary files ...` 会一起丢，后续解析会把二进制文件
    // 当成"没有差异"的文本文件。
    const chunks = splitDiffByFile(
      ["diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ"].join(
        "\n",
      ),
    );

    expect(chunks[0].path).toBe("logo.png");
    expect(parseUnifiedDiff(chunks[0].chunk).binary).toBe(true);
  });

  it("空文本与纯空白给空数组", () => {
    expect(splitDiffByFile("")).toEqual([]);
    expect(splitDiffByFile("   \n\n")).toEqual([]);
  });
});

describe("toPullRequestDiff 的空输入", () => {
  it("null / undefined / 非对象都返回同一个安全空结果，不抛错", () => {
    // 详情页有一条脏数据不该白屏；形状固定也让调用方不必到处判空。
    const empty = {
      files: [],
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      baseCommit: null,
      headCommit: null,
    };

    for (const raw of [null, undefined, 42, "diff", [], true]) {
      expect(toPullRequestDiff(raw)).toEqual(empty);
    }
  });

  it("`{}` 与「空 diff + 空清单 + 零统计」都是安全空结果", () => {
    expect(toPullRequestDiff({})).toEqual({
      files: [],
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      baseCommit: null,
      headCommit: null,
    });

    expect(
      toPullRequestDiff({
        diff: "",
        files: [],
        stats: { files_changed: 0, additions: 0, deletions: 0, total_changes: 0 },
      }),
    ).toEqual({
      files: [],
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      baseCommit: null,
      headCommit: null,
    });
  });

  it("空 diff 但清单非空时，条目全保留且计数为零", () => {
    // "这个 PR 没有文本差异"是正常状态（例如只有二进制改动），
    // 文件列表仍要显示出来。
    const diff = toPullRequestDiff(
      payload({
        diff: "",
        stats: { files_changed: 2, additions: 0, deletions: 0, total_changes: 0 },
      }),
    );

    expect(diff.files.map((f) => f.path)).toEqual(["src/app.ts", "src/new.ts"]);
    expect(diff.files.every((f) => f.hunks.length === 0)).toBe(true);
    expect(diff.files.every((f) => f.additions === 0 && f.deletions === 0)).toBe(true);
    expect(diff.filesChanged).toBe(2);
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
  });

  it("files[] 与 stats 都缺失时按 diff 文本自己列文件", () => {
    // 只剩文本也要能渲染：丢掉等于详情页一片空白。
    const diff = toPullRequestDiff({ diff: TWO_FILES });

    expect(diff.files.map((f) => f.path)).toEqual(["src/app.ts", "src/new.ts"]);
    expect(diff.files.map((f) => f.status)).toEqual(["unknown", "unknown"]);
    expect(diff.files.map((f) => f.statusCode)).toEqual(["?", "?"]);
    expect(diff.filesChanged).toBe(2);
    expect(diff.additions).toBe(4);
    expect(diff.deletions).toBe(1);
  });
});

describe("toPullRequestDiff 的统计兜底", () => {
  it("stats 缺失时用逐文件 hunk 求和", () => {
    // 总数与逐文件之和必须同源，否则会出现"文件里 3 行改动、顶上写着 5 行"。
    const diff = toPullRequestDiff(payload({ stats: undefined }));

    expect(diff.additions).toBe(4);
    expect(diff.deletions).toBe(1);
    expect(diff.filesChanged).toBe(2);
  });

  it("stats 字段不成立（负数/非数字）时按逐文件之和兜底", () => {
    // 负行数在界面上会渲染成 `+-3`；非数字则什么也渲染不出来。
    const diff = toPullRequestDiff(
      payload({ stats: { files_changed: -1, additions: "很多", deletions: -2 } }),
    );

    expect(diff.additions).toBe(4);
    expect(diff.deletions).toBe(1);
    expect(diff.filesChanged).toBe(2);
  });

  it("数字形式的字符串计数仍被采信（服务端历史行为）", () => {
    const diff = toPullRequestDiff(
      payload({ stats: { files_changed: "2", additions: "4", deletions: "1" } }),
    );

    expect(diff).toMatchObject({ additions: 4, deletions: 1, filesChanged: 2 });
  });
});

describe("prDiffKeys 与 PRDiffRequestError", () => {
  it("diff 键落在 pulls 缓存域里，按仓库与编号各自成槽", () => {
    // 与 PR 详情共享 `["pulls", repo]` 前缀：按仓库前缀统一失效时两者一起刷新。
    expect(prDiffKeys.diff("repo-1", 3)).toEqual(["pulls", "repo-1", "diff", 3]);
    expect(prDiffKeys.diff("repo-1", 3)).not.toEqual(prDiffKeys.diff("repo-1", 4));
    expect(prDiffKeys.diff("repo-1", 3)).not.toEqual(prDiffKeys.diff("repo-2", 3));
  });

  it("错误保留 HTTP 状态码供界面判定，且是 Error 实例", () => {
    const error = new PRDiffRequestError(403);
    expect(error.status).toBe(403);
    expect(error.name).toBe("PRDiffRequestError");
    expect(error.message).toContain("403");
    expect(error).toBeInstanceOf(Error);
  });
});
