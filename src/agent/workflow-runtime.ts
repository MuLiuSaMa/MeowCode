import type { ChildResult } from "./child-result.js";
import {
  builtinHarnessSeed,
  validateHarnessDocument,
  type HarnessDocument,
  type HarnessGateOnFail,
} from "./harness-document.js";
import type { AgentRole } from "./types.js";

/**
 * 治理层状态机（参考 metis PerformanceRuntime，由可编辑架构图驱动）：
 * 纯内存、无 IO。门禁序列（tier→gate 带序边）、角色绑定（gate-role 边）、
 * 失败回跳（gate 节点 onFail: block | loop-to:<gate>）全部来自
 * `.meowcode/harness.json`（缺省用内置种子 = G4→G5→G6、失败回跳 G4）。
 * 证据一律来自宿主观测（ChildResult 的 filesChanged/commands 与根侧文件改动）。
 */

export type GovernanceMode = "off" | "goal" | "always";
export type WorkflowTier = "T0" | "T1" | "T2";
export type GateStatus = "pending" | "passed" | "failed";
export type LaneStatus = "queued" | "active" | "done" | "blocked";

/** 从架构图推导出的单步门禁：谁来关、失败后去哪 */
export type HarnessGateStep = {
  id: string;
  name: string;
  /** 有权关闭的角色（gate-role 边的 target，必须命中角色注册表） */
  closedBy: string;
  onFail?: HarnessGateOnFail;
};

export type Lane = {
  id: string;
  objective: string;
  ownedPaths: string[];
  verificationCommands: string[];
  dependsOn: string[];
  status: LaneStatus;
  /** 门禁执行序（架构图 tier-gate 边按 order 升序） */
  gateOrder: string[];
  gates: Record<string, GateStatus>;
  /** 每道门禁的关账 agent（独立性：后续门禁关账者 ≠ 此前所有关账者） */
  closers: Record<string, string | undefined>;
  repairCount: number;
};

export type WorkflowRun = {
  tier: WorkflowTier;
  taskShape: string;
  lanes: Lane[];
  completed: boolean;
};

/** T1 的隐式单 lane id */
export const MAIN_LANE_ID = "main";
/** 每 lane 修复回跳上限 */
export const DEFAULT_MAX_REPAIRS = 3;
/** admit 之前被门禁拦住的变更类工具（metis PERFORMANCE_ADMISSION_GATED_TOOLS 的裁剪版） */
export const GOVERNANCE_GATED_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "run_command",
  "task",
  "browser_navigate",
  "browser_click",
  "browser_type",
]);

/** 角色节点的内置角色类型；旧文档没有 data.role 时用节点 id。 */
function roleTypeOfNode(node: HarnessDocument["nodes"][number] | undefined): string | undefined {
  if (!node || node.type !== "role") return undefined;
  const role = (node.data as { role?: unknown }).role;
  return typeof role === "string" ? role : node.id;
}

/** 从文档推导 {tier → 有序门禁序列}；tier-gate 边按 order 升序，gate-role 边给绑定。 */
function deriveGateSteps(doc: HarnessDocument): Map<string, HarnessGateStep[]> {
  const gateNodes = new Map(
    doc.nodes.filter((node) => node.type === "gate").map((node) => [node.id, node]),
  );
  const closedBy = new Map<string, string>();
  for (const edge of doc.edges) {
    if (edge.type !== "gate-role") continue;
    const target = doc.nodes.find((node) => node.id === edge.target);
    const roleType = roleTypeOfNode(target);
    if (roleType) closedBy.set(edge.source, roleType);
  }
  const byTier = new Map<string, Array<HarnessGateStep & { order: number }>>();
  for (const edge of doc.edges) {
    if (edge.type !== "tier-gate") continue;
    const source = doc.nodes.find((node) => node.id === edge.source);
    const gate = gateNodes.get(edge.target);
    if (source?.type !== "tier" || !gate || gate.type !== "gate") continue;
    const data = gate.data as { name?: string; onFail?: HarnessGateOnFail };
    const list = byTier.get(edge.source) ?? [];
    list.push({
      id: gate.id,
      name: typeof data.name === "string" ? data.name : gate.id,
      closedBy: closedBy.get(gate.id) ?? "",
      order: typeof edge.order === "number" ? edge.order : Number.MAX_SAFE_INTEGER,
      ...(data.onFail ? { onFail: data.onFail } : {}),
    });
    byTier.set(edge.source, list);
  }
  const steps = new Map<string, HarnessGateStep[]>();
  for (const [tier, list] of byTier) {
    steps.set(
      tier,
      [...list]
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map(({ id, name, closedBy: role, onFail }) => ({
          id,
          name,
          closedBy: role,
          ...(onFail ? { onFail } : {}),
        })),
    );
  }
  return steps;
}

