import { isAbortError } from "./http.js";
import { streamChatCompletion, utilityProvider } from "./provider.js";
import { ProviderRequestError } from "./provider-error.js";
import {
  buildMessageUnits,
  estimateMessagesTokens,
  estimateTokens,
  estimateToolDefinitionsTokens,
  trimMessages,
} from "./context.js";
import type { ChatMessage, ProviderConfig, ToolDefinition, TokenUsage } from "./types.js";

/**
 * 摘要正文规范：SYSTEM_PROMPT（独立摘要请求）与 INSTRUCTION（复用主前缀时
 * 追加在对话尾部）共用，避免两处各写一遍、改一处忘一处。
 */
const COMPACTION_BODY = `Use the same language as the conversation. Use terse bullet points under these headings:
Goal, Progress, Files, Commands and results, Decisions, Next step.
Preserve the user's objective, important file paths, commands already run, key results, unresolved errors, decisions, and the next concrete action.
If an earlier handoff summary is present, rewrite it from scratch within the budget, carrying forward only still-relevant items; never append delta sections to the old summary.
Do not restate system/developer instructions, AGENTS.md or repository conventions, environment details, or memory entries: the next agent receives those separately. Summarize only what this conversation added.
Do not paste full file contents, diffs, or long logs; cite path:line and the command instead.
Keep each heading to at most 6 bullets and drop details the next agent can cheaply re-derive.
Do not include API keys, tokens, passwords, or unrelated history.`;

export const COMPACTION_SYSTEM_PROMPT = `Create a compact handoff summary for a coding agent.
${COMPACTION_BODY}
Output plain text only; never emit tool-call markup or pretend to call tools.`;

/**
 * 复用主缓存前缀时，压缩指令作为最后一条 user 消息追加。
 * 此时输入包含最近会被逐字保留的消息，所以明确允许略过它们的细节。
 */
export const COMPACTION_INSTRUCTION = `Create a compact handoff summary of the conversation above for a coding agent that will continue the work.
${COMPACTION_BODY}
The most recent messages will remain verbatim after compaction, so you may omit details already covered there.
Do not call tools. Do not emit tool-call markup. Output plain text only.`;

/**
 * 语色开启时给摘要请求补一句中性要求。末尾指令位于缓存断点之后，
 * 因此不会破坏「复用主前缀」的缓存命中。
 */
export function buildCompactionInstruction(neutralizePersona = false): string {
  if (!neutralizePersona) return COMPACTION_INSTRUCTION;
  return `${COMPACTION_INSTRUCTION}
Ignore any persona, tone or catchphrase instructions above; write the summary in neutral technical language without 喵 or verbal tics.`;
}

/**
 * 摘要输出预算：2% 窗口，下限 2k、上限 4k；provider 自己更小就服从 provider。
 * 摘要会进入后续每次请求，不能像 Codex 那样开到 20k；但 1k 又会丢文件/报错细节，
 * 导致压缩后重新探索，按 2–4k 取平衡。
 */
export function compactionSummaryMaxTokens(provider: ProviderConfig): number {
  const window = provider.contextWindow;
  const windowBudget =
    window && window > 0 ? Math.floor(window * 0.02) : 4_096;
  const budget = Math.max(2_048, Math.min(4_096, windowBudget));
  return Math.min(budget, provider.maxTokens ?? budget);
}

/**
 * 压缩时逐字保留的近期对话 token 预算：摘要只覆盖更早的旧历史。
 * 参考metis（keepRecent 20K）与 opencode（keep 15K）的取值；
 * 实际保留量由 session-store 按不可拆单元从最新往回消耗，小窗口按 20% 自适应收缩。
 *
 * 16K → 20K：模型摘要只有 2–4k，压缩后「重新探索」是最大的隐性开销。多留 4k
 * 原文换取「最近的读文件/报错结果仍然在手」，比把摘要写长更划算（摘要在之后
 * 每次请求都要重发，原文只在窗口里占一次）。
 */
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000;

/**
 * 误报排除（参考 opencode 的 provider-error 分类器）：
 * 这些措辞是请求参数配置问题（输出上限 max_tokens 配错）或限流，
 * 压缩输入救不了 —— 绝不能当成上下文溢出去压缩，否则每轮都白丢历史。
 */
