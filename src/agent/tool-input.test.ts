import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_CONTRACTS } from "./tool-contract.js";
import { observerCopy, validateToolInput } from "./tool-input.js";
import { toolDefinitions } from "./tools.js";

/**
 * 入参门禁是模型看到的第一道纠错：报错文案会原样进上下文，
 * 所以每条都断言「说清是哪个字段、期望什么」。
 */
describe("validateToolInput", () => {
  describe("解析层", () => {
    it("坏 JSON 报解析位置，而不是报缺字段", () => {
      const result = validateToolInput("read_file", '{"path": "a.ts",');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("not valid JSON");
      expect(result.error).toMatch(/position \d+/);
      expect(result.error).not.toContain("missing required");
    });

    it("数组等非对象参数被拒", () => {
      for (const raw of ["[1,2]", '"text"', "null", "42"]) {
        const result = validateToolInput("read_file", raw);
        expect(result.ok, raw).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error).toBe("tool arguments must be a JSON object.");
      }
    });

    it("空参数串按空对象处理，落到缺字段而不是解析失败", () => {
      const result = validateToolInput("read_file", "");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain('missing required string argument "path"');
    });
  });

  describe("必填字段", () => {
    it("缺字段时点名，并列出全部必填项", () => {
      const result = validateToolInput("write_file", '{"path": "a.ts"}');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain('missing required string argument "content"');
      expect(result.error).toContain("required: path, content");
    });

    it("字段存在但不是字符串，按缺字段处理", () => {
      const result = validateToolInput("read_file", '{"path": 42}');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain('missing required string argument "path"');
    });

    it("nonEmpty 字段只有空白时单独报错", () => {
      const result = validateToolInput("run_command", '{"command": "   "}');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toBe('argument "command" must not be empty.');
    });

    it("合法参数原样返回同一个对象", () => {
      const raw = '{"path": "a.ts", "offset": 10}';
      const result = validateToolInput("read_file", raw);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.input).toEqual({ path: "a.ts", offset: 10 });
    });
  });

  describe("特殊形态", () => {
    it("multi_edit 支持顶层 path 与逐条 path 两种写法", () => {
      const top = validateToolInput(
        "multi_edit",
        '{"path": "a.ts", "edits": [{"oldString": "x", "newString": "y"}]}',
      );
      expect(top.ok).toBe(true);
      const perEdit = validateToolInput(
        "multi_edit",
        '{"edits": [{"path": "a.ts", "oldString": "x", "newString": "y"}]}',
      );
      expect(perEdit.ok).toBe(true);
    });

    it("multi_edit 缺 path 或 edits 为空都拒绝", () => {
      const noPath = validateToolInput(
        "multi_edit",
        '{"edits": [{"oldString": "x", "newString": "y"}]}',
      );
      expect(noPath.ok).toBe(false);
      const noEdits = validateToolInput("multi_edit", '{"path": "a.ts", "edits": []}');
      expect(noEdits.ok).toBe(false);
      if (noEdits.ok) throw new Error("unreachable");
      expect(noEdits.error).toContain("non-empty array");
    });

    it("read_many 的 paths 必须是字符串数组", () => {
      const cases: Array<[string, string]> = [
        ['{"paths": "a.ts"}', 'argument "paths" must be a non-empty array'],
        ['{"paths": []}', 'argument "paths" must be a non-empty array'],
        ['{"paths": ["a.ts", 42]}', "every entry in \"paths\" must be a non-empty string"],
        ['{"paths": ["a.ts", "  "]}', "every entry in \"paths\" must be a non-empty string"],
      ];
      for (const [raw, expected] of cases) {
        const result = validateToolInput("read_many", raw);
        expect(result.ok, raw).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error, raw).toContain(expected);
      }
    });

    it("read_many 超过上限时要求分批", () => {
      const paths = Array.from({ length: 13 }, (_, index) => `f${index}.ts`);
      const result = validateToolInput("read_many", JSON.stringify({ paths }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("accepts at most 12 files");
    });

    it("read_many 合法时放行", () => {
      const result = validateToolInput("read_many", '{"paths": ["a.ts", "b.ts"]}');
      expect(result.ok).toBe(true);
    });
  });

  describe("未知工具", () => {
    it("动态工具/插件工具放行，形态由各自实现校验", () => {
      const result = validateToolInput("some_plugin_tool", '{"anything": 1}');
      expect(result.ok).toBe(true);
    });
  });
});

/**
 * 契约表是门禁的唯一声明处。schema 里写了 required 却没进门禁，
 * 就等于「模型可以少给参数，直到实现层炸掉」——只读路径那个
 * "undefined not found." 就是这么来的。
 *
 * 这里不追求一次补齐：未覆盖的列进 KNOWN_UNGATED 并写明原因，
 * 新增工具漏声明会直接红灯。
 */
describe("契约 args 与工具 schema 的一致性", () => {
  const CUSTOM_VALIDATED = new Set(["multi_edit", "read_many"]);
  const KNOWN_UNGATED: Record<string, string> = {
    read_video: "数组/路径之外还有可选帧参数，缺 path 时 video.ts 自己给可读错误",
    update_plan: "steps 是数组，门禁表只覆盖字符串字段；缺省由 runtime 的 plan 分支兜底",
    ask_user: "questions 是数组，且兼容旧 {question, options} 单题形态，不能按必填拒绝",
    memory_read: "scope 的合法值只有 user/project，实现层的报错比门禁更具体",
    memory_write: "同 memory_read；另外 content 允许空字符串以外的校验由实现负责",
    memory_delete: "同 memory_read",
    session_search: "query 缺失时实现返回用法提示，语义比门禁更细",
    tool_search: "query 缺失时实现返回用法提示，并附当前已注册工具列表",
  };

  it("schema 声明 required 的工具都在门禁里有声明，或在例外表里写明原因", () => {
    const gated = new Set(
      Object.entries(BUILTIN_TOOL_CONTRACTS)
        .filter(([, contract]) => contract.args !== undefined)
        .map(([name]) => name),
    );
    const declared = toolDefinitions
      .filter((definition) => (definition.function.parameters.required ?? []).length > 0)
      .map((definition) => definition.function.name);
    const ungated = declared
      .filter((name) => !gated.has(name) && !CUSTOM_VALIDATED.has(name))
      .sort();
    expect(ungated).toEqual(Object.keys(KNOWN_UNGATED).sort());
  });

  it("例外表没有过期条目", () => {
    const declared = new Set(toolDefinitions.map((definition) => definition.function.name));
    for (const name of Object.keys(KNOWN_UNGATED)) {
      expect(declared.has(name), `${name} 已不存在，删掉这条例外`).toBe(true);
    }
  });
});

describe("observerCopy", () => {
  it("改副本不影响原始入参", () => {
    const input = { path: "a.ts", options: { deep: [1, 2] } };
    const copy = observerCopy(input) as typeof input;
    copy.path = "b.ts";
    copy.options.deep.push(3);
    expect(input.path).toBe("a.ts");
    expect(input.options.deep).toEqual([1, 2]);
  });

  it("原始值原样返回", () => {
    expect(observerCopy("text")).toBe("text");
    expect(observerCopy(null)).toBeNull();
    expect(observerCopy(7)).toBe(7);
  });
});
