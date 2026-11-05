import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { redactRecord } from "./redact.js";

export type AgentLogLevel = "debug" | "info" | "warn" | "error";

export type AgentLogRecord = {
  level: AgentLogLevel;
  event: string;
} & Record<string, unknown>;

export type AgentLogger = {
  readonly dir: string;
  /** 当前写入文件（按本地日期滚动） */
  filePath(): string;
  log(record: AgentLogRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
};

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const FLUSH_DELAY_MS = 50;

function dayStamp(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * agent 诊断日志：JSONL、按天分包、按大小轮转、全字段脱敏。
 * 写入失败只告警一次，绝不向回合冒泡；队列超过上限时丢弃最旧记录。
 */
export function createAgentLogger(options: {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
  flushDelayMs?: number;
}): AgentLogger {
  const dir = path.resolve(options.dir);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS;
  const pending: string[] = [];
  let day = dayStamp();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let warned = false;
  let closed = false;

  const fileFor = (stamp: string) => path.join(dir, `agent-${stamp}.jsonl`);

  async function rotate(file: string): Promise<void> {
    const base = file.replace(/\.jsonl$/, "");
    // 从最老的一档往前挪，最后一档直接丢弃
    for (let index = maxFiles; index >= 1; index -= 1) {
      const from = index === 1 ? file : `${base}.${index - 1}.jsonl`;
      const to = `${base}.${index}.jsonl`;
      await rename(from, to).catch(() => undefined);
    }
    await unlink(file).catch(() => undefined);
  }

  async function writeBatch(lines: string[]): Promise<void> {
    if (!lines.length) return;
    const stamp = dayStamp();
    if (stamp !== day) day = stamp;
    const file = fileFor(day);
    await mkdir(dir, { recursive: true });
    await appendFile(file, lines.join(""), "utf8");
    try {
      const info = await stat(file);
      if (info.size > maxBytes) await rotate(file);
    } catch {
      // 轮转失败不影响本次写入
    }
  }

  function schedule(): void {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushDelayMs);
    timer.unref?.();
  }

  async function flush(): Promise<void> {
    if (!pending.length) return chain;
    const lines = pending.splice(0, pending.length);
    chain = chain
      .then(() => writeBatch(lines))
      .catch((error) => {
        if (!warned) {
          warned = true;
          console.warn(
            `[meowcode] agent log write failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    return chain;
  }

  return {
    dir,
    filePath: () => fileFor(day),
    log: (record) => {
      if (closed) return;
      try {
        const payload = redactRecord({
          ts: new Date().toISOString(),
          ...record,
        });
        pending.push(`${JSON.stringify(payload)}\n`);
        // 写盘跟不上时丢最旧的，内存有界
        if (pending.length > 2000) pending.splice(0, pending.length - 2000);
        schedule();
      } catch {
        // 序列化失败（循环引用等）直接丢弃
      }
    },
    flush,
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await flush();
    },
  };
}

/** 清理超过保留期的日志（与工具输出同样的 7 天口径由调用方决定）。 */
export async function pruneAgentLogs(dir: string, keepDays = 7, now = Date.now()): Promise<number> {
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  const entries = await readdir(dir).catch(() => []);
  for (const name of entries) {
    if (!/^agent-\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(name)) continue;
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (info && info.mtimeMs < cutoff) {
      await unlink(file).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}
