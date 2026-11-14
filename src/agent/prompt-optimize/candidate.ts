/**
 * 离线提示词候选（#10）：候选的存储与冻结。
 *
 * 候选**永远不进热路径**：它们是磁盘上的一份 JSON，只在离线评估进程里被读出来
 * 与基线对照。热路径唯一的入口是 `systemSegments`（缓存边界后的增量段），
 * 冻结 = 把候选正文写进 segment 配置，这一步必须由人确认，本模块只负责落盘与标记。
 *
 * 存储位置：工作区 `.meowcode/prompt-candidates/<id>.json`。
 * 为什么放工作区而不是全局：候选是针对「这个仓库的提示词基线」调的，跨仓库没有意义。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeTextAtomic } from "../atomic-json.js";

export const PROMPT_CANDIDATES_DIR = path.join(".meowcode", "prompt-candidates");

export type PromptCandidate = {
  id: string;
  /** 创建时间（ISO）；决策按新旧排序时用 */
  createdAt: string;
  /** 评估时基线的 promptVersion.baseline（runtime.promptVersion），对照用 */
  baselineVersion: string;
  /** 候选改的是哪一段：segment 名（如 `root-agent`）；改基线记 `baseline` */
  segment: string;
  /** 候选正文：将被冻结为该 segment 的完整内容 */
  text: string;
  /** 人写的动机：为什么这版可能更好 */
  notes: string;
  /** frozen = 已经过人确认并写入 segment；冻结后不再参与评估 */
  frozen: boolean;
};

export function candidatesDirFor(workspace: string): string {
  return path.join(workspace, PROMPT_CANDIDATES_DIR);
}

function candidateFile(workspace: string, id: string): string {
  // id 只允许安全字符：文件名不能被构造成路径穿越
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) {
    throw new Error(`Invalid candidate id "${id}".`);
  }
  return path.join(candidatesDirFor(workspace), `${id}.json`);
}

export async function saveCandidate(workspace: string, candidate: PromptCandidate): Promise<void> {
  const file = candidateFile(workspace, candidate.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeTextAtomic(file, `${JSON.stringify(candidate, null, 2)}\n`);
}

export async function loadCandidate(
  workspace: string,
  id: string,
): Promise<PromptCandidate | null> {
  try {
    const raw = await fs.readFile(candidateFile(workspace, id), "utf8");
    const parsed = JSON.parse(raw) as PromptCandidate;
    if (typeof parsed?.id !== "string" || typeof parsed?.text !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function listCandidates(workspace: string): Promise<PromptCandidate[]> {
  const dir = candidatesDirFor(workspace);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: PromptCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const candidate = await loadCandidate(workspace, entry.name.slice(0, -5)).catch(() => null);
    if (candidate) out.push(candidate);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * 冻结标记：记录「这版已经过人确认」。真正写入 segment 是调用方（设置页/CLI）的事，
 * 这里只负责把状态落盘——模块自身没有任何写热路径的通道。
 */
export async function markFrozen(workspace: string, id: string): Promise<PromptCandidate | null> {
  const candidate = await loadCandidate(workspace, id);
  if (!candidate) return null;
  const frozen: PromptCandidate = { ...candidate, frozen: true };
  await saveCandidate(workspace, frozen);
  return frozen;
}
