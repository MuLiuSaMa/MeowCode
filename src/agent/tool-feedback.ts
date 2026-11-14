/**
 * 工具调用被拒时的可操作反馈。
 *
 * 模型看到的错误文本决定它下一轮能不能改对：只回一句 `Tool call rejected: ...`
 * 时，模型常见反应是换个工具瞎试，或者把同一份坏参数再发一遍。这里统一成
 * 「错误类别 + 工具名 + 收到的参数 + 怎么修 + 当前可用工具」五行，让纠错发生在
 * 同一个 turn 内（codex `FunctionCallError::RespondToModel` 的同款思路）。
 *
 * 约束：只改执行层生成的文本，不碰 tools schema / system，前缀缓存不受影响。
 */

export type ToolRejectionKind = "invalid_arguments" | "unavailable";

export type ToolRejectionInput = {
  tool: string;
  kind: ToolRejectionKind;
  /** 具体原因，如 `tool arguments are not valid JSON (Unexpected token ...)` */
  reason: string;
  /** 模型原始返回的 arguments 字符串；超长会截断 */
  rawArguments?: string;
  /** 当前实际可用的工具名；用于把「幻觉工具」引回真实能力面 */
  availableTools?: readonly string[];
  /** 可用工具最多列几个，默认 20 */
  maxTools?: number;
};

const RAW_ARGUMENT_LIMIT = 240;

function clipRawArguments(raw: string): string {
  // 压平换行：多行 JSON 会把「一行一条指令」的格式打散
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= RAW_ARGUMENT_LIMIT) return flat;
  return `${flat.slice(0, RAW_ARGUMENT_LIMIT)}…`;
}

function formatAvailableTools(tools: readonly string[], maxTools: number): string {
  const shown = tools.slice(0, maxTools);
  const suffix = tools.length > shown.length ? ", …" : "";
  return `${shown.join(", ")}${suffix}`;
}

export function formatToolRejection(input: ToolRejectionInput): string {
  const lines = [
    `Tool call rejected (${input.kind}).`,
    `Tool: ${input.tool}`,
    `Reason: ${input.reason}`,
  ];

  if (input.rawArguments !== undefined && input.rawArguments.trim()) {
    lines.push(`Arguments received: ${clipRawArguments(input.rawArguments)}`);
  }

  if (input.kind === "invalid_arguments") {
    lines.push(
      `Fix: send one JSON object with double-quoted keys, no trailing commas, and every required field present; then call ${input.tool} again.`,
    );
  } else {
    lines.push(
      "Fix: pick a tool from the list below, or call tool_search to discover deferred tools. Do not retry the same unavailable name.",
    );
  }

  if (input.availableTools?.length) {
    lines.push(
      `Available now: ${formatAvailableTools(input.availableTools, input.maxTools ?? 20)}`,
    );
  }

  return lines.join("\n");
}
