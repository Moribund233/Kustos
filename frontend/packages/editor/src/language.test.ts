import { describe, expect, it } from "vitest";
import { languages } from "@codemirror/language-data";

import { detectLanguage } from "./language";

/**
 * 语言识别与 CodeMirror 语言包的对接。
 *
 * 这里锁住一个真实踩过的坑：`detectLanguage` 按常见写法返回小写标识
 * （"python"），而 `@codemirror/language-data` 的 `languages[].name` 用
 * 展示名（"Python"）。直接 `===` 比较永远匹配不上，语法高亮静默失效——
 * 界面上只是没颜色，不报错，也不抛异常。
 */

/** 与 code-view.tsx 中相同的匹配规则。 */
function findLanguage(id: string) {
  const wanted = id.toLowerCase();
  return languages.find((item) => item.name.toLowerCase() === wanted);
}

describe("detectLanguage", () => {
  it("识别常见扩展名", () => {
    const cases: [string, string][] = [
      ["src/caret.ts", "typescript"],
      ["src/caret.tsx", "tsx"],
      ["main.go", "go"],
      ["greet.py", "python"],
      ["lib.rs", "rust"],
      ["index.jsx", "jsx"],
      ["styles.css", "css"],
      ["README.md", "markdown"],
      ["config.yaml", "yaml"],
      ["Cargo.toml", "toml"],
      ["package.json", "json"],
      ["run.sh", "shell"],
    ];
    for (const [path, want] of cases) {
      expect(detectLanguage(path), path).toBe(want);
    }
  });

  it("按文件名识别无扩展名的文件", () => {
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("Makefile")).toBe("makefile");
  });

  it("无法识别时返回 text", () => {
    expect(detectLanguage("LICENSE")).toBe("text");
    expect(detectLanguage("data.unknownext")).toBe("text");
  });
});

describe("语言包匹配", () => {
  it("每个检测结果都必须能在语言包里找到对应项", () => {
    // 只断言那些 CodeMirror 确实提供语言包的类型。
    const mustMatch = [
      "src/caret.ts",
      "src/caret.tsx",
      "main.go",
      "greet.py",
      "lib.rs",
      "index.jsx",
      "styles.css",
      "README.md",
      "config.yaml",
    ];
    for (const path of mustMatch) {
      const id = detectLanguage(path);
      expect(findLanguage(id), `${path} → ${id} 没有对应的语言包`).toBeDefined();
    }
  });

  it("大小写不敏感：小写标识能匹配到展示名", () => {
    // 这三组是大小写差异最典型的情况。
    expect(findLanguage("python")?.name).toBe("Python");
    expect(findLanguage("typescript")?.name).toBe("TypeScript");
    expect(findLanguage("go")?.name).toBe("Go");
  });

  it("严格比较会匹配失败——这正是修复前的行为", () => {
    const strict = languages.find((item) => item.name === detectLanguage("greet.py"));
    expect(strict).toBeUndefined();
  });
});