export type HarnessRoleOverride = {
  systemPrompt?: string;
  tools?: string[];
};

/** 角色节点上的工具/提示词覆盖：只收集显式配置过的字段。 */
function deriveRoleOverrides(doc: HarnessDocument): Map<string, HarnessRoleOverride> {
  const overrides = new Map<string, HarnessRoleOverride>();
  for (const node of doc.nodes) {
    if (node.type !== "role") continue;
    const data = node.data as { systemPrompt?: unknown; tools?: unknown };
    const override: HarnessRoleOverride = {};
    if (typeof data.systemPrompt === "string") override.systemPrompt = data.systemPrompt;
    if (Array.isArray(data.tools)) {
      override.tools = data.tools.filter((tool): tool is string => typeof tool === "string");
    }
    if (override.systemPrompt !== undefined || override.tools !== undefined) {
      const roleType = roleTypeOfNode(node);
      if (roleType) overrides.set(roleType, override);
    }
  }
  return overrides;
}

/**
 * 根 agent 节点的工具白名单：有就覆盖档位默认（task / admit 是编排通道，运行时始终保留）。
 * 缺省（没有 tools 字段）= 跟随档位；空数组 = 真的不给工具（只剩编排通道）。
 */
function deriveAgentTools(doc: HarnessDocument): ReadonlySet<string> | null {
  const root = doc.nodes.find((node) => node.type === "agent" && node.id === "main")
    ?? doc.nodes.find((node) => node.type === "agent");
  const raw = (root?.data as { tools?: unknown } | undefined)?.tools;
  if (!Array.isArray(raw)) return null;
  return new Set(raw.filter((tool): tool is string => typeof tool === "string"));
}

/** 根 agent 节点的系统提示词覆盖：缺省或空串 = 用档位提示词（整体替换，不是追加）。 */
function deriveAgentPrompt(doc: HarnessDocument): string | null {
  const root = doc.nodes.find((node) => node.type === "agent" && node.id === "main")
    ?? doc.nodes.find((node) => node.type === "agent");
  const raw = (root?.data as { systemPrompt?: unknown } | undefined)?.systemPrompt;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function hasCycle(lanes: Array<{ id: string; dependsOn: string[] }>): boolean {
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const current = state.get(id) ?? 0;
    if (current === 1) return true;
    if (current === 2) return false;
    state.set(id, 1);
    const lane = lanes.find((item) => item.id === id);
    if (lane?.dependsOn.some((dep) => visit(dep))) return true;
    state.set(id, 2);
    return false;
  };
  return lanes.some((lane) => visit(lane.id));
}

export type GateOutcome = {
  ok: boolean;
  verdict: "pass" | "fail" | "none";
  message: string;
  /** 实际落账的 lane 与门禁（verdict none 时可能未解析） */
  laneId?: string;
  gateId?: string;
};

export class WorkflowRuntime {
  private run: WorkflowRun | null = null;
  private readonly maxRepairs: number;
  private steps: Map<string, HarnessGateStep[]>;
  private roleOverrides: Map<string, HarnessRoleOverride>;
  /** 架构图根 agent 节点的工具白名单覆盖（null = 跟随档位） */
  private agentTools: ReadonlySet<string> | null = null;
  /** 架构图根 agent 节点的系统提示词覆盖（null = 用档位提示词） */
  private agentPrompt: string | null = null;

  constructor(options?: { maxRepairs?: number; harness?: HarnessDocument }) {
    this.maxRepairs = options?.maxRepairs ?? DEFAULT_MAX_REPAIRS;
    const harness = options?.harness ?? builtinHarnessSeed();
    this.steps = deriveGateSteps(harness);
    this.roleOverrides = deriveRoleOverrides(harness);
    this.agentTools = deriveAgentTools(harness);
    this.agentPrompt = deriveAgentPrompt(harness);
  }

