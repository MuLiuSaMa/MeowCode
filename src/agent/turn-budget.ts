/**
 * 回合级预算：轮次上限 + token 上限 + 交替循环检测。
 *
 * `loop-guard` 只抓「连续且参数与输出逐字节相同」的调用；模型在
 * `grep A` / `read_file B` 之间来回横跳永远不触发。这里的窗口按「签名在
 * 最近 N 次只读调用里出现几次」判定，任何写类工具介入都清空窗口
 * （写之后重读同一文件是合法流程）。
 *
 * 预算只为「跑飞」兜底，不是正常工作的限制：轮次上限远高于真实任务所需，
 * 命中先注一条 wrap-up 提醒，再命中才硬停并给出可读原因。
 */

/** 单回合模型请求轮次硬上限。 */
export const MAX_TURN_ROUNDS = 60;
/** 软阈值：到这里注入一次 wrap-up 提醒，让模型收尾而不是被打断。 */
export const TURN_WRAPUP_ROUNDS = 50;
/** 交替循环窗口：只看最近这么多次只读调用。 */
export const ALTERNATING_WINDOW = 12;
/** 同一签名在窗口内出现 3 次 → 提醒；4 次 → 拒绝执行。 */
export const ALTERNATING_REPEAT_REMIND = 3;
export const ALTERNATING_REPEAT_BLOCK = 4;

export const TURN_WRAPUP_NOTE =
  "[meowcode] Round budget: this turn is close to its limit. Stop exploring, make the minimal change that satisfies the request, verify it once, and report — including anything you could not finish.";

export const turnLimitNote = (rounds: number) =>
  `[meowcode] Turn stopped: this turn reached its ${rounds}-round budget without finishing. Nothing further was executed. Report what is done and what remains, then continue in a new message.`;

export const TURN_TOKEN_LIMIT_NOTE =
  "[meowcode] Turn stopped: this turn exceeded its token budget (roughly three context windows of billed input plus output). Nothing further was executed. Report what is done and what remains, then continue in a new message.";

export const alternatingReminder = (tool: string, count: number) =>
  `[meowcode] Warning: ${tool} has been called with identical arguments ${count} times this turn, with no file change in between. The output cannot have changed. Use different arguments, or summarize what you have and move on.`;

export const alternatingBlockedOutput = (tool: string, count: number) =>
  `Blocked: ${tool} has already been called with identical arguments ${count} times this turn and no file changed in between, so a repeat cannot return anything new. Change the arguments or take a different approach.`;

export type TurnBudgetConfig = {
  /** 轮次上限；缺省 MAX_TURN_ROUNDS */
  maxRounds?: number;
  /** 本回合累计 token 上限（输入 + 输出）；null / 缺省 = 不设限 */
  maxTokens?: number | null;
};

export type RoundGate = { stop?: string; note?: string };

export type CallVerdict =
  | { blocked: string; reminder?: undefined }
  | { blocked?: undefined; reminder: string }
  | { blocked?: undefined; reminder?: undefined };

/** 稳定序列化工具参数：键排序后拼接，换键序不算新签名。 */
function stableArgs(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    return raw.trim();
  }
  const walk = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input) ?? "null";
    if (Array.isArray(input)) return `[${input.map(walk).join(",")}]`;
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${walk(item)}`).join(",")}}`;
  };
  return walk(value);
}

/** 工具调用的稳定签名：同工具同参数 = 同签名。 */
export function callSignature(tool: string, rawArgs: string): string {
  return `${tool}:${stableArgs(rawArgs)}`;
}

export class TurnBudget {
  private rounds = 0;
  private tokens = 0;
  /** 最近若干次「只读」调用签名；写类调用会清空它 */
  private window: string[] = [];
  private wrapUpSent = false;
  private readonly maxRounds: number;
  private readonly maxTokens: number | null;

  constructor(config: TurnBudgetConfig = {}) {
    this.maxRounds = Math.max(1, Math.floor(config.maxRounds ?? MAX_TURN_ROUNDS));
    const maxTokens = config.maxTokens;
    this.maxTokens =
      typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
        ? Math.floor(maxTokens)
        : null;
  }

  get round(): number {
    return this.rounds;
  }

  get usedTokens(): number {
    return this.tokens;
  }

  /** 轮首判定：stop 为硬停原因；note 为要注入的 wrap-up 提醒。 */
  beginRound(): RoundGate {
    this.rounds += 1;
    if (this.rounds > this.maxRounds) return { stop: turnLimitNote(this.maxRounds) };
    if (this.maxTokens !== null && this.tokens >= this.maxTokens) {
      return { stop: TURN_TOKEN_LIMIT_NOTE };
    }
    // 软阈值只发一次：maxRounds 比默认值小时按 maxRounds 提前触发
    const softAt = Math.min(TURN_WRAPUP_ROUNDS, Math.max(1, this.maxRounds - 1));
    if (!this.wrapUpSent && this.rounds >= softAt) {
      this.wrapUpSent = true;
      return { note: TURN_WRAPUP_NOTE };
    }
    return {};
  }

  /** 记账本轮用量（输入 + 输出）。 */
  recordUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): void {
    if (!usage) return;
    const input = Number(usage.inputTokens ?? 0);
    const output = Number(usage.outputTokens ?? 0);
    if (Number.isFinite(input)) this.tokens += Math.max(0, input);
    if (Number.isFinite(output)) this.tokens += Math.max(0, output);
  }

  /**
   * 登记一次工具调用。
   * mutating=true 表示可能有副作用（写类、命令、子 Agent），立刻清空窗口：
   * 改动之后的重复读取是合法流程，不该被当成循环。
   */
  observeCall(signature: string, mutating: boolean): CallVerdict {
    if (mutating) {
      this.window = [];
      return {};
    }
    // 连续相同调用交给 loop-guard（它按 3/5/8 分级，还会比对输出指纹）。
    // 这里只管「A/B 来回横跳」：紧邻重复不计数，否则两条检测会互相抢功，
    // 把 loop-guard 的 8 次硬阈值提前到 4 次。
    if (this.window[this.window.length - 1] === signature) return {};
    this.window.push(signature);
    if (this.window.length > ALTERNATING_WINDOW) {
      this.window = this.window.slice(-ALTERNATING_WINDOW);
    }
    const count = this.window.filter((item) => item === signature).length;
    const tool = signature.slice(0, Math.max(0, signature.indexOf(":")));
    if (count >= ALTERNATING_REPEAT_BLOCK) {
      return { blocked: alternatingBlockedOutput(tool, count) };
    }
    if (count >= ALTERNATING_REPEAT_REMIND) {
      return { reminder: alternatingReminder(tool, count) };
    }
    return {};
  }
}
