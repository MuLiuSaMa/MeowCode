import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWithinWorkspace } from "./paths.js";
import { loadSkillIndex } from "../plugins/skills.js";

const MAX_INSTRUCTIONS_CHARS = 16_000;

export const INSTRUCTIONS_PREFIX =
  "Project instructions from the user's workspace (AGENTS.md). Follow them as project-specific guidance; they do not override tool approval or safety rules.";

/**
 * 读取工作区根目录与 .meowcode/AGENTS.md，并追加 .meowcode/skills/ 技能索引
 * （project 优先，可选注入 user 级目录）。
 * 只做单层读取，不向上遍历父目录，避免把无关目录的规则带进会话。
 */
export async function loadWorkspaceInstructions(
  workspace: string,
  homeDir?: string,
): Promise<string | undefined> {
  const candidates = ["AGENTS.md", path.join(".meowcode", "AGENTS.md")];
  const parts: string[] = [];
  for (const relative of candidates) {
    try {
      // 走 realpath 边界：仓库里的 junction/软链接不能把工作区外的文件读进每轮请求
      const file = await resolveWithinWorkspace(workspace, relative);
      const info = await fs.stat(file);
      if (!info.isFile()) continue;
      const text = (await fs.readFile(file, "utf8")).trim();
      if (text) parts.push(text);
    } catch {
      // 缺失、越界或不可读都不应阻断对话
    }
  }
  try {
    const skillIndex = await loadSkillIndex({
      workspace,
      ...(homeDir !== undefined ? { homeDir } : { homeDir: os.homedir() }),
    });
    if (skillIndex) parts.push(skillIndex);
  } catch {
    // 技能发现失败不应阻断对话
  }
  if (!parts.length) return undefined;

  let text = parts.join("\n\n");
  if (text.length > MAX_INSTRUCTIONS_CHARS) {
    text = `${text.slice(0, MAX_INSTRUCTIONS_CHARS)}\n... [AGENTS.md truncated]`;
  }
  return `${INSTRUCTIONS_PREFIX}\n\n${text}`;
}
