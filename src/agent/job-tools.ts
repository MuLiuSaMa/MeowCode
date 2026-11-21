import type { ToolDefinition, ToolResult } from "./types.js";
import { createAnsiStripper } from "./exec/ansi.js";
import type { JobChunk, JobManager } from "./jobs.js";

const DEFAULT_JOB_OUTPUT_CHARS = 12_000;
const JOB_WAIT_DEFAULT_MS = 60_000;
const JOB_WAIT_MIN_MS = 1_000;
const JOB_WAIT_MAX_MS = 300_000;

export const jobToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "job",
    description:
      "Inspect or control background jobs: run_command background=true, and commands that were still running at their timeout. Jobs keep running after the turn ends; the user can also open the terminal tab and take over input. Use action=wait to block until the job exits instead of sleeping between polls.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "output", "wait", "input", "kill"],
          description:
            "list = all jobs; output = new text since offset; wait = block until the job exits or the timeout hits (until=\"output\" returns as soon as new output arrives); input = write to stdin; kill = stop the job.",
        },
        job_id: { type: "string", description: "Job id returned by run_command (background=true or after a timeout)." },
        offset: {
          type: "number",
          description:
            "Next offset from the previous output call; omit to read from the start of the retained buffer (wait: only output after now).",
        },
        timeout_ms: {
          type: "number",
          description: "wait only: how long to block, 1000-300000 (default 60000).",
        },
        until: {
          type: "string",
          enum: ["exit", "output"],
          description:
            "wait only: exit (default) blocks until the process ends or the timeout hits and returns everything produced meanwhile; output returns as soon as there is new output.",
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

/** 清掉 PTY 里的 ANSI 控制序列（终端页签要原样，模型不用看这些） */
function cleanJobOutput(data: string): string {
  if (!data.includes("\u001b")) return data;
  const stripper = createAnsiStripper();
  return stripper.push(Buffer.from(data, "utf8")).toString("utf8") + stripper.flush().toString("utf8");
}

/** output / wait 共用的增量块格式。 */
function formatChunk(jobId: string, chunk: JobChunk, maxChars: number, note?: string): string {
  // PTY 缓冲里是原始字节（终端页签要留着颜色）：给模型看之前先清掉 ANSI 噪音
  const data = cleanJobOutput(chunk.data);
  const sliced = data.length > maxChars ? `[earlier output truncated]\n${data.slice(-maxChars)}` : data;
  const status = chunk.exited ? `exited (code ${chunk.code ?? "?"})` : "running";
  const meta = [
    `[job ${jobId} · ${status} · next offset ${chunk.offset}${chunk.truncated ? " · older output dropped" : ""}${note ? ` · ${note}` : ""}]`,
    data.length ? "" : "(no new output)",
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
        "It keeps running after this turn. Block until it finishes with job {action:\"wait\", job_id} (returns on exit or timeout, default 60s), read what it printed with job {action:\"output\", job_id}, and never sleep between polls. The user can open the terminal tab to interact with it.",
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
      const until = input.until === "output" ? "output" : "exit";
      const raw = Number(input.offset);
      const offset = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : undefined;
      const startedAt = Date.now();
      const chunk = await manager.wait(jobId, {
        ...(offset === undefined ? {} : { offset }),
        timeoutMs,
        until,
      });
      if (!chunk) return { ok: false, output: `Job ${jobId} was not found.` };
      const waited = Math.round((Date.now() - startedAt) / 1000);
      const note = chunk.exited ? undefined : `still running after ${waited}s`;
      return { ok: true, output: formatChunk(jobId, chunk, maxChars, note) };
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
