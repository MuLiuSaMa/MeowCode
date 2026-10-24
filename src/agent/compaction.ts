import { isAbortError } from "./http.js";
import { streamChatCompletion, utilityProvider } from "./provider.js";
import { ProviderRequestError } from "./provider-error.js";
import {
  estimateMessagesTokens,
  estimateToolDefinitionsTokens,
  trimMessages,
} from "./context.js";
import type { ChatMessage, ProviderConfig, ToolDefinition, TokenUsage } from "./types.js";

export const COMPACTION_SYSTEM_PROMPT = `Create a compact handoff summary for a coding agent.
Use the same language as the conversation. Use terse bullet points under these headings:
Goal, Progress, Files, Commands and results, Decisions, Next step.
Preserve the user's objective, important file paths, commands already run, key results, unresolved errors, decisions, and the next concrete action.
If an earlier handoff summary is present, update it with new progress instead of rewriting from scratch.
Do not include API keys, tokens, passwords, or unrelated history.
Output plain text only; never emit tool-call markup or pretend to call tools.`;

/**
 * 复用主缓存前缀时，压缩指令作为最后一条 user 消息追加。
 * 此时输入包含最近会被逐字保留的消息，所以明确允许略过它们的细节。
 */
export const COMPACTION_INSTRUCTION = `Create a compact handoff summary of the conversation above for a coding agent that will continue the work.
Use the same language as the conversation. Use terse bullet points under these headings:
Goal, Progress, Files, Commands and results, Decisions, Next step.
Preserve the user's objective, important file paths, commands already run, key results, unresolved errors, decisions, and the next concrete action.
If an earlier handoff summary is present, update it with new progress instead of rewriting from scratch.
The most recent messages will remain verbatim after compaction, so you may omit details already covered there.
Do not include API keys, tokens, passwords, or unrelated history.
Do not call tools. Do not emit tool-call markup. Output plain text only.`;

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
 */
export const COMPACTION_KEEP_RECENT_TOKENS = 16_000;

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
      { role: "user", content: COMPACTION_INSTRUCTION },
    ];
    const estimated = estimateMessagesTokens(input) + estimateToolDefinitionsTokens(tools);
    if (estimated + summaryMaxTokens + 1_024 <= contextWindow) {
      try {
        const result = await streamChatCompletion({
          provider: utility,
          messages: input,
          tools,
          toolChoice: "none",
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

  const source = trimMessages(
    [
      { role: "system", content: "" },
      ...(options.summaryMessages ?? options.messages).filter(
        (message) => message.role !== "system",
      ),
    ],
    contextWindow,
    summaryMaxTokens,
  ).filter((message) => message.role !== "system");

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

  // 只挑能塞进窗口的一部分：最大的先来，超预算的留在原位等下一档全量摘要
  const window = options.provider.contextWindow ?? 48_000;
  const charBudget = Math.max(8_000, Math.floor(window * 0.4 * 4));
  const selected: typeof options.outputs = [];
  let used = 0;
  for (const output of [...options.outputs].sort((a, b) => b.content.length - a.content.length)) {
    const block = TOOL_DIGEST_SYSTEM_PROMPT.length + output.content.length;
    if (used + block > charBudget) continue;
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
