import { ProviderTimeoutError } from "./provider-error.js";

const DEFAULT_IDLE_TIMEOUT_MS = 86_400_000;

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
  onFrame: (data: string) => void,
  signal?: AbortSignal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataTimedOut = false;
  let dataTimer: ReturnType<typeof setTimeout> | undefined;

  // 只有真正的 data: 帧才续期；keepalive 注释不能让"模型永远没开始响应"无限拖下去
  const armDataTimer = () => {
    if (dataTimer) clearTimeout(dataTimer);
    dataTimer = setTimeout(() => {
      dataTimedOut = true;
      void reader.cancel().catch(() => undefined);
    }, idleTimeoutMs);
  };
  const timeoutError = () =>
    new ProviderTimeoutError(
      `Model stream stalled for ${Math.round(idleTimeoutMs / 1000)}s without data.`,
    );
  armDataTimer();

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException("Aborted", "AbortError");
      }
      let chunk: ChunkResult;
      try {
        chunk = await readWithTimeout(reader, idleTimeoutMs);
      } catch (error) {
        if (dataTimedOut) throw timeoutError();
        throw error;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        armDataTimer();
        const data = trimmed.slice(5).trim();
        onFrame(data);
        if (data === "[DONE]") {
          // OpenAI 兼容流以 [DONE] 结束；有些网关不主动关连接，不能等它超时
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      armDataTimer();
      const data = tail.slice(5).trim();
      onFrame(data);
      if (data === "[DONE]") return;
    }
    if (dataTimedOut) throw timeoutError();
  } finally {
    if (dataTimer) clearTimeout(dataTimer);
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
