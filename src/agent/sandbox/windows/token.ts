/**
 * Ported from deepseek-harness packages/sandbox/sandbox-windows-acl/src/token.ts
 * (MIT License, Copyright (c) 2026 DeepSeek). MeowCode: OS-level run_command isolation.
 */

import * as abi from "./abi.js";
import { buildExplicitAccess } from "./acl.js";
import {
  allocBytes,
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodePtrAt,
  decodeUint32,
  encodeUint32,
  isNullPtr,
  ptrAddress,
  throwLastError,
  throwWin32,
  type NativePtr,
  type Win32Bindings,
} from "./ffi.js";

/** 打开当前进程令牌（经 OpenProcess 句柄，koffi 无法直接寻址伪句柄）。 */
export function openCurrentProcessToken(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid);
  if (isNullPtr(processHandle)) throwLastError(api, "OpenProcess", `pid ${process.pid}`);

  const tokenSlot = allocPtrSlot();
  const opened = api.openProcessToken(
    processHandle,
    abi.TOKEN_QUERY | abi.TOKEN_DUPLICATE | abi.TOKEN_ADJUST_DEFAULT | abi.TOKEN_ASSIGN_PRIMARY,
    tokenSlot,
  );
  if (opened === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(processHandle);
    throwWin32(api, "OpenProcessToken", win32Code, `pid ${process.pid}`);
  }
  if (api.closeHandle(processHandle) === 0) {
    throwLastError(api, "CloseHandle", "OpenProcess process handle");
  }
  const token = decodePtr(tokenSlot);
  if (token === null) {
    throwWin32(api, "OpenProcessToken", api.getLastError(), "null token handle");
  }
  return token;
}

/** 找到并复制登录会话 SID；受限令牌没有它时 WinSta0/桌面对象初始化失败。 */
export function findLogonSid(api: Win32Bindings, token: NativePtr): NativePtr {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, abi.TokenGroups, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed === 0) throwLastError(api, "GetTokenInformation", "TokenGroups size query");
  if (needed < abi.TOKEN_GROUPS_OFFSET) {
    throwWin32(api, "GetTokenInformation", api.getLastError(), `implausible TokenGroups size ${needed}`);
  }

  const groups = Buffer.alloc(needed);
  if (api.getTokenInformation(token, abi.TokenGroups, groups, groups.length, neededSlot) === 0) {
    throwLastError(api, "GetTokenInformation", "TokenGroups");
  }
  const groupCount = groups.readUInt32LE(0);
  for (let index = 0; index < groupCount; index += 1) {
    const sidPtr = decodePtrAt(groups, abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE);
    const attributes = groups.readUInt32LE(
      abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE + 8,
    );
    const isLogonId =
      ((attributes & abi.SE_GROUP_LOGON_ID) >>> 0) === (abi.SE_GROUP_LOGON_ID >>> 0);
    if (sidPtr === null || !isLogonId) continue;
    const sidLength = api.getLengthSid(sidPtr);
    if (sidLength === 0) throwLastError(api, "GetLengthSid", `logon SID group ${index}`);
    const copy = allocBytes(sidLength);
    if (api.copySid(sidLength, copy, sidPtr) === 0) {
      throwLastError(api, "CopySid", `logon SID group ${index}`);
    }
    return copy;
  }
  throw new Error(
    `CreateRestrictedToken prerequisite failed: no logon SID found among ${groupCount} token groups`,
  );
}

/** 创建 one well-known SID（68 字节缓冲）并断言有效。 */
export function makeWellKnownSid(api: Win32Bindings, type: number): NativePtr {
  const sid = allocBytes(abi.SECURITY_MAX_SID_SIZE);
  const sizeSlot = allocUint32();
  encodeUint32(sizeSlot, abi.SECURITY_MAX_SID_SIZE);
  if (api.createWellKnownSid(type, null, sid, sizeSlot) === 0) {
    throwLastError(api, "CreateWellKnownSid", `type ${type}`);
  }
  if (api.isValidSid(sid) === 0) {
    throwLastError(api, "IsValidSid", `CreateWellKnownSid type ${type}`);
  }
  return sid;
}

/**
 * 把一条能力 SID 全权 ACE 并入令牌默认 DACL：
 * 受限进程新建匿名管道/同步对象时取默认 DACL，缺这条会 EPERM。
 */
