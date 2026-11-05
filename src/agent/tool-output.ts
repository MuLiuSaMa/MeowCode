/**
 * 工具输出的落盘与清理。
 *
 * 单独成模块的原因：`code-mode.ts` 也要把沙箱日志落到同一个目录并参与 7 天清理，
 * 而它反过来 import `tools.ts` 会形成循环依赖。路径校验仍走 `paths.ts` 的
 * realpath 边界 —— 输出目录同样可能被替换成指向外部的 junction。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveToolPath } from "./paths.js";

export const TOOL_OUTPUT_DIR = path.join(".meowcode", "tool-output");
export const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 超过预算的完整工具输出落到工作区，模型可用 read_file 继续读取。 */
export async function persistToolOutput(
  workspace: string,
  tool: string,
  text: string,
): Promise<string> {
  const dir = await resolveToolPath(workspace, TOOL_OUTPUT_DIR);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${tool}-${stamp}-${randomUUID().slice(0, 8)}.log`);
  await fs.writeFile(file, text, "utf8");
  await cleanupToolOutput(dir);
  return path.relative(workspace, file).split(path.sep).join("/");
}

/** 删除超过保留期的落盘文件；并发删除或文件已消失都不影响本次调用。 */
async function cleanupToolOutput(dir: string): Promise<void> {
  const cutoff = Date.now() - TOOL_OUTPUT_RETENTION_MS;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = path.join(dir, entry.name);
          try {
            const stat = await fs.stat(file);
            if (stat.mtimeMs < cutoff) await fs.unlink(file);
          } catch {
            // 并发清理或文件已消失不影响本次输出
          }
        }),
    );
  } catch {
    // 清理失败不应阻断工具结果
  }
}

/**
 * 供其它落盘方（run_code 沙箱日志）复用同一套保留策略。
 * 不落新文件、只清理旧文件，所以失败一律吞掉。
 */
export async function sweepToolOutput(workspace: string): Promise<void> {
  try {
    const dir = await resolveToolPath(workspace, TOOL_OUTPUT_DIR);
    await cleanupToolOutput(dir);
  } catch {
    // 目录不存在或越界：无需清理
  }
}
