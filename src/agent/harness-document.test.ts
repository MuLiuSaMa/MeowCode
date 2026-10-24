import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  builtinHarnessSeed,
  harnessFilePath,
  legacyHarnessFilePath,
  loadHarnessDocument,
  saveHarnessDocument,
  validateHarnessDocument,
} from "./harness-document.js";
import { WorkflowRuntime } from "./workflow-runtime.js";
import type { ChildResult } from "./child-result.js";

function childResult(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    status: "completed",
    summary: "ok",
    findings: [],
    filesChanged: [],
    commands: [],
    valid: true,
    ...overrides,
  };
}

describe("harness 文档结构校验", () => {
  it("内置种子合法", () => {
    expect(validateHarnessDocument(builtinHarnessSeed())).toEqual({ valid: true, errors: [] });
  });

  it("内置种子是完整 Agent 拓扑：主 Agent + 子 Agent", () => {
    const seed = builtinHarnessSeed();
    expect(seed.nodes.filter((node) => node.type === "agent").map((node) => node.id)).toEqual([
      "main",
    ]);
    expect(
      seed.nodes
        .filter((node) => node.type === "role")
        .map((node) => node.id)
        .sort(),
    ).toEqual(["explore", "general", "implementer", "planner", "reviewer", "verifier"]);
    expect(seed.edges.some((edge) => edge.type === "agent-role")).toBe(true);
    expect(seed.edges.some((edge) => edge.type === "agent-tier")).toBe(true);
  });

  it("版本 / 数组 / 重复 id / 悬空边 / 非法角色 全部拒绝", () => {
    expect(validateHarnessDocument({ version: 2, nodes: [], edges: [] }).valid).toBe(false);
    expect(validateHarnessDocument(null).valid).toBe(false);
    expect(
      validateHarnessDocument({
        version: 1,
        nodes: [
          { id: "G4", type: "gate", data: { id: "G4", name: "实现" } },
          { id: "G4", type: "gate", data: { id: "G4", name: "重复" } },
        ],
        edges: [],
      }).errors.join("\n"),
    ).toContain("Duplicate node id");
    expect(
      validateHarnessDocument({
        version: 1,
        nodes: [{ id: "G4", type: "gate", data: { id: "G4", name: "实现" } }],
        edges: [{ id: "e1", source: "G4", target: "ghost", type: "gate-role" }],
      }).errors.join("\n"),
    ).toContain('target "ghost" does not exist');
    expect(
      validateHarnessDocument({
        version: 1,
        nodes: [{ id: "wizard", type: "role", data: { id: "wizard", name: "法师" } }],
        edges: [],
      }).errors.join("\n"),
    ).toContain("must reference a builtin role");
  });

  it("角色节点允许 tools / systemPrompt 覆盖，但类型必须正确", () => {
    const roleDoc = (data: Record<string, unknown>) => ({
      version: 1,
      nodes: [{ id: "implementer", type: "role", data: { id: "implementer", name: "实现", ...data } }],
      edges: [],
    });
    expect(
      validateHarnessDocument(roleDoc({ tools: ["read_file"], systemPrompt: "custom" })),
    ).toEqual({ valid: true, errors: [] });
    expect(validateHarnessDocument(roleDoc({ tools: "read_file" })).valid).toBe(false);
    expect(validateHarnessDocument(roleDoc({ tools: ["read_file", 1] })).valid).toBe(false);
    expect(validateHarnessDocument(roleDoc({ systemPrompt: 42 })).valid).toBe(false);
  });

  it("角色节点 id 可以自定义，data.role 指定内置角色类型", () => {
    const node = (role: unknown) => ({
      version: 1,
      nodes: [
        {
          id: "role-2",
          type: "role",
          data: { id: "role-2", name: "实现副本", role },
        },
      ],
      edges: [],
    });
    expect(validateHarnessDocument(node("implementer"))).toEqual({ valid: true, errors: [] });
    expect(validateHarnessDocument(node("wizard")).valid).toBe(false);
    expect(validateHarnessDocument(node(42)).valid).toBe(false);
  });

  it("故意删掉 G6/reviewer 不算错误（结构校验不管语义删减，metis 同款）", () => {
    const seed = builtinHarnessSeed();
    const pruned = {
      version: 1 as const,
      nodes: seed.nodes.filter((node) => node.id !== "G6" && node.id !== "verifier"),
      edges: seed.edges.filter((edge) => edge.source !== "G6" && edge.target !== "G6" && edge.target !== "verifier"),
    };
    expect(validateHarnessDocument(pruned).valid).toBe(true);
  });

  it("loop-to 目标不存在 / onFail 非法拒绝", () => {
    expect(
      validateHarnessDocument({
        version: 1,
        nodes: [{ id: "G5", type: "gate", data: { id: "G5", name: "评审", onFail: "loop-to:G9" } }],
        edges: [],
      }).errors.join("\n"),
    ).toContain('loop-to target "G9" does not exist');
    expect(
      validateHarnessDocument({
        version: 1,
        nodes: [{ id: "G5", type: "gate", data: { id: "G5", name: "评审", onFail: "explode" } }],
        edges: [],
      }).valid,
    ).toBe(false);
  });
});