  /**
   * 换一张架构图（仅在没有活跃 run 时允许 —— run 中快照冻结，metis 同款）。
   * 文档结构非法时保持原图不动，返回 false。
   */
  setHarness(doc: unknown): boolean {
    if (this.run && !this.run.completed) return false;
    if (!validateHarnessDocument(doc).valid) return false;
    const harness = doc as HarnessDocument;
    this.steps = deriveGateSteps(harness);
    this.roleOverrides = deriveRoleOverrides(harness);
    this.agentTools = deriveAgentTools(harness);
    this.agentPrompt = deriveAgentPrompt(harness);
    return true;
  }

  /** 角色节点的工具/提示词覆盖（未配置 = 用内置注册表）。 */
  roleOverride(name: string): HarnessRoleOverride | undefined {
    return this.roleOverrides.get(name);
  }

  /** 主 Agent 节点的工具白名单覆盖（null = 跟随当前档位）。 */
  get rootAgentTools(): ReadonlySet<string> | null {
    return this.agentTools;
  }

  /** 主 Agent 节点的系统提示词覆盖（null = 用当前档位的提示词）。 */
  get rootAgentPrompt(): string | null {
    return this.agentPrompt;
  }

  get state(): WorkflowRun | null {
    return this.run;
  }

  /** 门禁条件：还没 admit 过才拦截变更工具（admit 后门禁解除，靠 gate 管质量） */
  get needsAdmission(): boolean {
    return this.run === null;
  }

  get active(): boolean {
    return this.run !== null && !this.run.completed;
  }

  /** 全部未完成 lane 都已 blocked：继续催模型没有意义，该上报用户了 */
  get stalled(): boolean {
    if (!this.run || this.run.completed) return false;
    const open = this.run.lanes.filter((lane) => lane.status !== "done");
    return open.length > 0 && open.every((lane) => lane.status === "blocked");
  }

  /** 宿主续命循环条件：run 活跃且没被卡死 */
  get shouldContinue(): boolean {
    return this.active && !this.stalled;
  }

  reset(): void {
    this.run = null;
  }

  private buildLane(id: string, objective: string, tier: WorkflowTier, extras?: Partial<Lane>): Lane {
    const gates: Record<string, GateStatus> = {};
    const closers: Record<string, string | undefined> = {};
    const gateOrder = (this.steps.get(tier) ?? []).map((step) => step.id);
    for (const gateId of gateOrder) {
      gates[gateId] = "pending";
      closers[gateId] = undefined;
    }
    return {
      id,
      objective,
      ownedPaths: [],
      verificationCommands: [],
      dependsOn: [],
      status: "active",
      ...extras,
      gateOrder,
      gates,
      closers,
      repairCount: 0,
    };
  }

  private stepOf(tier: WorkflowTier, gateId: string): HarnessGateStep | undefined {
    return (this.steps.get(tier) ?? []).find((step) => step.id === gateId);
  }

  /** 当前待关门禁：序列里第一道非 passed 的门禁 */
  private pendingGate(lane: Lane): HarnessGateStep | undefined {
    const tier = this.run?.tier;
    if (!tier) return undefined;
    for (const gateId of lane.gateOrder) {
      if (lane.gates[gateId] !== "passed") return this.stepOf(tier, gateId);
    }
    return undefined;
  }

