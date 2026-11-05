import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_CONTRACTS } from "../../../../src/agent/tool-contract";
import { GenericActionView } from "./GenericView";
import { TOOL_VIEWS, hasToolBody, resolveToolView } from "./registry";
import type { TimelineTool } from "../../api";

function tool(overrides: Partial<TimelineTool>): TimelineTool {
  return {
    kind: "tool",
    key: "k",
    callId: "c",
    tool: "read_file",
    input: {},
    ...overrides,
  };
}

describe("工具视图注册表", () => {
  it("每个内置工具都有专属视图（动态工具才走通用兜底）", () => {
    const missing = Object.keys(BUILTIN_TOOL_CONTRACTS).filter(
      (name) => !(name in TOOL_VIEWS) && !name.startsWith("browser_") && !name.startsWith("computer_"),
    );
    expect(missing).toEqual([]);
  });

  it("未知 MCP/插件工具回落到通用视图", () => {
    expect(resolveToolView("mcp__unknown__tool")).toBe(GenericActionView);
    expect(resolveToolView("browser_click")).toBe(GenericActionView);
  });
});

describe("hasToolBody", () => {
  it("读类工具只有拿到结果才展开", () => {
    expect(hasToolBody(tool({ tool: "read_file", input: { path: "a.ts" } }))).toBe(false);
    expect(hasToolBody(tool({ tool: "read_file", input: { path: "a.ts" }, output: "1: a" }))).toBe(
      true,
    );
  });

  it("写/改类工具参数一到就能展开（运行中也能看 diff）", () => {
    expect(hasToolBody(tool({ tool: "edit_file", input: { path: "a.ts", oldString: "a", newString: "b" } }))).toBe(true);
    expect(hasToolBody(tool({ tool: "write_file", input: { path: "a.ts", content: "hello" } }))).toBe(true);
    expect(hasToolBody(tool({ tool: "write_file", input: { path: "a.ts" } }))).toBe(false);
  });

  it("失败的行始终可展开看错误", () => {
    expect(hasToolBody(tool({ tool: "read_file", input: {}, ok: false }))).toBe(true);
  });

  it("ask_user / update_plan 从参数取内容", () => {
    expect(
      hasToolBody(tool({ tool: "ask_user", input: { questions: [{ question: "q", options: [] }] } })),
    ).toBe(true);
    expect(hasToolBody(tool({ tool: "update_plan", input: { steps: [] } }))).toBe(false);
  });
});
