/**
 * 观察层：用零 token 的启发式判断「这一回合值不值得学」。
 *
 * 这是整个子系统最省钱的设计 —— 绝大多数回合根本不调用模型。
 * metis 的判据（见 metis-main/src/core/adaptations/learner.ts:302）证明够用：
 * 用户纠正、同一命令反复失败、有失败→恢复对、工具调用密集，这四类才是有信息量的回合。
 *
 * 另外两件事也在这里：
 *  - 隐式反馈分：把回合结果折算成 -1..1，供账本归因 helped/hurt；
 *  - holdout 哈希：15% 的回合确定性抽掉 tentative 条目，当对照组。
 */
import path from "node:path";
import type { TurnOutcomeRecord } from "./types.js";

// ---------------------------------------------------------------------------
// 信号识别用的正则
// ---------------------------------------------------------------------------

/** 用户纠正：上一轮做错了。中英文各一组，宁可漏判也不要误判。 */
const CHINESE_CORRECTION =
  /(?:不对|不是(?:这样|我要的|这个意思)|我是说|我指的是|错了|搞错|别这样|重来|改回去|你理解错)/;
const ENGLISH_CORRECTION =
  /\b(?:no,|nope|that'?s (?:not|wrong)|i meant|not what i (?:asked|meant)|undo that|revert that|wrong file|you misunderstood)\b/i;

/** 显式保存意图：精度最高的信号 —— 用户直接要求记住。 */
const EXPLICIT_SAVE =
  /(?:记住|记一下|记下来|以后都(?:这样|用这个)|下次(?:也|就)|保存(?:这个|下来)|save this|remember this|keep this in mind)/i;

/** 值得复盘的密集回合阈值（metis 用 8）。 */
const HEAVY_TURN_TOOL_CALLS = 8;

/** 同一命令失败到这个次数，说明有可复用的教训。 */
const REPEATED_FAILURE = 2;

export type LearningSignal =
  | { type: "correction"; detail: string }
  | { type: "explicit_save"; detail: string }
  | { type: "command_failure"; detail: string }
  | { type: "recovery"; detail: string }
  | { type: "heavy_turn"; detail: string }
  | { type: "skill_recall"; detail: string };

// ---------------------------------------------------------------------------
// 回合轨迹：由 runtime 的循环钩子逐次填充
// ---------------------------------------------------------------------------

export type TurnTrace = {
  toolCalls: number;
  toolErrors: number;
  commandFingerprints: Array<{ command: string; exitCode: number }>;
  errorSignatures: string[];
  /** 本回合模型读过的学习技能名（说明召回起了作用）。 */
  skillReads: string[];
  /** 本回合的用户消息原文（判定纠正/显式保存用）。 */
  userTexts: string[];
};

export function createTurnTrace(): TurnTrace {
  return {
    toolCalls: 0,
    toolErrors: 0,
    commandFingerprints: [],
    errorSignatures: [],
    skillReads: [],
    userTexts: [],
  };
}

/** 学习技能文件路径 → 技能名；不是学习技能返回 null。 */
export function skillNameFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const marker = "/.meowcode/learning/skills/";
  const index = normalized.indexOf(marker);
  if (index < 0) return null;
  const rest = normalized.slice(index + marker.length).split("/");
  return rest[0] || null;
}

/** 从工具输出里抽错误签名：只留最像「同一个错误又来了」的那几行。 */
export function extractErrorSignature(text: string): string | null {
  const source = text.slice(0, 4_000);
  const patterns: RegExp[] = [
    /(?:^|\n)\s*((?:error|Error|ERROR)[^\n]{0,120})/,
    /\b(Cannot find module|Module not found|command not found|No such file)[^\n]{0,80}/,
    /\b(TS\d{4})\b/,
    /\b(E[A-Z]{3,})\b:\s/,
    /(?:^|\n)\s*(FAILED|FAIL)\s+[^\n]{0,80}/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match) return match[1].trim().slice(0, 120);
  }
  return null;
}

/** 记录一次工具调用。run_command 会额外落命令指纹，read_file 会识别技能召回。 */
export function recordToolCall(
  trace: TurnTrace,
  input: { name: string; args: unknown; ok: boolean; output?: string },
): void {
  trace.toolCalls += 1;
  if (!input.ok) trace.toolErrors += 1;
  const args = (input.args ?? {}) as Record<string, unknown>;

  if (input.name === "run_command" && typeof args.command === "string") {
    trace.commandFingerprints.push({
      command: args.command.trim(),
      exitCode: input.ok ? 0 : 1,
    });
    if (input.ok) return;
  }

  if (!input.ok && typeof input.output === "string") {
    const signature = extractErrorSignature(input.output);
    if (signature && !trace.errorSignatures.includes(signature)) {
      trace.errorSignatures.push(signature);
    }
  }

  if (input.name === "read_file" && typeof args.path === "string") {
    const skill = skillNameFromPath(args.path);
    if (skill && !trace.skillReads.includes(skill)) trace.skillReads.push(skill);
  }
}

/**
 * 失败→恢复对：同一工具前缀下，失败命令之后出现的成功命令。
 * 这是「怎么修好一个坏构建」这类知识的最短形态，学习器据此能写出可复用流程。
 */
