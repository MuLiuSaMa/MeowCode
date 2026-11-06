import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

/**
 * 目录列举时跳过的条目名（构建产物 / 依赖 / VCS 内部目录）。
 * 放在 paths.ts 共享：list_dir 与 run_code 沙箱的 meow.listDir 必须看到同一份视图。
 */
export const IGNORED_ENTRY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".meowcode",
  "node_modules",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".next",
  ".turbo",
  ".cache",
]);

/** 词法包含判断：两侧都必须是绝对路径。 */
function containsLexically(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 真实路径：展开 8.3 短名与 junction；路径不存在时回退词法解析。 */
export function canonicalPathSync(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

export function isWithinWorkspace(workspace: string, target: string): boolean {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedTarget = path.resolve(target);
  if (containsLexically(resolvedWorkspace, resolvedTarget)) return true;
  // 工作区可能来自 8.3 短路径 / junction，而目标已被 realpath 展开：再按真实路径比一次
  return containsLexically(canonicalPathSync(resolvedWorkspace), canonicalPathSync(resolvedTarget));
}

/**
 * 允许路径尾部尚不存在（新建文件）：向上找到最近存在的祖先做 realpath，
 * 再把缺失段拼回去。这样工作区内指向外部的软链接/junction 也会被解析出来。
 */
async function realpathWithMissingSegments(target: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  while (true) {
    try {
      const real = await fs.realpath(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** 工作区本身可能是 junction / 8.3 短路径；不存在时回退词法路径。 */
async function canonicalWorkspace(workspace: string): Promise<string> {
  const resolved = path.resolve(workspace);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function resolveWithinWorkspace(workspace: string, target: string): Promise<string> {
  const [realWorkspace, realTarget] = await Promise.all([
    canonicalWorkspace(workspace),
    realpathWithMissingSegments(path.resolve(workspace, target)),
  ]);
  if (!isWithinWorkspace(realWorkspace, realTarget)) {
    throw new Error(`Path is outside the workspace: ${target}`);
  }
  return realTarget;
}

/** 工具路径解析：完全访问模式下允许绝对路径访问工作区外；相对路径仍按工作区解析。 */
export async function resolveToolPath(
  workspace: string,
  target: string,
  allowOutsideWorkspace = false,
): Promise<string> {
  if (allowOutsideWorkspace) return path.resolve(workspace, target);
  return resolveWithinWorkspace(workspace, target);
}

export function displayPath(workspace: string, target: string): string {
  const base = path.resolve(workspace);
  const resolved = path.resolve(base, target);
  if (containsLexically(base, resolved)) return path.relative(base, resolved) || ".";
  // 短路径 / junction 工作区：目标已被 realpath 展开，按真实路径重新算相对位置
  const realBase = canonicalPathSync(base);
  const realResolved = canonicalPathSync(resolved);
  if (containsLexically(realBase, realResolved)) return path.relative(realBase, realResolved) || ".";
  // 工作区外路径用绝对路径展示，避免出现大量 ..\..\
  return resolved;
}
