import { promises as fs } from "node:fs";
import path from "node:path";
import { AGENT_ROLE_LABELS, AGENT_ROLE_NAMES, definitionFor } from "./agent-definition.js";
import { agentProfileFor } from "./agent-profiles.js";
import type { AgentProfileId, AgentRole } from "./types.js";

/**
 * 可编辑架构图文档：
 * 一张 节点（tier / gate / role）+ 边（tier-gate 带序 / gate-role）的图，
 * 存放在工作区 `.meowcode/harness.json`，用户可随意增删改；
 * WorkflowRuntime 按这张图驱动门禁序列、角色绑定与失败回跳。
 *
 * 校验只管结构契约（版本 / id 唯一 / 边端点存在 / loop-to 目标存在），
 * 故意删掉 G6 或 reviewer 不算错误 —— 那是用户的架构决策，admit 时按图执行即可。
 */

export const HARNESS_DOCUMENT_VERSION = 1 as const;
export const HARNESS_FILE_NAME = "harness.json";
/** 每个主 Agent 的独立架构图目录 */
export const HARNESS_DIR_NAME = "harness";

export type HarnessNodeType = "agent" | "tier" | "gate" | "role";
export type HarnessEdgeType =
  | "agent-tier"
  | "agent-role"
  | "tier-gate"
  | "gate-role"
  | "role-delegation"
  | string;

export type HarnessGateOnFail = "block" | `loop-to:${string}`;

/** 主 Agent（根 runtime）节点：只用于拓扑展示，不参与门禁推导。 */
export interface HarnessAgentData {
  id: string;
  name: string;
  description?: string;
  /**
   * 覆盖工具白名单；缺省 = 跟随当前档位（standard 全量 / minimal 仅 read_file + run_command）。
   * 与 role 节点不同，主 Agent 允许包含 task / admit 这类编排通道。
   */
  tools?: string[];
  /**
   * 覆盖系统提示词；缺省或空串 = 用当前档位的提示词。
   * 注意是「整体替换」而不是追加——填了就不再带档位那份基础提示词。
   */
  systemPrompt?: string;
}

export interface HarnessTierData {
  id: string;
  name: string;
  description?: string;
}

export interface HarnessGateData {
  id: string;
  name: string;
  /** 门禁不变量的一句话描述（编辑器展示） */
  invariant?: string;
  /** 失败处理：block = lane 直接阻塞；loop-to:<gateId> = 回跳到指定门禁返工 */
  onFail?: HarnessGateOnFail;
}

export interface HarnessRoleData {
  id: string;
  name: string;
  description?: string;
  /** 内置角色类型；缺省 = 节点 id（兼容旧文档，允许同类型多个实例） */
  role?: AgentRole;
  /** 覆盖内置系统提示词；缺省或空串 = 用注册表 */
  systemPrompt?: string;
  /** 覆盖工具白名单；缺省 = 用注册表（空数组 = 不给工具） */
  tools?: string[];
}

export type HarnessNodeData =
  | HarnessAgentData
  | HarnessTierData
  | HarnessGateData
  | HarnessRoleData;

export interface HarnessNode {
  id: string;
  type: HarnessNodeType;
  data: HarnessNodeData;
  /** 图编辑器画布坐标；缺省由编辑器自动排布 */
  position?: { x: number; y: number };
}

export interface HarnessEdge {
  id: string;
  source: string;
  target: string;
  type?: HarnessEdgeType;
  /** tier-gate 边的执行顺序（1 起，同 tier 内升序即门禁序列） */
  order?: number;
}

export interface HarnessDocument {
  version: 1;
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  metadata?: {
    /** 架构图显示名（自定义 Agent 可改名；内置三档缺省用档位中文名） */
    name?: string;
    createdAt?: string;
    updatedAt?: string;
    description?: string;
  };
}

export interface HarnessValidationResult {
  valid: boolean;
  errors: string[];
}

/** 角色节点 id 必须命中内置角色注册表（真源在 agent-definition.ts）。 */
const BUILTIN_ROLE_IDS: ReadonlySet<string> = new Set(AGENT_ROLE_NAMES);

/**
 * 结构校验（metis 同款原则：只管结构，不管语义删减）。
 * 额外仅一条 MeowCode 特有约束：role 节点 id 必须命中内置角色注册表。
 */
