/**
 * 薄 Agent 主循环（参考 metis vendor agent-loop 的 thin loop / thick host 分层）：
 * 循环只负责轮次迭代、流式请求、工具批次分派与消息记账；
 * 审批、上下文治理、会话持久化、子 Agent 编排全部留在宿主（AgentRuntime）。
 *
 * 宿主通过 AgentLoopHost 提供能力，通过 AgentLoopHooks 注入回合间治理
 * （admission 门禁、workflow_context 注入、gate 证据采集等）。
 * hooks 全部可选：不注册时行为与经典 while(true) 工具循环完全一致。
 */
import {
  clampOutputTokens,
  estimateMessagesTokens,
  estimateRequestInputTokens,
  estimateToolDefinitionsTokens,
  repairToolPairs,
  trimMessages,
  type ContextUsageAnchor,
} from "./context.js";
import { isContextOverflow } from "./compaction.js";
import type { StreamCompletionResult } from "./provider.js";
import type { ToolCallProgress } from "./tool-progress.js";
import type { ChatMessage, ProviderConfig, ToolCall, ToolDefinition } from "./types.js";

export type ToolResultMessage = Extract<ChatMessage, { role: "tool" }>;

/**
 * 无副作用、可安全并发的只读工具（宿主未提供 isParallelSafe 时的回退）。
 * 生产路径以 tool-contract.ts 的契约为准；run_code 不在其中：meow 桥可以写文件。
 */
export const READ_ONLY_PARALLEL_TOOLS = new Set([
  "list_dir",
  "read_file",
  "read_many",
  "glob",
  "grep",
  "context_status",
  "diagnostics",
  "memory_read",
  "web_search",
  "web_fetch",
]);

/** 回合计时快照，循环结束时交宿主落盘 metrics。 */
export type AgentLoopTiming = {
  startedAt: number;
  firstDeltaAt: number | null;
  lastSpeed: number | null;
};

/**
 * 宿主治理钩子（metis 式）。Step 4 的治理层在 AgentRuntime 侧实现并注册：
 * - beforeToolCall：工具执行前门禁（可拦截，如 admission 未完成时的写工具）
 * - afterToolCall：工具结果进入上下文后的证据采集
 * - prepareNextTurn：两轮之间注入 workflow_context（frontier 提醒等）
 * - shouldStopAfterTurn：批次结束后宿主要求终止循环（治理 run 已完成）
 */
export interface AgentLoopHooks {
  beforeToolCall?(
    call: ToolCall,
  ): Promise<{ block: boolean; reason?: string } | void>;
  afterToolCall?(call: ToolCall, message: ToolResultMessage): Promise<void>;
  prepareNextTurn?(messages: ChatMessage[]): Promise<ChatMessage[] | void>;
  shouldStopAfterTurn?(): Promise<boolean>;
  /**
   * 运行中插话（子 Agent steer）：模型没有工具调用、准备收尾时，宿主可返回一条
   * user 消息让循环继续。与 beforeTurnEnd 分开，避免占用 stop hook 的拦截次数。
   */
  takeSteer?(): Promise<string | void>;
  /**
   * 回合收尾闸（Claude Code Stop hook 语义）：模型没有工具调用、准备结束回合时调用。
   * block=true → 宿主把 reason 作为新的 user 消息注入、循环继续。
   * stopHookActive 表示本回合已被拦截过（对应 CC 的 stop_hook_active），
   * 脚本可自行避让；循环侧另有 MAX_TURN_STOP_BLOCKS 硬上限防死循环。
   */
  beforeTurnEnd?(input: {
    result: StreamCompletionResult;
    messages: ChatMessage[];
    stopHookActive: boolean;
  }): Promise<{ block: boolean; reason?: string } | void>;
}

/** turn_stop 连续拦截上限：超过则强制收尾，防止 hook 脚本无限续跑。 */
export const MAX_TURN_STOP_BLOCKS = 3;

export type AgentStreamOptions = {
  provider: ProviderConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** Anthropic tools 断点锚点（会话目录快照末尾） */
  toolCacheAnchor?: number;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolCall?: (progress: ToolCallProgress) => void;
  onToolCallComplete?: (call: ToolCall) => void;
};

/**
 * 宿主接口：循环需要的一切能力。初始上下文装配、请求 provider 解析
 * （缓存 key / 输出预算 / 增量链）、流式事件转发、记账与工具执行都在宿主。
 */
