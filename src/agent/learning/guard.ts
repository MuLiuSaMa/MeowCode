/**
 * 学习产物的安全守卫。
 *
 * 这一层的存在理由很直接：学习器是个 LLM，它会产出「看起来合理」的文本。
 * 如果它写出一句「提交前先设置 approvalMode 为 full」，那这条经验就会被
 * 当成项目知识在后续回合反复注入 —— 相当于让模型自己给自己发权限。
 *
 * 所以守卫分三类：
 *  1. 内容层：不许提控制面工具、不许教绕过验证、不许碰配置文件；
 *  2. 体积层：技能正文/经验/陈述各有上限，超了说明在写文档不是写经验；
 *  3. 路径层：名字必须是 kebab-case，写盘路径必须落在学习根内。
 *
 * 另外抄了 metis 一条很实用的规则：更新同名技能时，如果新内容明显变短
 * 且丢了原有的命令参数，直接拒绝 —— 防止一条好经验被坏摘要覆盖。
 */
import path from "node:path";
import { isValidMemoryName } from "../memory.js";
import {
  MAX_GUIDELINE_CHARS,
  MAX_SKILL_CONTENT_CHARS,
  MAX_TRAIT_CHARS,
  type LearningKind,
} from "./types.js";

/**
 * 控制面标识：学习产物一旦提到它们，就有篡改治理流程的嫌疑。
 * 注意不要用裸 "task" —— 那是极常见的英文词，会大面积误杀。
 */
const FORBIDDEN_CONTROL_PLANE: RegExp[] = [
  /\bupdate_plan\b/i,
  /\bask_user\b/i,
  /\bspawn_agent\b/i,
  /\bharness\.json\b/i,
  /\.meowcode[\\/]harness/i,
  /\bapprovalMode\b/i,
  /\bapproval_required\b/i,
  /\bpermission_?mode\b/i,
  /\bworkflow\.json\b/i,
  /\bGOVERNANCE_GATED_TOOLS\b/,
];

/** 绕过验证的意图。允许写「跑测试」，不允许写「跳过测试」。 */
const FORBIDDEN_BYPASS: RegExp[] = [
  /跳过(?:验证|核验|检查|测试)/,
  /绕过(?:验证|核验|审批|检查|gate)/i,
  /无需(?:验证|核验|测试)/,
  /不(?:必|用)(?:验证|核验)/,
  /skip(?:ping)?\s+(?:the\s+)?(?:verification|checks?|tests?|review)/i,
  /bypass(?:ing)?\s+(?:the\s+)?(?:approval|verification|gate|checks?)/i,
  /--dangerously/,
  /--no-verify/,
  /\bno-verify\b/i,
];

