/**
 * 文件系统边界检查：沙箱的 ACL/Low 标签只对本地 NTFS 成立。
 * UNC 在进入 Win32 ACL 调用前就拒绝，FAT/exFAT 给出明确错误而不是让
 * SetNamedSecurityInfoW 报一个含糊的 Win32 码。
 */

import { parse, resolve } from "node:path";
import { win32Sync } from "./ffi.js";

export function assertLocalNtfs(label: string, target: string): void {
  if (target.startsWith("\\\\")) {
    throw new Error(
      `${label} is a UNC/network path; the sandbox requires a local NTFS volume: ${target}`,
    );
  }
  const root = parse(resolve(target)).root;
  if (!root) {
    throw new Error(`${label} has no volume root: ${target}`);
  }
  const api = win32Sync();
  const fileSystemName = Buffer.alloc(64 * 2);
  if (
    api.getVolumeInformationW(
      root,
      null,
      0,
      null,
      null,
      null,
      fileSystemName,
      64,
    ) === 0
  ) {
    throw new Error(
      `${label} volume is unavailable (Win32 ${api.getLastError()}): ${target}`,
    );
  }
  const name = (fileSystemName.toString("utf16le").split("\u0000", 1)[0] ?? "").trim();
  if (name.toUpperCase() !== "NTFS") {
    throw new Error(
      `${label} is on ${name || "an unknown file system"}; the sandbox requires NTFS: ${target}`,
    );
  }
}
