import { describe, expect, it } from "vitest";
import { isToolCallComplete, summarizeToolCalls } from "./tool-progress";
import type { ToolCall } from "./types";

function call(name: string, args: string): ToolCall {
  return { id: `call-${name}`, type: "function", function: { name, arguments: args } };
}

describe("summarizeToolCalls", () => {
  it("reads a complete path from partially streamed arguments", () => {
    const progress = summarizeToolCalls([
      call("write_file", '{"path":"plans/2026-10-17-demo.md","content":"# 计划'),
    ]);
    expect(progress).toMatchObject({
      count: 1,
      tool: "write_file",
      names: ["write_file"],
      path: "plans/2026-10-17-demo.md",
    });
  });

  it("ignores a path value that is still being streamed", () => {
    const progress = summarizeToolCalls([call("write_file", '{"path":"plans/2026-10-')]);
    expect(progress.path).toBeUndefined();
    expect(progress.count).toBe(1);
  });

  it("unescapes Windows separators in the path", () => {
    const progress = summarizeToolCalls([
      call("edit_file", '{"path":"plans\\\\2026-10-17-demo.md","oldString":"a'),
    ]);
    expect(progress.path).toBe("plans\\2026-10-17-demo.md");
  });

  it("takes the first path of a cross-file multi_edit batch", () => {
    const progress = summarizeToolCalls([
      call(
        "multi_edit",
        '{"edits":[{"path":"src/a.ts","oldString":"a"},{"path":"src/b.ts","oldString":"b"}]}',
      ),
    ]);
    expect(progress.path).toBe("src/a.ts");
  });

  it("reports no path for tools without a path argument", () => {
    const progress = summarizeToolCalls([call("run_command", '{"command":"ls"}')]);
    expect(progress.path).toBeUndefined();
  });
});

describe("isToolCallComplete", () => {
  const complete = (name: string, args: string, id = "call-1"): ToolCall => ({
    id,
    type: "function",
    function: { name, arguments: args },
  });

  it("accepts closed JSON arguments with id and name", () => {
    expect(isToolCallComplete(complete("read_file", '{"path":"a.txt"}'))).toBe(true);
    expect(isToolCallComplete(complete("glob", "{}"))).toBe(true);
  });

  it("rejects streaming fragments that do not parse", () => {
    expect(isToolCallComplete(complete("read_file", '{"pa'))).toBe(false);
    expect(isToolCallComplete(complete("read_file", '{"a":1'))).toBe(false);
  });

  it("rejects calls without id, name, or any streamed arguments", () => {
    expect(isToolCallComplete(complete("read_file", "{}", ""))).toBe(false);
    expect(isToolCallComplete(complete("", "{}"))).toBe(false);
    expect(isToolCallComplete(complete("read_file", ""))).toBe(false);
    expect(isToolCallComplete(complete("read_file", "   "))).toBe(false);
  });
});
