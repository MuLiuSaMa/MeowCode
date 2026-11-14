import { describe, expect, it } from "vitest";
import { formatToolRejection } from "./tool-feedback.js";

describe("formatToolRejection", () => {
  it("explains how to fix invalid JSON arguments", () => {
    const text = formatToolRejection({
      tool: "read_file",
      kind: "invalid_arguments",
      reason: "tool arguments are not valid JSON (Unexpected token } in JSON at position 18).",
      rawArguments: '{"path": "a.ts",}',
    });
    expect(text).toContain("Tool call rejected (invalid_arguments).");
    expect(text).toContain("Tool: read_file");
    expect(text).toContain("Unexpected token");
    expect(text).toContain('Arguments received: {"path": "a.ts",}');
    expect(text).toContain("then call read_file again");
  });

  it("clips and flattens long raw arguments", () => {
    const text = formatToolRejection({
      tool: "run_command",
      kind: "invalid_arguments",
      reason: 'missing required string argument "command" (required: command).',
      rawArguments: `{\n  "x": "${"a".repeat(400)}"\n}`,
    });
    const line = text.split("\n").find((item) => item.startsWith("Arguments received:"));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(280);
    expect(line).not.toContain("\n");
    expect(line!.endsWith("…")).toBe(true);
  });

  it("lists available tools and tells the model not to retry the same name", () => {
    const text = formatToolRejection({
      tool: "browser_click",
      kind: "unavailable",
      reason: 'not enabled for agent profile "minimal"',
      availableTools: ["read_file", "run_command", "task"],
      maxTools: 2,
    });
    expect(text).toContain("Do not retry the same unavailable name.");
    expect(text).toContain("Available now: read_file, run_command, …");
  });
});
