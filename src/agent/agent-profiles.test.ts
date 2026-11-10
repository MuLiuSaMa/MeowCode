import { describe, expect, it } from "vitest";
import {
  AGENT_PROFILES,
  AGENT_PROFILE_IDS,
  BASE_SYSTEM_PROMPT,
  agentProfileFor,
  isAgentProfile,
  normalizeAgentProfile,
  profileAllowsTool,
} from "./agent-profiles.js";
import { AGENT_ROLE_NAMES } from "./agent-definition.js";

describe("agent profiles", () => {
  it("registers exactly the three tiers in menu order", () => {
    expect(AGENT_PROFILE_IDS).toEqual(["standard", "minimal", "complex"]);
    expect(AGENT_PROFILE_IDS.map((id) => AGENT_PROFILES[id].name)).toEqual([
      "标准 Agent",
      "极简 Agent",
      "复杂 Agent",
    ]);
  });

  it("keeps the standard tier identical to the previous main agent", () => {
    const standard = AGENT_PROFILES.standard;
    expect(standard.prompt).toBe(BASE_SYSTEM_PROMPT);
    expect(standard.tools).toBeNull();
    // 标准档保持原来的 7 个角色；metis 式门禁角色只给复杂档
    expect(standard.roles).toEqual([
      "general",
      "explore",
      "planner",
      "implementer",
      "reviewer",
      "verifier",
      "custom",
    ]);
    expect(standard.maxSubagents).toBe(3);
  });

  it("gives the minimal tier exactly two working tools", () => {
    const minimal = AGENT_PROFILES.minimal;
    expect([...(minimal.tools ?? [])].sort()).toEqual(["read_file", "run_command"]);
    expect(minimal.roles).toEqual(["general", "explore"]);
    expect(minimal.maxSubagents).toBe(1);
    // 编排通道始终放行；干活工具按白名单
    expect(profileAllowsTool(minimal, "task")).toBe(true);
    expect(profileAllowsTool(minimal, "admit")).toBe(true);
    expect(profileAllowsTool(minimal, "read_file")).toBe(true);
    expect(profileAllowsTool(minimal, "run_command")).toBe(true);
    expect(profileAllowsTool(minimal, "write_file")).toBe(false);
    expect(profileAllowsTool(minimal, "edit_file")).toBe(false);
    expect(profileAllowsTool(minimal, "grep")).toBe(false);
  });

  it("lets the complex tier use every role with a higher concurrency budget", () => {
    const complex = AGENT_PROFILES.complex;
    expect(complex.tools).toBeNull();
    expect(complex.roles).toEqual(AGENT_ROLE_NAMES);
    expect(complex.maxSubagents).toBeGreaterThan(AGENT_PROFILES.standard.maxSubagents);
    expect(complex.prompt.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    // 复杂档比标准档多出 6 个 metis 式门禁角色
    expect(complex.roles.length - AGENT_PROFILES.standard.roles.length).toBe(6);
    for (const role of ["scoper", "depth-prober", "fresh-verifier", "juror", "sweeper", "goal-checker"] as const) {
      expect(complex.roles).toContain(role);
      expect(AGENT_PROFILES.standard.roles).not.toContain(role);
    }
    // 提示词要求按图关门禁，而不是写死某几个角色
    expect(complex.prompt).toContain("single source of truth for gates");
  });

  it("falls back to standard for unknown values", () => {
    expect(normalizeAgentProfile(undefined)).toBe("standard");
    expect(normalizeAgentProfile("weird")).toBe("standard");
    expect(normalizeAgentProfile("minimal")).toBe("minimal");
    expect(isAgentProfile("complex")).toBe(true);
    expect(isAgentProfile("plan")).toBe(false);
    expect(agentProfileFor("minimal").id).toBe("minimal");
  });
});
