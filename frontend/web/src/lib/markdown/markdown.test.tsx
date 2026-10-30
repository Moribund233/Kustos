import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./markdown";

/**
 * 提及高亮的行为。
 *
 * 这些用例守的是同一件事：提及的着色作用于已解析的文档结构，而不是
 * 切分源文。早先的实现在渲染前按 `@kustos-agent` 切字符串、逐段渲染，
 * 于是提及出现在结构内部时会把 Markdown 语法切断——加粗断成字面星号、
 * 代码块围栏不配对、列表被拆成两段。
 */
describe("Markdown 的提及高亮", () => {
  it("加粗里的提及不破坏强调语法", () => {
    const { container } = render(<Markdown content="**@kustos-agent** 请看一下" mentions />);

    const mention = container.querySelector(".kustos-mention");
    expect(mention?.textContent).toBe("@kustos-agent");
    // 胶囊嵌在 strong 内，说明结构保留而不是被切成三段
    expect(mention?.parentElement?.tagName).toBe("STRONG");
    expect(container.textContent).not.toContain("*");
  });

  it("代码块里的提及保持字面量", () => {
    const content = ['```', 'const who = "@kustos-agent";', '```'].join("\n");
    const { container } = render(<Markdown content={content} mentions />);

    expect(container.querySelector(".kustos-mention")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("@kustos-agent");
  });

  it("行内代码里的提及保持字面量", () => {
    const { container } = render(<Markdown content={"写 `@kustos-agent` 呼叫人"} mentions />);

    expect(container.querySelector(".kustos-mention")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("@kustos-agent");
  });

  it("列表项不被拆分", () => {
    const { container } = render(
      <Markdown content={"- 先问 @kustos-agent\n- 再合并"} mentions />,
    );

    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("li .kustos-mention")).not.toBeNull();
  });

  it("匹配不区分大小写", () => {
    const { container } = render(<Markdown content="问 @Kustos-Agent 试试" mentions />);

    expect(container.querySelector(".kustos-mention")?.textContent).toBe("@Kustos-Agent");
  });

  it("未开启 mentions 时保持纯文本", () => {
    const { container } = render(<Markdown content="问 @kustos-agent" />);

    expect(container.querySelector(".kustos-mention")).toBeNull();
    expect(container.textContent).toContain("@kustos-agent");
  });
});