export function deriveRecoveryPairs(
  fingerprints: Array<{ command: string; exitCode: number }>,
): Array<{ failed: string; recovered: string }> {
  const pairs: Array<{ failed: string; recovered: string }> = [];
  const pending: string[] = [];
  for (const fingerprint of fingerprints) {
    if (fingerprint.exitCode !== 0) {
      pending.push(fingerprint.command);
      continue;
    }
    if (!pending.length) continue;
    const tool = fingerprint.command.split(/\s+/)[0] ?? "";
    // 从后往前找同工具族的失败命令，配一次就清掉，避免一条失败配多个恢复
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const failed = pending[index];
      if ((failed.split(/\s+/)[0] ?? "") === tool) {
        pairs.push({ failed, recovered: fingerprint.command });
        pending.splice(index, 1);
        break;
      }
    }
  }
  return pairs.slice(-5);
}

/** 同一命令失败次数统计。 */
export function repeatedFailures(
  fingerprints: Array<{ command: string; exitCode: number }>,
): Array<{ command: string; count: number }> {
  const counts = new Map<string, number>();
  for (const fingerprint of fingerprints) {
    if (fingerprint.exitCode === 0) continue;
    counts.set(fingerprint.command, (counts.get(fingerprint.command) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= REPEATED_FAILURE)
    .map(([command, count]) => ({ command, count }));
}

/**
 * 零 token 门禁：返回命中的信号列表。空数组 = 这回合没东西可学，不调用模型。
 */
export function detectSignals(trace: TurnTrace): LearningSignal[] {
  const signals: LearningSignal[] = [];

  const firstUser = trace.userTexts.find((text) => text.trim().length > 0) ?? "";
  if (CHINESE_CORRECTION.test(firstUser) || ENGLISH_CORRECTION.test(firstUser)) {
    signals.push({ type: "correction", detail: firstUser.slice(0, 200) });
  }
  if (EXPLICIT_SAVE.test(firstUser)) {
    signals.push({ type: "explicit_save", detail: firstUser.slice(0, 200) });
  }

  for (const failure of repeatedFailures(trace.commandFingerprints)) {
    signals.push({
      type: "command_failure",
      detail: `${failure.command} (failed ${failure.count}x)`,
    });
  }

  const pairs = deriveRecoveryPairs(trace.commandFingerprints);
  if (pairs.length) {
    signals.push({
      type: "recovery",
      detail: pairs.map((pair) => `${pair.failed} -> ${pair.recovered}`).join("; ").slice(0, 300),
    });
  }

  if (trace.toolCalls >= HEAVY_TURN_TOOL_CALLS) {
    signals.push({ type: "heavy_turn", detail: `${trace.toolCalls} tool calls` });
  }

  if (trace.skillReads.length) {
    signals.push({ type: "skill_recall", detail: trace.skillReads.join(", ") });
  }

  return signals;
}

/** 用户这一轮是不是在纠正上一轮。 */
export function isUserCorrection(text: string): boolean {
  return CHINESE_CORRECTION.test(text) || ENGLISH_CORRECTION.test(text);
}

/**
 * 隐式反馈分。-1..1。
 * 顺序有意义：纠正与中断是最强负信号，会覆盖「工具都成功」的正分。
 */
export function computeImplicitScore(input: {
  status: "completed" | "error" | "aborted";
  toolErrors: number;
  userCorrected: boolean;
}): number {
  if (input.userCorrected) return -1;
  if (input.status === "aborted") return -1;
  if (input.status === "error") return -0.5;
  return input.toolErrors === 0 ? 1 : 0.5;
}

// ---------------------------------------------------------------------------
// 对照组
// ---------------------------------------------------------------------------

export function hashSessionTurn(sessionId: string, turnIndex: number): number {
  const source = `${sessionId}:${turnIndex}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash << 5) - hash + source.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * 15% 确定性对照组：同一 (session, turn) 永远得到同一个结果，
 * 这样「这条经验到底有没有用」才有可复现的反事实基线。
 */
export function isControlGroupHoldout(sessionId: string, turnIndex: number): boolean {
  return hashSessionTurn(sessionId, turnIndex) % 100 < 15;
}

// ---------------------------------------------------------------------------
// 组装 outcome 记录
// ---------------------------------------------------------------------------

export function buildOutcomeRecord(input: {
  sessionId: string;
  turnIndex: number;
  status: "completed" | "error" | "aborted";
  trace: TurnTrace;
  recalledIds: string[];
  userCorrected: boolean;
  holdout: boolean;
}): TurnOutcomeRecord {
  return {
    id: `${input.sessionId}-${input.turnIndex}-${Date.now()}`,
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    timestamp: new Date().toISOString(),
    scope: "project",
    status: input.status,
    toolCalls: input.trace.toolCalls,
    toolErrors: input.trace.toolErrors,
    commandFingerprints: input.trace.commandFingerprints.slice(-40),
    recoveryPairs: deriveRecoveryPairs(input.trace.commandFingerprints),
    errorSignatures: input.trace.errorSignatures.slice(-8),
    recalledIds: input.recalledIds,
    skillReads: input.trace.skillReads,
    userCorrected: input.userCorrected,
    implicitScore: computeImplicitScore({
      status: input.status,
      toolErrors: input.trace.toolErrors,
      userCorrected: input.userCorrected,
    }),
    holdout: input.holdout,
  };
}

/** 学习根下的技能目录名集合（给 read_file 匹配用，纯字符串判断，不读盘）。 */
export function looksLikeLearnedSkillPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/.meowcode/learning/skills/");
}

/** 便于日志里显示相对路径。 */
export function shortPath(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") ? relative : target;
}