export function validateHarnessDocument(doc: unknown): HarnessValidationResult {
  const errors: string[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { valid: false, errors: ["Document must be a JSON object."] };
  }
  const candidate = doc as Record<string, unknown>;
  if (candidate.version !== HARNESS_DOCUMENT_VERSION) {
    errors.push(`Document version must be ${HARNESS_DOCUMENT_VERSION}, got ${String(candidate.version)}.`);
  }
  if (!Array.isArray(candidate.nodes)) errors.push("Document 'nodes' must be an array.");
  if (!Array.isArray(candidate.edges)) errors.push("Document 'edges' must be an array.");
  if (errors.length > 0) return { valid: false, errors };

  const nodes = candidate.nodes as unknown[];
  const edges = candidate.edges as unknown[];
  const nodeIds = new Set<string>();

  nodes.forEach((node, index) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      errors.push(`Node at index ${index} must be an object.`);
      return;
    }
    const n = node as Record<string, unknown>;
    if (typeof n.id !== "string" || !n.id.trim()) {
      errors.push(`Node at index ${index} is missing a non-empty string 'id'.`);
      return;
    }
    if (nodeIds.has(n.id)) errors.push(`Duplicate node id "${n.id}".`);
    nodeIds.add(n.id);
    if (n.type !== "agent" && n.type !== "tier" && n.type !== "gate" && n.type !== "role") {
      errors.push(
        `Node "${n.id}" has invalid type "${String(n.type)}". Expected "agent", "tier", "gate", or "role".`,
      );
    }
    const data = n.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      errors.push(`Node "${n.id}" is missing an object 'data' payload.`);
      return;
    }
    const d = data as Record<string, unknown>;
    if (typeof d.name !== "string" || !d.name.trim()) {
      errors.push(`Node "${n.id}" must have a non-empty string 'name' in data.`);
    }
    if (n.type === "role") {
      if (d.role !== undefined && typeof d.role !== "string") {
        errors.push(`Role node "${n.id}" 'role' must be a string if defined.`);
      }
      const roleType = typeof d.role === "string" ? d.role : n.id;
      if (!BUILTIN_ROLE_IDS.has(roleType)) {
        errors.push(
          `Role node "${n.id}" must reference a builtin role (${[...BUILTIN_ROLE_IDS].join(", ")}).`,
        );
      }
      if (d.systemPrompt !== undefined && typeof d.systemPrompt !== "string") {
        errors.push(`Role node "${n.id}" 'systemPrompt' must be a string if defined.`);
      }
      if (d.tools !== undefined) {
        if (
          !Array.isArray(d.tools) ||
          d.tools.some((tool) => typeof tool !== "string" || !tool.trim())
        ) {
          errors.push(`Role node "${n.id}" 'tools' must be an array of non-empty strings if defined.`);
        }
      }
    }
    if (n.type === "gate" && d.onFail !== undefined) {
      if (typeof d.onFail !== "string") {
        errors.push(`Gate node "${n.id}" 'onFail' must be a string if defined.`);
      } else if (d.onFail !== "block" && !d.onFail.startsWith("loop-to:")) {
        errors.push(`Gate node "${n.id}" 'onFail' must be "block" or "loop-to:<nodeId>".`);
      }
    }
    if (n.position !== undefined) {
      const pos = n.position as Record<string, unknown> | null;
      if (!pos || typeof pos !== "object" || Array.isArray(pos)) {
        errors.push(`Node "${n.id}" 'position' must be an object with numeric x and y if defined.`);
      } else if (typeof pos.x !== "number" || typeof pos.y !== "number") {
        errors.push(`Node "${n.id}" 'position' coordinates (x, y) must be numbers.`);
      }
    }
  });

  // gate 的 loop-to 目标必须存在
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    if (n.type !== "gate" || !n.data || typeof n.data !== "object") continue;
    const onFail = (n.data as Record<string, unknown>).onFail;
    if (typeof onFail === "string" && onFail.startsWith("loop-to:")) {
      const target = onFail.slice("loop-to:".length).trim();
      if (!nodeIds.has(target)) {
        errors.push(`Gate node "${String(n.id)}" loop-to target "${target}" does not exist in nodes.`);
      }
    }
  }

  const edgeIds = new Set<string>();
  edges.forEach((edge, index) => {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
      errors.push(`Edge at index ${index} must be an object.`);
      return;
    }
    const e = edge as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id.trim()) {
      errors.push(`Edge at index ${index} is missing a non-empty string 'id'.`);
      return;
    }
    if (edgeIds.has(e.id)) errors.push(`Duplicate edge id "${e.id}".`);
    edgeIds.add(e.id);
    if (typeof e.source !== "string" || !nodeIds.has(e.source)) {
      errors.push(`Edge "${e.id}" source "${String(e.source)}" does not exist in nodes.`);
    }
    if (typeof e.target !== "string" || !nodeIds.has(e.target)) {
      errors.push(`Edge "${e.id}" target "${String(e.target)}" does not exist in nodes.`);
    }
    if (e.order !== undefined && typeof e.order !== "number") {
      errors.push(`Edge "${e.id}" 'order' must be a number if defined.`);
    }
  });

  return { valid: errors.length === 0, errors };
}

