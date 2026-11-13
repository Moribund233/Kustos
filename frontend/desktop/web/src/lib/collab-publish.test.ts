import { describe, expect, it } from "vitest";

import {
  CollabPublishError,
  emptyPreview,
  toDraftPreview,
  toDraftPublishResult,
} from "./collab-publish";

/**
 * 发布预览的收敛测试。
 *
 * 这一层唯一能脱离网络验证的就是"服务端给的 JSON 变成什么"。它对后果很敏感：
 * 少显示一个文件，用户就可能把没看过的改动 squash 进主分支；多显示一条不存在的
 * 差异，只是让人多点一次确认。所以断言都盯着"字段缺失时怎么退化"。
 */

describe("toDraftPreview", () => {
  it("收敛提交数与逐文件增删", () => {
    const preview = toDraftPreview({
      ahead_by: 3,
      files: [
        { new_path: "docs/a.md", old_path: "docs/a.md", status: "M", additions: 4, deletions: 1 },
        { new_path: "src/b.ts", old_path: "src/b.ts", status: "A", additions: 10, deletions: 0 },
      ],
      stats: { files_changed: 2, additions: 14, deletions: 1 },
    });
    expect(preview.commitCount).toBe(3);
    expect(preview.files.map((f) => f.path)).toEqual(["docs/a.md", "src/b.ts"]);
    expect(preview.additions).toBe(14);
    expect(preview.deletions).toBe(1);
    expect(preview.missingDraft).toBe(false);
  });

  it("删除的文件取旧路径", () => {
    const preview = toDraftPreview({
      files: [{ old_path: "gone.md", new_path: null, status: "D", additions: 0, deletions: 7 }],
    });
    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]?.path).toBe("gone.md");
    expect(preview.files[0]?.status).toBe("D");
  });

  it("两个路径都没有的条目被丢掉", () => {
    const preview = toDraftPreview({ files: [{ status: "M" }, { new_path: "keep.md" }] });
    expect(preview.files.map((f) => f.path)).toEqual(["keep.md"]);
  });

  it("没有 stats 时按文件累加", () => {
    const preview = toDraftPreview({
      files: [
        { new_path: "a", additions: 2, deletions: 1 },
        { new_path: "b", additions: 3, deletions: 4 },
      ],
    });
    expect(preview.additions).toBe(5);
    expect(preview.deletions).toBe(5);
  });

  it("形状不对时退回空预览，而不是抛异常", () => {
    expect(toDraftPreview(null)).toEqual(emptyPreview());
    expect(toDraftPreview("nope")).toEqual(emptyPreview());
    expect(toDraftPreview({ ahead_by: -4, files: "nope" })).toEqual(emptyPreview());
  });

  it("负数与非法增删归零", () => {
    const preview = toDraftPreview({
      files: [{ new_path: "a", additions: -3, deletions: Number.NaN }],
    });
    expect(preview.additions).toBe(0);
    expect(preview.deletions).toBe(0);
  });
});

describe("toDraftPublishResult", () => {
  it("收敛提交、分支与路径", () => {
    expect(
      toDraftPublishResult({ commit_id: "abc123", branch: "main", paths: ["a.md", "b.ts"] }),
    ).toEqual({ commitId: "abc123", branch: "main", paths: ["a.md", "b.ts"] });
  });

  it("没有待发布内容时 commit_id 为 null、路径为空", () => {
    expect(toDraftPublishResult({ commit_id: null, branch: "main", paths: [] })).toEqual({
      commitId: null,
      branch: "main",
      paths: [],
    });
  });

  it("路径里的非字符串被滤掉", () => {
    expect(toDraftPublishResult({ paths: ["a", 1, null, ""] }).paths).toEqual(["a"]);
  });

  it("形状不对时不抛异常", () => {
    expect(toDraftPublishResult(undefined)).toEqual({ commitId: null, branch: "", paths: [] });
  });
});

describe("CollabPublishError", () => {
  it("保留状态码与错误码，供界面区分冲突与权限", () => {
    const err = new CollabPublishError("publish", 400, "collab_publish_conflict", "请先解决冲突");
    expect(err.status).toBe(400);
    expect(err.code).toBe("collab_publish_conflict");
    expect(err.detail).toBe("请先解决冲突");
    expect(err.message).toContain("collab_publish_conflict");
  });
});