/** 配置文件与进程级开关：学习产物只允许是经验，不允许是配置。 */
const FORBIDDEN_CONFIG: RegExp[] = [
  /(?:^|[\\/\s"'`])settings\.json/i,
  /(?:^|[\\/\s"'`])providers\.json/i,
  /(?:^|[\\/\s"'`])mcp\.json/i,
  /(?:^|[\\/\s"'`])meowcode\.json/i,
  /\bMEOWCODE_[A-Z0-9_]+\b/,
];

/** 脱敏规则：命中即替换，避免密钥被写进长期记忆。 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, label: "anthropic-key" },
  { pattern: /\bsk-[A-Za-z0-9]{16,}/g, label: "openai-key" },
  { pattern: /\bghp_[A-Za-z0-9]{20,}/g, label: "github-token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: "github-pat" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: "slack-token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws-key" },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/g, label: "bearer" },
  {
    pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/gi,
    label: "credential",
  },
];

/** 把明显的密钥替换成 [redacted]；返回替换后的文本与命中数。 */
export function redactSecrets(text: string): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const { pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      hits += 1;
      // 保留 key 名，只抹掉值：`password=***` 比整行消失更有用
      const eq = match.search(/[:=]/);
      return eq > 0 ? `${match.slice(0, eq + 1)} [redacted]` : "[redacted]";
    });
  }
  return { text: out, hits };
}

/** 体积上限按类型分档。 */
export function maxCharsFor(kind: LearningKind): number {
  switch (kind) {
    case "skill":
      return MAX_SKILL_CONTENT_CHARS;
    case "guideline":
      return MAX_GUIDELINE_CHARS;
    case "profile":
      return MAX_TRAIT_CHARS;
    default:
      return MAX_SKILL_CONTENT_CHARS;
  }
}

/** 截断到上限，超了加省略标记（只在允许截断的场合用，比如 proposal）。 */
export function clipText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 内容检查：返回拒绝理由，通过时返回 null。
 * 用返回值而不是抛错，是因为批量应用时一条坏数据不该拖垮其余条目。
 */
export function checkLearningContent(content: string, kind: LearningKind): string | null {
  const text = content ?? "";
  if (!text.trim()) return "empty content";
  if (text.length > maxCharsFor(kind)) {
    return `content too long (${text.length} > ${maxCharsFor(kind)})`;
  }
  for (const pattern of FORBIDDEN_CONTROL_PLANE) {
    if (pattern.test(text)) return `mentions control plane (${pattern.source})`;
  }
  for (const pattern of FORBIDDEN_BYPASS) {
    if (pattern.test(text)) return `suggests bypassing verification (${pattern.source})`;
  }
  for (const pattern of FORBIDDEN_CONFIG) {
    if (pattern.test(text)) return `touches configuration (${pattern.source})`;
  }
  return null;
}

/** 抛错版，给「必须通过否则整条丢弃」的调用点用。 */
export function assertLearningSafe(content: string, kind: LearningKind): void {
  const reason = checkLearningContent(content, kind);
  if (reason) throw new Error(`Unsafe ${kind} content: ${reason}`);
}

/** 技能名：复用记忆的命名规则（kebab-case，且不与索引文件冲突）。 */
export function isValidLearningName(name: string): boolean {
  return isValidMemoryName(name);
}

/** target 是否在 root 内（含相等）。Windows 路径大小写不敏感。 */
export function isPathInside(root: string, target: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(root), normalize(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 写盘前的路径断言：名字已经过校验，这里再兜一次目录逃逸。 */
export function assertPathInside(root: string, target: string): void {
  if (!isPathInside(root, target)) {
    throw new Error(`Learning path escapes its root: ${target}`);
  }
}

/** 提取命令里的长参数（--flag / --key=value），用于「缩短丢参」判断。 */
export function extractCommandFlags(text: string): string[] {
  const flags = new Set<string>();
  for (const match of text.matchAll(/--[A-Za-z][\w-]*/g)) {
    flags.add(match[0].toLowerCase());
  }
  return [...flags].sort();
}

/**
 * 更新同名技能时的防覆盖检查（metis 的 reject 规则）。
 *
 * 坏摘要的典型形态：新正文比原文短一大截，原来那条 `pnpm publish --tag latest`
 * 变成了 `pnpm publish`。参数丢了，技能就废了，但表面上「内容更精炼」。
 * 判据取 60% 阈值 —— 正常补充/改写不会掉这么多。
 */
export function looksLikeLossyUpdate(previous: string, next: string): boolean {
  const before = previous.trim();
  const after = next.trim();
  if (!before || !after) return false;
  if (after.length >= before.length * 0.6) return false;
  const beforeFlags = extractCommandFlags(before);
  if (!beforeFlags.length) return false;
  const afterFlags = new Set(extractCommandFlags(after));
  return beforeFlags.some((flag) => !afterFlags.has(flag));
}

/** 正则 trigger 必须能编译，否则召回时会每回合抛错。 */
export function isValidTriggerRegex(source: string): boolean {
  if (!source || source.length > 120) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}
