/**
 * Ported from deepseek-harness packages/sandbox/sandbox-windows-acl/src/acl.ts
 * (MIT License, Copyright (c) 2026 DeepSeek). MeowCode: OS-level run_command isolation.
 *
 * 每次授权在 ONE SetNamedSecurityInfoW 里做三件事：能力 SID 写/删 ACE、
 * DENY Everyone FILE_DELETE_CHILD（只继承子目录）、Low no-write-up 标签。
 * 撤销分两种：temp 用 revokeWrite（目录马上删除），工作区用 revokeGrant
 * （精确删除我们加的两条 ACE + Low 标签，不留残留）。
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as abi from "./abi.js";
import {
  allocOverlapped,
  allocPtrSlot,
  decodePtr,
  decodeUint8At,
  decodeUint16At,
  decodeUint32At,
  getTempPath,
  isInvalidHandle,
  isNullPtr,
  ptrAddress,
  sameSidAt,
  throwLastError,
  throwWin32,
  type NativePtr,
  type Win32Bindings,
} from "./ffi.js";

/** 打包一条 x64 EXPLICIT_ACCESS_W（48B；ptstrName 绝对偏移 40）。 */
export function buildExplicitAccess(
  sidPtr: NativePtr,
  mode: number,
  permissions: number,
  inheritance: number = abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE);
  entry.writeUInt32LE(permissions, 0);
  entry.writeUInt32LE(mode, 4);
  entry.writeUInt32LE(inheritance, 8);
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24);
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28);
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32);
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40);
  return entry;
}

/** 一个受保护目录一把锁；锁根必须来自稳定的 GetTempPathW，不能是私有 temp。 */
export function lockFilePath(api: Win32Bindings, path: string): string {
  const digest = createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 16);
  return join(getTempPath(api), "meowcode-acl-locks", `${digest}.lock`);
}

/** 用 LockFileEx 单字节排他锁串行化 get-merge-set，避免并发授权互相覆盖。 */
export function withPathLock<T>(api: Win32Bindings, path: string, action: () => T): T {
  const lockPath = lockFilePath(api, path);
  mkdirSync(dirname(lockPath), { recursive: true });
  const handle = api.createFileW(
    lockPath,
    abi.GENERIC_READ | abi.GENERIC_WRITE,
    abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE,
    null,
    abi.OPEN_ALWAYS,
    0,
    null,
  );
  if (isInvalidHandle(handle)) throwLastError(api, "CreateFileW", lockPath);
  const overlapped = allocOverlapped();
  if (api.lockFileEx(handle, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(handle);
    throwWin32(api, "LockFileEx", win32Code, lockPath);
  }

  let result: T;
  try {
    result = action();
  } catch (error) {
    api.unlockFileEx(handle, 0, 1, 0, overlapped);
    api.closeHandle(handle);
    throw error;
  }
  if (api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(handle);
    throwWin32(api, "UnlockFileEx", win32Code, lockPath);
  }
  if (api.closeHandle(handle) === 0) throwLastError(api, "CloseHandle", `lock file ${lockPath}`);
  return result;
}

/** 读当前 DACL + 标签 ACL；descriptor 是唯一可 LocalFree 的分配，ACL 在它里面。 */
function readCurrentSecurity(
  api: Win32Bindings,
  path: string,
): { oldAcl: NativePtr | null; labelAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot();
  const groupSlot = allocPtrSlot();
  const daclSlot = allocPtrSlot();
  const saclSlot = allocPtrSlot();
  const descriptorSlot = allocPtrSlot();
  const readResult = api.getNamedSecurityInfoW(
    path,
    abi.SE_FILE_OBJECT,
    abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION,
    ownerSlot,
    groupSlot,
    daclSlot,
    saclSlot,
    descriptorSlot,
  );
  if (readResult !== abi.ERROR_SUCCESS) {
    throwWin32(api, "GetNamedSecurityInfoW", readResult, path);
  }
  return {
    oldAcl: decodePtr(daclSlot),
    labelAcl: decodePtr(saclSlot),
    descriptor: decodePtr(descriptorSlot),
  };
}

/** 构造 Low no-write-up 标签 ACL；调用方用 LocalFree 释放。 */
export function buildLowLabelAcl(api: Win32Bindings, lowLabelSidPtr: NativePtr): NativePtr {
  const sidLength = api.getLengthSid(lowLabelSidPtr);
  if (sidLength === 0) throwLastError(api, "GetLengthSid", "Low mandatory label SID");
  const aclLength = abi.ACL_HEADER_SIZE + abi.MANDATORY_ACE_OVERHEAD + sidLength;
  const acl = api.localAlloc(abi.LPTR, aclLength);
  if (isNullPtr(acl)) throwLastError(api, "LocalAlloc", "Low mandatory label ACL");
  if (api.initializeAcl(acl, aclLength, abi.ACL_REVISION) === 0) {
    const win32Code = api.getLastError();
    api.localFree(acl);
    throwWin32(api, "InitializeAcl", win32Code, "Low mandatory label ACL");
  }
  if (
    api.addMandatoryAce(
      acl,
      abi.ACL_REVISION,
      abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
      abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
      lowLabelSidPtr,
    ) === 0
  ) {
    const win32Code = api.getLastError();
    api.localFree(acl);
    throwWin32(api, "AddMandatoryAce", win32Code, "Low mandatory label ACL");
  }
  return acl;
}

type LabelEdit = { kind: "apply"; acl: NativePtr } | { kind: "clear" } | { kind: "keep" };

function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entries: Buffer,
  oldAcl: NativePtr | null,
  labelEdit: LabelEdit,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = allocPtrSlot();
  const mergeResult = api.setEntriesInAclW(
    entries.length / abi.EXPLICIT_ACCESS_W_SIZE,
    entries,
    oldAcl,
    newAclSlot,
  );
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor);
    if (labelEdit.kind === "apply") api.localFree(labelEdit.acl);
    throwWin32(api, "SetEntriesInAclW", mergeResult, `${label}(${path})`);
  }
  const newAcl = decodePtr(newAclSlot);
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor);
    if (labelEdit.kind === "apply") api.localFree(labelEdit.acl);
    throwWin32(api, "SetEntriesInAclW", api.getLastError(), `${label}(${path}): null new ACL`);
  }

  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null;
  const applyResult = api.setNamedSecurityInfoW(
    path,
    abi.SE_FILE_OBJECT,
    labelEdit.kind === "keep"
      ? abi.DACL_SECURITY_INFORMATION
      : abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION,
    null,
    null,
    newAcl,
    labelEdit.kind === "apply" ? labelEdit.acl : null,
  );
  const freedNew = api.localFree(newAcl);
  const freedLabel = labelEdit.kind === "apply" ? api.localFree(labelEdit.acl) : null;
  if (applyResult !== abi.ERROR_SUCCESS) {
    throwWin32(api, "SetNamedSecurityInfoW", applyResult, `${label}(${path})`);
  }
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) {
    throwLastError(api, "LocalFree", `${label}(${path}) descriptor`);
  }
  if (!isNullPtr(freedNew)) throwLastError(api, "LocalFree", `${label}(${path}) new ACL`);
  if (freedLabel !== null && !isNullPtr(freedLabel)) {
    throwLastError(api, "LocalFree", `${label}(${path}) label ACL`);
  }
}

