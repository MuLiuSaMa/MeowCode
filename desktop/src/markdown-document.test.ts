// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdownDocument } from "./markdown-document";

const render = (markdown: string) => renderMarkdownDocument(markdown).html;

describe("markdown document renderer", () => {
  it("renders inline and display KaTeX with MathML intact", () => {
    const html = render(
      "行内公式 $E = mc^2$ 与块级公式：\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n",
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain("katex-display");
    // MathML 是 KaTeX 的辅助输出；消毒不能把它整段删掉
    expect(html).toContain("<math");
  });

  it("supports bracket and environment delimiters", () => {
    const html = render(
      "\\(a^2+b^2=c^2\\)\n\n\\[\\sum_{i=1}^n i\\]\n\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n",
    );
    expect((html.match(/class="katex"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps raw HTML tags but removes scripts, handlers and global styles", () => {
    const html = render(
      [
        '<details open><summary>更多</summary><kbd>Ctrl</kbd> + <mark>K</mark></details>',
        '<p align="center"><img src="https://example.com/a.png" alt="badge"></p>',
        '<p onclick="alert(1)">safe</p>',
        "<script>alert(1)</script>",
        "<style>body{display:none}</style>",
      ].join("\n\n"),
    );
    expect(html).toContain("<details");
    expect(html).toContain("<summary>更多</summary>");
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<mark>K</mark>");
    expect(html).toContain('align="center"');
    expect(html).toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<style");
  });

  it("renders GFM tables, task lists, footnotes and alerts", () => {
    const html = render(
      [
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "Text[^1]",
        "",
        "[^1]: note",
        "",
        "> [!WARNING]",
        "> careful",
      ].join("\n"),
    );
    expect(html).toContain("<table");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("footnote-ref");
    expect(html).toContain("footnotes");
    expect(html).toContain("markdown-alert-warning");
  });

  it("highlights fenced code and strips frontmatter", () => {
    const html = render("---\ntitle: demo\ntags: [a, b]\n---\n\n```ts\nconst answer = 42;\n```\n");
    expect(html).not.toContain("title: demo");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("answer");
  });

  it("renders a large batch of formulas", () => {
    const markdown = Array.from(
      { length: 300 },
      (_, index) => `第 ${index} 条：$a_{${index}} + b_{${index}} = c_{${index}}$`,
    ).join("\n\n");
    const html = render(markdown);
    expect((html.match(/class="katex"/g) ?? []).length).toBeGreaterThanOrEqual(300);
  });
});
