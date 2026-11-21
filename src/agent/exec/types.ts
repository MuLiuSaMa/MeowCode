/** 统一执行面的输入/输出；只描述「怎么起进程、拿到什么字节」，不认识工具语义。 */

import type { ChildProcess } from "node:child_process";

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
  /**
   * 超时时不杀进程：把还活着的子进程连同已采集的输出交给调用方（提升为后台任务）。
   * 钩子必须同步接管 stdout/stderr —— capture 交出去之后就不再读它们了。
   */
  onTimeout?: (child: ChildProcess, captured: TimeoutHandoff) => void;
};

/** 超时移交时已经采集到的输出（已清过 ANSI） */
export type TimeoutHandoff = {
  stdout: Buffer;
  stderr: Buffer;
  capped: boolean;
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
  /** 超时后子进程已交给 onTimeout 继续跑：输出和退出码要从那个后台任务里取 */
  promoted?: boolean;
  spawnError?: string;
  durationMs: number;
  /** 本次实际生效的超时（超时文案用它，避免硬编码与实际不符） */
  timeoutMs?: number;
  /** runner 缺失 / 策略不合法 / 非 win32：不执行，也不回退无沙箱 */
  sandboxUnavailable?: { code: string; detail: string };
};

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
/** 模型能显式要求的上限（对齐 Claude Code 的 10 分钟） */
export const MAX_COMMAND_TIMEOUT_MS = 600_000;
export const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