function findExactEntryIndex(
  acl: NativePtr,
  aceType: number,
  inheritance: number,
  mask: number,
  sidPtr: NativePtr,
): number {
  const aclSize = decodeUint16At(acl, 2);
  const aceCount = decodeUint16At(acl, 4);
  if (aclSize < 8 || aclSize > 1_048_576) return -1;
  let offset = 8;
  for (let index = 0; index < aceCount; index += 1) {
    const aceSize = decodeUint16At(acl, offset + 2);
    if (aceSize < 8 || offset + aceSize > aclSize) return -1;
    const exact =
      decodeUint8At(acl, offset) === aceType &&
      decodeUint8At(acl, offset + 1) === inheritance &&
      decodeUint32At(acl, offset + 4) === mask;
    if (exact && sameSidAt(acl, offset + 8, sidPtr, 0)) return index;
    offset += aceSize;
  }
  return -1;
}

function hasExactEntry(
  acl: NativePtr,
  aceType: number,
  inheritance: number,
  mask: number,
  sidPtr: NativePtr,
): boolean {
  return findExactEntryIndex(acl, aceType, inheritance, mask, sidPtr) >= 0;
}

function hasExactLabel(labelAcl: NativePtr, lowLabelSidPtr: NativePtr): boolean {
  return hasExactEntry(
    labelAcl,
    abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE,
    abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
    lowLabelSidPtr,
  );
}

function hasExactGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  return hasExactEntry(
    oldAcl,
    abi.ACCESS_ALLOWED_ACE_TYPE,
    abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    abi.GRANT_MASK,
    sidPtr,
  );
}

function hasExactDeny(oldAcl: NativePtr, worldSidPtr: NativePtr): boolean {
  return hasExactEntry(
    oldAcl,
    abi.ACCESS_DENIED_ACE_TYPE,
    abi.CONTAINER_INHERIT_ACE,
    abi.FILE_DELETE_CHILD,
    worldSidPtr,
  );
}

function hasForeignGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(oldAcl, 2);
  const aceCount = decodeUint16At(oldAcl, 4);
  if (aclSize < 8 || aclSize > 1_048_576) return false;
  let offset = 8;
  for (let index = 0; index < aceCount; index += 1) {
    const aceSize = decodeUint16At(oldAcl, offset + 2);
    if (aceSize < 8 || offset + aceSize > aclSize) return false;
    const isGrant =
      decodeUint8At(oldAcl, offset) === abi.ACCESS_ALLOWED_ACE_TYPE &&
      decodeUint32At(oldAcl, offset + 4) === abi.GRANT_MASK;
    if (isGrant && !sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true;
    offset += aceSize;
  }
  return false;
}

