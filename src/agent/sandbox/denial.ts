import type { SandboxDenial, SandboxDenialKind } from "./types.js";

/**
 * 纯函数：从一次被沙箱包住的执行结果里判断「是不是写/删被拦」。
 * codex 的 denial.rs 同思路，但这里额外区分强/弱信号：
 * 裸 `permission denied`（git/ssh 常见）必须同时有写/删上下文才算；
 * 否则归 unknown_denied —— runtime 不会为它弹「关沙箱重试」。
 */

const STRONG_DENIAL =
  /(access is denied|access to the path|拒绝访问|访问被拒绝|0x80070005|unauthorizedaccessexception)/i;
const BARE_DENIAL =
  /(permission denied|operation not permitted|\beperm\b|\beacces\b|权限不足)/i;
const DELETE_CONTEXT =
  /(remove-item|\bdel\b|\brm\b|\brmdir\b|\bunlink\b|\bdelete\b|\bremove\b|\brename\b|\bmove\b|删除|移除|重命名|移动)/i;
const WRITE_CONTEXT =
  /(set-content|out-file|new-item|copy-item|add-content|\bwrite\b|\bcreate\b|\bmkdir\b|\bcopy\b|\bcp\b|写入|创建|新建|复制|保存|生成)/i;

const RUNNER_FAILURE_PREFIX = "meowcode-sandbox-run:";

export type SandboxDenialInput = {
  exitCode: number | null;
  /** stdout + stderr 合并后的可读输出 */
  output: string;
  command: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  writableRoots?: string[];
};

export function classifySandboxDenial(input: SandboxDenialInput): SandboxDenial | undefined {
  if (input.timedOut || input.aborted || input.spawnError) return undefined;
  if (input.exitCode === null || input.exitCode === 0) return undefined;
  if (input.exitCode === 127 && input.output.includes(RUNNER_FAILURE_PREFIX)) return undefined;

  const output = input.output;
  const strong = STRONG_DENIAL.test(output);
  const bare = !strong && BARE_DENIAL.test(output);
  if (!strong && !bare) return undefined;

  const context = `${input.command}\n${output}`;
  const deleteContext = DELETE_CONTEXT.test(context);
  const writeContext = WRITE_CONTEXT.test(context);
  if (bare && !deleteContext && !writeContext) {
    return {
      kind: "unknown_denied",
      evidence: evidenceFor(output, BARE_DENIAL),
      exitCode: input.exitCode,
      writableRoots: input.writableRoots ?? [],
    };
  }

  const kind: SandboxDenialKind = deleteContext && !writeContext ? "delete_denied" : "write_denied";
  return {
    kind,
    evidence: evidenceFor(output, strong ? STRONG_DENIAL : BARE_DENIAL),
    exitCode: input.exitCode,
    writableRoots: input.writableRoots ?? [],
  };
}

function evidenceFor(output: string, pattern: RegExp): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hit = lines.find((line) => pattern.test(line));
  return (hit ?? output).slice(0, 400);
}