const OVERFLOW_EXCLUSIONS = [
  /rate limit/i,
  /too many requests/i,
  /max[_ ]tokens (?:must|should) be (?:less|no more|smaller|at most)/i,
  /max[_ ]tokens.*exceed/i,
  /max[_ ]tokens.*too (?:large|high|big)/i,
  /invalid max[_ ]tokens/i,
];

/** 正面匹配：各家服务商「输入超过上下文窗口」的典型措辞。 */
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i,
  /prompt 超长/i,
  /input is too long for requested model/i,
  /exceed(?:s|ed)? (?:this model'?s? |the |model'?s )?context window/i,
  /context window (?:is )?exceeded/i,
  /exceeded this model context window limit/i,
  /maximum context length is \d+ tokens?/i,
  /input token count.*exceed/i,
  /number of input tokens exceeds/i,
  /maximum prompt length is \d+/i,
  /reduce the length of (?:the )?messages/i,
  /requested input length \d+ exceeds maximum input length/i,
  /input length.*exceeds.*context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /model_context_window_exceeded/i,
  /context length is only \d+ tokens/i,
  /greater than the context length/i,
  /exceeds the (?:maximum |model'?s )?allowed input length/i,
  /tokens in request more than max tokens allowed/i,
  /too many input tokens/i,
  /token limit exceeded/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /exceeds the available context size/i,
  /request_too_large/i,
];

