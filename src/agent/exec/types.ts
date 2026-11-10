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
  /** 头部（未超上限时即全部内容） */
  stdout: Buffer;
  stderr: Buffer;
  /** 超过采集上限时单独保留的尾部（报错/汇总通常在最后几行） */
  stdoutTail?: Buffer;
  stderrTail?: Buffer;
  /** 头尾之间被省略的字节数（分路统计；0 = 完整采集） */
  stdoutOmittedBytes?: number;
  stderrOmittedBytes?: number;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  capped: boolean;
  spawnError?: string;
  durationMs: number;
  /** 本次实际生效的超时（超时文案用它，避免硬编码与实际不符） */
  timeoutMs?: number;
  /** runner 缺失 / 策略不合法 / 非 win32：不执行，也不回退无沙箱 */
  sandboxUnavailable?: { code: string; detail: string };
};

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
