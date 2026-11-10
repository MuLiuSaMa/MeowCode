import type { AgentRole } from "./types.js";

/**
 * 子 Agent 结果契约（参考 metis 的 ChildResult + fail-closed 校验）：
 * 契约角色的最终报告必须携带一个 JSON 块；宿主用自己观测到的事实
 * （文件改动、执行过的命令）覆盖模型自述，再按角色做 fail-closed 校验。
 *
 * fail-closed 的两层含义：
 *  1. 缺块 / 解析失败 = 无效，不再默认「completed + valid」——没交契约就是没交证据；
 *  2. 每个门禁角色都有必须存在的证据字段（implementer 文件改动、verifier 命令、
 *     评审类角色 checked 清单、juror verdict），缺一项即 invalid。
 */
export type ChildFinding = {
  severity: "critical" | "major" | "minor";
  message: string;
  location?: string;
};

export type ChildResultStatus = "completed" | "failed" | "blocked";

/** juror 的终审结论；缺省一律按 FAIL 处理（default-FAIL）。 */
export type ChildVerdict = "PASS" | "FAIL";

export type ChildResult = {
  status: ChildResultStatus;
  summary: string;
  findings: ChildFinding[];
  /** 模型自述「我实际打开过什么」（file:line / 命令 / diff 片段）；评审类角色的必填证据 */
  checked: string[];
  /** juror 专用：PASS / FAIL；其余角色忽略 */
  verdict?: ChildVerdict;
  /** 宿主观测 ground truth（mergeHostObservations 覆盖模型自述） */
  filesChanged: string[];
  commands: Array<{ argv: string; exitCode: number }>;
  /** 报告里没有可解析的契约 JSON 块：契约角色一律判无效 */
  blockMissing: boolean;
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

/** 必须给出 checked 清单（「我亲手打开过什么」）的评审类角色。 */
export const EVIDENCE_ROLES: ReadonlySet<AgentRole> = new Set([
  "reviewer",
  "scoper",
  "depth-prober",
  "sweeper",
  "goal-checker",
  "juror",
]);

/** 角色系统提示词末尾附加的结果契约文本。 */
export const CHILD_RESULT_CONTRACT = `End your FINAL message with a fenced json block, exactly:
\`\`\`json
{"status":"completed","summary":"one short paragraph","checked":["path/file.ts:12","pnpm test → exit 0"],"findings":[]}
\`\`\`
status: completed | failed | blocked. checked: what you actually opened (file:line, command, diff) — required for review/scope/probe/sweep/goal-check/juror; a completed report without it is rejected. findings: [{"severity":"critical|major|minor","message":"...","location":"path/file.ts:12"}]. juror adds "verdict":"PASS"|"FAIL"; a missing verdict counts as FAIL. No block, no credit.`;

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

/** checked 归一化：只保留非空字符串，去重，限 20 条 / 每条 200 字符。 */
function normalizeChecked(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.slice(0, 20)) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) continue;
    const item = text.slice(0, 200);
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizeVerdict(value: unknown): ChildVerdict | undefined {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return text === "PASS" || text === "FAIL" ? text : undefined;
}

/**
 * 宽容归一化子代理最终报告：解析末尾 JSON 块。
 * 缺块 / 解析失败 / 非对象时保留全文摘要但标记 blockMissing，
 * 由 validateChildResult 判无效——归一化不替模型补证据。
 */
export function normalizeChildResult(report: string): ChildResult {
  const text = report.trim();
  const fallback: ChildResult = {
    status: "completed",
    summary: text.slice(0, 600),
    findings: [],
    checked: [],
    filesChanged: [],
    commands: [],
    blockMissing: true,
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
  const verdict = normalizeVerdict(parsed.verdict);
  const status = normalizeStatus(parsed.status);
  return {
    // verdict=FAIL 与 status=completed 自相矛盾：终审说 FAIL 就是没通过
    status: verdict === "FAIL" && status === "completed" ? "failed" : status,
    summary,
    findings: normalizeFindings(parsed.findings),
    checked: normalizeChecked(parsed.checked),
    ...(verdict ? { verdict } : {}),
    filesChanged: [],
    commands: [],
    blockMissing: false,
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
 * fail-closed 校验：宣称完成但宿主/报告里观测不到对应证据即判无效。
 * - 契约角色缺 JSON 块 → 无效（没交契约就是没交证据）
 * - 任何 completed 必须有非空 summary
 * - implementer completed 必须观测到文件改动
 * - verifier / fresh-verifier completed 必须观测到执行过命令
 * - 评审类角色 completed 必须给出非空 checked（亲手打开过的证据）
 * - juror 必须给出 verdict；缺省即 FAIL，FAIL 不能算 completed
 * - reviewer failed 必须带 findings
 */
export function validateChildResult(role: AgentRole, result: ChildResult): ChildResult {
  const invalid = (reason: string): ChildResult => ({
    ...result,
    valid: false,
    invalidReason: reason,
  });
  if (result.blockMissing) return invalid("MISSING_RESULT_BLOCK");
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
  if ((role === "verifier" || role === "fresh-verifier") && !result.commands.length) {
    return invalid("VERIFIER_COMPLETED_WITHOUT_COMMANDS");
  }
  if (role === "juror") {
    if (!result.verdict) return invalid("JUROR_MISSING_VERDICT");
    if (result.verdict === "FAIL") return invalid("JUROR_FAILED_CANNOT_COMPLETE");
  }
  if (EVIDENCE_ROLES.has(role) && !result.checked.length) {
    return invalid("COMPLETED_WITHOUT_CHECKED_EVIDENCE");
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
      checked: [],
      filesChanged: [],
      commands: [],
      blockMissing: false,
      valid: true,
    };
  } else {
    result = {
      status: "failed",
      summary: (input.errorMessage ?? input.report).trim().slice(0, 600) || "failed",
      findings: [],
      checked: [],
      filesChanged: [],
      commands: [],
      blockMissing: false,
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
    ...(result.verdict ? { verdict: result.verdict } : {}),
    summary: result.summary,
    ...(result.checked.length ? { checked: result.checked } : {}),
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
