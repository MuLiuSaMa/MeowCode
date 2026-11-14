import type { ToolDefinition, ToolResult } from "./types.js";
import type { JobChunk, JobManager } from "./jobs.js";

const DEFAULT_JOB_OUTPUT_CHARS = 12_000;
const JOB_WAIT_DEFAULT_MS = 20_000;
const JOB_WAIT_MIN_MS = 1_000;
const JOB_WAIT_MAX_MS = 60_000;
const JOB_WAIT_POLL_MS = 500;

export const jobToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "job",
    description:
      "Inspect or control background jobs started with run_command background=true. Jobs keep running after the turn ends; the user can also open the terminal tab and take over input. Use action=wait to block for output instead of sleeping.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "output", "wait", "input", "kill"],
          description:
            "list = all jobs; output = new text since offset; wait = block until output, exit, or timeout; input = write to stdin; kill = stop the job.",
        },
        job_id: { type: "string", description: "Job id returned by run_command background=true." },
        offset: {
          type: "number",
          description:
            "Next offset from the previous output call; omit to read from the start of the retained buffer (wait: only output after now).",
        },
        timeout_ms: {
          type: "number",
          description: "wait only: block time, 1000-60000 (default 20000).",
        },
        data: { type: "string", description: "Text to write to the job's stdin (input only)." },
        max_chars: {
          type: "number",
          description: "Maximum characters to return for output (default 12000).",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};

export function isJobTool(tool: string): boolean {
  return tool === "job";
}

function formatJobLine(job: {
  id: string;
  command: string;
  exited: boolean;
  code: number | null;
}): string {
  const status = job.exited ? `exited ${job.code ?? "?"}` : "running";
  return `- ${job.id} [${status}] ${job.command}`;
}

function maxCharsOf(input: Record<string, unknown>): number {
  return Number.isFinite(Number(input.max_chars))
    ? Math.max(200, Math.floor(Number(input.max_chars)))
    : DEFAULT_JOB_OUTPUT_CHARS;
}

/** output / wait 共用的增量块格式。 */
function formatChunk(jobId: string, chunk: JobChunk, maxChars: number, note?: string): string {
  const sliced =
    chunk.data.length > maxChars
      ? `[earlier output truncated]\n${chunk.data.slice(-maxChars)}`
      : chunk.data;
  const status = chunk.exited ? `exited (code ${chunk.code ?? "?"})` : "running";
  const meta = [
    `[job ${jobId} · ${status} · next offset ${chunk.offset}${chunk.truncated ? " · older output dropped" : ""}${note ? ` · ${note}` : ""}]`,
    chunk.data.length ? "" : "(no new output)",
  ]
    .filter(Boolean)
    .join("\n");
  return `${sliced}${sliced ? "\n" : ""}${meta}`;
}

function clampWaitMs(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return JOB_WAIT_DEFAULT_MS;
  return Math.min(JOB_WAIT_MAX_MS, Math.max(JOB_WAIT_MIN_MS, Math.floor(raw)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startBackgroundCommand(
  manager: JobManager,
  command: string,
  cwd: string,
): Promise<ToolResult> {
  try {
    const job = await manager.start({ command, cwd });
    return {
      ok: true,
      output: [
        `Started background job ${job.id}: ${command}`,
        "It keeps running after this turn. Read output with job {action:\"output\", job_id}, or block for new output with job {action:\"wait\", job_id, timeout_ms}; do not sleep between polls. The user can open the terminal tab to interact with it.",
      ].join("\n"),
    };
  } catch (error) {
    return {
      ok: false,
      output: `Failed to start background job: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function executeJobTool(
  manager: JobManager,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const action = String(input.action ?? "");
  const jobId = typeof input.job_id === "string" ? input.job_id.trim() : "";

  try {
    if (action === "list") {
      const jobs = await manager.list();
      if (!jobs.length) return { ok: true, output: "No background jobs." };
      return { ok: true, output: jobs.map(formatJobLine).join("\n") };
    }
    if (!jobId) {
      return { ok: false, output: `job action "${action}" requires job_id.` };
    }
    if (action === "output") {
      const raw = Number(input.offset);
      const offset = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : undefined;
      const chunk = await manager.read(jobId, offset);
      if (!chunk) return { ok: false, output: `Job ${jobId} was not found.` };
      return { ok: true, output: formatChunk(jobId, chunk, maxCharsOf(input)) };
    }
    if (action === "wait") {
      const timeoutMs = clampWaitMs(input.timeout_ms);
      const maxChars = maxCharsOf(input);
      const raw = Number(input.offset);
      let offset = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : undefined;
      if (offset === undefined) {
        // 省略 offset = 只等当前末尾之后的新输出：用超大 offset 只探末尾，不搬运历史缓冲
        const end = await manager.read(jobId, Number.MAX_SAFE_INTEGER);
        if (!end) return { ok: false, output: `Job ${jobId} was not found.` };
        if (end.exited) return { ok: true, output: formatChunk(jobId, end, maxChars) };
        offset = end.offset;
      }
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const chunk = await manager.read(jobId, offset);
        if (!chunk) return { ok: false, output: `Job ${jobId} was not found.` };
        if (chunk.data.length || chunk.exited) {
          return { ok: true, output: formatChunk(jobId, chunk, maxChars) };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return {
            ok: true,
            output: formatChunk(jobId, chunk, maxChars, `no new output after ${timeoutMs}ms`),
          };
        }
        await sleep(Math.min(JOB_WAIT_POLL_MS, remaining));
      }
    }
    if (action === "input") {
      const data = typeof input.data === "string" ? input.data : "";
      if (!data) return { ok: false, output: "job action \"input\" requires data." };
      await manager.write(jobId, data);
      return { ok: true, output: `Wrote ${data.length} characters to job ${jobId}.` };
    }
    if (action === "kill") {
      await manager.kill(jobId);
      return { ok: true, output: `Stopped job ${jobId}.` };
    }
    return { ok: false, output: `Unknown job action: ${action}` };
  } catch (error) {
    return {
      ok: false,
      output: `job ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
