import { describe, expect, it } from "vitest";

import {
  instanceTooOld,
  onboardingState,
  stepState,
  type OnboardingInput,
} from "./onboarding";

/**
 * 引导流程的判定。
 *
 * 这些断言的价值在于**锁住"什么时候解锁下一步"**：界面上看不出来的错误
 * （比如登录框在实例连不上时仍然可点）只能靠这里挡住。
 */

/** 一份"一切就绪"的输入，各用例只覆盖自己关心的字段。 */
const ready: OnboardingInput = {
  reachable: true,
  tooOld: false,
  loggedIn: true,
  hasWorkingCopy: true,
  cloneSkipped: false,
};

describe("onboardingState", () => {
  it("实例连不上时停在第一步，登录框不可用", () => {
    const state = onboardingState({ ...ready, reachable: false, loggedIn: false });
    expect(state.step).toBe("connect");
    expect(state.loginEnabled).toBe(false);
    expect(state.ready).toBe(false);
    expect(state.canSkipClone).toBe(false);
  });

  it("版本过旧与连不上等价：都停在第一步", () => {
    const state = onboardingState({ ...ready, tooOld: true, loggedIn: false });
    expect(state.step).toBe("connect");
    expect(state.loginEnabled).toBe(false);
  });

  it("实例可用但没登录时停在第二步", () => {
    const state = onboardingState({ ...ready, loggedIn: false });
    expect(state.step).toBe("login");
    expect(state.loginEnabled).toBe(true);
    // 还没登录就不该给"跳过克隆"——那会绕过登录。
    expect(state.canSkipClone).toBe(false);
    expect(state.ready).toBe(false);
  });

  it("登录后默认落到克隆这一步", () => {
    const state = onboardingState({ ...ready, hasWorkingCopy: false });
    expect(state.step).toBe("clone");
    expect(state.canSkipClone).toBe(true);
    // 还没克隆也没跳过，流程不算走完。
    expect(state.ready).toBe(false);
  });

  it("有了工作副本即完成", () => {
    const state = onboardingState(ready);
    expect(state.step).toBe("clone");
    expect(state.ready).toBe(true);
  });

  it("跳过克隆也算完成", () => {
    const state = onboardingState({ ...ready, hasWorkingCopy: false, cloneSkipped: true });
    expect(state.ready).toBe(true);
  });
});

describe("stepState", () => {
  it("停在第一步时：第一步展开，后两步锁定", () => {
    const state = onboardingState({ ...ready, reachable: false, loggedIn: false });
    expect(stepState(state, "connect")).toBe("active");
    expect(stepState(state, "login")).toBe("locked");
    expect(stepState(state, "clone")).toBe("locked");
  });

  it("停在第二步时：第一步已完成", () => {
    const state = onboardingState({ ...ready, loggedIn: false });
    expect(stepState(state, "connect")).toBe("done");
    expect(stepState(state, "login")).toBe("active");
    expect(stepState(state, "clone")).toBe("locked");
  });

  it("停在第三步时：前两步都已完成", () => {
    const state = onboardingState({ ...ready, hasWorkingCopy: false });
    expect(stepState(state, "connect")).toBe("done");
    expect(stepState(state, "login")).toBe("done");
    expect(stepState(state, "clone")).toBe("active");
  });

  it("全部走完后三步都是已完成", () => {
    const state = onboardingState(ready);
    expect(stepState(state, "connect")).toBe("done");
    expect(stepState(state, "login")).toBe("done");
    expect(stepState(state, "clone")).toBe("done");
  });
});

describe("instanceTooOld", () => {
  it("契约最低版本是 v1 时不算过旧", () => {
    expect(instanceTooOld({ apiCompat: { apiMin: "v1" } })).toBe(false);
  });

  it("契约最低版本高于 v1 时算过旧", () => {
    expect(instanceTooOld({ apiCompat: { apiMin: "v2" } })).toBe(true);
  });

  it("没有契约信息时按兼容处理，不拦用户", () => {
    expect(instanceTooOld({})).toBe(false);
    expect(instanceTooOld({ apiCompat: null })).toBe(false);
    expect(instanceTooOld({ apiCompat: { apiMin: "" } })).toBe(false);
  });
});
