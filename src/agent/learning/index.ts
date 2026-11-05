/**
 * 学习子系统的门面。
 *
 * runtime.ts 只跟这个类打交道：它负责单飞、游标、回合计数、召回去重、
 * 以及把「观察 → 归因 → 学习」串成一次调用。存储细节全在 store.ts。
 *
 * 所有方法都不抛错：学习是后台增强，任何一步失败都应该静默降级，
 * 绝不能让一次蒸馏失败影响到用户正在看的对话。
 */
import path from "node:path";
import type { ChatMessage, ProviderConfig, TokenUsage } from "../types.js";
import { serializeMessages } from "../memory-extraction.js";
import { discoverSkills } from "../../plugins/skills.js";
import { generateLearningOps, type ExistingKnowledge } from "./learner.js";
import {
  DEFAULT_DAILY_CALL_BUDGET,
  DEFAULT_MAX_LEARNED_SKILLS,
  adaptationId,
  type LearningOp,
} from "./types.js";
import {
  appendJournal,
  appendOutcome,
  applyLearningOps,
  clearLearningRoot,
  consumeDailyBudget,
  deleteLearnedSkill,
  learningRootFor,
  learningRoots,
  listLearnedSkills,
  readGuidelines,
  readJournal,
  readLedger,
  readProfile,
  recordApplied,
  recordEffect,
  rollbackSkill as rollbackSkillFile,
  setSkillStatus,
  type ApplyResult,
  type LearnedSkill,
} from "./store.js";
import type {
  Guideline,
  JournalEntry,
  LedgerEntry,
  LearningScope,
  UserTrait,
} from "./types.js";
import {
  buildOutcomeRecord,
  computeImplicitScore,
  detectSignals,
  isControlGroupHoldout,
  isUserCorrection,
  type TurnTrace,
} from "./signals.js";
import {
  buildRecallNote,
  matchGuidelines,
  recallKey,
  type RecallContext,
} from "./recall.js";

export type LearningConfig = {
  enabled: boolean;
  maxSkills: number;
  dailyBudget: number;
};

/** 学习进度事件：前端只用来画一个低调状态提示，不打断流式响应。 */
export type LearningProgress = {
  sessionId: string;
  runId: string;
  trigger: "turn" | "idle";
  phase: "observe" | "review" | "guard" | "write" | "evaluate";
  step: number;
  total: number;
  status: "running" | "completed" | "skipped" | "failed";
  summary?: string;
};

/**
 * 默认关闭：自我学习还是实验性能力，且它会改写「模型以后怎么做事」，
 * 这种影响面不该在用户没点头的情况下发生。开关在设置页，或 MEOWCODE_SELF_LEARNING=1。
 */
export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  enabled: false,
  maxSkills: DEFAULT_MAX_LEARNED_SKILLS,
  dailyBudget: DEFAULT_DAILY_CALL_BUDGET,
};

export type BeginTurnResult = {
  /** 追加到历史尾部的召回注记；没有命中就没有。 */
  note?: string;
  recalledIds: string[];
  holdout: boolean;
  turnIndex: number;
};

/** 设置页用的只读快照。 */
export type LearningSnapshot = {
  enabled: boolean;
  profile: UserTrait[];
  guidelines: Guideline[];
  skills: Array<LearnedSkill & { scope: LearningScope }>;
  ledger: Record<string, LedgerEntry>;
  journal: JournalEntry[];
  dailyCalls: { date: string; count: number };
};

export class LearningController {
  private config: LearningConfig;
  private workspace: string;
  private homeDir: string | undefined;

  /** 会话 -> 已学习的消息游标。 */
  private cursors = new Map<string, number>();
  /** 会话 -> 回合计数（切会话不清零，同会话内单调）。 */
  private turnIndexes = new Map<string, number>();
  /** 会话 -> 上一回合召回的条目，等下一回合判断是否被纠正。 */
  private pendingAttribution = new Map<string, string[]>();
  /** 会话 -> 上次注入的召回指纹，防止复述。 */
  private lastRecallKeys = new Map<string, string>();
  /** 单飞：一次只跑一个学习请求。 */
  busy = false;
  private onProgress: ((event: LearningProgress) => void) | undefined;

