import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { setupI18n } from "../../i18n";
import { ToolBody } from "./ToolBody";
import type { TimelineTool } from "../../api";

function item(partial: Partial<TimelineTool>): TimelineTool {
  return {
    kind: "tool",
    key: "k",
    callId: "c",
    tool: "read_file",
    input: {},
    ok: true,
    ...partial,
  };
}

function render(toolItem: TimelineTool): string {
  return renderToStaticMarkup(createElement(ToolBody, { item: toolItem, status: "ok" }));
}

describe("工具行专属展开体", () => {
  beforeAll(() => {
    setupI18n();
  });

  it("edit_file 展开是行 diff", () => {
    const html = render(
      item({
        tool: "edit_file",
        input: { path: "src/a.ts", oldString: "a\nb", newString: "a\nB" },
        output: "Edited a.ts",
        added: 1,
        removed: 1,
      }),
    );
    expect(html).toContain("mc-tv__diffbox");
    expect(html).toContain("b");
    expect(html).not.toContain(">Input<");
  });

  it("ask_user 展开是问题与回答", () => {
    const html = render(
      item({
        tool: "ask_user",
        input: { questions: [{ question: "用哪种风格？", options: ["简洁", "活泼"] }] },
        output: "1. 用哪种风格？\n   → 简洁",
      }),
    );
    expect(html).toContain("用哪种风格？");
    expect(html).toContain("简洁");
    expect(html).toContain("mc-tv__answer");
  });

  it("read_file 展开是带行号正文", () => {
    const html = render(
      item({ tool: "read_file", input: { path: "a.ts" }, output: "1: const a = 1\n2: export {}" }),
    );
    expect(html).toContain("const a = 1");
    expect(html).toContain("mc-tv__codebox");
  });

  it("grep / command / plan / patch 都能渲染", () => {
    const grep = render(
      item({
        tool: "grep",
        input: { pattern: "foo" },
        output: "a.ts:2: foo()",
      }),
    );
    expect(grep).toContain("mc-tv__mark");

    const command = render(
      item({ tool: "run_command", input: { command: "pnpm test" }, output: "ok" }),
    );
    expect(command).toContain("pnpm test");
    expect(command).toContain("data-terminal");

    const plan = render(
      item({
        tool: "update_plan",
        input: { steps: [{ title: "读代码", status: "completed" }] },
      }),
    );
    expect(plan).toContain("读代码");

    const patch = render(
      item({
        tool: "apply_patch",
        input: { patch: "*** Begin Patch\n*** Add File: b.ts\n+hello\n*** End Patch" },
        output: "Patch applied.",
      }),
    );
    expect(patch).toContain("hello");
  });

  it("MCP 工具兜底为参数列表而不是整段 JSON", () => {
    const html = render(
      item({
        tool: "mcp__demo__echo",
        input: { text: "hi", nested: { a: 1 } },
        output: "hi",
      }),
    );
    expect(html).toContain("mc-tv__paramkey");
    expect(html).toContain("text");
    expect(html).toContain("hi");
  });
});
