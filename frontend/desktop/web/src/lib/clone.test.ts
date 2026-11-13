import { describe, expect, it } from "vitest";

import { ClonePhase } from "@/bindings/github.com/kustos/kustos-desktop/internal/git/models";
import { cloneErrorText, clonePhaseLabel, joinPath, repoNameFromURL, samePath } from "./clone";

/**
 * 克隆的纯函数部分。
 *
 * 目标路径算错会直接把仓库拉到意想不到的地方，所以这里对分隔符、`.git` 后缀
 * 与 scp 形式各写一条——这些正是手写字符串拼接最容易漏的分支。
 */

describe("repoNameFromURL", () => {
  it("取 https 地址的末段并去掉 .git", () => {
    expect(repoNameFromURL("https://git.example.com/alice/notes.git")).toBe("notes");
    expect(repoNameFromURL("https://git.example.com/alice/notes")).toBe("notes");
  });

  it("支持结尾带斜杠的地址", () => {
    expect(repoNameFromURL("https://git.example.com/alice/notes.git/")).toBe("notes");
  });

  it("支持 scp 形式", () => {
    expect(repoNameFromURL("git@git.example.com:alice/notes.git")).toBe("notes");
  });

  it("猜不出名字时返回空串", () => {
    expect(repoNameFromURL("")).toBe("");
    expect(repoNameFromURL("   ")).toBe("");
    expect(repoNameFromURL("https://git.example.com/alice/..git")).toBe("");
  });
});

describe("joinPath", () => {
  it("按父目录的分隔符拼接", () => {
    expect(joinPath("/home/me/Kustos", "notes")).toBe("/home/me/Kustos/notes");
    expect(joinPath("C:\\Users\\me\\Kustos", "notes")).toBe("C:\\Users\\me\\Kustos\\notes");
  });

  it("去掉父目录结尾的分隔符，不产生双斜杠", () => {
    expect(joinPath("/home/me/Kustos/", "notes")).toBe("/home/me/Kustos/notes");
    expect(joinPath("C:\\Users\\me\\Kustos\\", "notes")).toBe("C:\\Users\\me\\Kustos\\notes");
  });

  it("父目录为空时返回空串，避免拉到当前工作目录", () => {
    expect(joinPath("", "notes")).toBe("");
    expect(joinPath("   ", "notes")).toBe("");
  });
});

describe("samePath", () => {
  it("斜杠方向与大小写不同也算同一处", () => {
    expect(samePath("C:\\Users\\Me\\Kustos\\notes", "c:/users/me/kustos/notes")).toBe(true);
  });

  it("忽略结尾分隔符", () => {
    expect(samePath("/home/me/notes/", "/home/me/notes")).toBe(true);
  });

  it("不同目录不等价", () => {
    expect(samePath("/home/me/notes", "/home/me/notes2")).toBe(false);
  });
});

describe("clonePhaseLabel", () => {
  const t = (key: string) => key;

  it("每个阶段都有对应文案", () => {
    expect(clonePhaseLabel(ClonePhase.ClonePhaseReceiving, t)).toBe(
      "onboarding.clonePhaseReceiving",
    );
    expect(clonePhaseLabel(ClonePhase.ClonePhaseCheckout, t)).toBe(
      "onboarding.clonePhaseCheckout",
    );
  });

  it("未知阶段回落到开始阶段，不返回空串", () => {
    // 绑定层的枚举会变；崩溃或空白文案都不如一个中性说明。
    expect(clonePhaseLabel("nonsense" as never, t)).toBe("onboarding.clonePhaseStarting");
  });
});

describe("cloneErrorText", () => {
  const t = (key: string) => key;

  it("权限不足换成可操作的提示，且不泄露系统原文", () => {
    const err = new Error(
      "RuntimeError: 创建目录失败: C:\\Users\\me\\Kustos: mkdir C:\\Users\\me\\Kustos: Access is denied.",
    );
    expect(cloneErrorText(err, t)).toBe("onboarding.cloneNoPermission");
    expect(cloneErrorText(new Error("Permission denied"), t)).toBe("onboarding.cloneNoPermission");
    expect(cloneErrorText(new Error("EACCES: errno 13"), t)).toBe(
      "onboarding.cloneNoPermission",
    );
  });

  it("目标目录已有内容时提示换目录", () => {
    expect(cloneErrorText(new Error("目标目录已存在"), t)).toBe("onboarding.cloneTargetExists");
    expect(cloneErrorText(new Error("fatal: destination path already exists"), t)).toBe(
      "onboarding.cloneTargetExists",
    );
  });

  it("没装 git 时指向安装", () => {
    expect(cloneErrorText(new Error("未找到 git 可执行文件"), t)).toBe("onboarding.gitMissing");
    expect(cloneErrorText(new Error("exec: git: executable file not found in %PATH%"), t)).toBe(
      "onboarding.gitMissing",
    );
  });

  it("认不出的失败剥掉运行时前缀后保留原文", () => {
    // 有些失败只有 git 自己说得清，这时候改写反而丢信息。
    expect(cloneErrorText(new Error("RuntimeError: fatal: unable to access the remote"), t)).toBe(
      "fatal: unable to access the remote",
    );
  });

  it("没有消息时给兜底文案，不显示空白", () => {
    expect(cloneErrorText(null, t)).toBe("onboarding.cloneFailedFallback");
    expect(cloneErrorText(new Error(""), t)).toBe("onboarding.cloneFailedFallback");
    // 只有前缀也算没有消息。
    expect(cloneErrorText(new Error("RuntimeError:"), t)).toBe("onboarding.cloneFailedFallback");
  });
});
