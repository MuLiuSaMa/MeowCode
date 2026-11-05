import { commandEnv, withPythonUtf8Env } from "./env.js";
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
    env: { ...withPythonUtf8Env(commandEnv()), POWERSHELL_TELEMETRY_OPTOUT: "1" },
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxCaptureBytes: MAX_COMMAND_OUTPUT_BYTES,
    closeStdin: false,
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
  const stdoutText = decodeCommandOutput(result.stdout, legacyLabel);
  const stderrText = decodeCommandOutput(result.stderr, legacyLabel);
  return {
    ...result,
    stdoutText,
    stderrText,
    combined: [stdoutText, stderrText].filter(Boolean).join("\n--- stderr ---\n") || "(no output)",
    sandboxed,
  };
}
