/**
 * 回合级预算：可选 token 上限 + 交替循环检测。
 *
 * `loop-guard` 只抓「连续且参数与输出逐字节相同」的调用；模型在
 * `grep A` / `read_file B` 之间来回横跳永远不触发。这里的窗口按「签名在
 * 最近 N 次只读调用里出现几次」判定，任何写类工具介入都清空窗口
 * （写之后重读同一文件是合法流程）。
 *
 * 不设轮次上限：轮次本身不产生额外开销，跑多少轮由任务和模型决定；
 * 跑飞由交替循环检测兜底。
 */

/** 交替循环窗口：只看最近这么多次只读调用。 */
export const ALTERNATING_WINDOW = 12;
/**
 * 缓存命中的输入按这个权重计入预算（与计费同口径：命中部分约 1/10 价）。
 *
 * 不折的后果很直观：预热过的长会话每轮 95%+ 输入都是缓存命中，按全量计的
 * 话预算烧得比账单快 5~10 倍，一次正常的二十轮任务就能把「三倍窗口」耗尽。
 */
export const CACHE_READ_WEIGHT = 0.1;
/** 同一签名在窗口内出现 3 次起提醒，重复再多也只提醒、不拦截。 */
export const ALTERNATING_REPEAT_REMIND = 3;

export const TURN_TOKEN_LIMIT_NOTE =
  "[meowcode] Turn stopped: this turn exceeded its token budget (roughly three context windows of billed input plus output). Nothing further was executed. Report what is done and what remains, then continue in a new message.";

export const alternatingReminder = (tool: string, count: number) =>
  `[meowcode] Warning: ${tool} has been called with identical arguments ${count} times this turn, with no file change in between. The output cannot have changed. Use different arguments, or summarize what you have and move on.`;

export type TurnBudgetConfig = {
  /** 本回合累计 token 上限（输入 + 输出）；null / 缺省 = 不设限 */
  maxTokens?: number | null;
};

export type RoundGate = { stop?: string };

export type CallVerdict = { reminder?: string };

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
  private tokens = 0;
  /** 最近若干次「只读」调用签名；写类调用会清空它 */
  private window: string[] = [];
  private readonly maxTokens: number | null;

  constructor(config: TurnBudgetConfig = {}) {
    const maxTokens = config.maxTokens;
    this.maxTokens =
      typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
        ? Math.floor(maxTokens)
        : null;
  }

  get usedTokens(): number {
    return this.tokens;
  }

  /** 轮首判定：只有显式配置的 token 上限会硬停，轮次本身不设限。 */
  beginRound(): RoundGate {
    if (this.maxTokens !== null && this.tokens >= this.maxTokens) {
      return { stop: TURN_TOKEN_LIMIT_NOTE };
    }
    return {};
  }

  /** 记账本轮用量（输入 + 输出），缓存命中的输入按计费当量折算。 */
  recordUsage(
    usage:
      | { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
      | undefined,
  ): void {
    if (!usage) return;
    const input = Number(usage.inputTokens ?? 0);
    const output = Number(usage.outputTokens ?? 0);
    if (Number.isFinite(output)) this.tokens += Math.max(0, output);
    if (!Number.isFinite(input) || input <= 0) return;
    // 各协议对 inputTokens 是否含缓存命中不一致（anthropic 适配器折进去了，
    // chat completions 用 prompt_tokens 也含），统一按「总量 - 命中」拆：
    // clamp 兜住"命中数大于总量"的异常上报，宁可少折不倒扣。
    const cacheRead = Math.min(
      Math.max(0, Number(usage.cacheReadTokens ?? 0) || 0),
      Math.max(0, input),
    );
    this.tokens += (input - cacheRead) + cacheRead * CACHE_READ_WEIGHT;
  }

  /**
   * 上下文被收缩/压缩之后回血：账降到当前上下文的规模。
   *
   * 回合内的预算按「每轮重发整段历史」累计，压缩把历史折叠掉之后，那部分
   * 已经付过的 token 不该继续压着新的一轮——否则越压越早停，压缩等于白做。
   * 只降不升：估算偏小时不能凭空发额度。
   */
  rebase(usedTokens: number): void {
    const target = Number(usedTokens);
    if (!Number.isFinite(target) || target < 0) return;
    if (target < this.tokens) this.tokens = Math.floor(target);
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
    if (count >= ALTERNATING_REPEAT_REMIND) {
      return { reminder: alternatingReminder(tool, count) };
    }
    return {};
  }
}