/** 每个档位的根节点文案：一张架构图对应一个主 Agent。 */
const PROFILE_ROOT: Record<AgentProfileId, { name: string; description: string }> = {
  standard: {
    name: "标准 Agent",
    description:
      "根 AgentRuntime（标准档）：薄循环 + 厚宿主；负责会话、审批、工具调度与子 Agent 编排",
  },
  minimal: {
    name: "极简 Agent",
    description:
      "根 AgentRuntime（极简档）：只有 read_file / run_command；子 Agent 仅通用 / Explore，无门禁",
  },
  complex: {
    name: "复杂 Agent",
    description: "根 AgentRuntime（复杂档）：先规划，再并行实现，逐关独立评审与验证",
  },
};

type SeedRole = { id: AgentRole; name: string; description: string };

const SUPPORT_ROLES: SeedRole[] = [
  {
    id: "general",
    name: "通用",
    description:
      "自包含任务全权处理：可编辑文件、运行命令，也承载 MCP / 浏览器工具",
  },
  {
    id: "explore",
    name: "探索",
    description: "只读检索与探索，成本最低；批量搜索、读文件后只回传结论与路径",
  },
  {
    id: "planner",
    name: "规划",
    description: "只读调研后产出带文件路径的排序工作项，并列出风险与验证方式",
  },
];

const GATE_ROLES: SeedRole[] = [
  {
    id: "implementer",
    name: "实现",
    description:
      "按 TDD 实现一个 lane：先写失败测试，再改代码通过；报告前必须真实运行验证，只改所属路径",
  },
  {
    id: "reviewer",
    name: "评审",
    description:
      "独立评审改动的正确性、边界、安全与一致性；输出 severity + file:line 的 findings，有关键问题必须打回",
  },
  {
    id: "verifier",
    name: "验证",
    description:
      "真实执行验证命令，逐条报告退出码与决定性输出；不能改文件或弱化测试，失败即门禁失败",
  },
];

const SEED_GATES: Array<{ id: string; name: string; invariant: string; onFail?: string }> = [
  { id: "G4", name: "实现", invariant: "宿主观测到真实文件改动；模型自述完成不算通过" },
  {
    id: "G5",
    name: "独立评审",
    invariant: "评审完成且无 critical findings；关账者必须独立于实现者",
    onFail: "loop-to:G4",
  },
  {
    id: "G6",
    name: "验证",
    invariant: "验证命令真实执行且全部退出码 0；未运行或失败即不通过",
    onFail: "loop-to:G4",
  },
];

const SEED_TIERS: Array<{ id: string; name: string; description: string }> = [
  { id: "T0", name: "琐碎任务", description: "无门禁：疑问、机械修改或单条命令；admit 后直接完成并留审计" },
  { id: "T1", name: "单车道", description: "一个聚焦的功能或修复；主 Agent 实现后，独立评审与验证再关门" },
  { id: "T2", name: "并行车道", description: "多个不相交 lane + 依赖 DAG；每条 lane 走完整 G4→G5→G6" },
];

/**
 * 极简档种子：只有根节点 + 通用 / Explore，没有层级与门禁
 * （极简档的工具集里没有实现/评审/验证角色，门禁无处关账）。
 */
function minimalHarnessSeed(): HarnessDocument {
  const nodes: HarnessNode[] = [
    {
      id: "main",
      type: "agent",
      data: { id: "main", ...PROFILE_ROOT.minimal },
      position: { x: 40, y: 180 },
    },
    {
      id: "general",
      type: "role",
      data: {
        id: "general",
        name: "通用",
        description: "自包含任务：用命令行读写文件，也承载 MCP / 浏览器工具",
        role: "general",
      },
      position: { x: 400, y: 100 },
    },
    {
      id: "explore",
      type: "role",
      data: {
        id: "explore",
        name: AGENT_ROLE_LABELS.explore,
        description: "只读检索与探索，成本最低；批量搜索、读文件后只回传结论与路径",
        role: "explore",
      },
      position: { x: 400, y: 230 },
    },
  ];
  const edges: HarnessEdge[] = [
    { id: "main-general", source: "main", target: "general", type: "agent-role" },
    { id: "main-explore", source: "main", target: "explore", type: "agent-role" },
  ];
  return {
    version: 1,
    nodes,
    edges,
    metadata: {
      description:
        "MeowCode 内置极简 Agent 架构：两个工具（read_file / run_command），无门禁，只有通用 / Explore 两个子 Agent",
    },
  };
}

