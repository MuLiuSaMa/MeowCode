import { spawn, type ChildProcess } from "node:child_process";
import { encodeFrame, FrameParser } from "./framing.js";
import { LspUnavailableError } from "./types.js";

export type RpcProtocol = "jsonrpc" | "tsserver";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type RpcOptions = {
  command: string;
  args: string[];
  cwd: string;
  protocol: RpcProtocol;
  env?: NodeJS.ProcessEnv;
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).unref();
      return;
    } catch {
      // 回退到 child.kill
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 已退出
  }
}

/**
 * stdio JSON-RPC：同一套请求/超时/进程生命周期，适配 LSP 与 tsserver 两种报文。
 * 共享 server 不在单个请求取消时被杀；只有 dispose / 进程退出才结束。
 */
export class RpcConnection {
  private readonly child: ChildProcess;
  private readonly parser: FrameParser;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;
  private spawnError: Error | null = null;
  private stderrTail = "";

  constructor(private readonly options: RpcOptions) {
    const env = { ...process.env, ...options.env };
    const windowsScript =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(options.command);
    try {
      this.child = windowsScript
        ? spawn(
            process.env.ComSpec ?? "cmd.exe",
            [
              "/d",
              "/s",
              "/c",
              [quoteForCmd(options.command), ...options.args.map(quoteForCmd)].join(" "),
            ],
            { cwd: options.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
          )
        : spawn(options.command, options.args, {
            cwd: options.cwd,
            env,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
    } catch (error) {
      throw new LspUnavailableError(
        `Could not start language server (${options.command}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.parser = new FrameParser(
      (message) => this.handleMessage(message),
      (error) => {
        this.stderrTail = `${this.stderrTail}\n[protocol] ${error.message}`.slice(-8192);
      },
    );
    this.child.stdout?.on("data", (chunk: Buffer) => this.parser.feed(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8192);
    });
    this.child.on("error", (error) => {
      this.spawnError =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new LspUnavailableError(`Language server command not found: ${options.command}`)
          : error;
      this.rejectAll(this.spawnError);
    });
    this.child.on("exit", (code, signal) => {
      this.rejectAll(
        new RpcError(`Language server exited (${code ?? signal ?? "unknown"}).`),
      );
      this.disposed = true;
      options.onExit?.(code, signal);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  request(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new RpcError("Language server connection is closed."));
    }
    if (this.spawnError) {
      return Promise.reject(this.spawnError);
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? 10_000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settlePending(id);
        reject(new RpcError(`Language server request timed out: ${method}`));
      }, timeoutMs);
      const onAbort = () => {
        this.settlePending(id);
        reject(new RpcError(`Language server request aborted: ${method}`));
      };
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          reject(new RpcError(`Language server request aborted: ${method}`));
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(options.signal ? { signal: options.signal, onAbort } : {}),
      });
      const payload =
        this.options.protocol === "tsserver"
          ? { seq: id, type: "request", command: method, arguments: params ?? {} }
          : {
              jsonrpc: "2.0",
              id,
              method,
              ...(params === undefined ? {} : { params }),
            };
      this.write(payload);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed || this.options.protocol === "tsserver") return;
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new RpcError("Language server connection closed."));
    killTree(this.child);
  }

  private write(payload: unknown): void {
    if (this.disposed || this.spawnError) return;
    try {
      // tsserver 的输入是换行分隔 JSON；输出仍是 Content-Length 帧（与 VS Code 一致）
      const data =
        this.options.protocol === "tsserver"
          ? Buffer.from(`${JSON.stringify(payload)}\n`, "utf8")
          : encodeFrame(payload);
      this.child.stdin?.write(data);
    } catch (error) {
      this.stderrTail = `${this.stderrTail}\n[write] ${
        error instanceof Error ? error.message : String(error)
      }`.slice(-8192);
    }
  }

  private settlePending(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    return pending;
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.settlePending(id);
      pending.reject(error);
    }
  }

  private handleMessage(message: unknown): void {
    if (Array.isArray(message)) {
      for (const item of message) this.handleMessage(item);
      return;
    }
    if (!message || typeof message !== "object") return;
    if (this.options.protocol === "tsserver") {
      this.handleTsserverMessage(message as Record<string, unknown>);
      return;
    }
    this.handleJsonRpcMessage(message as Record<string, unknown>);
  }

  private handleTsserverMessage(message: Record<string, unknown>): void {
    if (message.type === "response") {
      const id = Number(message.request_seq);
      const pending = this.settlePending(id);
      if (!pending) return;
      if (message.success === false) {
        pending.reject(
          new RpcError(
            typeof message.message === "string" ? message.message : "tsserver request failed.",
          ),
        );
        return;
      }
      pending.resolve(message.body);
      return;
    }
    if (message.type === "event" && typeof message.event === "string") {
      this.options.onNotification?.(message.event, message.body);
    }
  }

  private handleJsonRpcMessage(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        void this.answerServerRequest(message);
        return;
      }
      this.options.onNotification?.(message.method, message.params);
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const id = Number(message.id);
    const pending = this.settlePending(id);
    if (!pending) return;
    if (message.error) {
      const error = message.error as { code?: number; message?: string; data?: unknown };
      pending.reject(
        new RpcError(
          typeof error.message === "string" ? error.message : "Language server error.",
          error.code,
          error.data,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private async answerServerRequest(message: Record<string, unknown>): Promise<void> {
    let result: unknown = null;
    try {
      result =
        (await this.options.onRequest?.(
          String(message.method),
          message.params,
        )) ?? null;
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
    this.write({ jsonrpc: "2.0", id: message.id, result });
  }
}