export function setTokenDefaultDaclGrant(
  api: Win32Bindings,
  token: NativePtr,
  sidPtr: NativePtr,
): void {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, abi.TokenDefaultDacl, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed === 0) throwLastError(api, "GetTokenInformation", "TokenDefaultDacl size query");
  const buffer = Buffer.alloc(needed);
  if (api.getTokenInformation(token, abi.TokenDefaultDacl, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(api, "GetTokenInformation", "TokenDefaultDacl");
  }
  const currentDacl = decodePtrAt(buffer, 0);
  if (currentDacl === null) {
    throw new Error("setTokenDefaultDaclGrant: the token carries no default DACL to extend");
  }
  const newDaclSlot = allocPtrSlot();
  const result = api.setEntriesInAclW(
    1,
    buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.FILE_ALL_ACCESS),
    currentDacl,
    newDaclSlot,
  );
  if (result !== abi.ERROR_SUCCESS) {
    throwWin32(api, "SetEntriesInAclW", result, "default DACL merge");
  }
  const newDacl = decodePtr(newDaclSlot);
  if (newDacl === null) {
    throwWin32(api, "SetEntriesInAclW", result, "null merged default DACL");
  }
  const info = Buffer.alloc(8);
  info.writeBigUInt64LE(ptrAddress(newDacl), 0);
  if (api.setTokenInformation(token, abi.TokenDefaultDacl, info, info.length) === 0) {
    const win32Code = api.getLastError();
    api.localFree(newDacl);
    throwWin32(api, "SetTokenInformation", win32Code, "TokenDefaultDacl");
  }
  api.localFree(newDacl);
}

/** 把受限令牌降到 Low 完整性，才能与 grantWrite 写入的 Low 标签匹配。 */
export function restrictTokenIntegrity(
  api: Win32Bindings,
  token: NativePtr,
  lowLabelSidPtr: NativePtr,
): void {
  const sidLength = api.getLengthSid(lowLabelSidPtr);
  if (sidLength === 0) throwLastError(api, "GetLengthSid", "Low integrity label SID");
  const info = Buffer.alloc(abi.TOKEN_MANDATORY_LABEL_SIZE + sidLength);
  info.writeBigUInt64LE(ptrAddress(lowLabelSidPtr), 0);
  info.writeUInt32LE(abi.SE_GROUP_INTEGRITY, 8);
  if (api.setTokenInformation(token, abi.TokenIntegrityLevel, info, info.length) === 0) {
    throwLastError(api, "SetTokenInformation", "TokenIntegrityLevel (Low)");
  }
}

function buildRestrictingSids(sids: readonly NativePtr[]): Buffer {
  const buffer = Buffer.alloc(abi.SID_AND_ATTRIBUTES_SIZE * sids.length);
  sids.forEach((sid, index) => {
    buffer.writeBigUInt64LE(ptrAddress(sid), abi.SID_AND_ATTRIBUTES_SIZE * index);
  });
  return buffer;
}

export interface RestrictingSidSet {
  world: NativePtr;
}

/**
 * 创建 WRITE_RESTRICTED 令牌：
 * - read-only: [logon, Everyone]
 * - workspace-write: [logon, Everyone, workspaceSid, tempSid?]
 * Everyone/logon 是保活组，缺了 pwsh 会 0xC0000142；Authenticated Users /
 * INTERACTIVE / LOCAL 一律不放（WMI 与 Public 目录写逃逸）。
 */
export function createRestrictedToken(
  api: Win32Bindings,
  currentToken: NativePtr,
  logonSid: NativePtr,
  writeSids: readonly NativePtr[],
  known: RestrictingSidSet,
  mode: "read-only" | "workspace-write",
): NativePtr {
  let list: NativePtr[];
  if (mode === "read-only") {
    list = [logonSid, known.world];
  } else {
    if (writeSids.length === 0) {
      throw new Error(
        "createRestrictedToken: workspace-write restricting list requires at least one write SID",
      );
    }
    list = [logonSid, known.world, ...writeSids];
  }
  const restrictingSids = buildRestrictingSids(list);
  const tokenSlot = allocPtrSlot();
  const created = api.createRestrictedToken(
    currentToken,
    abi.DISABLE_MAX_PRIVILEGE | abi.WRITE_RESTRICTED,
    0,
    null,
    0,
    null,
    list.length,
    restrictingSids,
    tokenSlot,
  );
  if (created === 0) {
    throwLastError(api, "CreateRestrictedToken", `restricting SIDs: ${list.length}`);
  }
  const token = decodePtr(tokenSlot);
  if (token === null) {
    throwWin32(api, "CreateRestrictedToken", api.getLastError(), "null token handle");
  }
  return token;
}
