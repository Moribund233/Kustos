import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { relativeTime } from "@/lib/relative-time";

/**
 * 相对时间的边界测试。
 *
 * 这一层只做"把时间差映射成哪个文案"，因此断言的是**选中的翻译键与计数**，
 * 不是文案本身：文案会随语言变，键与计数变才是回归。
 *
 * "现在"必须固定：用真实时钟会把边界写死在毫秒级，跑一次绿、下次红。
 * 时钟用 vi 的假时间，不引任何替身库。
 */

const NOW = new Date("2026-05-20T12:00:00.000Z").getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 假翻译函数：把键原样返回，带 count 时拼在键后面，便于断言。 */
function fakeT(): (key: string, opts?: Record<string, unknown>) => string {
  return (key, opts) =>
    opts && "count" in opts ? `${key}#${String(opts.count)}` : key;
}

/** 造一个距离基准时刻 diff 毫秒的时间串（正数表示过去）。 */
function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("relativeTime 的无效输入", () => {
  it("null 与空串返回空串，而不是硬编一句文案", () => {
    expect(relativeTime(null, fakeT())).toBe("");
    expect(relativeTime("", fakeT())).toBe("");
  });

  it("无法解析的字符串返回空串，而不是 Invalid Date", () => {
    for (const raw of [" ", "   ", "not-a-date", "2026-13-01", "1700000000"]) {
      expect(relativeTime(raw, fakeT())).toBe("");
    }
  });

  it("无效输入不调用翻译函数", () => {
    const t = vi.fn(fakeT());
    relativeTime(null, t);
    relativeTime("nonsense", t);
    expect(t).not.toHaveBeenCalled();
  });
});

describe("relativeTime 的过去时间", () => {
  it("一分钟以内是刚刚", () => {
    expect(relativeTime(isoAgo(0), fakeT())).toBe("relativeTime.justNow");
    expect(relativeTime(isoAgo(SECOND), fakeT())).toBe("relativeTime.justNow");
    expect(relativeTime(isoAgo(MINUTE - 1), fakeT())).toBe("relativeTime.justNow");
  });

  it("跨过一分钟改用分钟计数", () => {
    // 边界取闭开区间：刚好 60 秒就已经是"1 分钟前"。
    expect(relativeTime(isoAgo(MINUTE), fakeT())).toBe("relativeTime.minutesAgo#1");
    expect(relativeTime(isoAgo(90 * SECOND), fakeT())).toBe("relativeTime.minutesAgo#1");
    expect(relativeTime(isoAgo(59 * MINUTE + 59 * SECOND), fakeT())).toBe(
      "relativeTime.minutesAgo#59",
    );
  });

  it("跨过一小时改用小时计数，且向下取整", () => {
    expect(relativeTime(isoAgo(HOUR), fakeT())).toBe("relativeTime.hoursAgo#1");
    expect(relativeTime(isoAgo(HOUR + 59 * MINUTE), fakeT())).toBe("relativeTime.hoursAgo#1");
    expect(relativeTime(isoAgo(DAY - 1), fakeT())).toBe("relativeTime.hoursAgo#23");
  });

  it("跨过一天改用天数计数", () => {
    expect(relativeTime(isoAgo(DAY), fakeT())).toBe("relativeTime.daysAgo#1");
    expect(relativeTime(isoAgo(DAY + 23 * HOUR), fakeT())).toBe("relativeTime.daysAgo#1");
    expect(relativeTime(isoAgo(29 * DAY + 23 * HOUR), fakeT())).toBe("relativeTime.daysAgo#29");
  });

  it("超过 30 天改显示绝对日期，不再走翻译键", () => {
    const t = vi.fn(fakeT());
    const iso = isoAgo(30 * DAY);
    const shown = relativeTime(iso, t);

    expect(t).not.toHaveBeenCalled();
    expect(shown).toBe(new Date(iso).toLocaleDateString("zh-CN"));
  });

  it("绝对日期的格式跟着 localeTag 走", () => {
    const iso = isoAgo(400 * DAY);
    const zh = relativeTime(iso, fakeT());
    const en = relativeTime(iso, fakeT(), "en-US");

    // 与平台自身的格式化结果比对，而不是写死 "2026/10/11"：日期格式随 ICU
    // 版本变，写死会让这条用例在换 Node 版本时误报。
    expect(zh).toBe(new Date(iso).toLocaleDateString("zh-CN"));
    expect(en).toBe(new Date(iso).toLocaleDateString("en-US"));

    // 两种语言的日期顺序不同。只有在平台真的给出不同结果时才断言，
    // 避免精简版 ICU 环境下把"格式相同"当成缺陷。
    const expectedZh = new Date(iso).toLocaleDateString("zh-CN");
    const expectedEn = new Date(iso).toLocaleDateString("en-US");
    if (expectedZh !== expectedEn) {
      expect(zh).not.toBe(en);
    }
  });
});

describe("relativeTime 的未来时间", () => {
  it("轻微超前的时钟偏差算刚刚，不显示负数", () => {
    expect(relativeTime(isoAgo(-5 * SECOND), fakeT())).toBe("relativeTime.justNow");
    expect(relativeTime(isoAgo(-59 * SECOND), fakeT())).toBe("relativeTime.justNow");
  });

  it("未来时间不会产生负数计数", () => {
    const shown = relativeTime(isoAgo(-3 * DAY), fakeT());
    expect(shown).not.toMatch(/-\d/);
  });
});

describe("relativeTime 的翻译键契约", () => {
  it("计数通过第二个参数传给翻译函数，而不是拼进键里", () => {
    const t = vi.fn(fakeT());
    relativeTime(isoAgo(5 * MINUTE), t);

    expect(t).toHaveBeenCalledTimes(1);
    expect(t).toHaveBeenCalledWith("relativeTime.minutesAgo", { count: 5 });
  });

  it("四档计数各自用不同的键", () => {
    const keys = [
      relativeTime(isoAgo(10 * SECOND), fakeT()),
      relativeTime(isoAgo(10 * MINUTE), fakeT()),
      relativeTime(isoAgo(10 * HOUR), fakeT()),
      relativeTime(isoAgo(10 * DAY), fakeT()),
    ].map((shown) => shown.split("#")[0]);

    expect(keys).toEqual([
      "relativeTime.justNow",
      "relativeTime.minutesAgo",
      "relativeTime.hoursAgo",
      "relativeTime.daysAgo",
    ]);
  });
});
