import { ProviderTimeoutError } from "./provider-error.js";

/**
 * 三层预算：
 * - 首帧预算：响应头已到、但第一个 data 帧还没来的阶段。加密思考 / 长 prefill
 *   可以几分钟没有任何帧（Codex 这条路径在 Claude Code 里默认 300s）。
 * - 流中空闲预算：首个内容帧之后，只用来发现半死连接，90s 没有新帧就报错。
 *   metadata / usage / ping 帧不结束首帧阶段——有些网关很早就发 bookkeeping，
 *   之后才是长时间静默的思考/prefill。
 * - 无进展上限：每产出一帧新内容就重置；只有连续 10 分钟没有任何新输出才停。
 *   慢模型、超长输出只要还在出字就永远不会被这条截断；它只抓「一直有帧、
 *   但没有新内容、也永远不结束」的滴漏流（Claude Code 用墙钟总时长抓，
 *   会把 10 tok/s 的本地模型和超大输出误杀，这里改为按进展计）。
 */
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 300_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 600_000;

type ChunkResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

/** 单次读取加空闲超时：连接还活着但服务商不再发送任何数据时，不能无限等下去。 */
function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ChunkResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(
        new ProviderTimeoutError(
          `Model stream stalled for ${Math.round(timeoutMs / 1000)}s without data.`,
        ),
      );
    }, timeoutMs);
    reader.read().then(
      (chunk) => {
        clearTimeout(timer);
        resolve(chunk);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * SSE 帧读取。三种协议都是 `data: {...}` 一行一帧、`data: [DONE]` 或事件类型收尾，
 * 所以解析逻辑可以共用。
 */
export async function readSseFrames(
  body: ReadableStream<Uint8Array>,
  /** 返回 true 表示这一帧产出了新内容（文本 / 思考 / 工具参数增量） */
  onFrame: (data: string) => boolean | void,
  signal?: AbortSignal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  firstTokenTimeoutMs = DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  noProgressTimeoutMs = DEFAULT_NO_PROGRESS_TIMEOUT_MS,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataTimedOut = false;
  let dataTimer: ReturnType<typeof setTimeout> | undefined;
  // 首个内容帧到达前用首帧预算，之后切回流中空闲预算
  let budgetMs = firstTokenTimeoutMs;
  let timedOutBudgetMs = budgetMs;
  const progressCapMs =
    Number.isFinite(noProgressTimeoutMs) && noProgressTimeoutMs > 0
      ? Math.min(Math.floor(noProgressTimeoutMs), 2_147_483_647)
      : 0;
  let progressTimedOut = false;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;

  // 只有真正的 data: 帧才续期；keepalive 注释不能让"模型永远没开始响应"无限拖下去
  const armDataTimer = () => {
    if (dataTimer) clearTimeout(dataTimer);
    const armedMs = budgetMs;
    dataTimer = setTimeout(() => {
      dataTimedOut = true;
      timedOutBudgetMs = armedMs;
      void reader.cancel().catch(() => undefined);
    }, armedMs);
  };
  const timeoutError = () =>
    new ProviderTimeoutError(
      `Model stream stalled for ${Math.round(timedOutBudgetMs / 1000)}s without data.`,
    );
  const progressError = () =>
    new ProviderTimeoutError(
      `Model stream produced no new output for ${Math.round(progressCapMs / 1000)}s and was stopped.`,
    );
  // 只要还在产出新内容就重置；usage / ping 这类帧不续命，稳定滴漏骗不过它
  const armProgressTimer = () => {
    if (progressTimer) clearTimeout(progressTimer);
    if (progressCapMs <= 0) return;
    progressTimer = setTimeout(() => {
      progressTimedOut = true;
      void reader.cancel().catch(() => undefined);
    }, progressCapMs);
  };
  armDataTimer();
  armProgressTimer();

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException("Aborted", "AbortError");
      }
      let chunk: ChunkResult;
      try {
        chunk = await readWithTimeout(reader, budgetMs);
      } catch (error) {
        if (progressTimedOut) throw progressError();
        if (dataTimedOut) throw timeoutError();
        throw error;
      }
      if (chunk.done) {
        if (progressTimedOut) throw progressError();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        // 只有内容增量才结束首帧阶段；metadata / usage / ping 不能把 300s 降成 90s
        if (onFrame(data) === true) {
          budgetMs = idleTimeoutMs;
          armProgressTimer();
        }
        armDataTimer();
        if (data === "[DONE]") {
          // OpenAI 兼容流以 [DONE] 结束；有些网关不主动关连接，不能等它超时
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const data = tail.slice(5).trim();
      if (onFrame(data) === true) {
        budgetMs = idleTimeoutMs;
        armProgressTimer();
      }
      armDataTimer();
      if (data === "[DONE]") return;
    }
    if (progressTimedOut) throw progressError();
    if (dataTimedOut) throw timeoutError();
  } finally {
    if (dataTimer) clearTimeout(dataTimer);
    if (progressTimer) clearTimeout(progressTimer);
  }
}

export function parseJson<T>(data: string): T | undefined {
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}