  /**
   * 结构化准入：tier 决定路线，门禁序列来自架构图（缺省 G4→G5→G6）。
   * 校验失败 fail-closed 返回错误，不建立 run。
   */
  admit(input: unknown): { ok: true; report: string } | { ok: false; error: string } {
    if (this.run && !this.run.completed) {
      return {
        ok: false,
        error: "A governed run is already active. Finish its gates (see workflow context) before admitting a new task.",
      };
    }
    const args = (input ?? {}) as Record<string, unknown>;
    const tier = args.tier;
    if (tier !== "T0" && tier !== "T1" && tier !== "T2") {
      return { ok: false, error: 'tier must be one of "T0" | "T1" | "T2".' };
    }
    const taskShape = typeof args.task_shape === "string" ? args.task_shape.trim() : "";
    if (!taskShape) return { ok: false, error: "task_shape must be a non-empty string." };

    const sequence = this.steps.get(tier) ?? [];
    // 序列里每道门禁都必须有角色绑定（gate-role 边），否则没人能关它
    for (const step of sequence) {
      if (!step.closedBy) {
        return {
          ok: false,
          error: `Architecture graph: gate "${step.id}" (${step.name}) has no gate-role binding; add a gate-role edge in the harness editor.`,
        };
      }
    }
    const routeText = sequence.length
      ? sequence.map((step) => `${step.id}(${step.name}, by ${step.closedBy})`).join(" → ")
      : "no gates (architecture graph defines no tier-gate edges for this tier)";

    if (sequence.length === 0) {
      // 图上没有门禁：声明即完成（内置种子下即 T0；用户也可把 T1/T2 改成无门禁）
      this.run = { tier, taskShape, lanes: [], completed: true };
      return {
        ok: true,
        report:
          `Governed run admitted (${tier}, no gates): ${clip(taskShape)}\n` +
          "No gates on this tier per the architecture graph — implement directly and verify before reporting done.",
      };
    }

    if (tier === "T1") {
      if (args.lanes !== undefined && args.lanes !== null) {
        return { ok: false, error: "T1 runs on a single implicit lane; pass lanes only for T2." };
      }
      this.run = {
        tier,
        taskShape,
        lanes: [this.buildLane(MAIN_LANE_ID, taskShape, tier)],
        completed: false,
      };
      return {
        ok: true,
        report:
          `Governed run admitted (T1, single lane "${MAIN_LANE_ID}"): ${clip(taskShape)}\n` +
          `Route from the architecture graph: ${routeText}.\n` +
          `Dispatch gates with task(agent_type=<role>, lane_id="${MAIN_LANE_ID}"). Mutating tools are unblocked.`,
      };
    }

    // T2：显式 lanes + DAG
    const rawLanes = args.lanes;
    if (!Array.isArray(rawLanes) || rawLanes.length === 0) {
      return { ok: false, error: "T2 requires a non-empty lanes array." };
    }
    const lanes: Lane[] = [];
    const seen = new Set<string>();
    for (const raw of rawLanes.slice(0, 6)) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const objective = typeof item.objective === "string" ? item.objective.trim() : "";
      if (!id || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(id)) {
        return { ok: false, error: `lane id must match [a-z0-9][a-z0-9_-]{0,40}: got "${id}".` };
      }
      if (!objective) return { ok: false, error: `lane "${id}" needs a non-empty objective.` };
      if (seen.has(id)) return { ok: false, error: `duplicate lane id "${id}".` };
      seen.add(id);
      lanes.push(
        this.buildLane(id, objective, tier, {
          ownedPaths: stringsOf(item.owned_paths),
          verificationCommands: stringsOf(item.verification_commands),
          dependsOn: stringsOf(item.depends_on),
          status: "queued",
        }),
      );
    }
    for (const lane of lanes) {
      for (const dep of lane.dependsOn) {
        if (!seen.has(dep)) {
          return { ok: false, error: `lane "${lane.id}" depends on unknown lane "${dep}".` };
        }
      }
    }
    if (hasCycle(lanes)) {
      return { ok: false, error: "lane depends_on graph has a cycle." };
    }
    // T2 并行安全：ownedPaths 两两不相交（metis findOverlappingOwnedPaths）
    for (let i = 0; i < lanes.length; i += 1) {
      for (let j = i + 1; j < lanes.length; j += 1) {
        const overlap = lanes[i].ownedPaths.find((path) =>
          lanes[j].ownedPaths.some((other) => samePath(path, other)),
        );
        if (overlap) {
          return {
            ok: false,
            error: `lanes "${lanes[i].id}" and "${lanes[j].id}" both own "${overlap}". T2 parallel lanes must not overlap.`,
          };
        }
      }
    }
    this.run = { tier, taskShape, lanes, completed: false };
    this.advance();
    return {
      ok: true,
      report:
        `Governed run admitted (T2, ${lanes.length} lanes): ${clip(taskShape)}\n` +
        lanes
          .map(
            (lane) =>
              `- ${lane.id} [${lane.status}]${lane.dependsOn.length ? ` (after ${lane.dependsOn.join(", ")})` : ""}: ${clip(lane.objective, 120)}`,
          )
          .join("\n") +
        `\nGate sequence per lane from the architecture graph: ${routeText}. Dispatch with task(..., lane_id=<id>). Mutating tools are unblocked.`,
    };
  }

  /**
   * 根侧实现证据（T1）：当前待关门禁的绑定角色是 implementer 时，
   * 观测到 root 自己改了文件即过。返回变更说明（无变更返回 null）。
   */
  noteRootMutation(path: string): string | null {
    if (!this.run || this.run.completed || this.run.tier !== "T1") return null;
    const lane = this.run.lanes[0];
    if (!lane || lane.status !== "active") return null;
    const pending = this.pendingGate(lane);
    if (!pending || pending.closedBy !== "implementer") return null;
    lane.gates[pending.id] = "passed";
    lane.closers[pending.id] = "root";
    return `Gate ${pending.id} passed (lane "${lane.id}"): root implementation observed changing ${path}.`;
  }

  /**
   * 子代理 gate 申请：按架构图的角色绑定与序列执行，独立性 + 证据校验 + onFail 回跳。
   * verdict none = 不适用于当前状态（消息说明原因），不产生迁移。
   */
  applyChildGate(input: {
    laneId?: string;
    role: AgentRole;
    agentId: string;
    childResult: ChildResult;
  }): GateOutcome {
    if (!this.run || this.run.completed) {
      return { ok: false, verdict: "none", message: "No active governed run; gate not recorded." };
    }
    const laneId = input.laneId ?? (this.run.tier === "T1" ? MAIN_LANE_ID : undefined);
    if (!laneId) {
      return { ok: false, verdict: "none", message: "Governed run is T2: pass lane_id when dispatching gate roles." };
    }
    const lane = this.run.lanes.find((item) => item.id === laneId);
    if (!lane) {
      return { ok: false, verdict: "none", message: `Unknown lane "${laneId}"; gate not recorded.` };
    }
    if (lane.status === "done") {
      return { ok: false, verdict: "none", message: `Lane "${laneId}" is already done.` };
    }
    if (lane.status === "blocked") {
      return { ok: false, verdict: "none", message: `Lane "${laneId}" is blocked (repair limit); report to the user.` };
    }
    if (lane.status === "queued") {
      return { ok: false, verdict: "none", message: `Lane "${laneId}" has not started (dependencies pending).` };
    }
    const pending = this.pendingGate(lane);
    if (!pending) {
      return { ok: false, verdict: "none", message: `Lane "${laneId}" has no pending gate.` };
    }
    if (pending.closedBy !== input.role) {
      return {
        ok: false,
        verdict: "none",
        message: `Gate ${pending.id} (${pending.name}) is closed by role "${pending.closedBy}" per the architecture graph; dispatched role was "${input.role}".`,
      };
    }
    // 独立性：本门禁关账者 ≠ 该 lane 此前所有门禁的关账者
    const previousClosers = lane.gateOrder
      .slice(0, lane.gateOrder.indexOf(pending.id))
      .map((gateId) => lane.closers[gateId])
      .filter((agentId): agentId is string => Boolean(agentId));
    if (previousClosers.includes(input.agentId)) {
      return {
        ok: false,
        verdict: "none",
        message: `Independence violated: the agent closing ${pending.id} must differ from earlier gate closers of this lane.`,
      };
    }
    lane.closers[pending.id] = input.agentId;

    const pass = this.gateVerdict(input.role, input.childResult);
    if (pass) {
      lane.gates[pending.id] = "passed";
      const next = this.pendingGate(lane);
      if (!next) {
        lane.status = "done";
        this.advance();
        this.checkComplete();
        return {
          ok: true,
          verdict: "pass",
          laneId,
          gateId: pending.id,
          message: `Gate ${pending.id} passed for lane "${laneId}" — lane done.`,
        };
      }
      return {
        ok: true,
        verdict: "pass",
        laneId,
        gateId: pending.id,
        message: `Gate ${pending.id} passed for lane "${laneId}". Next: ${next.id} (${next.name}, by ${next.closedBy}).`,
      };
    }

    // fail → 按 gate 节点的 onFail 处理：block 直接阻塞；loop-to:<gate> 回跳返工
    lane.repairCount += 1;
    const overLimit = lane.repairCount > this.maxRepairs;
    const loopTarget =
      typeof pending.onFail === "string" && pending.onFail.startsWith("loop-to:")
        ? pending.onFail.slice("loop-to:".length).trim()
        : "";
    const resetFrom = loopTarget && lane.gateOrder.includes(loopTarget) ? loopTarget : lane.gateOrder[0];
    if (overLimit || pending.onFail === "block") {
      lane.status = "blocked";
      for (const gateId of lane.gateOrder) {
        lane.gates[gateId] = "pending";
        lane.closers[gateId] = undefined;
      }
      return {
        ok: true,
        verdict: "fail",
        laneId,
        gateId: pending.id,
        message: overLimit
          ? `Gate ${pending.id} failed for lane "${laneId}" (reason: ${failReason(input.childResult)}). Repair limit (${this.maxRepairs}) reached — lane blocked; report the blockage to the user.`
          : `Gate ${pending.id} failed for lane "${laneId}" (reason: ${failReason(input.childResult)}). onFail=block — lane blocked; report the blockage to the user.`,
      };
    }
    for (const gateId of lane.gateOrder) {
      if (lane.gateOrder.indexOf(gateId) >= lane.gateOrder.indexOf(resetFrom)) {
        lane.gates[gateId] = "pending";
        lane.closers[gateId] = undefined;
      }
    }
    return {
      ok: true,
      verdict: "fail",
      laneId,
      gateId: pending.id,
      message: `Gate ${pending.id} failed for lane "${laneId}" (reason: ${failReason(input.childResult)}). Rework: loop back to ${resetFrom} (repair ${lane.repairCount}/${this.maxRepairs}), then repeat the remaining gates.`,
    };
  }

  /** 当前推进提示：活动 lane、待关 gate、下一步建议；无活动 run 返回 null。 */
  frontier(): string | null {
    if (!this.run || this.run.completed) return null;
    const lanes = this.run.lanes;
    const done = lanes.filter((lane) => lane.status === "done").length;
    const lines = [`Governed run (tier ${this.run.tier}) active: ${clip(this.run.taskShape, 140)}`];
    for (const lane of lanes) {
      const pending = this.pendingGate(lane);
      const next =
        lane.status === "done"
          ? "done"
          : lane.status === "blocked"
            ? "BLOCKED — tell the user"
            : pending
              ? `await ${pending.id} (${pending.name}, by ${pending.closedBy})`
              : "await gates";
      lines.push(`- lane ${lane.id} [${lane.status}] ${next} (repairs ${lane.repairCount}/${this.maxRepairs})`);
    }
    lines.push(
      `Progress: ${done}/${lanes.length} lanes done. Do not claim the task complete while any lane awaits a gate.`,
    );
    return lines.join("\n");
  }

  /** UI/事件用的全量快照；无 run 返回 null。 */
  snapshot(): {
    tier: WorkflowTier;
    taskShape: string;
    completed: boolean;
    lanes: Array<{
      id: string;
      objective: string;
      status: LaneStatus;
      gates: Record<string, GateStatus>;
      repairCount: number;
    }>;
  } | null {
    if (!this.run) return null;
    return {
      tier: this.run.tier,
      taskShape: this.run.taskShape,
      completed: this.run.completed,
      lanes: this.run.lanes.map((lane) => ({
        id: lane.id,
        objective: lane.objective,
        status: lane.status,
        gates: { ...lane.gates },
        repairCount: lane.repairCount,
      })),
    };
  }

  /** 依赖满足的 queued lane 转 active；run 完成判定。 */
  private advance(): void {
    if (!this.run) return;
    for (const lane of this.run.lanes) {
      if (lane.status !== "queued") continue;
      const depsDone = lane.dependsOn.every((dep) =>
        this.run!.lanes.some((item) => item.id === dep && item.status === "done"),
      );
      if (depsDone) lane.status = "active";
    }
  }

  private checkComplete(): void {
    if (!this.run) return;
    if (this.run.lanes.length > 0 && this.run.lanes.every((lane) => lane.status === "done")) {
      this.run.completed = true;
    }
  }

  /** gate 判定按绑定角色的证据语义（全部吃宿主已校验的 ChildResult） */
  private gateVerdict(role: string, result: ChildResult): boolean {
    if (!result.valid || result.status !== "completed") return false;
    if (role === "implementer") return result.filesChanged.length > 0;
    if (role === "reviewer") {
      return !result.findings.some((finding) => finding.severity === "critical");
    }
    if (role === "juror" || role === "goal-checker") {
      // 终审 / 目标核对是 default-FAIL：critical 或 major 都算不通过
      return !result.findings.some(
        (finding) => finding.severity === "critical" || finding.severity === "major",
      );
    }
    if (role === "verifier" || role === "fresh-verifier") {
      return result.commands.length > 0 && result.commands.every((command) => command.exitCode === 0);
    }
    // 架构图把门禁绑给了其他角色（general/explore/planner/scoper/depth-prober/sweeper）：
    // 只认 completed + valid
    return true;
  }
}

function failReason(result: ChildResult): string {
  return result.invalidReason ?? result.summary.slice(0, 160);
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 300))
    .slice(0, 12);
}

function clip(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function samePath(left: string, right: string): boolean {
  const a = left.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const b = right.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return a === b;
}
