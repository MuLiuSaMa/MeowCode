import path from "node:path";
import {
  findExecutable,
  loadLspConfig,
  resolveTypeScriptServer,
  serverForFile,
  type LspConfig,
} from "./config.js";
import { LanguageServer } from "./language-server.js";
import { TypeScriptServer } from "./typescript.js";
import { LspUnavailableError, type LspDiagnostic } from "./types.js";

export type DiagnoseInput = {
  cwd: string;
  files: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type DiagnoseOutput = {
  serverNames: string[];
  diagnostics: LspDiagnostic[];
  unavailable?: string;
};

type Entry = {
  key: string;
  adapter: TypeScriptServer | LanguageServer;
  lastUsed: number;
  chain: Promise<void>;
  busy: number;
};

const MAX_ENTRIES = 4;
const IDLE_MS = 10 * 60_000;
const FAILURE_COOLDOWN_MS = 30_000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(() => reject(new Error("LSP diagnostics aborted.")));
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    if (signal?.aborted) {
      reject(new Error("LSP diagnostics aborted."));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => finish(() => reject(new Error(`LSP diagnostics timed out after ${timeoutMs}ms.`))),
      timeoutMs,
    );
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function dedupe(diagnostics: LspDiagnostic[]): LspDiagnostic[] {
  const seen = new Set<string>();
  const result: LspDiagnostic[] = [];
  for (const item of diagnostics) {
    const key = `${item.file}|${item.line}|${item.column}|${item.severity}|${item.code ?? ""}|${
      item.message
    }`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.severity.localeCompare(b.severity),
  );
}

/**
 * 按 workspace 缓存语言服务进程。不同 workspace 的请求并发；同一 workspace 串行，
 * 避免 tsserver/didChange 事件交叉。结果只读，失败/超时都降级为空诊断。
 */
export class LspManager {
  private readonly entries = new Map<string, Entry>();
  private readonly failures = new Map<string, number>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  async diagnose(input: DiagnoseInput): Promise<DiagnoseOutput> {
    const files = [...new Set(input.files.map((file) => path.resolve(file)))];
    if (!files.length) return { serverNames: [], diagnostics: [] };
    const config = await loadLspConfig(input.cwd);
    if (config.disabled) {
      return {
        serverNames: [],
        diagnostics: [],
        unavailable: "LSP diagnostics are disabled by .meowcode/lsp.json.",
      };
    }
    const timeoutMs = Math.max(
      1_000,
      Math.min(20_000, input.timeoutMs ?? config.timeoutMs),
    );

    const groups = new Map<
      string,
      { label: string; files: string[]; create: () => TypeScriptServer | LanguageServer; check: () => Promise<string | undefined> }
    >();
    const unsupported = new Set<string>();
    for (const file of files) {
      const ref = serverForFile(config, file);
      if (!ref) {
        unsupported.add(path.extname(file).replace(/^\./, "") || "unknown");
        continue;
      }
      if (ref.kind === "typescript") {
        const key = "typescript";
        if (!groups.has(key)) {
          groups.set(key, {
            label: "typescript",
            files: [],
            create: () =>
              new TypeScriptServer({
                workspace: input.cwd,
                serverPath: "",
                timeoutMs,
              }),
            check: () => resolveTypeScriptServer(input.cwd, config.typescript.serverPath),
          });
        }
        groups.get(key)!.files.push(file);
        continue;
      }
      const key = `lsp:${ref.name}`;
      if (!groups.has(key)) {
        groups.set(key, {
          label: ref.name,
          files: [],
          create: () =>
            new LanguageServer({
              name: ref.name,
              config: ref.config,
              workspace: input.cwd,
              timeoutMs,
            }),
          check: () => findExecutable(ref.config.command),
        });
      }
      groups.get(key)!.files.push(file);
    }

    const diagnostics: LspDiagnostic[] = [];
    const serverNames: string[] = [];
    const warnings: string[] = [];

    await Promise.all(
      [...groups.entries()].map(async ([groupKey, group]) => {
        const entryKey = `${groupKey}:${input.cwd}`;
        const failedAt = this.failures.get(entryKey);
        if (failedAt && Date.now() - failedAt < FAILURE_COOLDOWN_MS) {
          warnings.push(`${group.label}: temporarily unavailable after a startup failure.`);
          return;
        }
        const available = await group.check();
        if (!available) {
          warnings.push(
            groupKey === "typescript"
              ? "typescript: tsserver not found (install typescript in the project)."
              : `${group.label}: command not found.`,
          );
          return;
        }
        const entry = this.getEntry(entryKey, () => {
          // tsserver 的 serverPath 由 check 时确定；LanguageServer 自己再探测命令。
          if (groupKey === "typescript") {
            return new TypeScriptServer({
              workspace: input.cwd,
              serverPath: available,
              timeoutMs,
            });
          }
          return group.create();
        });
        entry.busy += 1;
        const run = entry.chain.then(async () => {
          entry.lastUsed = Date.now();
          return entry.adapter.diagnose(group.files, input.signal);
        });
        entry.chain = run.then(
          () => undefined,
          () => undefined,
        );
        void run
          .finally(() => {
            entry.busy = Math.max(0, entry.busy - 1);
          })
          .catch(() => undefined);
        try {
          const result = await withTimeout(run, timeoutMs, input.signal);
          diagnostics.push(...result);
          serverNames.push(group.label);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            error instanceof LspUnavailableError ||
            /exited|not found|failed to start|initialize failed/i.test(message)
          ) {
            this.failures.set(entryKey, Date.now());
            this.dropEntry(entryKey);
          }
          warnings.push(`${group.label}: ${message}`);
        }
      }),
    );

    const uniqueServers = [...new Set(serverNames)];
    const result: DiagnoseOutput = {
      serverNames: uniqueServers,
      diagnostics: dedupe(diagnostics),
    };
    if (!uniqueServers.length) {
      const reasons = [...warnings];
      if (unsupported.size) {
        reasons.push(
          `no language server configured for: ${[...unsupported].join(", ")}`,
        );
      }
      result.unavailable = reasons.join("; ") || "No language server is available.";
    }
    return result;
  }

  disposeAll(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const entry of this.entries.values()) entry.adapter.dispose();
    this.entries.clear();
    this.failures.clear();
  }

  private getEntry(
    key: string,
    create: () => TypeScriptServer | LanguageServer,
  ): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        adapter: create(),
        lastUsed: Date.now(),
        chain: Promise.resolve(),
        busy: 0,
      };
      this.entries.set(key, entry);
      this.startIdleTimer();
      this.evictIfNeeded();
    }
    entry.lastUsed = Date.now();
    return entry;
  }

  private dropEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.adapter.dispose();
    this.entries.delete(key);
  }

  private evictIfNeeded(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const candidates = [...this.entries.values()]
        .filter((entry) => entry.busy === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      const oldest = candidates[0];
      if (!oldest) return;
      oldest.adapter.dispose();
      this.entries.delete(oldest.key);
    }
  }

  private startIdleTimer(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (entry.busy === 0 && now - entry.lastUsed > IDLE_MS) {
          entry.adapter.dispose();
          this.entries.delete(key);
        }
      }
      if (!this.entries.size && this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
      }
    }, 60_000);
    this.idleTimer.unref?.();
  }
}

let singleton: LspManager | null = null;

export function getLspManager(): LspManager {
  singleton ??= new LspManager();
  return singleton;
}

/** 测试用：丢弃进程级单例。 */
export function resetLspManager(): void {
  singleton?.disposeAll();
  singleton = null;
}

export type { LspConfig };