/**
 * 复杂档的 Metis 式门禁拓扑（参考 metis-main 的 builtin-harness.ts）：
 * G0 基线 → G1 规划 → G2 范围 → G3.5 深挖 → G4 实现 → G5 评审 → G6 独立复验
 * → G7 终审 → sweep 收敛 → goal-check 目标核对；每道门禁绑一个独立角色。
 */
const COMPLEX_GATES: Array<{
  id: string;
  name: string;
  invariant: string;
  onFail?: string;
  y: number;
}> = [
  {
    id: "G0",
    name: "基线",
    invariant: "未改动的仓库先跑通既有检查，拿到基线；跑不通就不许开工",
    y: 520,
  },
  {
    id: "G1",
    name: "规划",
    invariant: "工作项带文件路径与验证方式；关键设计分叉必须先定，不许边做边改",
    y: 640,
  },
  {
    id: "G2",
    name: "范围",
    invariant: "改动边界写死：可改路径、不可碰的契约、明确不做的部分",
    y: 760,
  },
  {
    id: "G3.5",
    name: "深挖锁定",
    invariant: "计划依赖的假设逐条证实/证伪，未解未知不许进入实现",
    y: 880,
  },
  {
    id: "G4",
    name: "实现",
    invariant: "宿主观测到真实文件改动；模型自述完成不算通过",
    y: 1000,
  },
  {
    id: "G5",
    name: "评审",
    invariant: "评审完成且无 critical findings；关账者必须独立于实现者",
    onFail: "loop-to:G4",
    y: 1120,
  },
  {
    id: "G6",
    name: "独立复验",
    invariant: "没参与实现的角色自己跑检查，退出码全 0；未运行即不通过",
    onFail: "loop-to:G4",
    y: 1240,
  },
  {
    id: "G7",
    name: "终审",
    invariant: "default-FAIL：每条结论都靠亲手打开的证据翻成 PASS，含糊即 FAIL",
    onFail: "loop-to:G4",
    y: 1360,
  },
  {
    id: "sweep",
    name: "收敛清扫",
    invariant: "同改动的调用方/兄弟模块一起看，没有漏改的调用点与残留死代码",
    onFail: "loop-to:G4",
    y: 1480,
  },
  {
    id: "goal-check",
    name: "目标核对",
    invariant: "用户每条诉求逐条对证据，未验证即未达成",
    y: 1600,
  },
];

/** 门禁 → 关账角色（metis 的 gateRoleAssignments 同构）。 */
const COMPLEX_GATE_ROLES: Array<{ gate: string; role: AgentRole; y: number }> = [
  { gate: "G0", role: "verifier", y: 520 },
  { gate: "G1", role: "planner", y: 640 },
  { gate: "G2", role: "scoper", y: 760 },
  { gate: "G3.5", role: "depth-prober", y: 880 },
  { gate: "G4", role: "implementer", y: 1000 },
  { gate: "G5", role: "reviewer", y: 1120 },
  { gate: "G6", role: "fresh-verifier", y: 1240 },
  { gate: "G7", role: "juror", y: 1360 },
  { gate: "sweep", role: "sweeper", y: 1480 },
  { gate: "goal-check", role: "goal-checker", y: 1600 },
];

/** 复杂档门禁角色的人话说明（种子图节点描述）。 */
const COMPLEX_ROLE_DESCRIPTIONS: Record<string, string> = {
  planner: "只读调研后产出带文件路径的排序工作项（G1 规划）",
  scoper: "写死改动边界：可改路径、不可碰的契约、明确不做的部分（G2 范围）",
  "depth-prober": "把计划依赖的假设逐条证实或证伪，未解未知不许进入实现（G3.5 深挖锁定）",
  implementer: "按 TDD 实现一个 lane：先写失败测试，再改代码通过（G4 实现）",
  reviewer: "独立评审正确性、边界、安全与一致性，输出 severity + file:line（G5 评审）",
  verifier: "先跑既有检查拿基线，再报告退出码（G0 基线）",
  "fresh-verifier": "没参与实现的人自己复跑全部检查，只认退出码（G6 独立复验）",
  juror: "default-FAIL 终审：每条结论都要亲手打开证据才翻 PASS（G7 终审）",
  sweeper: "清扫调用方与兄弟模块：漏改的调用点、半截重命名、残留死代码（sweep 收敛）",
  "goal-checker": "把用户原始诉求逐条对证据，未验证即未达成（goal-check 目标核对）",
};

