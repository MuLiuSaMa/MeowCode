import { describe, expect, it } from "vitest";
import { EXPLORE_TOOLS, VERIFIER_TOOLS, WRITE_TOOLS } from "./agent-definition.js";
import { READ_ONLY_PARALLEL_TOOLS } from "./agent-loop.js";
import { browserToolDefinitions } from "./browser-tools.js";
import { PLAN_MUTATION_TOOLS } from "./plan-freshness.js";
import {
  APPROVAL_TOOLS,
  BROWSER_APPROVAL_TOOLS,
  MEMORY_TOOL_NAMES,
  WRITABLE_ROOT_TOOLS,
} from "./runtime.js";
import { BUILTIN_TOOL_CONTRACTS } from "./tool-contract.js";
import { admitToolDefinition, toolDefinitions } from "./tools.js";
import { GOVERNANCE_GATED_TOOLS } from "./workflow-runtime.js";

/**
 * 工具集合一致性：新加/删除一个内置工具，或改动某个策略集合，测试必须红。
 *
 * 之前只有 `tool-contract.test.ts` 一条单向断言（schema ⊆ 契约），且浏览器工具
 * 不在循环里 —— 删工具、给浏览器工具加一个不写契约，都不会报错。真正危险的是
 * `APPROVAL_TOOLS`：少写一个写工具，它就静默不弹审批直接执行。
 *
 * 明确**不纳入**断言的（加了会误报）：
 * - 动态工具（MCP / 插件，`mcp__*` 等）：运行时注册，契约表里永远没有；
 * - `ALWAYS_VISIBLE_DYNAMIC_TOOLS`：同上，是动态名；
 * - `types.ts` 的 `ToolName` 联合：已陈旧（只列了 17 个），不能当基准；
 * - `AgentRuntime.computeTools()` 的运行时输出：按档位/开关动态过滤，同进程不同配置不同。
 */

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** 三处声明出来的内置工具 schema（`admit` 与 `browser_*` 不在静态数组里）。 */
const STATIC_TOOL_NAMES = sorted([
  ...toolDefinitions.map((definition) => definition.function.name),
  admitToolDefinition.function.name,
  ...browserToolDefinitions.map((definition) => definition.function.name),
]);

const CONTRACT_NAMES = sorted(Object.keys(BUILTIN_TOOL_CONTRACTS));

/** 按工具名硬编码的策略集合：成员必须是真实存在的内置工具。 */
const STRATEGY_SETS: Array<[string, ReadonlySet<string> | Set<string>]> = [
  ["APPROVAL_TOOLS", APPROVAL_TOOLS],
  ["WRITABLE_ROOT_TOOLS", WRITABLE_ROOT_TOOLS],
  ["BROWSER_APPROVAL_TOOLS", BROWSER_APPROVAL_TOOLS],
  ["MEMORY_TOOL_NAMES", MEMORY_TOOL_NAMES],
  ["GOVERNANCE_GATED_TOOLS", GOVERNANCE_GATED_TOOLS],
  ["PLAN_MUTATION_TOOLS", PLAN_MUTATION_TOOLS],
  ["WRITE_TOOLS", WRITE_TOOLS],
  ["READ_ONLY_PARALLEL_TOOLS", READ_ONLY_PARALLEL_TOOLS],
  ["EXPLORE_TOOLS", EXPLORE_TOOLS],
  ["VERIFIER_TOOLS", VERIFIER_TOOLS],
];

describe("工具集合一致性", () => {
  it("schema 与契约表双向一一对应", () => {
    // 双向比较：漏建契约（多一个 schema）与删工具后契约残留（多一个键）都要红
    expect(CONTRACT_NAMES).toEqual(STATIC_TOOL_NAMES);
  });

  it("策略集合的成员都是真实工具（防改名 / 拼错 / 工具删了集合没删）", () => {
    for (const [label, set] of STRATEGY_SETS) {
      for (const name of set) {
        expect(CONTRACT_NAMES.includes(name), `${label} 引用了不存在的工具：${name}`).toBe(true);
      }
    }
  });

  it("写类集合口径一致", () => {
    // 这三处各自手写了一遍同样的 6 个文件写工具，必须同步增删
    expect(sorted(WRITABLE_ROOT_TOOLS)).toEqual(sorted(WRITE_TOOLS));
    expect(sorted(PLAN_MUTATION_TOOLS)).toEqual(sorted(WRITE_TOOLS));
    // 审批面 = 写类 + 命令；命令走独立的高危判定，不进可写根
    expect(sorted(APPROVAL_TOOLS)).toEqual(sorted([...WRITABLE_ROOT_TOOLS, "run_command"]));
  });
});