  constructor(options: {
    workspace: string;
    homeDir?: string;
    config?: Partial<LearningConfig>;
    onProgress?: (event: LearningProgress) => void;
  }) {
    this.workspace = options.workspace;
    this.homeDir = options.homeDir;
    this.config = { ...DEFAULT_LEARNING_CONFIG, ...options.config };
    this.onProgress = options.onProgress;
  }

  private progress(
    sessionId: string,
    trigger: "turn" | "idle",
    phase: LearningProgress["phase"],
    step: number,
    status: LearningProgress["status"],
    summary?: string,
  ): void {
    try {
      this.onProgress?.({
        sessionId,
        runId: `${sessionId}-${trigger}`,
        trigger,
        phase,
        step,
        total: 5,
        status,
        ...(summary ? { summary } : {}),
      });
    } catch {
      // 监听者出错不该影响学习本身
    }
  }

  /**
   * 没有工作区就整个关掉：项目级产物会落到相对路径 .meowcode/learning，
   * 那可能正好是应用自身的安装目录 —— 宁可什么都不学，也不能往那儿写。
   */
  get enabled(): boolean {
    return this.config.enabled && this.workspace.length > 0;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  get maxSkills(): number {
    return this.config.maxSkills;
  }

  setWorkspace(workspace: string): void {
    // 不清空游标/计数：它们都按 sessionId 索引，而 sessionId 全局唯一，
    // 切工作区不会串号。清空反而会让来回切换的两个工作区互相踩。
    this.workspace = workspace;
  }

  /** 会话被删除/切换时清掉内存态，避免旧游标误导新会话。 */
  forgetSession(sessionId: string): void {
    this.cursors.delete(sessionId);
    this.turnIndexes.delete(sessionId);
    this.pendingAttribution.delete(sessionId);
    this.lastRecallKeys.delete(sessionId);
  }

  // -------------------------------------------------------------------------
  // 回合开始：归因上一轮 + 召回本轮
  // -------------------------------------------------------------------------

  /**
   * 回合开始。两件事：
   *  1. 用户这句话如果是在纠正上一轮，把 hurt 记到上一轮召回的条目上；
   *  2. 按 trigger 召回本轮相关的项目经验，返回要追加到历史尾部的注记。
   */
  async beginTurn(sessionId: string, userText: string, context: RecallContext): Promise<BeginTurnResult> {
    const turnIndex = (this.turnIndexes.get(sessionId) ?? 0) + 1;
    this.turnIndexes.set(sessionId, turnIndex);
    const holdout = isControlGroupHoldout(sessionId, turnIndex);

    // 1) 归因上一轮
    const pending = this.pendingAttribution.get(sessionId);
    if (pending?.length) {
      this.pendingAttribution.delete(sessionId);
      if (isUserCorrection(userText)) {
        await this.attribute(sessionId, pending, "hurt").catch(() => undefined);
      }
    }

    if (!this.enabled) return { recalledIds: [], holdout, turnIndex };

    // 2) 召回
    try {
      const roots = learningRoots(this.workspace, this.homeDir);
      const collected: Array<{ scope: "user" | "project"; items: ReturnType<typeof matchGuidelines> }> = [];
      for (const scope of ["project", "user"] as const) {
        const file = await readGuidelines(roots[scope]);
        // 对照组回合把 tentative 经验抽掉，留出反事实基线
        const pool = holdout ? file.items.filter((item) => item.status === "active") : file.items;
        const matched = matchGuidelines(pool, context);
        if (matched.length) collected.push({ scope, items: matched });
      }
      const flat = collected.flatMap((entry) => entry.items);
      if (!flat.length) return { recalledIds: [], holdout, turnIndex };

      const key = recallKey(flat);
      const ids = collected.flatMap((entry) =>
        entry.items.map((item) => adaptationId(entry.scope, "guideline", item.id)),
      );
      // 「被应用」按 scope 分开记账：user 条目写进 user 账本，别串到项目里
      for (const scope of ["project", "user"] as const) {
        const scoped = ids.filter((id) => id.startsWith(`${scope}:`));
        if (scoped.length) await recordApplied(roots[scope], scoped).catch(() => undefined);
      }

      if (this.lastRecallKeys.get(sessionId) === key) {
        // 同一批命中已经注入过：不重复复述，但应用次数照记
        return { recalledIds: ids, holdout, turnIndex };
      }
      this.lastRecallKeys.set(sessionId, key);

      const note = buildRecallNote(flat);
      return { ...(note ? { note } : {}), recalledIds: ids, holdout, turnIndex };
    } catch {
      return { recalledIds: [], holdout, turnIndex };
    }
  }

  // -------------------------------------------------------------------------
  // 回合结束：落 outcome + 归因本轮
  // -------------------------------------------------------------------------

  async endTurn(input: {
    sessionId: string;
    turnIndex: number;
    status: "completed" | "error" | "aborted";
    trace: TurnTrace;
    recalledIds: string[];
    holdout: boolean;
  }): Promise<void> {
    if (!this.enabled) return;
    const roots = learningRoots(this.workspace, this.homeDir);
    try {
      const userCorrected = input.trace.userTexts.some((text) => isUserCorrection(text));
      const record = buildOutcomeRecord({ ...input, userCorrected });
      await appendOutcome(roots.project, record);

      // 归因本轮：对照组不记负向（它只是反事实基线，不该被自己的噪音误伤）
      const score = computeImplicitScore({
        status: input.status,
        toolErrors: input.trace.toolErrors,
        userCorrected,
      });
      if (input.recalledIds.length) {
        if (score > 0) {
          await this.attribute(input.sessionId, input.recalledIds, "helped");
        } else if (score < 0 && !input.holdout) {
          await this.attribute(input.sessionId, input.recalledIds, "hurt");
        }
        // 留给下一回合判断「有没有被纠正」
        this.pendingAttribution.set(input.sessionId, input.recalledIds);
      }
    } catch {
      // 观察失败不影响对话
    }
  }

  private async attribute(
    sessionId: string,
    ids: string[],
    effect: "helped" | "hurt",
  ): Promise<void> {
    // 条目可能来自两层：逐个根试，命中哪个算哪个
    for (const scope of ["project", "user"] as const) {
      const root = learningRootFor(scope, this.workspace, this.homeDir);
      const scoped = ids.filter((id) => id.startsWith(`${scope}:`));
      if (scoped.length) await recordEffect(root, scoped, effect);
    }
    this.pendingAttribution.delete(sessionId);
  }

  // -------------------------------------------------------------------------
  // 学习
  // -------------------------------------------------------------------------

  /**
   * 回合级学习。返回 null 表示被门禁挡下（没调用模型）。
   *
   * 门禁顺序刻意从便宜到贵：开关 → 单飞 → 配额 → 零 token 信号 → 模型调用。
   */
  async learnFromTurn(input: {
    sessionId: string;
    messages: ChatMessage[];
    trace: TurnTrace;
    provider: ProviderConfig;
    onUsage?: (usage: TokenUsage) => void;
    signal?: AbortSignal;
  }): Promise<ApplyResult | null> {
    if (!this.enabled || this.busy) return null;
    const signals = detectSignals(input.trace);
    if (!signals.length) {
      this.progress(input.sessionId, "turn", "observe", 1, "skipped", "no learning signal");
      return null;
    }

    const cursor = this.cursors.get(input.sessionId) ?? 0;
    const delta = input.messages.slice(cursor);
    if (!delta.length) return null;
    // 游标先推进再发请求：在途期间的新消息并入下回合，同一增量绝不学两次
    this.cursors.set(input.sessionId, input.messages.length);

    const transcript = serializeMessages(delta);
    if (!transcript.trim()) return null;

    const roots = learningRoots(this.workspace, this.homeDir);
    if (!(await consumeDailyBudget(roots.project, this.config.dailyBudget).catch(() => true))) {
      this.progress(input.sessionId, "turn", "observe", 1, "skipped", "daily call budget reached");
      return null;
    }

    this.progress(
      input.sessionId,
      "turn",
      "observe",
      1,
      "completed",
      `${signals.length} signal(s): ${signals.map((signal) => signal.type).join(", ")}`,
    );
    this.busy = true;
    try {
      this.progress(input.sessionId, "turn", "review", 2, "running", "reviewing this turn");
      const existing = await this.collectExisting();
      const ops: LearningOp[] = await generateLearningOps({
        provider: input.provider,
        mode: "turn",
        transcript,
        signals,
        existing,
        today: new Date().toISOString().slice(0, 10),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onUsage ? { onUsage: input.onUsage } : {}),
      });
      this.progress(input.sessionId, "turn", "guard", 3, "completed", `${ops.length} item(s) passed`);
      if (!ops.length) {
        this.progress(input.sessionId, "turn", "write", 4, "skipped", "nothing worth keeping");
        return { applied: [], rejected: [] };
      }
      this.progress(input.sessionId, "turn", "write", 4, "running", "writing learned items");
      const result = await applyLearningOps(ops, {
        workspace: this.workspace,
        ...(this.homeDir ? { homeDir: this.homeDir } : {}),
        maxSkills: this.config.maxSkills,
        actor: "learner",
        handwrittenSkills: await this.handwrittenSkillNames(),
        evidence: `${input.sessionId}#${this.turnIndexes.get(input.sessionId) ?? 0}`,
      });
      this.progress(
        input.sessionId,
        "turn",
        "evaluate",
        5,
        result.applied.length ? "completed" : "skipped",
        `${result.applied.length} applied, ${result.rejected.length} rejected`,
      );
      return result;
    } catch {
      this.progress(input.sessionId, "turn", "review", 2, "failed", "learning call failed");
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** 会话级整理：合并近义经验、蒸技能、剪噪音。 */
  async consolidate(input: {
    sessionId: string;
    messages: ChatMessage[];
    provider: ProviderConfig;
    onUsage?: (usage: TokenUsage) => void;
    signal?: AbortSignal;
  }): Promise<ApplyResult | null> {
    if (!this.enabled || this.busy) return null;
    const transcript = serializeMessages(input.messages.slice(-400));
    if (!transcript.trim()) return null;

    const roots = learningRoots(this.workspace, this.homeDir);
    if (!(await consumeDailyBudget(roots.project, this.config.dailyBudget).catch(() => true))) {
      return null;
    }

    this.busy = true;
    try {
      const existing = await this.collectExisting();
      const ops = await generateLearningOps({
        provider: input.provider,
        mode: "idle",
        transcript,
        signals: [],
        existing,
        today: new Date().toISOString().slice(0, 10),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onUsage ? { onUsage: input.onUsage } : {}),
      });
      if (!ops.length) return { applied: [], rejected: [] };
      return await applyLearningOps(ops, {
        workspace: this.workspace,
        ...(this.homeDir ? { homeDir: this.homeDir } : {}),
        maxSkills: this.config.maxSkills,
        actor: "learner",
        handwrittenSkills: await this.handwrittenSkillNames(),
      });
    } catch {
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** 设置页快照：两层的用户模型、经验、技能、账本与最近审计。 */
  async snapshot(): Promise<LearningSnapshot> {
    const roots = learningRoots(this.workspace, this.homeDir);
    const [projectProfile, userProfile, projectGuidelines, userGuidelines] = await Promise.all([
      readProfile(roots.project),
      readProfile(roots.user),
      readGuidelines(roots.project),
      readGuidelines(roots.user),
    ]);
    const [projectSkills, userSkills, projectLedger, userLedger, journal] = await Promise.all([
      listLearnedSkills(roots.project),
      listLearnedSkills(roots.user),
      readLedger(roots.project),
      readLedger(roots.user),
      readJournal(roots.project, 50),
    ]);
    const skills = [
      ...projectSkills.map((skill) => ({ ...skill, scope: "project" as const })),
      ...userSkills.map((skill) => ({ ...skill, scope: "user" as const })),
    ];
    return {
      enabled: this.enabled,
      profile: [...userProfile.traits, ...projectProfile.traits],
      guidelines: [...projectGuidelines.items, ...userGuidelines.items],
      skills,
      ledger: { ...userLedger.perAdaptation, ...projectLedger.perAdaptation },
      journal,
      dailyCalls: projectLedger.dailyCalls,
    };
  }

  /** 设置页操作：删掉一个学习技能。 */
  async removeSkill(scope: "user" | "project", name: string): Promise<boolean> {
    const root = learningRootFor(scope, this.workspace, this.homeDir);
    const removed = await deleteLearnedSkill(root, name);
    if (removed) {
      await appendJournal(root, {
        action: "rollback",
        scope,
        kind: "skill",
        name,
        revision: 0,
        actor: "model",
        reason: "removed from settings",
      }).catch(() => undefined);
    }
    return removed;
  }

  /** 设置页操作：把一个退役技能重新启用为 tentative，重新进入考察。 */
  async reactivateSkill(scope: "user" | "project", name: string): Promise<boolean> {
    const root = learningRootFor(scope, this.workspace, this.homeDir);
    return setSkillStatus(root, name, "tentative");
  }

  /** 设置页操作：回滚到上一版正文。 */
  async rollbackSkill(scope: "user" | "project", name: string): Promise<boolean> {
    const root = learningRootFor(scope, this.workspace, this.homeDir);
    const done = await rollbackSkillFile(root, name);
    if (done) {
      await appendJournal(root, {
        action: "rollback",
        scope,
        kind: "skill",
        name,
        revision: 0,
        actor: "model",
        reason: "manual rollback",
      }).catch(() => undefined);
    }
    return done;
  }

  /**
   * 清除两层学习根下的全部产物（不可撤销）。
   * 内存态一并清空：游标、回合计数、待归因、召回指纹都不该跨越「重来一次」。
   */
  async clearAll(): Promise<{ cleared: string[] }> {
    const roots = learningRoots(this.workspace, this.homeDir);
    const cleared: string[] = [];
    for (const scope of ["project", "user"] as const) {
      await clearLearningRoot(roots[scope]);
      cleared.push(scope);
    }
    this.cursors.clear();
    this.turnIndexes.clear();
    this.pendingAttribution.clear();
    this.lastRecallKeys.clear();
    return { cleared };
  }

  private async collectExisting(): Promise<ExistingKnowledge> {
    const roots = learningRoots(this.workspace, this.homeDir);
    const [projectProfile, projectGuidelines, userProfile, userGuidelines, projectSkills, userSkills] =
      await Promise.all([
        readProfile(roots.project),
        readGuidelines(roots.project),
        readProfile(roots.user),
        readGuidelines(roots.user),
        listLearnedSkills(roots.project),
        listLearnedSkills(roots.user),
      ]);
    return {
      profile: { version: 1, updatedAt: "", traits: [...userProfile.traits, ...projectProfile.traits] },
      guidelines: {
        version: 1,
        updatedAt: "",
        items: [...projectGuidelines.items, ...userGuidelines.items],
      },
      skills: [...projectSkills, ...userSkills].map((skill) => ({
        name: skill.name,
        description: skill.description,
        status: skill.status,
      })),
      maxSkills: this.config.maxSkills,
    };
  }

  /** 手写技能名：学习产物与它们同名时必须让路。 */
  private async handwrittenSkillNames(): Promise<Set<string>> {
    const skills = await discoverSkills([
      { dir: path.join(this.workspace, ".meowcode", "skills"), source: "project" },
    ]).catch(() => []);
    return new Set(skills.map((skill) => skill.name));
  }
}

export { createTurnTrace, type TurnTrace } from "./signals.js";
export type { ApplyResult } from "./store.js";