export interface AgentLoopHost {
  /** 本回合初始上下文（system 提示 + 投影后的有效历史） */
  initialMessages(): ChatMessage[];
  /** 本回合的激活 provider（回合内不变） */
  provider(): ProviderConfig;
  /** 工具表：随每轮请求发送，schema 计入裁剪预算 */
  tools(): ToolDefinition[];
  /** 工具断点锚点下标（目录快照末尾）；未实现时退化为数组末尾 */
  toolCacheAnchor?(): number;
  /** 真实用量锚点（输入预算的估算基准） */
  usageAnchor(): ContextUsageAnchor | null;
  /** 回合是否已被用户中止 */
  aborted(): boolean;
  abortSignal(): AbortSignal | undefined;
  /** Responses 增量传输：开关 + 链签名 */
  incremental(): { enabled: boolean; signature: string };
  /**
   * 供应商故障转移：可重试错误（超时 / 429 / 5xx）时由宿主决定是否切到下一跳。
   * 返回新 provider 表示已切换（循环会重置溢出档位并重发本轮）；返回 null 表示不切。
   * 未实现时等价于关闭 fallback。
   */
  fallbackProvider?(error: unknown): ProviderConfig | null;
  /** 组装本轮请求 provider：缓存 key + 输出预算 + 增量链续接判断 */
  resolveRequestProvider(input: { messages: ChatMessage[]; maxTokens: number }): ProviderConfig;
  /** 流结果返回后更新增量链（在追加 assistant 消息之前，快照对齐本次发送） */
  commitResponseChain(input: { responseId?: string; messages: ChatMessage[] }): void;

  /** 轮首：partial round 计数推进、清空上一轮提前执行的只读工具 */
  onRoundStart(): Promise<void> | void;
  onDelta(delta: string): void;
  onThinking(delta: string): void;
  onToolCallProgress(progress: ToolCallProgress): void;
  /** 流中工具参数闭合回调（实验：流中提前执行只读工具） */
  onToolCallComplete(call: ToolCall, messages: ChatMessage[]): void;

  stream(options: AgentStreamOptions): Promise<StreamCompletionResult>;
  /** assistant 消息落盘（含 flush 与 partial 检查点收尾） */
  persistAssistantMessage(message: ChatMessage): Promise<void>;
  /** 真实用量记账：锚点更新、usage 落盘、事件、压缩预热 */
  recordUsage(usage: NonNullable<StreamCompletionResult["usage"]>): Promise<void>;
  onMessageComplete(result: StreamCompletionResult): void;
  onError(message: string): void;
  persistMetrics(timing: AgentLoopTiming): Promise<void>;

  /** 溢出降级：预热采纳 → 确定性收缩 → 摘要工具输出 → 全量压缩 */
  escalateOnOverflow(
    messages: ChatMessage[],
    stage: number,
  ): Promise<{ messages: ChatMessage[]; stage: 1 | 2 | 3 }>;

  /** 串行工具执行（含审批/插件 hook/循环检测/写后验证），返回进入上下文的工具消息 */
  executeToolCall(call: ToolCall, messages: ChatMessage[]): Promise<ToolResultMessage>;
  /** task 子 Agent 派发 */
  executeTaskToolCall(call: ToolCall): Promise<ToolResultMessage>;
  /** 只读工具并发执行 */
  executeReadOnlyToolCall(call: ToolCall, messages: ChatMessage[]): Promise<ToolResultMessage>;
  /** 工具消息落盘并追加进工作上下文 */
  pushToolMessage(messages: ChatMessage[], message: ToolResultMessage): Promise<void>;
  /** 流中已提前启动的只读执行（按 callId 幂等） */
  earlyRun(callId: string): Promise<ToolResultMessage> | undefined;
  /** user 消息落盘并追加进工作上下文（turn_stop 拦截后续跑用） */
  pushUserMessage(messages: ChatMessage[], content: string): Promise<void>;
  /** 工具被门禁拦截时的 UI 事件（tool_started/output/finished ok=false） */
  onToolBlocked?(call: ToolCall, message: ToolResultMessage): void;
  /**
   * 该工具是否可放进并发批（宿主按工具契约判定，覆盖内置与动态工具）。
   * 未实现时退回 READ_ONLY_PARALLEL_TOOLS，保持旧行为。
   */
  isParallelSafe?(toolName: string): boolean;

  hooks?: AgentLoopHooks;
}

/**
 * 工具轮次不设上限：模型要连续调多少轮就跑多少轮，停止靠用户的中止按钮。
 * 唯一的额外出口是宿主 hooks（shouldStopAfterTurn / prepareNextTurn）。
 */
