import { describe, expect, it } from "vitest";
import { highlightHtml, highlightToLines, languageForFile } from "./code-highlight";

describe("languageForFile", () => {
  it("按扩展名映射语言，无扩展名文件按文件名识别", () => {
    expect(languageForFile("src/App.tsx")).toBe("typescript");
    expect(languageForFile("package.json")).toBe("json");
    expect(languageForFile("lib.rs")).toBe("rust");
    expect(languageForFile("Dockerfile")).toBe("dockerfile");
    expect(languageForFile("Makefile")).toBe("makefile");
    expect(languageForFile("README")).toBeUndefined();
  });
});

describe("highlightHtml", () => {
  it("已知语言产出 hljs-* 着色 span，内容被转义", () => {
    const html = highlightHtml('const a = "x";', "a.ts");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-string");
    expect(html).not.toContain('<script');
  });

  it("显式语言 id 直接生效（Markdown language-* 类场景）", () => {
    const html = highlightHtml('{"a":1}', "json");
    expect(html).toContain("hljs-attr");
  });

  it("识别不出语言时回退纯转义（无 span）", () => {
    const html = highlightHtml("plain text <>&", "x.unknownext");
    expect(html).not.toContain("<span");
    expect(html).toContain("&lt;&gt;&amp;");
  });
});

describe("highlightToLines", () => {
  it("node 环境（无 DOMParser）退回逐行纯转义，行数与源一致", () => {
    const code = "const a = 1;\nconst b = 2;\n";
    const lines = highlightToLines(code, "a.ts");
    expect(lines).toHaveLength(3);
    expect(lines[0]).not.toContain("<span"); // node 环境无 DOMParser：纯文本
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
  });

  it("超长文本不进高亮管线，逐行转义", () => {
    const big = "x".repeat(600 * 1024);
    const lines = highlightToLines(big, "a.ts");
    expect(lines).toHaveLength(1);
  });
});
