/**
 * 自我学习子系统的类型契约。
 *
 * 设计来源是 metis 的 adaptations 软层（metis-main/docs/self-learning.md），
 * 但按 MeowCode 的约束做了三处裁剪：
 *  1. 学习产物只允许 Markdown 与自有 JSON —— 不产出可执行 tool / hook，
 *     因为 MeowCode 插件走 jiti 加载，让学习器写代码等于开提权口子；
 *  2. 召回不走关键词匹配器 —— 技能索引常驻 + 模型按需 read_file 已经够用；
 *  3. 所有制品都带 status（tentative/active/retired），退役不删文件。
 */

/** 学习产物作用域：user 跨项目，project 只在本工作区生效。 */
export type LearningScope = "user" | "project";

/** 学习产物类型。刻意不含 tool / hook / workflow —— 见文件头注释。 */
export type LearningKind = "profile" | "guideline" | "skill" | "proposal";

/** 生命周期状态。retired 的文件保留在磁盘，召回阶段跳过。 */
export type LearningStatus = "tentative" | "active" | "retired";

/** 用户模型的六个维度（照抄 metis，够用且不散）。 */
export type TraitDimension =
  | "communication"
  | "rigor"
  | "autonomy"
  | "coding_style"
  | "toolchain"
  | "domain";

export const TRAIT_DIMENSIONS: readonly TraitDimension[] = [
  "communication",
  "rigor",
  "autonomy",
  "coding_style",
  "toolchain",
  "domain",
];

// ---------------------------------------------------------------------------
// profile.json —— 结构化用户模型
// ---------------------------------------------------------------------------

export type UserTrait = {
  dimension: TraitDimension;
  /** 一句话陈述，自带主语（"用户偏好先跑测试再改代码"），脱离上下文也读得懂。 */
  statement: string;
  /** 0-1；用户明说的直接 0.95，推断出来的从 0.4 起。 */
  confidence: number;
  /** 支撑事实：来自哪个会话、哪句话的摘要。 */
  evidence: string[];
  /** ISO 日期（YYYY-MM-DD）。 */
  lastConfirmed: string;
  status: LearningStatus;
  /** 用户显式提出：不衰减、不进对照组。 */
  userStated?: boolean;
};