export async function runAgentLoop(host: AgentLoopHost): Promise<void> {
  // 故障转移会就地替换本回合的 provider（用户的全局配置不动）
  let provider = host.provider();
  const turnStartedAt = Date.now();
  let firstDeltaAt: number | null = null;
  let roundStartedAt: number | null = null;
  let lastSpeed: number | null = null;
  let messages: ChatMessage[] = host.initialMessages();
  // 溢出降级档位：0 未处理 → 1 已确定性收缩 → 2 已摘要工具输出 → 3 已全量压缩
  let escalation = 0;
  // 本回合 turn_stop 拦截计数（硬上限 MAX_TURN_STOP_BLOCKS 防 hook 死循环）
  let turnStopBlocks = 0;
  const { enabled: incrementalOn } = host.incremental();
  const hooks = host.hooks;
  const parallelSafe = (call: ToolCall): boolean =>
    host.isParallelSafe
      ? host.isParallelSafe(call.function.name)
      : READ_ONLY_PARALLEL_TOOLS.has(call.function.name);

  while (true) {
    // 服务商声明了上下文窗口就按窗口裁剪：永远保留 system，
    // 带 tool_calls 的 assistant 与它的 tool 结果成组丢弃，避免孤儿 tool_call_id。
    // 配对修复必须无条件执行：没配 contextWindow 时不会走 trimMessages，
    // 历史里一旦有 tool_use 缺结果（中断/旧数据），Anthropic 会直接 400。
    messages = repairToolPairs(messages);
    // 工具 schema 每轮都会随请求发送：裁剪预算必须把它一起扣掉，
    // 否则 MCP/浏览器工具多时会出现「裁剪后仍然溢出」的全上下文重试。
    // 同一轮内只取一次：估算与请求必须看到同一份快照。
    const roundTools = host.tools();
    const toolTokens = estimateToolDefinitionsTokens(roundTools);
    // 溢出误判护栏的输入基准：裁剪前的全量估算（裁剪/收缩之后看起来很小，
    // 不代表真实输入小——真实溢出恰恰常发生在「裁剪救不动」的会话里）。
    const overflowBaseline = estimateMessagesTokens(messages) + toolTokens;
    // 预算内不改写历史：旧的逐轮剪枝会让上一次请求的缓存前缀失效，
    // 省下的输出 token 远小于整段后缀重新计费的成本。真超窗口由 trimMessages
    // 兜底，过阈值由压缩链处理。
    // 输出预算先按裁剪前的输入收紧一次；裁剪后再按实际输入放宽/收紧，
    // 保证 input + output + 余量始终落在窗口内（参考 ZCode/OpenCode 的 clamp）。
    // 输入优先用服务商真实用量锚点 + 尾部估算，锚点失效才整段字符估算。
    let outputTokens = clampOutputTokens(
      provider,
      estimateRequestInputTokens(messages, host.usageAnchor(), toolTokens),
    );
    if (provider.contextWindow) {
      messages = trimMessages(messages, provider.contextWindow, outputTokens, toolTokens);
      outputTokens = clampOutputTokens(
        provider,
        estimateRequestInputTokens(messages, host.usageAnchor(), toolTokens),
      );
    }

    let result;
    roundStartedAt = null;
    await host.onRoundStart();
    // 每轮流式响应都是新的一批工具调用：清掉上一轮残留的提前执行记录
    let lastToolProgressKey = "";
    let lastToolProgressChars = 0;
    const requestProvider = host.resolveRequestProvider({ messages, maxTokens: outputTokens });
    try {
      result = await host.stream({
        provider: requestProvider,
        messages,
        tools: roundTools,
        toolCacheAnchor: host.toolCacheAnchor?.(),
        signal: host.abortSignal(),
        onToolCallComplete: (call) => host.onToolCallComplete(call, messages),
        onDelta: (delta) => {
          const now = Date.now();
          if (firstDeltaAt == null) firstDeltaAt = now;
          if (roundStartedAt == null) roundStartedAt = now;
          host.onDelta(delta);
        },
        onThinking: (delta) => {
          const now = Date.now();
          if (firstDeltaAt == null) firstDeltaAt = now;
          if (roundStartedAt == null) roundStartedAt = now;
          host.onThinking(delta);
        },
        onToolCall: (progress) => {
          // 工具参数可能以大量小 chunk 到达：只在数量/名字/目标路径变化或每 512 字符发一次
          const key = `${progress.count}|${(progress.names ?? []).join(",")}|${progress.path ?? ""}`;
          if (
            key === lastToolProgressKey &&
            progress.chars - lastToolProgressChars < 512
          ) {
            return;
          }
          lastToolProgressKey = key;
          lastToolProgressChars = progress.chars;
          host.onToolCallProgress(progress);
        },
      });
    } catch (error) {
      // 1) 溢出优先：换服务商解决不了上下文太长，先走既有的压缩降级链。
      if (isContextOverflow(error)) {
        if (escalation >= 3) throw error;
        // 护栏：声明了窗口但输入远小于窗口时，"溢出"多半是误判
        // （比如 max_tokens 配置被服务商拒绝时的报错措辞撞上了溢出关键词）。
        // 压缩救不了还白丢历史 —— 直接把真实错误抛出去，让用户看到根因。
        const declaredWindow = provider.contextWindow ?? 0;
        if (declaredWindow > 0) {
          const floor = Math.max(4_096, Math.min(declaredWindow * 0.2, 32_768));
          if (Math.max(overflowBaseline, estimateMessagesTokens(messages)) < floor) throw error;
        }
        console.error(
          `[meowcode] context overflow (stage ${escalation}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        const escalated = await host.escalateOnOverflow(messages, escalation);
        escalation = escalated.stage;
        messages = escalated.messages;
        continue;
      }
      // 2) 可重试的服务商故障（超时 / 429 / 5xx）：切到 fallback 链的下一跳。
      //    档位归零：新 provider 的窗口与预算都不一样，重新从"未处理"开始；
      //    每跳只发一次请求（fetchWithRetry 内部已有退避，不在这里叠加）。
      const next = host.fallbackProvider?.(error) ?? null;
      if (next) {
        provider = next;
        escalation = 0;
        continue;
      }
      throw error;
    }

    // 增量链更新：快照必须对应「本次实际发送」的消息列表 —— 在把 assistant
    // 回复与工具结果追加进 messages 之前记录。
    if (incrementalOn) {
      host.commitResponseChain({ responseId: result.responseId, messages });
    }

    await host.persistAssistantMessage(result.message);
    messages.push(result.message);
    if (result.usage) {
      if (roundStartedAt != null && result.usage.outputTokens && result.usage.outputTokens > 0) {
        const seconds = (Date.now() - roundStartedAt) / 1000;
        if (seconds >= 0.05) lastSpeed = result.usage.outputTokens / seconds;
      }
      await host.recordUsage(result.usage);
    }

    const toolCalls = result.message.tool_calls ?? [];
    const truncated = result.finishReason === "length";
    if (!toolCalls.length) {
      // 运行中插话优先于收尾：注入后继续下一轮，不占用 stop hook 次数
      const steer = await hooks?.takeSteer?.();
      if (steer) {
        await host.pushUserMessage(messages, steer);
        continue;
      }
      // 回合收尾闸（Stop hook）：拦截则 reason 作为 user 消息续跑，不落 metrics
      const stop = await hooks?.beforeTurnEnd?.({
        result,
        messages,
        stopHookActive: turnStopBlocks > 0,
      });
      if (stop?.block) {
        turnStopBlocks += 1;
        if (turnStopBlocks > MAX_TURN_STOP_BLOCKS) {
          host.onError("Stop hook kept blocking; ending the turn anyway.");
          await host.persistMetrics({ startedAt: turnStartedAt, firstDeltaAt, lastSpeed });
          return;
        }
        await host.pushUserMessage(
          messages,
          stop.reason || "Continue: the stop hook blocked the turn from ending.",
        );
        continue;
      }
      turnStopBlocks = 0;
      host.onMessageComplete(result);
      if (truncated) {
        host.onError(
          'Response truncated: the model reached its output token limit. Send "continue" to resume.',
        );
      }
      await host.persistMetrics({ startedAt: turnStartedAt, firstDeltaAt, lastSpeed });
      return;
    }

    if (truncated) {
      // 工具参数可能只写了一半：不执行，补上配对的 tool 结果避免历史非法。
      for (const call of toolCalls) {
        await host.pushToolMessage(messages, {
          role: "tool",
          content: "Tool call not executed: the model response was truncated.",
          tool_call_id: call.id,
          name: call.function.name,
        });
      }
      host.onError("Response truncated during a tool call; nothing was executed. Please retry.");
      await host.persistMetrics({ startedAt: turnStartedAt, firstDeltaAt, lastSpeed });
      return;
    }

    const abortedMessage = (call: ToolCall): ToolResultMessage => ({
      role: "tool",
      content: "Tool call not executed: the turn was aborted.",
      tool_call_id: call.id,
      name: call.function.name,
    });
    /** 宿主门禁：返回拦截原因，null 放行（未注册钩子时恒为 null） */
    const gate = async (call: ToolCall): Promise<string | null> => {
      const verdict = await hooks?.beforeToolCall?.(call);
      return verdict?.block ? verdict.reason ?? "blocked by host policy" : null;
    };
    /** 串行工具执行（原 executeToolCall 路径），带门禁与证据钩子 */
    const runTool = async (call: ToolCall): Promise<ToolResultMessage> => {
      const blocked = await gate(call);
      if (blocked) {
        const message = abortedMessage(call);
        message.content = `Tool call not executed: ${blocked}.`;
        host.onToolBlocked?.(call, message);
        await host.pushToolMessage(messages, message);
        await hooks?.afterToolCall?.(call, message);
        return message;
      }
      const message = await host.executeToolCall(call, messages);
      await hooks?.afterToolCall?.(call, message);
      return message;
    };
    /** task 子 Agent 派发，带门禁；结果由收集方统一落盘 */
    const runTask = async (call: ToolCall): Promise<ToolResultMessage> => {
      const blocked = await gate(call);
      if (blocked) {
        const message = abortedMessage(call);
        message.content = `Tool call not executed: ${blocked}.`;
        await hooks?.afterToolCall?.(call, message);
        return message;
      }
      const message = await host.executeTaskToolCall(call);
      await hooks?.afterToolCall?.(call, message);
      return message;
    };
    /** 只读批执行：流中提前启动的优先复用，否则（经门禁后）现场执行 */
    const runReadOnly = async (call: ToolCall): Promise<ToolResultMessage> => {
      const early = host.earlyRun(call.id);
      if (early) {
        const message = await early;
        await hooks?.afterToolCall?.(call, message);
        return message;
      }
      const blocked = await gate(call);
      if (blocked) {
        const message = abortedMessage(call);
        message.content = `Tool call not executed: ${blocked}.`;
        await hooks?.afterToolCall?.(call, message);
        return message;
      }
      const message = await host.executeReadOnlyToolCall(call, messages);
      await hooks?.afterToolCall?.(call, message);
      return message;
    };

    const taskCalls = toolCalls.filter((call) => call.function.name === "task");
    const otherCalls = toolCalls.filter((call) => call.function.name !== "task");

    if (taskCalls.length) {
      // update_plan 先落盘：同一批里省略 prompt 的 task 会自动读取最新计划。
      // 其余工具不阻塞 task 启动，避免“更新计划 + 3 个 task”退化成串行。
      for (const call of otherCalls.filter((item) => item.function.name === "update_plan")) {
        if (host.aborted()) {
          await host.pushToolMessage(messages, abortedMessage(call));
          continue;
        }
        await runTool(call);
      }
      const remainingCalls = otherCalls.filter(
        (item) => item.function.name !== "update_plan",
      );
      const taskPromises = taskCalls.map((call) =>
        host.aborted() ? Promise.resolve(abortedMessage(call)) : runTask(call),
      );
      if (remainingCalls.length) {
        if (remainingCalls.every((call) => parallelSafe(call))) {
          const results = await Promise.all(remainingCalls.map((call) => runReadOnly(call)));
          for (const result of results) {
            await host.pushToolMessage(messages, result);
          }
        } else {
          for (const call of remainingCalls) {
            // 混合批里提前执行过的只读调用直接取结果，其余照常串行
            if (host.earlyRun(call.id)) {
              await host.pushToolMessage(messages, await runReadOnly(call));
              continue;
            }
            if (host.aborted()) {
              await host.pushToolMessage(messages, abortedMessage(call));
              continue;
            }
            await runTool(call);
          }
        }
      }
      for (const promise of taskPromises) {
        await host.pushToolMessage(messages, await promise);
      }
    } else if (toolCalls.every((call) => parallelSafe(call))) {
      const results = await Promise.all(toolCalls.map((call) => runReadOnly(call)));
      for (const result of results) {
        await host.pushToolMessage(messages, result);
      }
    } else {
      for (const call of toolCalls) {
        if (host.aborted()) {
          // 用户已停止：不再执行剩余写操作，但补上 tool 结果保证历史配对完整
          await host.pushToolMessage(messages, abortedMessage(call));
          continue;
        }
        await runTool(call);
      }
    }

    // 宿主要求终止循环（治理 run 已完成等）：按回合收尾处理。
    if (hooks?.shouldStopAfterTurn && (await hooks.shouldStopAfterTurn())) {
      await host.persistMetrics({ startedAt: turnStartedAt, firstDeltaAt, lastSpeed });
      return;
    }
    // 两轮之间注入宿主上下文（workflow_context 提醒等）：宿主可改写消息列表。
    if (hooks?.prepareNextTurn) {
      const prepared = await hooks.prepareNextTurn(messages);
      if (prepared) messages = prepared;
    }
  }
}