describe("每个主 Agent 一张独立架构图", () => {
  const roleIds = (doc: ReturnType<typeof builtinHarnessSeed>) =>
    doc.nodes.filter((node) => node.type === "role").map((node) => node.id).sort();

  it("三档种子各自合法且拓扑不同", () => {
    const standard = builtinHarnessSeed("standard");
    const minimal = builtinHarnessSeed("minimal");
    const complex = builtinHarnessSeed("complex");
    for (const doc of [standard, minimal, complex]) {
      expect(validateHarnessDocument(doc)).toEqual({ valid: true, errors: [] });
    }

    expect(roleIds(standard)).toEqual([
      "explore",
      "general",
      "implementer",
      "planner",
      "reviewer",
      "verifier",
    ]);
    // 极简档没有实现/评审/验证角色，也就没有门禁
    expect(roleIds(minimal)).toEqual(["explore", "general"]);
    expect(minimal.nodes.filter((node) => node.type === "gate")).toEqual([]);
    expect(minimal.nodes.filter((node) => node.type === "tier")).toEqual([]);

    // 复杂档 = metis 式十道门禁 + 十个关账角色（与标准档明显不同）
    const complexGates = complex.nodes.filter((node) => node.type === "gate").map((node) => node.id);
    expect(complexGates).toEqual([
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
    expect(roleIds(complex)).toEqual([
      "depth-prober",
      "explore",
      "fresh-verifier",
      "general",
      "goal-checker",
      "implementer",
      "juror",
      "planner",
      "reviewer",
      "scoper",
      "sweeper",
      "verifier",
    ]);
    // 标准档只有三道门禁
    expect(standard.nodes.filter((node) => node.type === "gate").map((node) => node.id)).toEqual([
      "G4",
      "G5",
      "G6",
    ]);
    expect(complex.edges.filter((edge) => edge.type === "role-delegation")).toHaveLength(3);
    expect(standard.edges.filter((edge) => edge.type === "role-delegation")).toHaveLength(0);

    // T1 走 5 道门禁、T2 走完整 10 道（order 升序）
    const seq = (doc: typeof complex, tier: string) =>
      doc.edges
        .filter((edge) => edge.type === "tier-gate" && edge.source === tier)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((edge) => edge.target);
    expect(seq(complex, "T1")).toEqual(["G0", "G4", "G5", "G6", "goal-check"]);
    expect(seq(complex, "T2")).toEqual(complexGates);

    // 根节点名字跟着档位走
    const rootName = (doc: ReturnType<typeof builtinHarnessSeed>) =>
      (doc.nodes.find((node) => node.type === "agent")?.data as { name?: string }).name;
    expect(rootName(standard)).toBe("标准 Agent");
    expect(rootName(minimal)).toBe("极简 Agent");
    expect(rootName(complex)).toBe("复杂 Agent");
  });

  it("各档位的图存到各自文件，互不覆盖", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-harness-"));
    const minimal = builtinHarnessSeed("minimal");
    minimal.metadata = { description: "minimal edited" };
    expect((await saveHarnessDocument(dir, minimal, "minimal")).valid).toBe(true);

    // 极简图不影响标准档：标准档仍是自己的种子
    expect((await loadHarnessDocument(dir, "standard")).metadata?.description).toContain("标准");
    expect((await loadHarnessDocument(dir, "minimal")).metadata?.description).toBe("minimal edited");
    expect(harnessFilePath(dir, "minimal")).toContain(path.join("harness", "minimal.json"));
    expect(harnessFilePath(dir, "standard")).toContain(path.join("harness", "standard.json"));
  });

  it("旧版单图作为标准档的兼容来源，其他档位不受影响", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-harness-"));
    const legacy = builtinHarnessSeed("standard");
    legacy.metadata = { description: "legacy graph" };
    await mkdir(path.dirname(legacyHarnessFilePath(dir)), { recursive: true });
    await writeFile(legacyHarnessFilePath(dir), JSON.stringify(legacy), "utf8");

    expect((await loadHarnessDocument(dir, "standard")).metadata?.description).toBe("legacy graph");
    expect((await loadHarnessDocument(dir, "minimal")).metadata?.description).toContain("极简");
  });
});