/**
 * 复杂档种子：metis 式完整门禁链（10 道门禁 / 10 个关账角色），
 * 与标准档（G4→G5→G6 三道）明显不同。
 */
function complexHarnessSeed(): HarnessDocument {
  const supportRoles: AgentRole[] = ["general", "explore"];
  const nodes: HarnessNode[] = [
    {
      id: "main",
      type: "agent",
      data: { id: "main", ...PROFILE_ROOT.complex },
      position: { x: 40, y: 1000 },
    },
    ...supportRoles.map((role, index) => ({
      id: role,
      type: "role" as const,
      data: {
        id: role,
        name: AGENT_ROLE_LABELS[role],
        description:
          role === "general"
            ? "自包含任务全权处理：可编辑文件、运行命令，也承载 MCP / 浏览器工具"
            : role === "explore"
              ? "只读检索与探索，成本最低；批量搜索、读文件后只回传结论与路径"
              : "自定义角色：提示词与工具白名单在节点面板里配置",
        role,
      },
      position: { x: 400, y: 40 + index * 120 },
    })),
    ...SEED_TIERS.map((tier, index) => ({
      id: tier.id,
      type: "tier" as const,
      data: { id: tier.id, name: tier.name, description: tier.description },
      position: { x: 400, y: 560 + index * 200 },
    })),
    ...COMPLEX_GATES.map((gate) => ({
      id: gate.id,
      type: "gate" as const,
      data: {
        id: gate.id,
        name: gate.name,
        invariant: gate.invariant,
        ...(gate.onFail ? { onFail: gate.onFail as HarnessGateOnFail } : {}),
      },
      position: { x: 760, y: gate.y },
    })),
    ...COMPLEX_GATE_ROLES.map(({ role, y }) => ({
      id: role,
      type: "role" as const,
      data: {
        id: role,
        name: AGENT_ROLE_LABELS[role],
        description: COMPLEX_ROLE_DESCRIPTIONS[role] ?? "",
        role,
      },
      position: { x: 1120, y },
    })),
  ];

  const edges: HarnessEdge[] = [
    ...supportRoles.map((role) => ({
      id: `main-${role}`,
      source: "main",
      target: role,
      type: "agent-role",
    })),
    ...SEED_TIERS.map((tier) => ({
      id: `main-${tier.id}`,
      source: "main",
      target: tier.id,
      type: "agent-tier",
    })),
  ];

  // T1（单车道）：基线 → 实现 → 评审 → 复验 → 目标核对
  const t1Sequence = ["G0", "G4", "G5", "G6", "goal-check"];
  // T2（并行车道）：完整 metis 链
  const t2Sequence = [
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
  ];
  for (const [tierId, sequence] of [
    ["T1", t1Sequence],
    ["T2", t2Sequence],
  ] as const) {
    sequence.forEach((gateId, index) => {
      edges.push({
        id: `${tierId}-${gateId}`,
        source: tierId,
        target: gateId,
        type: "tier-gate",
        order: index + 1,
      });
    });
  }
  for (const { gate, role } of COMPLEX_GATE_ROLES) {
    edges.push({
      id: `${gate}-${role}`,
      source: gate,
      target: role,
      type: "gate-role",
    });
  }
  // 编排链路（展示用）：规划产物交给实现；评审/终审打回实现返工
  edges.push(
    { id: "planner-implementer", source: "planner", target: "implementer", type: "role-delegation" },
    { id: "reviewer-implementer", source: "reviewer", target: "implementer", type: "role-delegation" },
    { id: "juror-implementer", source: "juror", target: "implementer", type: "role-delegation" },
  );

  return {
    version: 1,
    nodes,
    edges,
    metadata: {
      description:
        "MeowCode 内置复杂 Agent 架构：T1 走 G0→G4→G5→G6→goal-check，T2 走 G0→G1→G2→G3.5→G4→G5→G6→G7→sweep→goal-check",
    },
  };
}

