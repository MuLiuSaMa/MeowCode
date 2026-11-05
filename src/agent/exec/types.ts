/** 统一执行面的输入/输出；只描述「怎么起进程、拿到什么字节」，不认识工具语义。 */

export type ExecSpec = {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** 每路（stdout / stderr 各自）的采集上限，沿用现有 1MB 语义 */
  maxCaptureBytes: number;
  /** true = 子进程 stdin 直接 EOF（沙箱 runner 用）；false = 保留 pipe（现有 run_command 行为） */
  closeStdin: boolean;
  signal?: AbortSignal;
  windowsHide?: boolean;
};

export type ExecResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  capped: boolean;
  spawnError?: string;
  durationMs: number;
  /** runner 缺失 / 策略不合法 / 非 win32：不执行，也不回退无沙箱 */
  sandboxUnavailable?: { code: string; detail: string };
};

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
