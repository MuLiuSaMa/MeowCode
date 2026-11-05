import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeTextAtomic } from "./atomic-json.js";

/**
 * 项目级审批规则：用户批准一次后可「本项目不再询问」。
 * 规则落在 <workspace>/.meowcode/approvals.json（该目录已在 paths.ts 的忽略集里，
 * 不会被 list_dir / 搜索看到）。删除项目目录即撤销全部规则。
 */
export type ApprovalRuleKind = "tool" | "path" | "command-exact" | "command-prefix";

export type ApprovalRule = {
  id: string;
  tool: string;
  match: {
    kind: ApprovalRuleKind;
    /** tool = 工具名；path = 相对路径；command-* = 命令或前缀 */
    value: string;
    /** path 规则记录批准时的文件版本；文件改动后规则自动失效 */
    fileSha?: string;
  };
  createdAt: string;
};

export const APPROVALS_FILE = path.join(".meowcode", "approvals.json");
const MAX_RULES = 200;

const SHELL_META = /[;&|><`$(){}[\]\n\r]/;

function fileOf(workspace: string): string {
  return path.join(workspace, APPROVALS_FILE);
}

/** 规则里的路径统一存工作区相对 POSIX 形式，项目整体搬走后仍然有效。 */
export function toRulePath(workspace: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(workspace), path.resolve(absolutePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath.split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

export async function readApprovalRules(workspace: string): Promise<ApprovalRule[]> {
  try {
    const raw = await fs.readFile(fileOf(workspace), "utf8");
    const parsed = JSON.parse(raw) as { version?: number; rules?: ApprovalRule[] };
    if (!Array.isArray(parsed.rules)) return [];
    return parsed.rules.filter(
      (rule): rule is ApprovalRule =>
        Boolean(rule) &&
        typeof rule.id === "string" &&
        typeof rule.tool === "string" &&
        typeof rule.match?.kind === "string" &&
        typeof rule.match?.value === "string" &&
        typeof rule.createdAt === "string",
    );
  } catch {
    return [];
  }
}

async function writeRules(workspace: string, rules: ApprovalRule[]): Promise<void> {
  const file = fileOf(workspace);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeTextAtomic(
    file,
    `${JSON.stringify({ version: 1, rules: rules.slice(-MAX_RULES) }, null, 2)}\n`,
  );
}

export async function addApprovalRule(
  workspace: string,
  input: { tool: string; kind: ApprovalRuleKind; value: string; fileSha?: string },
): Promise<ApprovalRule> {
  const rules = await readApprovalRules(workspace);
  // 同 tool + kind + value 的规则只保留最新一条（版本随最新一次批准刷新）
  const filtered = rules.filter(
    (rule) =>
      !(
        rule.tool === input.tool &&
        rule.match.kind === input.kind &&
        rule.match.value === input.value
      ),
  );
  const rule: ApprovalRule = {
    id: randomUUID(),
    tool: input.tool,
    match: {
      kind: input.kind,
      value: input.value,
      ...(input.fileSha ? { fileSha: input.fileSha } : {}),
    },
    createdAt: new Date().toISOString(),
  };
  filtered.push(rule);
  await writeRules(workspace, filtered);
  return rule;
}

export async function removeApprovalRule(workspace: string, id: string): Promise<boolean> {
  const rules = await readApprovalRules(workspace);
  const next = rules.filter((rule) => rule.id !== id);
  if (next.length === rules.length) return false;
  await writeRules(workspace, next);
  return true;
}

export async function clearApprovalRules(workspace: string): Promise<number> {
  const rules = await readApprovalRules(workspace);
  if (rules.length) await writeRules(workspace, []);
  return rules.length;
}

/** 命令前缀建议：含 shell 元字符或无法安全归一的命令不给前缀，只允许精确匹配。 */
export function commandPrefix(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed || SHELL_META.test(trimmed)) return undefined;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return undefined;
  const [exe, sub, third] = tokens;
  if (!/^[A-Za-z0-9._-]+$/.test(exe) || !/^[A-Za-z0-9._-]+$/.test(sub)) return undefined;
  // 包管理器：pnpm run <script> 收窄到脚本级；exec 一律不生成前缀
  if (["npm", "pnpm", "yarn", "bun"].includes(exe)) {
    if (sub === "exec" || sub === "dlx") return undefined;
    if (sub === "run" && third && /^[A-Za-z0-9:._-]+$/.test(third)) return `${exe} run ${third}`;
    return `${exe} ${sub}`;
  }
  return `${exe} ${sub}`;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  const normalized = normalizeCommand(command);
  if (SHELL_META.test(normalized)) return false;
  // 空白是参数边界，冒号是脚本名边界（pnpm run test → test:unit）
  return (
    normalized === prefix ||
    normalized.startsWith(`${prefix} `) ||
    normalized.startsWith(`${prefix}:`)
  );
}

export type ApprovalRuleMatchInput = {
  tool: string;
  command?: string;
  /** 绝对路径 + 当前版本（captureVersion） */
  targets?: Array<{ path: string; version: string }>;
};

/**
 * 命中返回对应规则；文件类工具要求「所有目标都被 path 规则覆盖且版本一致」。
 * 高危命令由调用方先排除，规则层不做风险判断。
 */
export function matchApprovalRule(
  rules: ApprovalRule[],
  input: ApprovalRuleMatchInput,
): ApprovalRule | undefined {
  const forTool = rules.filter((rule) => rule.tool === input.tool);
  if (!forTool.length) return undefined;

  if (input.targets?.length) {
    const pathRules = forTool.filter((rule) => rule.match.kind === "path");
    const covered = input.targets.every((target) =>
      pathRules.some(
        (rule) =>
          rule.match.value === target.path &&
          (rule.match.fileSha === undefined || rule.match.fileSha === target.version),
      ),
    );
    if (covered) return pathRules[0];
    // 文件工具不允许 tool 级「全部放行」规则兜底
    return undefined;
  }

  if (input.command !== undefined) {
    const exact = forTool.find(
      (rule) =>
        rule.match.kind === "command-exact" &&
        normalizeCommand(rule.match.value) === normalizeCommand(input.command ?? ""),
    );
    if (exact) return exact;
    return forTool.find(
      (rule) =>
        rule.match.kind === "command-prefix" &&
        commandMatchesPrefix(input.command ?? "", rule.match.value),
    );
  }

  return forTool.find((rule) => rule.match.kind === "tool");
}
