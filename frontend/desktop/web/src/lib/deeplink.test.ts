import { describe, expect, it } from "vitest";

import { asDeeplinkSurface } from "./deeplink";

/**
 * 深链落屏只认白名单：Go 侧已校验过一次，这边再收一次是防"绑定层与前端
 * 版本不一致"。未知值必须丢弃而不是猜一个分区——悄悄打开 Inbox 会让人
 * 以为链接生效了。
 */
describe("asDeeplinkSurface", () => {
  it("认得的五个分区都放行", () => {
    expect(asDeeplinkSurface("inbox")).toBe("inbox");
    expect(asDeeplinkSurface("working-copy")).toBe("working-copy");
    expect(asDeeplinkSurface("code")).toBe("code");
    expect(asDeeplinkSurface("pulls")).toBe("pulls");
    expect(asDeeplinkSurface("issues")).toBe("issues");
  });

  it("空值不放行", () => {
    expect(asDeeplinkSurface("")).toBeNull();
    expect(asDeeplinkSurface(null)).toBeNull();
    expect(asDeeplinkSurface(undefined)).toBeNull();
  });

  it("未知分区不放行，也不做大小写或近义猜测", () => {
    expect(asDeeplinkSurface("settings")).toBeNull();
    expect(asDeeplinkSurface("Code")).toBeNull();
    expect(asDeeplinkSurface("working-copy ")).toBeNull();
    expect(asDeeplinkSurface("kustos://code")).toBeNull();
  });
});
