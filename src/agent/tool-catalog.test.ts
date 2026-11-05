import { describe, expect, it } from "vitest";
import { createToolCatalog, reconcileToolCatalog } from "./tool-catalog";
import type { ToolDefinition } from "./types";

function tool(name: string, description = `${name} description`): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: {} },
    },
  };
}

describe("tool catalog snapshot", () => {
  it("anchors the breakpoint at the snapshot end", () => {
    const catalog = createToolCatalog([tool("a"), tool("b"), tool("c")]);
    expect(catalog.anchorIndex).toBe(2);
    expect(catalog.delta).toEqual({ added: [], removed: [], rewritten: [] });
  });

  it("appends additions in name order and keeps the old anchor", () => {
    const catalog = createToolCatalog([tool("b"), tool("d")]);
    const { catalog: next, appliedAdditions } = reconcileToolCatalog(catalog, [
      tool("z"),
      tool("b"),
      tool("a"),
      tool("d"),
    ]);

    expect(appliedAdditions).toEqual(["a", "z"]);
    expect(next.tools.map((item) => item.function.name)).toEqual(["b", "d", "a", "z"]);
    expect(next.anchorIndex).toBe(1);
    expect(next.fingerprint).not.toBe(catalog.fingerprint);
    expect(next.delta).toEqual({ added: ["a", "z"], removed: [], rewritten: [] });
  });

  it("moves the anchor to the new end when the original catalog was empty", () => {
    const catalog = createToolCatalog([]);
    const { catalog: next } = reconcileToolCatalog(catalog, [tool("a"), tool("b")]);
    expect(next.anchorIndex).toBe(1);
  });

  it("keeps removed tools byte-identical until a rebuild", () => {
    const catalog = createToolCatalog([tool("a"), tool("b")]);
    const { catalog: next, appliedAdditions } = reconcileToolCatalog(catalog, [tool("a")]);

    expect(appliedAdditions).toEqual([]);
    expect(next.tools).toEqual(catalog.tools);
    expect(next.fingerprint).toBe(catalog.fingerprint);
    expect(next.delta).toEqual({ added: [], removed: ["b"], rewritten: [] });
  });

  it("keeps rewritten definitions byte-identical and reports them", () => {
    const catalog = createToolCatalog([tool("a", "old"), tool("b")]);
    const { catalog: next } = reconcileToolCatalog(catalog, [
      tool("a", "new"),
      tool("b"),
    ]);

    expect(next.tools.map((item) => item.function.description)).toEqual(["old", "b description"]);
    expect(next.delta).toEqual({ added: [], removed: [], rewritten: ["a"] });
  });

  it("clears a deferred removal when the same tool returns unchanged", () => {
    const original = tool("a");
    const catalog = createToolCatalog([original]);
    const removed = reconcileToolCatalog(catalog, []).catalog;
    expect(removed.delta.removed).toEqual(["a"]);

    const restored = reconcileToolCatalog(removed, [tool("a")]).catalog;
    expect(restored.delta).toEqual({ added: [], removed: [], rewritten: [] });
    expect(restored.tools).toEqual([original]);
  });

  it("is stable across repeated reconciles with the same input", () => {
    const catalog = createToolCatalog([tool("a")]);
    const first = reconcileToolCatalog(catalog, [tool("a")]).catalog;
    const second = reconcileToolCatalog(first, [tool("a")]).catalog;
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.tools).toBe(first.tools);
  });
});
