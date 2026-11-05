import type { ToolDefinition, ToolResult } from "./types.js";
import type { JobManager } from "./jobs.js";

const DEFAULT_JOB_OUTPUT_CHARS = 12_000;

export const jobToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "job",
    description:
      "Inspect or control background jobs started with run_command background=true. Jobs keep running after the turn ends; the user can also open the terminal tab and take over input.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "output", "input", "kill"],
          description: "list = all jobs; output = new text since offset; input = write to stdin; kill = stop the job.",
        },
        job_id: { type: "string", description: "Job id returned by run_command background=true." },
        offset: {
          type: "number",
          description: "Next offset from the previous output call; omit to read from the start of the retained buffer.",
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
        "It keeps running after this turn. Read output with job {action:\"output\", job_id}. The user can open the terminal tab to interact with it.",
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
      const maxChars = Number.isFinite(Number(input.max_chars))
        ? Math.max(200, Math.floor(Number(input.max_chars)))
        : DEFAULT_JOB_OUTPUT_CHARS;
      const sliced =
        chunk.data.length > maxChars
          ? `[earlier output truncated]\n${chunk.data.slice(-maxChars)}`
          : chunk.data;
      const status = chunk.exited
        ? `exited (code ${chunk.code ?? "?"})`
        : "running";
      const meta = [
        `[job ${jobId} · ${status} · next offset ${chunk.offset}${chunk.truncated ? " · older output dropped" : ""}]`,
        chunk.data.length ? "" : "(no new output)",
      ]
        .filter(Boolean)
        .join("\n");
      return { ok: true, output: `${sliced}${sliced ? "\n" : ""}${meta}` };
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