describe("架构图完整性（角色节点自动补齐）", () => {
  it("图上缺角色时补节点并接到根节点，只加不删", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-harness-"));
    const partial = {
      version: 1,
      nodes: [
        { id: "main", type: "agent", data: { id: "main", name: "标准 Agent" } },
        { id: "general", type: "role", data: { id: "general", name: "通用", role: "general" } },
      ],
      edges: [{ id: "main-general", source: "main", target: "general", type: "agent-role" }],
    };
    await mkdir(path.dirname(harnessFilePath(dir)), { recursive: true });
    await writeFile(harnessFilePath(dir), JSON.stringify(partial), "utf8");

    const doc = await loadHarnessDocument(dir, "standard");
    const roles = doc.nodes
      .filter((node) => node.type === "role")
      .map((node) => (node.data as { role?: string }).role ?? node.id)
      .sort();
    // 标准档 6 个内置角色齐全（原来只有 general）；custom 不自动补
    expect(roles).toEqual([
      "explore",
      "general",
      "implementer",
      "planner",
      "reviewer",
      "verifier",
    ]);
    // 补齐的节点都挂在根节点上，且名字是中文
    const added = doc.nodes.find(
      (node) => node.type === "role" && (node.data as { role?: string }).role === "planner",
    );
    expect((added?.data as { name?: string }).name).toBe("规划");
    expect(
      doc.edges.some((edge) => edge.source === "main" && edge.target === added?.id),
    ).toBe(true);
    // 用户已有的节点/边原样保留
    expect(doc.edges.some((edge) => edge.id === "main-general")).toBe(true);
  });

  it("极简档不会补出它派不出的角色", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-harness-"));
    const doc = await loadHarnessDocument(dir, "minimal");
    expect(
      doc.nodes
        .filter((node) => node.type === "role")
        .map((node) => (node.data as { role?: string }).role)
        .sort(),
    ).toEqual(["explore", "general"]);
  });

  it("种子里的角色名都是中文", () => {
    for (const profile of ["standard", "minimal", "complex"] as const) {
      for (const node of builtinHarnessSeed(profile).nodes) {
        if (node.type !== "role") continue;
        const name = (node.data as { name?: string }).name ?? "";
        expect(/[\u4e00-\u9fa5]/.test(name), `${profile}/${node.id} 名字应含中文`).toBe(true);
      }
    }
  });
});

describe("harness 读写", () => {
  it("文件缺失回退内置种子；非法文件告警回退", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-harness-"));
    expect((await loadHarnessDocument(dir)).metadata?.description).toContain("内置");
    await mkdir(path.dirname(harnessFilePath(dir)), { recursive: true });
    await writeFile(harnessFilePath(dir), "{ broken", "utf8");
    expect((await loadHarnessDocument(dir)).nodes.length).toBeGreaterThan(0);
  });

  it("保存合法文档；非法文档不落盘并返回错误", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-harness-"));
    const doc = builtinHarnessSeed();
    doc.metadata = { description: "edited" };
    const saved = await saveHarnessDocument(dir, doc);
    expect(saved.valid).toBe(true);
    const onDisk = JSON.parse(await readFile(harnessFilePath(dir), "utf8"));
    expect(onDisk.metadata.description).toBe("edited");
    expect(onDisk.metadata.updatedAt).toBeTruthy();

    // 空图（无节点无边）是合法的架构裁剪 —— 结构校验不拒绝；用悬空边测非法路径
    expect(await saveHarnessDocument(dir, { version: 1, nodes: [], edges: [] })).toEqual({
      valid: true,
      errors: [],
    });
    const bad = await saveHarnessDocument(dir, {
      version: 1,
      nodes: [],
      edges: [{ id: "e1", source: "G4", target: "ghost", type: "gate-role" }],
    });
    expect(bad.valid).toBe(false);
    // 非法文档不覆盖已保存内容（盘上仍是空图，而非悬空边版本）
    const afterBad = JSON.parse(await readFile(harnessFilePath(dir), "utf8"));
    expect(afterBad.nodes).toEqual([]);
    expect(afterBad.edges).toEqual([]);
  });
});

