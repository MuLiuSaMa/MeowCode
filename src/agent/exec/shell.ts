import { commandEnv, withPlainOutputEnv, withPythonUtf8Env } from "./env.js";
import { decodeCommandOutput, getLegacyOutputLabel } from "./encoding.js";
import { powerShellArgv, resolvePowerShell } from "./powershell.js";
import { runCapture } from "./capture.js";
import { getSandboxSettings } from "../sandbox/policy.js";
import { wrapExecSpec } from "../sandbox/runner-client.js";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
  type ExecResult,
  type ExecSpec,
} from "./types.js";

export type ShellRunResult = ExecResult & {
  stdoutText: string;
  stderrText: string;
  /** 工具回执的合并形态；与迁移前逐字节一致。 */
  combined: string;
  /** 这次执行是否真的经过沙箱 runner */
  sandboxed: boolean;
};

/** PowerShell 命令执行：组装 argv / env，采集后按 UTF-8 + 系统码页回退解码。 */
export async function runShellCommand(options: {
  workspace: string;
  command: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  sandbox?: "enforce" | "bypass";
}): Promise<ShellRunResult> {
  const executable = await resolvePowerShell();
  const legacyLabel = await getLegacyOutputLabel();
  let spec: ExecSpec = {
    file: executable,
    args: powerShellArgv(options.command),
    cwd: options.workspace,
    env: withPlainOutputEnv({
      ...withPythonUtf8Env(commandEnv()),
      POWERSHELL_TELEMETRY_OPTOUT: "1",
    }),
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxCaptureBytes: MAX_COMMAND_OUTPUT_BYTES,
    // 没有 stdin 通道：交互式命令（Read-Host / pause / git commit 无 -m）必须立刻拿 EOF，
    // 否则只会挂满整个超时时间
    closeStdin: true,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  let sandboxed = false;
  const settings = getSandboxSettings();
  if (settings.enabled && options.sandbox !== "bypass") {
    const wrapped = wrapExecSpec(spec, settings);
    if ("unavailable" in wrapped) {
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: null,
        timedOut: false,
        aborted: false,
        capped: false,
        durationMs: 0,
        sandboxUnavailable: wrapped.unavailable,
        stdoutText: "",
        stderrText: "",
        combined: "",
        sandboxed: false,
      };
    }
    spec = wrapped.spec;
    sandboxed = true;
  }
  const result = await runCapture(spec);
  /**
   * 头 + 尾拼回一段可读文本。中间被省略的部分必须显式标出来：
   * 直接首尾相接，模型会把两段读成连在一起的一句话。
   */
  const mergeTail = (head: string, tail: Buffer | undefined, omitted: number | undefined): string => {
    if (!tail?.length) return head;
    const tailText = decodeCommandOutput(tail, legacyLabel);
    if (!tailText) return head;
    return `${head}\n... [${omitted ?? 0} bytes omitted here; output kept its first and last part — filter it in the command (Select-Object -First, Select-String) to see the middle]\n${tailText}`;
  };
  const stdoutText = mergeTail(
    decodeCommandOutput(result.stdout, legacyLabel),
    result.stdoutTail,
    result.stdoutOmittedBytes,
  );
  const stderrText = mergeTail(
    decodeCommandOutput(result.stderr, legacyLabel),
    result.stderrTail,
    result.stderrOmittedBytes,
  );
  return {
    ...result,
    stdoutText,
    stderrText,
    combined: [stdoutText, stderrText].filter(Boolean).join("\n--- stderr ---\n") || "(no output)",
    sandboxed,
  };
}
