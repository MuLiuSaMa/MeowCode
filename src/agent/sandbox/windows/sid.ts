/**
 * Ported from deepseek-harness packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts
 * (MIT License, Copyright (c) 2026 DeepSeek). MeowCode: OS-level run_command isolation.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/**
 * 确定性能力 SID（S-1-4-x-y）：同一工作区跨会话/重启派生同一身份，
 * 工作区 ACE 只需传播一次；后续 provision 靠精确 ACE 跳过。
 */
export function workspaceWriteSid(workspaceRoot: string): string {
  const digest = createHash("sha256").update(workspaceRoot, "utf8").digest();
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
  return `S-1-4-${first}-${second}`;
}

/** 私有 temp 目录的写身份；固定第三子权限域，和所有 workspace SID 不相交。 */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash("sha256")
    .update("temp\0", "utf8")
    .update(tempDir, "utf8")
    .digest();
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
  return `S-1-4-${first}-${second}-1`;
}

/** Windows 上必须用 native realpath：不同别名/大小写拼写要收敛到同一个 SID。 */
export function canonicalizeExistingPath(target: string): string {
  return realpathSync.native(target);
}
