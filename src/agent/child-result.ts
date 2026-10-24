import type { AgentRole } from "./types.js";

/**
 * 子 Agent 结果契约（参考 metis 的 ChildResult + fail-closed 校验）：
 * implementer / reviewer / verifier 的最终报告必须携带一个 JSON 块；
 * 宿主用自己观测到的事实（文件改动、执行过的命令）覆盖模型自述，
 * 再按角色做 fail-closed 校验——"宣称完成但宿主观测不到证据"直接判无效。
 */
export type ChildFinding = {
  severity: "critical" | "major" | "minor";
  message: string;
  location?: string;
};

export type ChildResultStatus = "completed" | "failed" | "blocked";

export type ChildResult = {
  status: ChildResultStatus;
  summary: string;
  findings: ChildFinding[];
  /** 宿主观测 ground truth（mergeHostObservations 覆盖模型自述） */
  filesChanged: string[];
  commands: Array<{ argv: string; exitCode: number }>;
  /** fail-closed 校验结果；invalid 时 invalidReason 给出机器可读原因 */
  valid: boolean;
  invalidReason?: string;
};

/** 受契约约束的角色：这些角色的结果会被解析与校验（门禁关账者必须在这里）。 */
export const CHILD_RESULT_ROLES: ReadonlySet<AgentRole> = new Set([
  "implementer",
  "reviewer",
  "verifier",
  "scoper",
  "depth-prober",
  "fresh-verifier",
  "juror",
  "sweeper",
  "goal-checker",
]);

/** 角色系统提示词末尾附加的结果契约文本。 */
export const CHILD_RESULT_CONTRACT = `End your FINAL message with a fenced json block in exactly this shape:
\`\`\`json
{"status": "completed", "summary": "one short paragraph", "findings": []}
\`\`\`
status: completed | failed | blocked. findings: [{"severity": "critical|major|minor", "message": "...", "location": "path/file.ts:12"}] — reviewers list every finding; implementers/verifiers usually omit it or list unresolved ones.`;

type RawFinding = { severity?: unknown; message?: unknown; location?: unknown };

/** 提取最后一个 ```json 围栏块；找不到返回 null。 */
function extractJsonBlock(text: string): string | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const last = matches[matches.length - 1];
  return last ? last[1].trim() : null;
}

function normalizeStatus(value: unknown): ChildResultStatus {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["completed", "done", "success", "succeeded", "passed", "ok"].includes(text)) {
    return "completed";
  }
  if (["blocked", "block", "stuck", "interrupted"].includes(text)) return "blocked";
  return "failed";
}

function normalizeSeverity(value: unknown): ChildFinding["severity"] {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "critical" || text === "major" ? text : "minor";
}

function normalizeFindings(value: unknown): ChildFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: ChildFinding[] = [];
  for (const raw of value.slice(0, 20)) {
    const item = (raw ?? {}) as RawFinding;
    const message = typeof item.message === "string" ? item.message.trim() : "";
    if (!message) continue;
    const location = typeof item.location === "string" ? item.location.trim() : "";
    findings.push({
      severity: normalizeSeverity(item.severity),
      message: message.slice(0, 400),
      ...(location ? { location: location.slice(0, 200) } : {}),
    });
  }
  return findings;
}

/**
 * 宽容归一化子代理最终报告：解析末尾 JSON 块，失败或字段异常时降级为
 * {status: "completed", summary: 全文}——信任与否交给 validate 决定。
 */
export function normalizeChildResult(report: string): ChildResult {
  const fallback: ChildResult = {
    status: "completed",
    summary: report.trim().slice(0, 600),
    findings: [],
    filesChanged: [],
    commands: [],
    valid: true,
  };
  const block = extractJsonBlock(report);
  if (!block) return fallback;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(block);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fallback;
    parsed = value as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 600)
      : fallback.summary;
  return {
    status: normalizeStatus(parsed.status),
    summary,
    findings: normalizeFindings(parsed.findings),
    filesChanged: [],
    commands: [],
    valid: true,
  };
}

/** 用宿主观测事实覆盖模型自述的 filesChanged / commands。 */
export function mergeHostObservations(
  result: ChildResult,
  observations: { filesChanged: string[]; commands: Array<{ argv: string; exitCode: number }> },
): ChildResult {
  return {
    ...result,
    filesChanged: [...new Set(observations.filesChanged)],
    commands: observations.commands.map((command) => ({
      argv: command.argv.slice(0, 300),
      exitCode: command.exitCode,
    })),
  };
}

/**
 * fail-closed 校验：宣称完成但宿主观测不到对应证据即判无效。
 * - implementer completed 必须观测到文件改动
 * - verifier completed 必须观测到执行过命令
 * - reviewer failed 必须带 findings
 * - 任何 completed 必须有非空 summary
 */
export function validateChildResult(role: AgentRole, result: ChildResult): ChildResult {
  const invalid = (reason: string): ChildResult => ({
    ...result,
    valid: false,
    invalidReason: reason,
  });
  if (result.status !== "completed") {
    if (role === "reviewer" && result.status === "failed" && !result.findings.length) {
      return invalid("REVIEW_FAILED_WITHOUT_FINDINGS");
    }
    return result;
  }
  if (!result.summary.trim()) return invalid("EMPTY_SUMMARY");
  if (role === "implementer" && !result.filesChanged.length) {
    return invalid("IMPLEMENTER_COMPLETED_WITHOUT_FILE_CHANGES");
  }
  if (role === "verifier" && !result.commands.length) {
    return invalid("VERIFIER_COMPLETED_WITHOUT_COMMANDS");
  }
  return result;
}

/**
 * 完整流水线（宿主在子代理结算时调用）：
 * 回合状态映射 → 报告归一化 → 宿主观测合并 → fail-closed 校验。
 * 非契约角色的输出原样丢弃（返回 null），父级只看自由文本报告。
 */
export function buildChildResult(input: {
  role: AgentRole;
  report: string;
  turnStatus: string;
  errorMessage?: string;
  observations: { filesChanged: string[]; commands: Array<{ argv: string; exitCode: number }> };
}): ChildResult | null {
  if (!CHILD_RESULT_ROLES.has(input.role)) return null;
  let result: ChildResult;
  if (input.turnStatus === "completed") {
    result = normalizeChildResult(input.report);
  } else if (input.turnStatus === "aborted" || input.turnStatus === "interrupted") {
    result = {
      status: "blocked",
      summary: input.report.trim().slice(0, 600) || "aborted before finishing",
      findings: [],
      filesChanged: [],
      commands: [],
      valid: true,
    };
  } else {
    result = {
      status: "failed",
      summary: (input.errorMessage ?? input.report).trim().slice(0, 600) || "failed",
      findings: [],
      filesChanged: [],
      commands: [],
      valid: true,
    };
  }
  result = mergeHostObservations(result, input.observations);
  return validateChildResult(input.role, result);
}

/** 给父级模型的工具结果文本：紧凑 JSON 块，宿主已校验。 */
export function renderChildResult(result: ChildResult): string {
  const payload = {
    status: result.status,
    valid: result.valid,
    ...(result.invalidReason ? { invalidReason: result.invalidReason } : {}),
    summary: result.summary,
    ...(result.filesChanged.length ? { filesChanged: result.filesChanged } : {}),
    ...(result.commands.length
      ? {
          commands: result.commands.map((command) => ({
            argv: command.argv,
            exitCode: command.exitCode,
          })),
        }
      : {}),
    ...(result.findings.length ? { findings: result.findings } : {}),
  };
  return `Child result (host-verified):\n\`\`\`json\n${JSON.stringify(payload, null, 0)}\n\`\`\``;
}