/**
 * 给能力 SID 授予 GRANT_MASK、给 Everyone 拒绝 FILE_DELETE_CHILD（只继承子目录）、
 * 打 Low 标签，一次 merge + apply。精确 ACE 已存在时跳过 apply（避免整树重复传播）。
 */
export function grantWrite(
  api: Win32Bindings,
  path: string,
  sidPtr: NativePtr,
  lowLabelSidPtr: NativePtr,
  worldSidPtr: NativePtr,
): void {
  withPathLock(api, path, () => {
    const { oldAcl, labelAcl, descriptor } = readCurrentSecurity(api, path);
    if (
      oldAcl !== null &&
      labelAcl !== null &&
      hasExactGrant(oldAcl, sidPtr) &&
      hasExactDeny(oldAcl, worldSidPtr) &&
      hasExactLabel(labelAcl, lowLabelSidPtr)
    ) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor);
        if (!isNullPtr(freed)) throwLastError(api, "LocalFree", `grantWrite(${path}) descriptor`);
      }
      return;
    }
    let label: NativePtr;
    try {
      label = buildLowLabelAcl(api, lowLabelSidPtr);
    } catch (error) {
      if (descriptor !== null) api.localFree(descriptor);
      throw error;
    }
    mergeAndApply(
      api,
      path,
      Buffer.concat([
        buildExplicitAccess(worldSidPtr, abi.DENY_ACCESS, abi.FILE_DELETE_CHILD, abi.CONTAINER_INHERIT_ACE),
        buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK),
      ]),
      oldAcl,
      { kind: "apply", acl: label },
      descriptor,
      "grantWrite",
    );
  });
}

/** 撤销一个临时目录的能力 ACE；目录随后会被删除，残留的 world deny 无影响。 */
export function revokeWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentSecurity(api, path);
    if (oldAcl === null) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor);
        if (!isNullPtr(freed)) throwLastError(api, "LocalFree", `revokeWrite(${path}) descriptor`);
      }
      return false;
    }
    mergeAndApply(
      api,
      path,
      buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0),
      oldAcl,
      hasForeignGrant(oldAcl, sidPtr) ? { kind: "keep" } : { kind: "clear" },
      descriptor,
      "revokeWrite",
    );
    return true;
  });
}

/**
 * 完整撤销工作区/额外根：精确删除我们加的能力 ACE 与 Everyone deny，
 * 无其他能力授权时清掉 Low 标签。参考实现的 revokeWrite 不删 world deny，
 * 会让「撤销授权」永久留一条拒绝 ACE —— 这里用 DeleteAce 精确移除。
 */
export function revokeGrant(
  api: Win32Bindings,
  path: string,
  capSidPtr: NativePtr,
  worldSidPtr: NativePtr,
  lowLabelSidPtr: NativePtr,
): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, labelAcl, descriptor } = readCurrentSecurity(api, path);
    if (oldAcl === null) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor);
        if (!isNullPtr(freed)) throwLastError(api, "LocalFree", `revokeGrant(${path}) descriptor`);
      }
      return false;
    }

    const indices: number[] = [];
    const grantIndex = findExactEntryIndex(
      oldAcl,
      abi.ACCESS_ALLOWED_ACE_TYPE,
      abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
      abi.GRANT_MASK,
      capSidPtr,
    );
    if (grantIndex >= 0) indices.push(grantIndex);
    const denyIndex = findExactEntryIndex(
      oldAcl,
      abi.ACCESS_DENIED_ACE_TYPE,
      abi.CONTAINER_INHERIT_ACE,
      abi.FILE_DELETE_CHILD,
      worldSidPtr,
    );
    if (denyIndex >= 0) indices.push(denyIndex);

    const clearLabel =
      !hasForeignGrant(oldAcl, capSidPtr) &&
      labelAcl !== null &&
      hasExactLabel(labelAcl, lowLabelSidPtr);
    if (indices.length === 0 && !clearLabel) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor);
        if (!isNullPtr(freed)) throwLastError(api, "LocalFree", `revokeGrant(${path}) descriptor`);
      }
      return false;
    }

    for (const index of indices.sort((left, right) => right - left)) {
      if (api.deleteAce(oldAcl, index) === 0) {
        const win32Code = api.getLastError();
        if (descriptor !== null) api.localFree(descriptor);
        throwWin32(api, "DeleteAce", win32Code, path);
      }
    }

    const applyResult = api.setNamedSecurityInfoW(
      path,
      abi.SE_FILE_OBJECT,
      clearLabel
        ? abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION
        : abi.DACL_SECURITY_INFORMATION,
      null,
      null,
      oldAcl,
      null,
    );
    const freed = descriptor !== null ? api.localFree(descriptor) : null;
    if (applyResult !== abi.ERROR_SUCCESS) {
      throwWin32(api, "SetNamedSecurityInfoW", applyResult, `revokeGrant(${path})`);
    }
    if (freed !== null && !isNullPtr(freed)) {
      throwLastError(api, "LocalFree", `revokeGrant(${path}) descriptor`);
    }
    return indices.length > 0 || clearLabel;
  });
}