/**
 * 内置种子（每个档位一张独立架构图）：
 * - standard：标准 Agent →（task）general / explore / planner；T0/T1/T2 → G4→G5→G6 → implementer/reviewer/verifier。
 * - minimal：极简 Agent → general / explore，无层级与门禁。
 * - complex：Metis 式十道门禁（G0/G1/G2/G3.5/G4/G5/G6/G7/sweep/goal-check）+ 十个关账角色。
 * 坐标按「主 Agent 列 → 角色/层级列 → 门禁列 → 关账角色列」排布，可直接拖动。
 */
export function builtinHarnessSeed(profile: AgentProfileId = "standard"): HarnessDocument {
  if (profile === "minimal") return minimalHarnessSeed();
  if (profile === "complex") return complexHarnessSeed();

  const nodes: HarnessNode[] = [
    {
      id: "main",
      type: "agent",
      data: { id: "main", ...PROFILE_ROOT.standard },
      position: { x: 40, y: 480 },
    },
    ...SUPPORT_ROLES.map((role, index) => ({
      id: role.id,
      type: "role" as const,
      data: { id: role.id, name: role.name, description: role.description, role: role.id },
      position: { x: 400, y: 20 + index * 110 },
    })),
    ...SEED_TIERS.map((tier, index) => ({
      id: tier.id,
      type: "tier" as const,
      data: { id: tier.id, name: tier.name, description: tier.description },
      position: { x: 400, y: 480 + index * 170 },
    })),
    ...SEED_GATES.map((gate, index) => ({
      id: gate.id,
      type: "gate" as const,
      data: {
        id: gate.id,
        name: gate.name,
        invariant: gate.invariant,
        ...(gate.onFail ? { onFail: gate.onFail as HarnessGateOnFail } : {}),
      },
      position: { x: 760, y: 480 + index * 170 },
    })),
    ...GATE_ROLES.map((role, index) => ({
      id: role.id,
      type: "role" as const,
      data: { id: role.id, name: role.name, description: role.description, role: role.id },
      position: { x: 1120, y: 480 + index * 170 },
    })),
  ];

  const edges: HarnessEdge[] = [
    ...SUPPORT_ROLES.map((role) => ({
      id: `main-${role.id}`,
      source: "main",
      target: role.id,
      type: "agent-role",
    })),
    ...SEED_TIERS.map((tier) => ({
      id: `main-${tier.id}`,
      source: "main",
      target: tier.id,
      type: "agent-tier",
    })),
  ];
  const addSeq = (tierId: string) => {
    SEED_GATES.forEach((gate, index) => {
      edges.push({
        id: `${tierId}-${gate.id}`,
        source: tierId,
        target: gate.id,
        type: "tier-gate",
        order: index + 1,
      });
    });
  };
  addSeq("T1");
  addSeq("T2");
  edges.push(
    { id: "G4-implementer", source: "G4", target: "implementer", type: "gate-role" },
    { id: "G5-reviewer", source: "G5", target: "reviewer", type: "gate-role" },
    { id: "G6-verifier", source: "G6", target: "verifier", type: "gate-role" },
  );

  return {
    version: 1,
    nodes,
    edges,
    metadata: {
      description:
        "MeowCode 内置标准 Agent 架构：完整拓扑（子 Agent + T0/T1/T2 门禁；T1/T2 经 G4→G5→G6）",
    },
  };
}

function roleTypeOfNode(node: HarnessNode): string | undefined {
  if (node.type !== "role") return undefined;
  const role = (node.data as { role?: unknown }).role;
  return typeof role === "string" ? role : node.id;
}

/**
 * 补齐该档位可派发但图里没画出来的内置角色节点（只加不删）：
 * 架构图是"这个主 Agent 的完整装配"，缺角色会让人以为派不出。
 * custom 不补（它需要节点上自己配提示词/工具），用户删掉的层级/门禁/连线也不动。
 */
