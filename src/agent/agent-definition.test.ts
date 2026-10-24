import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS, AGENT_ROLE_NAMES, definitionFor, isAgentRole } from "./agent-definition.js";
import { CHILD_RESULT_ROLES } from "./child-result.js";

/** 内核全部已知工具名（内置 + browser + 虚拟），白名单不得引用不存在的工具。 */
const KNOWN_TOOLS = new Set([
  "list_dir",
  "read_file",
  "read_many",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "multi_edit",
  "run_command",
  "run_code",
  "update_plan",
  "task",
  "context_status",
  "ask_user",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_back",
  "browser_reload",
]);

describe("agent-definition 角色注册表", () => {
  it("十三个内置角色齐备（含 metis 式门禁角色），key 与 name 一致", () => {
    expect(AGENT_ROLE_NAMES).toEqual([
      "general",
      "explore",
      "planner",
      "scoper",
      "depth-prober",
      "implementer",
      "reviewer",
      "verifier",
      "fresh-verifier",
      "juror",
      "sweeper",
      "goal-checker",
      "custom",
    ]);
    for (const name of AGENT_ROLE_NAMES) {
      expect(BUILTIN_AGENTS[name].name).toBe(name);
      expect(BUILTIN_AGENTS[name].systemPrompt.length).toBeGreaterThan(50);
      expect(BUILTIN_AGENTS[name].description.length).toBeGreaterThan(3);
    }
  });

  it("白名单只引用已知工具，且不含 task（禁止嵌套派发）", () => {
    for (const name of AGENT_ROLE_NAMES) {
      const tools = BUILTIN_AGENTS[name].tools;
      if (!tools) continue;
      for (const tool of tools) {
        expect(KNOWN_TOOLS.has(tool), `${name} 引用了未知工具 ${tool}`).toBe(true);
      }
      expect(tools.has("task")).toBe(false);
    }
  });

  it("只读角色没有文件写工具；implementer 有写与命令；verifier 有命令无写", () => {
    const writes = ["write_file", "edit_file", "multi_edit"];
    for (const name of ["explore", "planner", "reviewer"] as const) {
      const tools = BUILTIN_AGENTS[name].tools!;
      for (const write of writes) {
        expect(tools.has(write), `${name} 不应有 ${write}`).toBe(false);
      }
    }
    const implementer = BUILTIN_AGENTS.implementer.tools!;
    expect(implementer.has("write_file")).toBe(true);
    expect(implementer.has("edit_file")).toBe(true);
    expect(implementer.has("multi_edit")).toBe(true);
    expect(implementer.has("run_command")).toBe(true);
    const verifier = BUILTIN_AGENTS.verifier.tools!;
    expect(verifier.has("run_command")).toBe(true);
    for (const write of writes) {
      expect(verifier.has(write)).toBe(false);
    }
  });

  it("gate 绑定：implementer→G4、reviewer→G5、verifier→G6，其余无", () => {
    expect(BUILTIN_AGENTS.implementer.expectedGates).toEqual(["G4"]);
    expect(BUILTIN_AGENTS.reviewer.expectedGates).toEqual(["G5"]);
    expect(BUILTIN_AGENTS.verifier.expectedGates).toEqual(["G6"]);
    expect(BUILTIN_AGENTS.general.expectedGates).toBeUndefined();
    expect(BUILTIN_AGENTS.explore.expectedGates).toBeUndefined();
    expect(BUILTIN_AGENTS.planner.expectedGates).toBeUndefined();
    expect(BUILTIN_AGENTS.custom.expectedGates).toBeUndefined();
  });

  it("metis 式门禁角色各自绑定对应门禁，且都受 ChildResult 契约约束", () => {
    expect(BUILTIN_AGENTS.scoper.expectedGates).toEqual(["G2"]);
    expect(BUILTIN_AGENTS["depth-prober"].expectedGates).toEqual(["G3.5"]);
    expect(BUILTIN_AGENTS["fresh-verifier"].expectedGates).toEqual(["G6"]);
    expect(BUILTIN_AGENTS.juror.expectedGates).toEqual(["G7"]);
    expect(BUILTIN_AGENTS.sweeper.expectedGates).toEqual(["sweep"]);
    expect(BUILTIN_AGENTS["goal-checker"].expectedGates).toEqual(["goal-check"]);
    for (const role of [
      "scoper",
      "depth-prober",
      "fresh-verifier",
      "juror",
      "sweeper",
      "goal-checker",
    ] as const) {
      expect(CHILD_RESULT_ROLES.has(role), `${role} 必须在 ChildResult 契约里`).toBe(true);
    }
    // 只读角色不能写文件
    for (const role of ["scoper", "depth-prober", "juror", "sweeper", "goal-checker"] as const) {
      expect(BUILTIN_AGENTS[role].readOnly).toBe(true);
      const tools = BUILTIN_AGENTS[role].tools!;
      for (const write of ["write_file", "edit_file", "multi_edit", "run_command"]) {
        expect(tools.has(write), `${role} 不应有 ${write}`).toBe(false);
      }
    }
    // 独立复验要跑命令，但不能写文件
    expect(BUILTIN_AGENTS["fresh-verifier"].tools!.has("run_command")).toBe(true);
    for (const write of ["write_file", "edit_file", "multi_edit"]) {
      expect(BUILTIN_AGENTS["fresh-verifier"].tools!.has(write)).toBe(false);
    }
  });

  it("general 不设白名单（继承父级全量工具含 MCP/浏览器）；explore 不注入 AGENTS.md", () => {
    expect(BUILTIN_AGENTS.general.tools).toBeUndefined();
    expect(BUILTIN_AGENTS.general.injectInstructions).toBe(true);
    expect(BUILTIN_AGENTS.custom.tools).toBeUndefined();
    expect(BUILTIN_AGENTS.custom.injectInstructions).toBe(true);
    expect(BUILTIN_AGENTS.explore.tools).toBeDefined();
    expect(BUILTIN_AGENTS.explore.injectInstructions).toBe(false);
  });

  it("definitionFor：未知角色回落 general；isAgentRole 校验", () => {
    expect(definitionFor("nope").name).toBe("general");
    expect(definitionFor("reviewer").name).toBe("reviewer");
    expect(isAgentRole("verifier")).toBe(true);
    expect(isAgentRole("wizard")).toBe(false);
    expect(isAgentRole(42)).toBe(false);
  });
});
