import { describe, expect, it } from "vitest";

import { matchRepository, parseRemoteSlug } from "./remote-slug.ts";
import type { Repository } from "./repos.ts";

/**
 * remote 地址解析与仓库匹配的边界测试。
 *
 * 这两段是纯逻辑，也是"本机工作副本 ↔ 服务端仓库"唯一的桥梁：解析错了，
 * PR/Issue 面就会拿着一个必然 404 的 repo_id 去请求，表现为空白列表，
 * 而不是一条能定位的错误。
 */

describe("parseRemoteSlug", () => {
  it("解析 https 形态并去掉 .git 后缀", () => {
    expect(parseRemoteSlug("https://kustos.example.com/octo/kustos.git")).toEqual({
      owner: "octo",
      name: "kustos",
    });
  });

  it("解析不带 .git 后缀的 https 地址", () => {
    expect(parseRemoteSlug("https://kustos.example.com/octo/kustos")).toEqual({
      owner: "octo",
      name: "kustos",
    });
  });

  it("解析 ssh:// 形态，端口不参与路径", () => {
    expect(parseRemoteSlug("ssh://git@kustos.example.com:2222/octo/kustos.git")).toEqual({
      owner: "octo",
      name: "kustos",
    });
  });

  it("解析 scp 风格：冒号是分隔符而不是端口", () => {
    expect(parseRemoteSlug("git@kustos.example.com:octo/kustos.git")).toEqual({
      owner: "octo",
      name: "kustos",
    });
  });

  it("自托管子路径下只取最后两段", () => {
    // 服务端的 Repository.path 恒为 owner/repo 两段，多出来的前缀对不上号。
    expect(parseRemoteSlug("https://host/git/octo/kustos.git")).toEqual({
      owner: "octo",
      name: "kustos",
    });
  });

  it("末尾斜杠与空白不影响结果", () => {
    expect(parseRemoteSlug("  https://host/octo/kustos.git/  ".trim())).toEqual({
      owner: "octo",
      name: "kustos",
    });
  });

  it("空值与无法识别的输入返回 null", () => {
    expect(parseRemoteSlug("")).toBeNull();
    expect(parseRemoteSlug("   ")).toBeNull();
    expect(parseRemoteSlug(null)).toBeNull();
    expect(parseRemoteSlug(undefined)).toBeNull();
  });

  it("路径层级不足时返回 null，不猜", () => {
    expect(parseRemoteSlug("https://host/onlyname.git")).toBeNull();
    expect(parseRemoteSlug("no-colon-and-no-scheme")).toBeNull();
  });
});

describe("matchRepository", () => {
  const repos: Repository[] = [
    {
      id: "1",
      name: "kustos",
      path: "octo/kustos",
      description: null,
      isPublic: true,
      defaultBranch: "main",
      isArchived: false,
      createdAt: null,
      updatedAt: null,
    },
    {
      id: "2",
      name: "kustos",
      path: "other/kustos",
      description: null,
      isPublic: true,
      defaultBranch: "main",
      isArchived: false,
      createdAt: null,
      updatedAt: null,
    },
  ];

  it("按完整 path 精确匹配，大小写不敏感", () => {
    const { matched, ambiguous } = matchRepository(repos, { owner: "OCTO", name: "Kustos" });
    expect(ambiguous).toBe(false);
    expect(matched?.id).toBe("1");
  });

  it("名字有多个同名仓库且 owner 对不上时不猜，报歧义", () => {
    // 宁可空手让用户去选，也不猜一个可能错的仓库。
    const { matched, ambiguous } = matchRepository(repos, { owner: "nobody", name: "kustos" });
    expect(matched).toBeNull();
    expect(ambiguous).toBe(true);
  });

  it("唯一同名命中时按名字兜底", () => {
    const single: Repository[] = [repos[0]];
    const { matched, ambiguous } = matchRepository(single, { owner: "renamed", name: "kustos" });
    expect(ambiguous).toBe(false);
    expect(matched?.id).toBe("1");
  });

  it("slug 为空时不做匹配", () => {
    expect(matchRepository(repos, null)).toEqual({ matched: null, ambiguous: false });
  });

  it("没有命中时既不算匹配也不算歧义", () => {
    const { matched, ambiguous } = matchRepository(repos, { owner: "x", name: "y" });
    expect(matched).toBeNull();
    expect(ambiguous).toBe(false);
  });
});