export function completeHarnessRoles(
  doc: HarnessDocument,
  profile: AgentProfileId,
): HarnessDocument {
  // custom 是"自己配一个角色"的入口，没有节点面板里的提示词/工具就是个空壳，不自动补
  const wanted = agentProfileFor(profile).roles.filter((role) => role !== "custom");
  const present = new Set(
    doc.nodes.map((node) => roleTypeOfNode(node)).filter((role): role is string => Boolean(role)),
  );
  const missing = wanted.filter((role) => !present.has(role));
  if (!missing.length) return doc;

  const root = doc.nodes.find((node) => node.type === "agent") ?? null;
  const roleYs = doc.nodes
    .filter((node) => node.type === "role" && (node.position?.x ?? 0) <= 520)
    .map((node) => node.position?.y ?? 0);
  let y = (roleYs.length ? Math.max(...roleYs) : 20) + 120;

  const nodes = [...doc.nodes];
  const edges = [...doc.edges];
  const nodeIds = new Set(doc.nodes.map((node) => node.id));
  const edgeIds = new Set(doc.edges.map((edge) => edge.id));

  for (const role of missing) {
    let id: string = role;
    let seq = 2;
    while (nodeIds.has(id)) {
      id = `${role}-${seq}`;
      seq += 1;
    }
    nodeIds.add(id);
    nodes.push({
      id,
      type: "role",
      data: {
        id,
        name: AGENT_ROLE_LABELS[role],
        description: `${definitionFor(role).description}（自动补齐：该档位可派发）`,
        role,
      },
      position: { x: 400, y },
    });
    y += 120;
    if (root) {
      let edgeId = `${root.id}-${id}`;
      let edgeSeq = 2;
      while (edgeIds.has(edgeId)) {
        edgeId = `${root.id}-${id}-${edgeSeq}`;
        edgeSeq += 1;
      }
      edgeIds.add(edgeId);
      edges.push({ id: edgeId, source: root.id, target: id, type: "agent-role" });
    }
  }

  return { ...doc, nodes, edges };
}

/** 每个主 Agent 一张独立架构图：.meowcode/harness/<id>.json（id 也可以是自定义架构） */
export function harnessFilePath(cwd: string, id: string = "standard"): string {
  return path.join(cwd, ".meowcode", HARNESS_DIR_NAME, `${id}.json`);
}

/** 架构图 id 允许的形态：小写字母数字与连字符（自定义架构用 custom-1 / custom-2 …） */
export const HARNESS_ARCHITECTURE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isHarnessArchitectureId(value: unknown): value is string {
  return typeof value === "string" && HARNESS_ARCHITECTURE_ID_RE.test(value);
}

/** 内置三档（运行时档位）；其余 id 都是用户自建的架构副本 */
export function isBuiltinHarnessId(id: string): id is AgentProfileId {
  return id === "standard" || id === "minimal" || id === "complex";
}

/** 左栏「主 Agent」列表项：内置三档 + 用户自建架构 */
export interface HarnessArchitectureSummary {
  id: string;
  /** 自定义架构的显示名；内置三档为 null（前端用本地档位中文名） */
  name: string | null;
  builtin: boolean;
}

/** 列出工作区里所有架构图：内置三档固定在最前，其余按文件名排序 */
export async function listHarnessArchitectures(cwd: string): Promise<HarnessArchitectureSummary[]> {
  const summaries: HarnessArchitectureSummary[] = (["standard", "minimal", "complex"] as const).map(
    (id) => ({ id, name: null, builtin: true }),
  );
  const dir = path.join(cwd, ".meowcode", HARNESS_DIR_NAME);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return summaries;
  }
  const custom: HarnessArchitectureSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!isHarnessArchitectureId(id) || isBuiltinHarnessId(id)) continue;
    let name: string | null = null;
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf8");
      const parsed: unknown = JSON.parse(raw);
      const meta = (parsed as { metadata?: { name?: unknown } }).metadata;
      if (meta && typeof meta.name === "string" && meta.name.trim()) name = meta.name.trim();
    } catch {
      // 文件损坏也列出来，名字回退成 id，用户可以在编辑器里修
    }
    custom.push({ id, name, builtin: false });
  }
  custom.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return [...summaries, ...custom];
}

/**
 * 把架构名写进根 agent 节点（优先 id=main，否则取第一个 agent 节点）。
 * 自定义架构里「架构名」与「主 Agent 节点名」是同一个名字，左栏列表读 metadata.name。
 */
function withRootAgentName(doc: HarnessDocument, name: string): HarnessDocument {
  const root =
    doc.nodes.find((node) => node.type === "agent" && node.id === "main") ??
    doc.nodes.find((node) => node.type === "agent");
  if (!root) return doc;
  return {
    ...doc,
    nodes: doc.nodes.map((node) =>
      node.id === root.id ? { ...node, data: { ...node.data, name } } : node,
    ),
  };
}

/**
 * 新建一张架构图（默认复制标准 Agent 的图）。
 * 生成 custom-1 / custom-2 … 的 id，写盘后返回新图，前端直接切过去。
 */