describe("自定义架构图驱动 WorkflowRuntime", () => {
  function customDoc() {
    return {
      version: 1 as const,
      nodes: [
        { id: "T1", type: "tier" as const, data: { id: "T1", name: "单车道" } },
        { id: "BUILD", type: "gate" as const, data: { id: "BUILD", name: "构建", onFail: "loop-to:BUILD" } },
        { id: "AUDIT", type: "gate" as const, data: { id: "AUDIT", name: "审计", onFail: "block" } },
        { id: "implementer", type: "role" as const, data: { id: "implementer", name: "实现" } },
        { id: "reviewer", type: "role" as const, data: { id: "reviewer", name: "评审" } },
      ],
      edges: [
        { id: "e1", source: "T1", target: "BUILD", type: "tier-gate", order: 2 },
        { id: "e2", source: "T1", target: "AUDIT", type: "tier-gate", order: 1 },
        { id: "e3", source: "BUILD", target: "implementer", type: "gate-role" },
        { id: "e4", source: "AUDIT", target: "reviewer", type: "gate-role" },
      ],
    };
  }

  it("order 决定门禁序列：AUDIT(1) 在 BUILD(2) 前；角色按 gate-role 边绑定", async () => {
    const workflow = new WorkflowRuntime({ harness: customDoc() });
    const admitted = workflow.admit({ tier: "T1", task_shape: "x" });
    expect(admitted.ok).toBe(true);
    expect(admitted.ok && admitted.report).toContain("AUDIT(审计, by reviewer) → BUILD(构建, by implementer)");

    // 第一道门禁是 AUDIT：reviewer 先关，implementer 后关
    const early = workflow.applyChildGate({
      role: "implementer",
      agentId: "impl-1",
      childResult: childResult({ filesChanged: ["a.ts"] }),
    });
    expect(early.verdict).toBe("none");
    const audit = workflow.applyChildGate({
      role: "reviewer",
      agentId: "rev-1",
      childResult: childResult(),
    });
    expect(audit.gateId).toBe("AUDIT");
    expect(audit.verdict).toBe("pass");
    const build = workflow.applyChildGate({
      role: "implementer",
      agentId: "impl-1",
      childResult: childResult({ filesChanged: ["a.ts"] }),
    });
    expect(build.gateId).toBe("BUILD");
    expect(build.verdict).toBe("pass");
    expect(workflow.state?.completed).toBe(true);
  });

  it("onFail=block：门禁失败直接 blocked，不返工", () => {
    const workflow = new WorkflowRuntime({ harness: customDoc() });
    workflow.admit({ tier: "T1", task_shape: "x" });
    const failed = workflow.applyChildGate({
      role: "reviewer",
      agentId: "rev-1",
      childResult: childResult({
        status: "failed",
        findings: [{ severity: "critical", message: "broken" }],
      }),
    });
    expect(failed.verdict).toBe("fail");
    expect(failed.message).toContain("onFail=block");
    expect(workflow.state?.lanes[0]?.status).toBe("blocked");
    expect(workflow.stalled).toBe(true);
  });

  it("删掉 tier 的全部门禁边 → 该 tier 声明即完成（自由裁剪架构）", () => {
    const doc = builtinHarnessSeed();
    const trimmed = {
      version: 1 as const,
      nodes: doc.nodes,
      edges: doc.edges.filter((edge) => !(edge.type === "tier-gate" && edge.source === "T2")),
    };
    const workflow = new WorkflowRuntime({ harness: trimmed });
    const admitted = workflow.admit({ tier: "T2", task_shape: "y", lanes: [{ id: "a", objective: "o" }] });
    expect(admitted.ok).toBe(true);
    expect(workflow.state?.completed).toBe(true);
  });

  it("门禁缺 gate-role 绑定时 admit 拒绝并提示编辑器", () => {
    const doc = builtinHarnessSeed();
    const unbound = {
      version: 1 as const,
      nodes: doc.nodes,
      edges: doc.edges.filter((edge) => edge.target !== "verifier"),
    };
    const workflow = new WorkflowRuntime({ harness: unbound });
    const admitted = workflow.admit({ tier: "T1", task_shape: "x" });
    expect(admitted.ok).toBe(false);
    expect(!admitted.ok && admitted.error).toContain('gate "G6"');
  });

  it("setHarness：run 活跃时冻结不换图；非法文档拒收", () => {
    const workflow = new WorkflowRuntime();
    expect(workflow.setHarness({ version: 2, nodes: [], edges: [] })).toBe(false);
    workflow.admit({ tier: "T1", task_shape: "x" });
    expect(workflow.setHarness(customDoc())).toBe(false);
    workflow.reset();
    expect(workflow.setHarness(customDoc())).toBe(true);
  });
});
