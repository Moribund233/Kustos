import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Chip } from "./kit";

/* vitest 没开 globals，RTL 依赖 afterEach 全局钩子的自动清理不生效：
   不显式注册的话，前一条用例的 DOM 会留到下一条，按 role+name 查询就
   会撞到多个元素。 */
afterEach(cleanup);

/**
 * Chip 是一个开关式筛选胶囊，激活与否原先只体现在配色上。
 * `aria-pressed` 是它唯一的语义出口，删掉就等于把状态藏起来了。
 */
describe("Chip", () => {
  it("激活时向读屏播报已按下", () => {
    render(<Chip active>只看草稿</Chip>);

    expect(screen.getByRole("button", { name: "只看草稿" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("未激活时播报未按下", () => {
    render(<Chip>只看草稿</Chip>);

    expect(screen.getByRole("button", { name: "只看草稿" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
