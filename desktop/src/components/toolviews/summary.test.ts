import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TFunction } from "i18next";
import i18n from "i18next";
import { setupI18n } from "../../i18n";
import type { TimelineTool } from "../../api";
import { ToolRow } from "../ToolRow";
import { toolSummary } from "./summary";

function tool(overrides: Partial<TimelineTool>): TimelineTool {
  return {
    kind: "tool",
    key: "k",
    callId: "c",
    tool: "read_file",
    input: {},
    ok: true,
    ...overrides,
  };
}

describe("工具行右侧摘要", () => {
  let t: TFunction;

  beforeAll(async () => {
    setupI18n();
    await i18n.changeLanguage("zh-CN");
    t = i18n.getFixedT("zh-CN", "chat");
  });

  it("读取文件显示行数", () => {
    expect(
      toolSummary(tool({ tool: "read_file", input: { path: "a.ts" }, output: "1: a\n2: b\n3: c" }), "ok", t),
    ).toBe("3 行");
  });

  it("没有结果时不给摘要（运行中只看参数）", () => {
    expect(toolSummary(tool({ tool: "read_file", input: { path: "a.ts" } }), "running", t)).toBeUndefined();
  });

  it("查看目录显示条目数", () => {
    const output = "dir src\nfile package.json\nfile README.md";
    expect(toolSummary(tool({ tool: "list_dir", input: { path: "." }, output }), "ok", t)).toBe("3 项");
  });

  it("批量读取显示文件数与总行数", () => {
    const output = "=== a.ts ===\n1: a\n2: b\n=== b.ts ===\n1: c";
    expect(toolSummary(tool({ tool: "read_many", output }), "ok", t)).toBe("2 个文件 · 3 行");
  });

  it("搜索内容显示命中数，多文件时带文件数", () => {
    const output = "a.ts:1: foo\na.ts:3: foo\nb.ts:2: foo";
    expect(toolSummary(tool({ tool: "grep", input: { pattern: "foo" }, output }), "ok", t)).toBe(
      "3 处命中 · 2 个文件",
    );
    expect(toolSummary(tool({ tool: "grep", input: { pattern: "foo" }, output: "a.ts:1: foo" }), "ok", t)).toBe(
      "1 处命中",
    );
  });

  it("查找文件显示文件数", () => {
    expect(toolSummary(tool({ tool: "glob", output: "a.ts\nb.ts\n... [truncated]" }), "ok", t)).toBe("2 个文件");
  });

  it("运行代码显示首行代码", () => {
    expect(toolSummary(tool({ tool: "run_code", input: { code: "\n  const a = 1;\nreturn a;" } }), "ok", t)).toBe(
      "const a = 1;",
    );
  });

  it("联网搜索显示结果数，抓取网页显示 HTTP 状态", () => {
    expect(
      toolSummary(tool({ tool: "web_search", output: "- [A](https://a.com)\n- [B](https://b.com)" }), "ok", t),
    ).toBe("2 条结果");
    expect(toolSummary(tool({ tool: "web_fetch", output: "Fetched: https://a.com (HTTP 200)" }), "ok", t)).toBe(
      "HTTP 200",
    );
  });

  it("记忆类：写入显示 description，读/删显示条目名", () => {
    expect(
      toolSummary(
        tool({
          tool: "memory_write",
          input: { scope: "project", name: "marketplace-rules", description: "技能卡必须有中文名" },
        }),
        "ok",
        t,
      ),
    ).toBe("技能卡必须有中文名");
    expect(
      toolSummary(tool({ tool: "memory_read", input: { scope: "user", name: "user-profile" } }), "ok", t),
    ).toBe("user-profile");
    expect(
      toolSummary(tool({ tool: "memory_delete", input: { scope: "project", name: "old-note" } }), "ok", t),
    ).toBe("old-note");
  });

  it("上下文状态、搜索工具、提问回答、浏览器操作也有摘要", () => {
    expect(toolSummary(tool({ tool: "context_status", output: "12% used" }), "ok", t)).toBe("12% used");
    expect(
      toolSummary(tool({ tool: "tool_search", output: "Matched tools:\n- excel: 表格\n- pptx: 演示" }), "ok", t),
    ).toBe("excel · pptx");
    expect(
      toolSummary(tool({ tool: "ask_user", output: "1. 用哪种风格？\n   → 简洁" }), "ok", t),
    ).toBe("简洁");
    expect(
      toolSummary(tool({ tool: "browser_navigate", input: { url: "http://localhost:5273/" } }), "ok", t),
    ).toBe("http://localhost:5273/");
    expect(toolSummary(tool({ tool: "browser_click", input: { ref: "e3" } }), "running", t)).toBe("e3");
  });

  it("失败行不显示摘要", () => {
    expect(toolSummary(tool({ tool: "list_dir", output: "dir src", ok: false }), "failed", t)).toBeUndefined();
  });

  it("工具行把摘要渲染到右侧常驻位（不展开也可见）", () => {
    const html = renderToStaticMarkup(
      createElement(ToolRow, { item: tool({ tool: "list_dir", input: { path: "." }, output: "dir src\nfile a" }) }),
    );
    expect(html).toContain("mc-toolrow__preview");
    expect(html).toContain("2 项");
  });
});
