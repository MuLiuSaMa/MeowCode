import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_GATED_TOOLS,
  MAIN_LANE_ID,
  WorkflowRuntime,
} from "./workflow-runtime.js";
import type { ChildResult } from "./child-result.js";
import { builtinHarnessSeed, type HarnessDocument } from "./harness-document.js";

function childResult(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    status: "completed",
    summary: "did it",
    findings: [],
    filesChanged: ["src/a.ts"],
    commands: [],
    valid: true,
    ...overrides,
  };
}

const T1_INPUT = { tier: "T1", task_shape: "add feature X" };

describe("WorkflowRuntime admit", () => {
  it("非法 tier / 空 task_shape 拒绝且不建立 run", () => {
    const workflow = new WorkflowRuntime();
    expect(workflow.admit({ tier: "T9", task_shape: "x" }).ok).toBe(false);
    expect(workflow.admit({ tier: "T1", task_shape: "  " }).ok).toBe(false);
    expect(workflow.needsAdmission).toBe(true);
  });

  it("T0：无 gate，run 立即完成（门禁解除留审计）", () => {
    const workflow = new WorkflowRuntime();
    const result = workflow.admit({ tier: "T0", task_shape: "rename variable" });
    expect(result.ok).toBe(true);
    expect(workflow.active).toBe(false);
    expect(workflow.needsAdmission).toBe(false);
    expect(workflow.frontier()).toBeNull();
  });

  it("层级提示词：tier 配了 instructions 时随 admit 报告注入", () => {
    const harness: HarnessDocument = {
      version: 1,
      nodes: [
        {
          id: "T1",
          type: "tier",
          data: { id: "T1", name: "单车道", instructions: "所有改动先跑 pnpm test" },
        },
        { id: "G4", type: "gate", data: { id: "G4", name: "实现" } },
        { id: "implementer", type: "role", data: { id: "implementer", name: "实现", role: "implementer" } },
      ],
      edges: [
        { id: "t1-g4", source: "T1", target: "G4", type: "tier-gate", order: 1 },
        { id: "g4-impl", source: "G4", target: "implementer", type: "gate-role" },
      ],
    };
    const workflow = new WorkflowRuntime({ harness });
    const admitted = workflow.admit(T1_INPUT);
    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      expect(admitted.report).toContain("Governed run admitted (T1");
      expect(admitted.report).toContain("Tier instructions: 所有改动先跑 pnpm test");
    }
  });

  it("层级提示词：缺省 / 空串 / 纯空白不注入", () => {
    const harness = (instructions?: string): HarnessDocument => ({
      version: 1,
      nodes: [
        {
          id: "T1",
          type: "tier",
          data: {
            id: "T1",
            name: "单车道",
            ...(instructions === undefined ? {} : { instructions }),
          },
        },
        { id: "G4", type: "gate", data: { id: "G4", name: "实现" } },
        { id: "implementer", type: "role", data: { id: "implementer", name: "实现", role: "implementer" } },
      ],
      edges: [
        { id: "t1-g4", source: "T1", target: "G4", type: "tier-gate", order: 1 },
        { id: "g4-impl", source: "G4", target: "implementer", type: "gate-role" },
      ],
    });
    for (const value of [undefined, "", "   \n "]) {
      const workflow = new WorkflowRuntime({ harness: harness(value) });
      const admitted = workflow.admit(T1_INPUT);
      expect(admitted.ok).toBe(true);
      if (admitted.ok) expect(admitted.report).not.toContain("Tier instructions");
    }
  });

  it("层级提示词：内置种子不带该字段，T0 直通报告也不含", () => {
    const workflow = new WorkflowRuntime();
    const admitted = workflow.admit({ tier: "T0", task_shape: "rename variable" });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) expect(admitted.report).not.toContain("Tier instructions");
  });

  it("T1：带 lanes 拒绝；成功后创建隐式 main lane", () => {
    const workflow = new WorkflowRuntime();
    expect(workflow.admit({ ...T1_INPUT, lanes: [{ id: "a", objective: "x" }] }).ok).toBe(false);
    expect(workflow.admit(T1_INPUT).ok).toBe(true);
    expect(workflow.state?.lanes).toHaveLength(1);
    expect(workflow.state?.lanes[0]?.id).toBe(MAIN_LANE_ID);
    expect(workflow.state?.lanes[0]?.status).toBe("active");
    expect(workflow.active).toBe(true);
  });

  it("活跃 run 期间重复 admit 拒绝", () => {
    const workflow = new WorkflowRuntime();
    workflow.admit(T1_INPUT);
    expect(workflow.admit(T1_INPUT).ok).toBe(false);
  });

  it("T2 校验：重复 id / 未知依赖 / 环 / ownedPaths 重叠全部拒绝", () => {
    const workflow = new WorkflowRuntime();
    const base = { tier: "T2", task_shape: "rework" };
    expect(
      workflow.admit({
        ...base,
        lanes: [
          { id: "a", objective: "x" },
          { id: "a", objective: "y" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      workflow.admit({ ...base, lanes: [{ id: "a", objective: "x", depends_on: ["ghost"] }] }).ok,
    ).toBe(false);
    expect(
      workflow.admit({
        ...base,
        lanes: [
          { id: "a", objective: "x", depends_on: ["b"] },
          { id: "b", objective: "y", depends_on: ["a"] },
        ],
      }).ok,
    ).toBe(false);
    expect(
      workflow.admit({
        ...base,
        lanes: [
          { id: "a", objective: "x", owned_paths: ["src/shared.ts"] },
          { id: "b", objective: "y", owned_paths: ["src\\Shared.ts"] },
        ],
      }).ok,
    ).toBe(false);
    expect(workflow.needsAdmission).toBe(true);
  });

  it("T2 成功：无依赖 lane 立即 active，被依赖 lane 保持 queued", () => {
    const workflow = new WorkflowRuntime();
    const result = workflow.admit({
      tier: "T2",
      task_shape: "parallel work",
      lanes: [
        { id: "core", objective: "core changes" },
        { id: "docs", objective: "docs", depends_on: ["core"] },
      ],
    });
    expect(result.ok).toBe(true);
    const lanes = workflow.state!.lanes;
    expect(lanes.find((lane) => lane.id === "core")?.status).toBe("active");
    expect(lanes.find((lane) => lane.id === "docs")?.status).toBe("queued");
  });

  it("门禁工具集覆盖写/命令/派发/浏览器写", () => {
    for (const tool of ["write_file", "edit_file", "multi_edit", "run_command", "task"]) {
      expect(GOVERNANCE_GATED_TOOLS.has(tool), tool).toBe(true);
    }
    expect(GOVERNANCE_GATED_TOOLS.has("read_file")).toBe(false);
    expect(GOVERNANCE_GATED_TOOLS.has("update_plan")).toBe(false);
  });
});

describe("复杂档（Metis 式十道门禁）", () => {
  it("T2 按图跑 G0→G1→G2→G3.5→G4→G5→G6→G7→sweep→goal-check", () => {
    const workflow = new WorkflowRuntime({ harness: builtinHarnessSeed("complex") });
    const admitted = workflow.admit({
      tier: "T2",
      task_shape: "rebuild checkout",
      lanes: [{ id: "a", objective: "checkout", owned_paths: ["src/checkout.ts"] }],
    });
    expect(admitted.ok).toBe(true);
    const lane = workflow.state!.lanes[0];
    expect(lane.gateOrder).toEqual([
      "G0",
      "G1",
      "G2",
      "G3.5",
      "G4",
      "G5",
      "G6",
      "G7",
      "sweep",
      "goal-check",
    ]);

    // G0 绑的是 verifier：派 implementer 关不掉
    expect(
      workflow.applyChildGate({
        role: "implementer",
        agentId: "impl-1",
        laneId: "a",
        childResult: childResult(),
      }).verdict,
    ).toBe("none");
    // verifier 必须真的跑过命令（全 0）才算基线通过
    expect(
      workflow.applyChildGate({
        role: "verifier",
        agentId: "v-0",
        laneId: "a",
        childResult: childResult({ filesChanged: [], commands: [] }),
      }).verdict,
    ).toBe("fail");
    expect(
      workflow.applyChildGate({
        role: "verifier",
        agentId: "v-0",
        laneId: "a",
        childResult: childResult({
          filesChanged: [],
          commands: [{ argv: "pnpm test", exitCode: 0 }],
        }),
      }).verdict,
    ).toBe("pass");

    // G1 规划 → G2 范围 → G3.5 深挖（三道都是只读角色）
    for (const [role, agentId] of [
      ["planner", "p-1"],
      ["scoper", "s-1"],
      ["depth-prober", "d-1"],
    ] as const) {
      const outcome = workflow.applyChildGate({
        role,
        agentId,
        laneId: "a",
        childResult: childResult({ filesChanged: [] }),
      });
      expect(outcome.verdict, `${role} 应能关掉自己的门禁`).toBe("pass");
    }

    // G4 实现 → G5 评审 → G6 独立复验
    expect(
      workflow.applyChildGate({
        role: "implementer",
        agentId: "impl-1",
        laneId: "a",
        childResult: childResult({ filesChanged: ["src/checkout.ts"] }),
      }).verdict,
    ).toBe("pass");
    expect(
      workflow.applyChildGate({
        role: "reviewer",
        agentId: "r-1",
        laneId: "a",
        childResult: childResult({ filesChanged: [] }),
      }).verdict,
    ).toBe("pass");
    expect(
      workflow.applyChildGate({
        role: "fresh-verifier",
        agentId: "fv-1",
        laneId: "a",
        childResult: childResult({
          filesChanged: [],
          commands: [{ argv: "pnpm test", exitCode: 0 }],
        }),
      }).verdict,
    ).toBe("pass");

    // G7 终审：major finding 直接判 FAIL
    expect(
      workflow.applyChildGate({
        role: "juror",
        agentId: "j-1",
        laneId: "a",
        childResult: childResult({
          filesChanged: [],
          findings: [{ severity: "major", message: "契约未覆盖并发" }],
        }),
      }).verdict,
    ).toBe("fail");
    // 终审打回 → onFail=loop-to:G4：从 G4 起重走 G4→G5→G6→G7（关账者必须换人）
    expect(
      workflow.applyChildGate({
        role: "implementer",
        agentId: "impl-2",
        laneId: "a",
        childResult: childResult({ filesChanged: ["src/checkout.ts"] }),
      }).verdict,
    ).toBe("pass");
    expect(
      workflow.applyChildGate({
        role: "reviewer",
        agentId: "r-2",
        laneId: "a",
        childResult: childResult({ filesChanged: [] }),
      }).verdict,
    ).toBe("pass");
    expect(
      workflow.applyChildGate({
        role: "fresh-verifier",
        agentId: "fv-2",
        laneId: "a",
        childResult: childResult({
          filesChanged: [],
          commands: [{ argv: "pnpm test", exitCode: 0 }],
        }),
      }).verdict,
    ).toBe("pass");
    expect(
      workflow.applyChildGate({
        role: "juror",
        agentId: "j-2",
        laneId: "a",
        childResult: childResult({ filesChanged: [] }),
      }).verdict,
    ).toBe("pass");

    // sweep 收敛 → goal-check 目标核对 → run 完成
    expect(
      workflow.applyChildGate({
        role: "sweeper",
        agentId: "sw-1",
        laneId: "a",
        childResult: childResult({ filesChanged: [] }),
      }).verdict,
    ).toBe("pass");
    const done = workflow.applyChildGate({
      role: "goal-checker",
      agentId: "gc-1",
      laneId: "a",
      childResult: childResult({ filesChanged: [] }),
    });
    expect(done.verdict).toBe("pass");
    expect(workflow.state?.completed).toBe(true);
  });
});

describe("WorkflowRuntime gates（T1）", () => {
  it("完整通过链：根侧 G4 → reviewer G5 → verifier G6 → run 完成", () => {
    const workflow = new WorkflowRuntime();
    workflow.admit(T1_INPUT);
    expect(workflow.applyChildGate({ role: "reviewer", agentId: "r1", childResult: childResult() }).verdict).toBe("none");

    const g4 = workflow.noteRootMutation("src/a.ts");
    expect(g4).toContain("G4 passed");

    const g5 = workflow.applyChildGate({
      role: "reviewer",
      agentId: "r1",
      childResult: childResult({ filesChanged: [] }),
    });
    expect(g5.verdict).toBe("pass");

    const g6 = workflow.applyChildGate({
      role: "verifier",
      agentId: "v1",
      childResult: childResult({ filesChanged: [], commands: [{ argv: "pnpm test", exitCode: 0 }] }),
    });
    expect(g6.verdict).toBe("pass");
    expect(workflow.state?.completed).toBe(true);
    expect(workflow.active).toBe(false);
  });

  it("gate-role 绑定自定义节点 id 时按 data.role 解析关账角色", () => {
    const harness: HarnessDocument = {
      version: 1,
      nodes: [
        { id: "T1", type: "tier", data: { id: "T1", name: "单车道" } },
        { id: "G4", type: "gate", data: { id: "G4", name: "实现" } },
        {
          id: "impl-node",
          type: "role",
          data: { id: "impl-node", name: "实现副本", role: "implementer" },
        },
      ],
      edges: [
        { id: "t1-g4", source: "T1", target: "G4", type: "tier-gate", order: 1 },
        { id: "g4-impl", source: "G4", target: "impl-node", type: "gate-role" },
      ],
    };
    const workflow = new WorkflowRuntime({ harness });
    expect(workflow.admit(T1_INPUT).ok).toBe(true);
    const outcome = workflow.applyChildGate({
      role: "implementer",
      agentId: "impl-1",
      childResult: childResult(),
    });
    expect(outcome.verdict).toBe("pass");
  });

  it("独立性：G5/G6 不得由 G4 实现者担任", () => {
    const workflow = new WorkflowRuntime();
    workflow.admit(T1_INPUT);
    workflow.applyChildGate({
      role: "implementer",
      agentId: "impl-1",
      childResult: childResult(),
    });
    const self = workflow.applyChildGate({
      role: "reviewer",
      agentId: "impl-1",
      childResult: childResult({ filesChanged: [] }),
    });
    expect(self.verdict).toBe("none");
    expect(self.message).toContain("Independence");
    const selfVerify = workflow.applyChildGate({
      role: "verifier",
      agentId: "impl-1",
      childResult: childResult({ filesChanged: [], commands: [{ argv: "x", exitCode: 0 }] }),
    });
    expect(selfVerify.verdict).toBe("none");
  });

  it("G5 critical findings → fail → 回跳 G4 返工；连续超限 lane blocked、run 卡死", () => {
    const workflow = new WorkflowRuntime();
    workflow.admit(T1_INPUT);
    workflow.noteRootMutation("src/a.ts");
    const critical = childResult({
      filesChanged: [],
      findings: [{ severity: "critical", message: "breaks everything", location: "a.ts:1" }],
    });
    for (let round = 1; round <= 3; round += 1) {
      const outcome = workflow.applyChildGate({ role: "reviewer", agentId: `r${round}`, childResult: critical });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.message).toContain(`repair ${round}/3`);
      // 返工后重新过 G4
      workflow.noteRootMutation("src/a.ts");
    }
    const fourth = workflow.applyChildGate({ role: "reviewer", agentId: "r4", childResult: critical });
    expect(fourth.message).toContain("blocked");
    expect(workflow.stalled).toBe(true);
    expect(workflow.shouldContinue).toBe(false);
    expect(workflow.state?.completed).toBe(false);
  });

  it("G6 命令非零退出 → fail 返工；G6 未跑命令直接判 fail", () => {
    const workflow = new WorkflowRuntime();
    workflow.admit(T1_INPUT);
    workflow.noteRootMutation("src/a.ts");
    workflow.applyChildGate({ role: "reviewer", agentId: "r1", childResult: childResult({ filesChanged: [] }) });
    const failing = workflow.applyChildGate({
      role: "verifier",
      agentId: "v1",
      childResult: childResult({
        filesChanged: [],
        commands: [
          { argv: "pnpm test", exitCode: 0 },
          { argv: "pnpm build", exitCode: 1 },
        ],
      }),
    });
    expect(failing.verdict).toBe("fail");
    // 返工：G4 回到 pending
    const lane = workflow.state!.lanes[0]!;
    expect(lane.gates.G4).toBe("pending");
    const noCommands = workflow.applyChildGate({
      role: "verifier",
      agentId: "v2",
      childResult: childResult({ filesChanged: [], commands: [] }),
    });
    expect(noCommands.verdict).toBe("none"); // G4 未过，直接拒
  });

  it("无效 ChildResult（fail-closed 判 invalid）不能关 gate", () => {
    const workflow = new WorkflowRuntime();
    workflow.admit(T1_INPUT);
    workflow.noteRootMutation("src/a.ts");
    const invalid = workflow.applyChildGate({
      role: "reviewer",
      agentId: "r1",
      childResult: childResult({ filesChanged: [], valid: false, invalidReason: "EMPTY_SUMMARY" }),
    });
    expect(invalid.verdict).toBe("fail");
  });

  it("非 gate 角色与无 run 状态：verdict none 不迁移", () => {
    const workflow = new WorkflowRuntime();
    expect(
      workflow.applyChildGate({ role: "implementer", agentId: "i", childResult: childResult() }).ok,
    ).toBe(false);
    workflow.admit(T1_INPUT);
    expect(
      workflow.applyChildGate({ role: "explore", agentId: "e", childResult: childResult() }).verdict,
    ).toBe("none");
  });
});

describe("WorkflowRuntime lanes（T2）", () => {
  function t2(): WorkflowRuntime {
    const workflow = new WorkflowRuntime();
    workflow.admit({
      tier: "T2",
      task_shape: "parallel",
      lanes: [
        { id: "core", objective: "core", verification_commands: ["pnpm test"] },
        { id: "docs", objective: "docs", depends_on: ["core"] },
      ],
    });
    return workflow;
  }

  function closeLane(workflow: WorkflowRuntime, laneId: string, suffix: string): void {
    workflow.applyChildGate({
      laneId,
      role: "implementer",
      agentId: `impl-${suffix}`,
      childResult: childResult(),
    });
    workflow.applyChildGate({
      laneId,
      role: "reviewer",
      agentId: `rev-${suffix}`,
      childResult: childResult({ filesChanged: [] }),
    });
    workflow.applyChildGate({
      laneId,
      role: "verifier",
      agentId: `ver-${suffix}`,
      childResult: childResult({ filesChanged: [], commands: [{ argv: "pnpm test", exitCode: 0 }] }),
    });
  }

  it("依赖 lane 在前置完成后自动 active；全 done 后 run 完成", () => {
    const workflow = t2();
    expect(workflow.state!.lanes.find((lane) => lane.id === "docs")?.status).toBe("queued");
    // docs lane 未激活时 gate 拒绝
    expect(
      workflow.applyChildGate({ laneId: "docs", role: "implementer", agentId: "x", childResult: childResult() })
        .verdict,
    ).toBe("none");
    closeLane(workflow, "core", "core");
    expect(workflow.state!.lanes.find((lane) => lane.id === "docs")?.status).toBe("active");
    expect(workflow.state?.completed).toBe(false);
    closeLane(workflow, "docs", "docs");
    expect(workflow.state?.completed).toBe(true);
  });

  it("T2 缺 lane_id 的 gate 角色被拒并提示", () => {
    const workflow = t2();
    const outcome = workflow.applyChildGate({
      role: "implementer",
      agentId: "i1",
      childResult: childResult(),
    });
    expect(outcome.verdict).toBe("none");
    expect(outcome.message).toContain("lane_id");
  });

  it("frontier 输出各 lane 状态与待办 gate", () => {
    const workflow = t2();
    const frontier = workflow.frontier();
    expect(frontier).toContain("T2");
    expect(frontier).toContain("core");
    expect(frontier).toContain("await G4");
    expect(frontier).toContain("0/2 lanes done");
  });
});

describe("主 Agent 工具白名单", () => {
  it("根 agent 节点的 tools 覆盖档位默认；缺省为 null", () => {
    const seed = builtinHarnessSeed();
    expect(new WorkflowRuntime({ harness: seed }).rootAgentTools).toBeNull();

    const withTools: HarnessDocument = {
      ...seed,
      nodes: seed.nodes.map((node) =>
        node.type === "agent"
          ? { ...node, data: { ...node.data, tools: ["read_file", "run_command"] } }
          : node,
      ),
    };
    const workflow = new WorkflowRuntime({ harness: withTools });
    expect([...(workflow.rootAgentTools ?? [])]).toEqual(["read_file", "run_command"]);

    // setHarness 换图时同步更新
    expect(workflow.setHarness(seed)).toBe(true);
    expect(workflow.rootAgentTools).toBeNull();
  });
});

describe("主 Agent 提示词覆盖", () => {
  it("根 agent 节点的 systemPrompt 优先；空串视为未覆盖", () => {
    const seed = builtinHarnessSeed();
    expect(new WorkflowRuntime({ harness: seed }).rootAgentPrompt).toBeNull();

    const withPrompt: HarnessDocument = {
      ...seed,
      nodes: seed.nodes.map((node) =>
        node.type === "agent"
          ? { ...node, data: { ...node.data, systemPrompt: "  你是自定义主 Agent  " } }
          : node,
      ),
    };
    expect(new WorkflowRuntime({ harness: withPrompt }).rootAgentPrompt).toBe("你是自定义主 Agent");

    const blank: HarnessDocument = {
      ...seed,
      nodes: seed.nodes.map((node) =>
        node.type === "agent" ? { ...node, data: { ...node.data, systemPrompt: "   " } } : node,
      ),
    };
    expect(new WorkflowRuntime({ harness: blank }).rootAgentPrompt).toBeNull();
  });
});