export async function createHarnessArchitecture(
  cwd: string,
  options: { name?: string; cloneFrom?: string } = {},
): Promise<{ id: string; name: string; document: HarnessDocument }> {
  const dir = path.join(cwd, ".meowcode", HARNESS_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  let seq = 1;
  let id = `custom-${seq}`;
  for (;;) {
    try {
      await fs.access(harnessFilePath(cwd, id));
      seq += 1;
      id = `custom-${seq}`;
    } catch {
      break;
    }
  }
  const cloneFrom = options.cloneFrom && isHarnessArchitectureId(options.cloneFrom)
    ? options.cloneFrom
    : "standard";
  const source = await loadHarnessDocument(cwd, cloneFrom);
  const name = (options.name ?? "").trim() || "自定义 Agent";
  // 架构名同时写进主 Agent 节点名：画布、属性面板、左栏列表三处一致
  const document: HarnessDocument = withRootAgentName(
    {
      ...source,
      metadata: {
        ...source.metadata,
        name,
        createdAt: new Date().toISOString(),
      },
    },
    name,
  );
  await fs.writeFile(harnessFilePath(cwd, id), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { id, name, document };
}

/** 给自定义架构改名（内置三档不允许改）。返回 false 表示 id 非法或不存在。 */
export async function renameHarnessArchitecture(
  cwd: string,
  id: string,
  name: string,
): Promise<boolean> {
  if (!isHarnessArchitectureId(id) || isBuiltinHarnessId(id)) return false;
  const filePath = harnessFilePath(cwd, id);
  let document: HarnessDocument;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!validateHarnessDocument(parsed).valid) return false;
    document = parsed as HarnessDocument;
  } catch {
    return false;
  }
  const trimmed = name.trim() || "自定义 Agent";
  const next: HarnessDocument = withRootAgentName(
    {
      ...document,
      metadata: { ...document.metadata, name: trimmed, updatedAt: new Date().toISOString() },
    },
    trimmed,
  );
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return true;
}

/** 删除自定义架构（内置三档不允许删）。 */
export async function deleteHarnessArchitecture(cwd: string, id: string): Promise<boolean> {
  if (!isHarnessArchitectureId(id) || isBuiltinHarnessId(id)) return false;
  try {
    await fs.unlink(harnessFilePath(cwd, id));
    return true;
  } catch {
    return false;
  }
}

/** 旧版单图路径：升级前的 .meowcode/harness.json，作为标准 Agent 的兼容来源 */
export function legacyHarnessFilePath(cwd: string): string {
  return path.join(cwd, ".meowcode", HARNESS_FILE_NAME);
}

/**
 * 读取工作区架构图：文件缺失或结构非法时回退内置种子（非法文件打印告警）。
 * 每个治理 run 开始时取一次快照（run 中冻结，metis 同款）。
 */
export async function loadHarnessDocument(
  cwd: string,
  id: string = "standard",
): Promise<HarnessDocument> {
  // 自定义架构（custom-*）在门禁/角色补齐上按标准档位处理
  const builtin: AgentProfileId = isBuiltinHarnessId(id) ? id : "standard";
  // 标准 Agent 额外回退到旧版单图（升级前的 .meowcode/harness.json）
  const candidates = [harnessFilePath(cwd, id)];
  if (id === "standard") candidates.push(legacyHarnessFilePath(cwd));
  for (const filePath of candidates) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const result = validateHarnessDocument(parsed);
      if (result.valid) return completeHarnessRoles(parsed as HarnessDocument, builtin);
      console.error(
        `[meowcode] ignoring invalid harness document (${filePath}):\n- ${result.errors.join("\n- ")}`,
      );
    } catch {
      // 文件不存在：正常路径，继续下一个候选 / 用内置种子
    }
  }
  return completeHarnessRoles(builtinHarnessSeed(builtin), builtin);
}

/** 校验并落盘；返回校验结果（invalid 时不写文件）。 */
export async function saveHarnessDocument(
  cwd: string,
  doc: unknown,
  id: string = "standard",
): Promise<HarnessValidationResult> {
  const result = validateHarnessDocument(doc);
  if (!result.valid) return result;
  const filePath = harnessFilePath(cwd, id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const document = doc as HarnessDocument;
  // 有架构名就保证主 Agent 节点名与之一致（画布改名、列表改名都不会分叉）
  const declaredName = document.metadata?.name?.trim();
  const named = declaredName ? withRootAgentName(document, declaredName) : document;
  const withMeta: HarnessDocument = {
    ...named,
    metadata: {
      ...named.metadata,
      updatedAt: new Date().toISOString(),
    },
  };
  await fs.writeFile(filePath, `${JSON.stringify(withMeta, null, 2)}\n`, "utf8");
  return { valid: true, errors: [] };
}