export type ProfileFile = {
  version: 1;
  traits: UserTrait[];
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// guidelines.json —— 带触发条件的项目经验
// ---------------------------------------------------------------------------

/**
 * 触发条件。对象型 guideline 必须至少有一个 trigger —— 没有触发的经验
 * 会变成每次回合都注入的噪音，那属于 profile 而不是 guideline。
 */
export type GuidelineTrigger = {
  /** 命令指纹，如 "pnpm test"。 */
  command?: string;
  /** 错误签名或关键字，如 "ETIMEDOUT" / "Cannot find module"。 */
  error?: string;
  /** 用户提示词关键词。 */
  keyword?: string;
  /** 正则；写入前必须编译通过，长度 ≤120。 */
  regex?: string;
  /** 文件 glob，如 "**\/*.test.ts"。 */
  filePattern?: string;
};

export type Guideline = {
  /** 内容哈希前 8 位；同一条经验更新时复用它。 */
  id: string;
  text: string;
  trigger: GuidelineTrigger;
  status: LearningStatus;
  confidence: number;
  created: string;
};

export type GuidelinesFile = {
  version: 1;
  items: Guideline[];
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// ledger.json —— 效果账本
// ---------------------------------------------------------------------------

export type LedgerEntry = {
  /** 命中召回且回合顺利交付的次数。 */
  helped: number;
  /** 命中召回但回合被打断/纠正/报错的次数。 */
  hurt: number;
  /** 被召回的总次数（含未归因的）。 */
  applied: number;
  status: LearningStatus;
  /** 每次写入自增，配合 history/ 做回滚。 */
  revision: number;
  lastOutcomeAt: string;
};

export type LedgerFile = {
  version: 1;
  updatedAt: string;
  /** key 是 adaptationId(scope, kind, name)，如 "project:skill:pnpm-publish"。 */
  perAdaptation: Record<string, LedgerEntry>;
  /** 每日模型调用配额记账（跨进程重启也要守住预算）。 */
  dailyCalls: { date: string; count: number };
};

// ---------------------------------------------------------------------------
// outcomes.jsonl —— 回合经验（滚动 500 条）
// ---------------------------------------------------------------------------

export type TurnOutcomeRecord = {
  id: string;
  sessionId: string;
  turnIndex: number;
  timestamp: string;
  scope: LearningScope;
  status: "completed" | "error" | "aborted";
  toolCalls: number;
  toolErrors: number;
  commandFingerprints: Array<{ command: string; exitCode: number }>;
  recoveryPairs: Array<{ failed: string; recovered: string }>;
  errorSignatures: string[];
  /** 本回合召回的 adaptation id。 */
  recalledIds: string[];
  /** 本回合模型读过的学习技能名。 */
  skillReads: string[];
  userCorrected: boolean;
  /** -1..1 的隐式反馈分；归因 helped/hurt 就看它。 */
  implicitScore: number;
  /** 本回合是 15% 对照组：不记负向归因，保护经验不被噪声误伤。 */
  holdout: boolean;
};

// ---------------------------------------------------------------------------
// journal.jsonl —— 审计
// ---------------------------------------------------------------------------

export type JournalEntry = {
  id: string;
  ts: string;
  action: "apply" | "rollback" | "retire" | "reject";
  scope: LearningScope;
  kind: LearningKind;
  name?: string;
  revision: number;
  prevRevision?: number;
  snapshotId?: string;
  /** 谁改的：模型主动、学习器、还是评估器自动退役。 */
  actor: "model" | "learner" | "evaluator";
  reason?: string;
};

// ---------------------------------------------------------------------------
// state.json —— 水位与空闲整理时间戳
// ---------------------------------------------------------------------------

export type LearningStateFile = {
  version: 1;
  /** 上次空闲整理的时间戳（ms）；切会话时判断是否该整理。 */
  lastIdleAt: number;
  /** sessionId -> 已整理的回合数。防止同一会话被反复整理。 */
  watermarks: Record<string, number>;
};

// ---------------------------------------------------------------------------
// 学习器产出（清洗后）
// ---------------------------------------------------------------------------

export type LearningOp =
  | {
      op: "profile";
      scope: LearningScope;
      dimension: TraitDimension;
      statement: string;
      userStated?: boolean;
      reason?: string;
    }
  | {
      op: "guideline";
      scope: LearningScope;
      /** 给了就按 id 就地更新，没给就按 text 归一化匹配。 */
      id?: string;
      text: string;
      trigger: GuidelineTrigger;
      reason?: string;
    }
  | {
      op: "skill";
      scope: LearningScope;
      name: string;
      description: string;
      /** 正文（不含 frontmatter）：frontmatter 由 store 统一生成，避免模型写坏。 */
      content: string;
      /** 技能数到上限时必须指定要替换掉的旧技能名。 */
      replaces?: string;
      reason?: string;
    }
  | {
      op: "proposal";
      scope: LearningScope;
      name: string;
      content: string;
      reason?: string;
    };

/** 单次学习最多落多少条：写满说明素材全是噪音，不如留着下次。 */
export const MAX_OPS_PER_BATCH = 6;

/** 学到的技能数量上限；超限必须 replaces 一个旧的。 */
export const DEFAULT_MAX_LEARNED_SKILLS = 20;

/** 每日学习模型调用上限（跨会话共享）。 */
export const DEFAULT_DAILY_CALL_BUDGET = 40;

/** outcomes.jsonl 滚动窗口。 */
export const MAX_OUTCOME_RECORDS = 500;

/** 学到的技能正文上限（字符）。 */
export const MAX_SKILL_CONTENT_CHARS = 6_000;

/** guideline 正文上限：超过说明它在写文档，不是经验。 */
export const MAX_GUIDELINE_CHARS = 300;

/** profile 陈述上限。 */
export const MAX_TRAIT_CHARS = 200;

/** 晋升阈值：helped 达到这个数且 hurt 为 0。 */
export const PROMOTE_HELPED = 3;

/** 退役阈值：hurt 达到这个数（文件保留，召回跳过）。 */
export const RETIRE_HURT = 2;

/** 统一的 3 段式标识符，串起召回、账本与自动退役。 */
export function adaptationId(
  scope: LearningScope,
  kind: LearningKind,
  name?: string,
): string {
  return name ? `${scope}:${kind}:${name}` : `${scope}:${kind}`;
}

/** 是否退役：ledger 与文件 frontmatter 任一为 retired 即算。 */
export function isRetiredStatus(status: string | null | undefined): boolean {
  return status === "retired";
}
