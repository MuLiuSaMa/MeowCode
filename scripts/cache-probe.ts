/**
 * 前缀缓存实测探针（手动跑，不进 CI）。
 *
 * 用途：新网关进入 MEASURED 白名单前先实测；验证 MeowCode 的保活 ping 在真实
 * 端点真的读回（read=0 说明保活在白写）。分类口径照 hermes 的
 * cache_concurrency_probe.py（ideal / stuck / collapse），用来抓代理静默重排前缀。
 *
 * 用法（任一协议都走真实的 streamChatCompletion 序列化）：
 *   MEOWCODE_PROBE_BASE_URL=https://api.example.com/v1 \
 *   MEOWCODE_PROBE_API_KEY=sk-... \
 *   MEOWCODE_PROBE_MODEL=claude-sonnet-4-5 \
 *   MEOWCODE_PROBE_PROTOCOL=anthropic-messages \
 *   pnpm exec tsx scripts/cache-probe.ts
 *
 * 流程：稳定前缀（≥2048 token）连发两次 → 追加一轮工具调用再发 → 原样再发
 * （等价于保活 ping 的 max_tokens=1 重放）。没有 API key 直接跳过（exit 0），
 * 任何一次该命中的请求 read=0 时 exit 1。
 */
import type { ChatMessage, ProviderConfig, TokenUsage, ToolDefinition } from "../src/agent/types.js";
import { streamChatCompletion } from "../src/agent/provider.js";

const baseUrl = process.env.MEOWCODE_PROBE_BASE_URL;
const apiKey = process.env.MEOWCODE_PROBE_API_KEY;
const model = process.env.MEOWCODE_PROBE_MODEL;
const protocol = (process.env.MEOWCODE_PROBE_PROTOCOL ?? "openai-chat-completions") as
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";

if (!apiKey) {
  console.log("[probe] MEOWCODE_PROBE_API_KEY is not set; skipping (exit 0).");
  process.exit(0);
}
if (!baseUrl || !model) {
  console.error("[probe] MEOWCODE_PROBE_BASE_URL and MEOWCODE_PROBE_MODEL are required.");
  process.exit(1);
}

// 足够越过缓存粒度（2048 token）：~300 行 × 60 字符 ≈ 4500 token
const STABLE_SYSTEM = Array.from(
  { length: 300 },
  (_, index) =>
    `Rule ${index + 1}: keep the response short, cite files by path, and never invent tool output.`,
).join("\n");

const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

const provider: ProviderConfig = {
  id: "probe",
  name: "Probe",
  protocol,
  baseUrl,
  model,
  apiKey,
  promptCacheKey: "meowcode-probe:main",
};

type Sample = { label: string; usage?: TokenUsage };

async function send(label: string, messages: ChatMessage[], maxTokens?: number): Promise<Sample> {
  let usage: TokenUsage | undefined;
  try {
    const result = await streamChatCompletion({
      provider: maxTokens ? { ...provider, maxTokens } : provider,
      messages,
      tools,
      onDelta: () => undefined,
      onUsage: (next) => {
        usage = next;
      },
    });
    usage ??= result.usage;
  } catch (error) {
    console.error(`[probe] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  return { label, usage };
}

function classify(sample: Sample, previous: Sample | undefined): string {
  const read = sample.usage?.cacheReadTokens;
  if (read === undefined) return "not_reported";
  if (read === 0) return "no_hit";
  const previousInput = previous?.usage?.inputTokens ?? 0;
  if (previousInput > 0 && read >= previousInput * 0.8) return "ideal";
  if (previousInput > 0 && read < previousInput * 0.5) return "collapse";
  if (previous?.usage?.cacheReadTokens === read) return "stuck";
  return "partial";
}

function report(sample: Sample, previous: Sample | undefined): void {
  const usage = sample.usage;
  const read = usage?.cacheReadTokens;
  const write = usage?.cacheWriteTokens;
  console.log(
    `[probe] ${sample.label.padEnd(16)} input=${usage?.inputTokens ?? "?"} ` +
      `read=${read ?? "n/a"} write=${write ?? "n/a"} class=${classify(sample, previous)}`,
  );
}

const conversation: ChatMessage[] = [
  { role: "system", content: STABLE_SYSTEM },
  { role: "user", content: "Reply with OK." },
];

const samples: Sample[] = [];
const first = await send("baseline", conversation);
samples.push(first);
report(first, undefined);

const replay = await send("replay", conversation);
samples.push(replay);
report(replay, first);

// 模拟工具循环：追加 assistant tool_call + tool result，前缀继续增长
conversation.push({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "probe-call-1",
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "probe.txt" }) },
    },
  ],
});
conversation.push({
  role: "tool",
  tool_call_id: "probe-call-1",
  name: "read_file",
  content: "probe tool output line\n".repeat(120),
});

const toolTurn = await send("tool_loop", conversation);
samples.push(toolTurn);
report(toolTurn, replay);

const toolReplay = await send("tool_replay", conversation);
samples.push(toolReplay);
report(toolReplay, toolTurn);

// 等价于保活 ping：max_tokens=1 原样重放同一前缀，必须读回几乎整段
const keepalive = await send("keepalive_ping", conversation, 1);
samples.push(keepalive);
report(keepalive, toolReplay);

const misses = samples.slice(1).filter((sample) => !sample.usage?.cacheReadTokens);
if (misses.length) {
  console.error(
    `[probe] ${misses.map((sample) => sample.label).join(", ")} read no cached tokens: ` +
      "端点可能不支持缓存、代理在重排前缀，或保活参数与主请求不一致。",
  );
  process.exitCode = 1;
} else {
  console.log("[probe] cache reads confirmed on every post-write request.");
}
