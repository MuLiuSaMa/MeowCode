/**
 * Ported from deepseek-harness packages/sandbox/sandbox-windows-acl/src/path-boundary.ts
 * (MIT License, Copyright (c) 2026 DeepSeek). MeowCode: OS-level run_command isolation.
 */

import { isAbsolute, relative, resolve } from "node:path";

function normalizeForCompare(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(normalizeForCompare(parent), normalizeForCompare(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 私有 temp 根不能落在工作区里，否则临时目录反过来扩大了可写面。 */
export function assertTempRootOutsideWorkspace(workspace: string, tempRoot: string): void {
  if (isInsideOrEqual(tempRoot, workspace)) {
    throw new Error(`sandbox temp root is inside the workspace: ${tempRoot}`);
  }
}

/** 私有 temp 与任一可写根不得互相包含。 */
export function assertPrivateTempDisjoint(writableDirs: readonly string[], tempDir: string): void {
  for (const dir of writableDirs) {
    if (isInsideOrEqual(tempDir, dir) || isInsideOrEqual(dir, tempDir)) {
      throw new Error(`sandbox temp dir and writable root overlap: ${tempDir} vs ${dir}`);
    }
  }
}