function matchesOverflow(text: string): boolean {
  if (OVERFLOW_EXCLUSIONS.some((pattern) => pattern.test(text))) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 只有「网关不认识复用请求的字段」才值得回退到专用摘要路径；
 * 网络错误/后端 5xx/限流对两条路径同样致命，再发一次只是多烧一份输入。
 */
function isCacheReuseMismatch(error: unknown): boolean {
  if (!(error instanceof ProviderRequestError) || error.status !== 400) return false;
  return /tool_choice|cache_control|prompt.?cach|unknown.*(?:field|parameter)|invalid.*(?:field|parameter)/i.test(
    error.body,
  );
}

export function isContextOverflow(error: unknown): boolean {
  if (error instanceof ProviderRequestError) {
    if (error.status === 413) return true;
    return matchesOverflow(error.body);
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return matchesOverflow(message);
}

/**
 * 生成压缩摘要。
 *
 * 两条路径：
 *  - reusePrefix：输入与主请求完全一致（system + tools + 全量投影对话 + 末尾指令），
 *    让前缀缓存覆盖整段历史；摘要请求本身只新增末尾那几十个 token。参考 DeepSeek
 *    Harness 的 summarizer 复用 system/tools/prefix。
 *  - 专用路径：无缓存或复用输入塞不进窗口时，用专用 system + 仅待摘要旧历史 + tools:[]。
 *
 * `summaryMessages` 是专用路径的输入（通常是旧前缀）；`messages` 是复用路径的输入
 * （通常是全量投影对话）。两者分开，避免回退路径把最近 16k 也重新摘要一遍。
 */
export async function createCompactionSummary(options: {
  provider: ProviderConfig;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
  reusePrefix?: boolean;
  systemMessages?: ChatMessage[];
  tools?: ToolDefinition[];
  summaryMessages?: ChatMessage[];
  /** 语色生效时要求摘要保持中性；仅复用前缀路径需要（专用路径本身已中性）。 */
  neutralizePersona?: boolean;
}): Promise<string> {
  const contextWindow = options.provider.contextWindow ?? 48_000;
  // 请求体的 max_tokens 必须和裁剪预留一致，否则输入+输出会超窗
  const summaryMaxTokens = compactionSummaryMaxTokens(options.provider);
  const utility = utilityProvider(options.provider, summaryMaxTokens, "compaction");

  if (options.reusePrefix && options.provider.promptCaching !== false) {
    const systems = (
      options.systemMessages ?? options.messages.filter((message) => message.role === "system")
    ).filter(
      (message): message is Extract<ChatMessage, { role: "system" }> =>
        message.role === "system" && Boolean(message.content),
    );
    const conversation = options.messages.filter((message) => message.role !== "system");
    const tools = options.tools ?? [];
    const input: ChatMessage[] = [
      ...systems,
      ...conversation,
      { role: "user", content: buildCompactionInstruction(options.neutralizePersona) },
    ];
    const estimated = estimateMessagesTokens(input) + estimateToolDefinitionsTokens(tools);
    if (estimated + summaryMaxTokens + 1_024 <= contextWindow) {
      try {
        const result = await streamChatCompletion({
          provider: utility,
          messages: input,
          tools,
          toolChoice: "none",
          // 复用主前缀：不做一次性判形，并把写入断点前移到指令之前。
          // 末尾那条 COMPACTION_INSTRUCTION 只出现这一次，给它打断点是纯亏。
          cacheMode: "prefix-reuse",
          signal: options.signal,
          onDelta: () => undefined,
        });
        if (result.usage) options.onUsage?.(result.usage);
        const text = (result.message.content ?? "").trim();
        // 纯文本空摘要不重试：换条路径大概率还是空，等于白烧一份大输入。
        // 但模型仍试图调工具说明复用请求不被支持，回退到 tools:[] 的专用路径。
        if (text || !result.message.tool_calls?.length) return text;
      } catch (error) {
        if (isAbortError(error) || !isCacheReuseMismatch(error)) throw error;
        // 网关不认识 tool_choice / 缓存字段 → 回退到专用摘要路径
        console.error(
          `[meowcode] compaction prefix reuse rejected, falling back: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const source = fitSummaryInput(
    (options.summaryMessages ?? options.messages).filter((message) => message.role !== "system"),
    contextWindow,
    summaryMaxTokens,
  );

  const result = await streamChatCompletion({
    provider: utility,
    messages: [{ role: "system", content: COMPACTION_SYSTEM_PROMPT }, ...source],
    tools: [],
    signal: options.signal,
    onDelta: () => undefined,
  });
  if (result.usage) options.onUsage?.(result.usage);
  return (result.message.content ?? "").trim();
}

/**
 * 摘要回退路径的输入降级梯（参考 opencode 的 transcript shortening ladder）。
 *
 * 复用前缀塞不进窗口时，不能只靠 trimMessages 的整单元丢弃 —— 那会连用户/助手正文
 * 一起消失。逐档降级，每档重新估算，够用即停：
 *   1. trimMessages（内部已含旧工具输出抽头尾）
 *   2. 旧工具输出压成单行摘要（最近一个单元保留原文）
 *   3. 只留 user 文本与 assistant 正文，丢弃全部工具往来
 *   4. 从最老端整条省略
 * 第 3/4 档在最前面插一行说明，避免模型以为早期内容从未发生。
 */
const SUMMARY_OMITTED_NOTE =
  "Earlier assistant and tool messages were omitted to fit the summary request; treat the following as a partial transcript.";

function summaryBudget(contextWindow: number, maxTokens: number): number {
  return Math.max(1_024, contextWindow - maxTokens - 1_024);
}

/** 降级梯第 2 档：把旧工具输出压成单行摘要；最近一个单元保留原文。 */
function collapseOldToolOutputs(messages: ChatMessage[]): ChatMessage[] {
  const units = buildMessageUnits(messages);
  const cutoff = Math.max(0, units.length - 1);
  return units.flatMap((unit, index) => {
    if (index >= cutoff) return unit;
    return unit.map((message) => {
      if (message.role !== "tool") return message;
      const first = message.content.split("\n").find((line) => line.trim()) ?? "";
      const head = first.trim().slice(0, 120);
      return {
        ...message,
        content: `[${message.name ?? "tool"} output omitted${head ? `: ${head}` : ""}]`,
        images: undefined,
        documents: undefined,
      };
    });
  });
}

/** 降级梯第 3 档：只留 user 文本与 assistant 正文，丢掉全部工具往来。 */
function keepConversationText(messages: ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    kept.push({
      role: message.role,
      content: message.content,
      ...(message.role === "assistant" && message.reasoning
        ? { reasoning: message.reasoning }
        : {}),
    } as ChatMessage);
  }
  return [{ role: "user", content: SUMMARY_OMITTED_NOTE }, ...kept];
}

/** 降级梯第 4 档：从最老端整条省略，直到落进预算。 */
function dropOldestUntilFit(messages: ChatMessage[], budget: number): ChatMessage[] {
  let start = 0;
  while (start < messages.length - 1 && estimateMessagesTokens(messages.slice(start)) > budget) {
    start += 1;
  }
  if (start === 0) return messages;
  return [{ role: "user", content: SUMMARY_OMITTED_NOTE }, ...messages.slice(start)];
}

/** 按降级梯裁出一份能塞进窗口的摘要输入。 */
function fitSummaryInput(
  messages: ChatMessage[],
  contextWindow: number,
  maxTokens: number,
): ChatMessage[] {
  const budget = summaryBudget(contextWindow, maxTokens);
  let current: ChatMessage[] = trimMessages(
    [{ role: "system", content: "" }, ...messages],
    contextWindow,
    maxTokens,
  ).filter((message) => message.role !== "system");
  if (estimateMessagesTokens(current) <= budget) return current;

  current = collapseOldToolOutputs(current);
  if (estimateMessagesTokens(current) <= budget) return current;

  current = keepConversationText(current);
  if (estimateMessagesTokens(current) <= budget) return current;

  return dropOldestUntilFit(current, budget);
}

export const TOOL_DIGEST_SYSTEM_PROMPT = `You compress tool outputs for a coding agent that is running out of context window.
You receive a list of tool results, each introduced by "#<id> <tool name>".
Rewrite each one as at most two short lines: keep file paths, symbols, line numbers, commands,
exit codes, error strings, counts and concrete findings; drop repeated log noise and boilerplate.
Never invent content. Reply with one line per item, formatted exactly as:
<id>: <digest>
Output nothing else.`;

/** 单条工具输出送进摘要请求时的截断上限：再长也只是重复日志。 */
const TOOL_DIGEST_ENTRY_CHARS = 6_000;
/** 摘要结果的硬上限：一条工具输出不值得占用超过这个字符数。 */
const TOOL_DIGEST_MAX_CHARS = 600;

/**
 * 第二层压缩（比全量摘要轻）：只把「旧工具输出」交给模型压成短纪要，用户与助手的
 * 对话正文逐字保留。换来的收益是模型仍然知道每个文件/命令的结果，但不再为几万行
 * 日志付费。返回 callId → 纪要；调用方负责替换消息并落盘。
 */
export async function summarizeToolOutputs(options: {
  provider: ProviderConfig;
  outputs: Array<{ callId: string; tool: string; content: string }>;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}): Promise<Map<string, string>> {
  const ids = new Set(options.outputs.map((output) => output.callId));
  if (!ids.size) return new Map();

  // 只挑能塞进窗口的一部分：最大的先来，超预算的留在原位等下一档全量摘要。
  // 预算必须按 token 口径算：`window * 0.4 * 4` 是「字符 = token × 4」的英文假设，
  // 中文仓库里 1 字 ≈ 1 token，按字符配预算会把 4 倍的正文塞进摘要请求，
  // 换来的是一次溢出或一次静默截断 —— 正好毁掉这层要保的东西。
  const window = options.provider.contextWindow ?? 48_000;
  const tokenBudget = Math.max(2_000, Math.floor(window * 0.4));
  const selected: typeof options.outputs = [];
  let used = estimateTokens(TOOL_DIGEST_SYSTEM_PROMPT);
  for (const output of [...options.outputs].sort((a, b) => b.content.length - a.content.length)) {
    const block = estimateTokens(output.content.slice(0, TOOL_DIGEST_ENTRY_CHARS));
    if (used + block > tokenBudget) continue;
    selected.push(output);
    used += block;
  }
  if (!selected.length) return new Map();

  const items = selected
    .map((output) => `#${output.callId} ${output.tool}\n${output.content.slice(0, TOOL_DIGEST_ENTRY_CHARS)}`)
    .join("\n\n");
  const maxTokens = Math.min(options.provider.maxTokens ?? 2_048, 2_048);

  const result = await streamChatCompletion({
    provider: utilityProvider(options.provider, maxTokens, "digest"),
    messages: [
      { role: "system", content: TOOL_DIGEST_SYSTEM_PROMPT },
      { role: "user", content: items },
    ],
    tools: [],
    signal: options.signal,
    onDelta: () => undefined,
  });
  if (result.usage) options.onUsage?.(result.usage);

  const digests = new Map<string, string>();
  for (const line of (result.message.content ?? "").split(/\r?\n/)) {
    const match = /^\s*#?([A-Za-z0-9_-]+)\s*[:：]\s*(.+)$/.exec(line);
    if (!match || !ids.has(match[1])) continue;
    const digest = match[2].trim().slice(0, TOOL_DIGEST_MAX_CHARS);
    if (digest) digests.set(match[1], digest);
  }
  return digests;
}
