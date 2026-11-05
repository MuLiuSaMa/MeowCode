/**
 * Ported from deepseek-harness packages/sandbox/sandbox-windows-acl/src/ffi.ts and
 * packages/subprocess/win32-process/src/{ffi,abi}.ts
 * (MIT License, Copyright (c) 2026 DeepSeek). MeowCode: OS-level run_command isolation.
 *
 * 只被 runner 进程加载：server 永不 import 本文件，因此生产进程不依赖 koffi。
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import type koffiType from "koffi";
import * as abi from "./abi.js";
import { Win32Error } from "./errors.js";

type Koffi = typeof koffiType;
type Ptr = ReturnType<Koffi["pointer"]>;
type StructType = ReturnType<Koffi["struct"]>;

declare const nativePtrBrand: unique symbol;
/** Koffi 原生指针；按 bigint 处理，只做相等/空判断，不做算术。 */
export type NativePtr = bigint & { readonly [nativePtrBrand]: true };

let cachedKoffi: Koffi | undefined;

/** 懒加载 koffi；打包后可用 MEOWCODE_SANDBOX_KOFFI 指向包目录。 */
function koffi(): Koffi {
  if (cachedKoffi !== undefined) return cachedKoffi;
  const override = process.env.MEOWCODE_SANDBOX_KOFFI;
  const base = override
    ? /\.(?:c|m)?js$/i.test(override)
      ? override
      : join(override, "noop.js")
    : import.meta.url;
  const require = createRequire(base);
  try {
    cachedKoffi = require("koffi") as Koffi;
  } catch (error) {
    throw new Error(
      `koffi is required for the Windows sandbox runner; set MEOWCODE_SANDBOX_KOFFI to the koffi package directory (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  return cachedKoffi;
}

export function requireKoffi(): Koffi {
  return koffi();
}

interface Types {
  PVOID: Ptr;
  PPVOID: Ptr;
  STARTUPINFOW: StructType;
  PROCESS_INFORMATION: StructType;
}

let cachedTypes: Types | undefined;

function types(): Types {
  if (cachedTypes !== undefined) return cachedTypes;
  const k = koffi();
  const PVOID = k.pointer("void");
  const PPVOID = k.pointer(PVOID);
  const STARTUPINFOW = k.struct("MEOW_STARTUPINFOW", {
    cb: "uint32",
    lpReserved: "str16",
    lpDesktop: "str16",
    lpTitle: "str16",
    dwX: "uint32",
    dwY: "uint32",
    dwXSize: "uint32",
    dwYSize: "uint32",
    dwXCountChars: "uint32",
    dwYCountChars: "uint32",
    dwFillAttribute: "uint32",
    dwFlags: "uint32",
    wShowWindow: "uint16",
    cbReserved2: "uint16",
    lpReserved2: k.pointer("uint8"),
    hStdInput: PVOID,
    hStdOutput: PVOID,
    hStdError: PVOID,
  });
  const PROCESS_INFORMATION = k.struct("MEOW_PROCESS_INFORMATION", {
    hProcess: PVOID,
    hThread: PVOID,
    dwProcessId: "uint32",
    dwThreadId: "uint32",
  });
  if (STARTUPINFOW.size !== abi.STARTUPINFOW_SIZE) {
    throw new Error(
      `STARTUPINFOW layout mismatch: koffi computed ${STARTUPINFOW.size}, expected ${abi.STARTUPINFOW_SIZE}`,
    );
  }
  if (PROCESS_INFORMATION.size !== abi.PROCESS_INFORMATION_SIZE) {
    throw new Error(
      `PROCESS_INFORMATION layout mismatch: koffi computed ${PROCESS_INFORMATION.size}, expected ${abi.PROCESS_INFORMATION_SIZE}`,
    );
  }
  cachedTypes = { PVOID, PPVOID, STARTUPINFOW, PROCESS_INFORMATION };
  return cachedTypes;
}

export interface StartupInfoInput {
  cb: number;
  dwFlags: number;
  wShowWindow: number;
  hStdInput: NativePtr;
  hStdOutput: NativePtr;
  hStdError: NativePtr;
}

export interface ProcessInfoOutput {
  hProcess: NativePtr | null;
  hThread: NativePtr | null;
  dwProcessId: number;
  dwThreadId: number;
}

/** runner 需要的全部 Win32 调用（通用进程 + 令牌/ACL）。 */
export interface Win32Bindings {
  closeHandle(handle: NativePtr): number;
  getLastError(): number;
  formatMessageW(
    flags: number,
    source: null,
    messageId: number,
    languageId: number,
    buffer: Buffer,
    size: number,
    args: null,
  ): number;
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number;
  getStdHandle(stdHandle: number): NativePtr;
  createProcessAsUserW(
    token: NativePtr,
    applicationName: string | null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number;
  waitForSingleObject(handle: NativePtr, milliseconds: number): number;
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number;
  createJobObjectW(attributes: null, name: null): NativePtr;
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number;
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number;
  resumeThread(thread: NativePtr): number;
  terminateProcess(process: NativePtr, exitCode: number): number;
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr;
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number;
  localAlloc(flags: number, bytes: number): NativePtr;
  localFree(memory: NativePtr): NativePtr;
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number;
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number;
  isValidSid(sid: NativePtr): number;
  getLengthSid(sid: NativePtr): number;
  copySid(length: number, destination: NativePtr, source: NativePtr): number;
  getTokenInformation(
    token: NativePtr,
    cls: number,
    info: Buffer | null,
    length: number,
    needed: NativePtr,
  ): number;
  setTokenInformation(token: NativePtr, cls: number, info: Buffer, length: number): number;
  createRestrictedToken(
    existing: NativePtr,
    flags: number,
    disableCount: number,
    disableSids: null,
    deletePrivilegeCount: number,
    privilegesToDelete: null,
    restrictCount: number,
    restrictingSids: Buffer,
    newToken: NativePtr,
  ): number;
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number;
  initializeAcl(acl: NativePtr, length: number, revision: number): number;
  addMandatoryAce(
    acl: NativePtr,
    revision: number,
    aceFlags: number,
    policy: number,
    sid: NativePtr,
  ): number;
  deleteAce(acl: NativePtr, index: number): number;
  setNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: null,
    group: null,
    dacl: NativePtr | null,
    sacl: NativePtr | null,
  ): number;
  getNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: NativePtr,
    group: NativePtr,
    dacl: NativePtr,
    sacl: NativePtr,
    descriptor: NativePtr,
  ): number;
  getTempPathW(length: number, buffer: Buffer): number;
  getVolumeInformationW(
    rootPathName: string,
    volumeNameBuffer: null,
    volumeNameSize: number,
    volumeSerialNumber: null,
    maximumComponentLength: null,
    fileSystemFlags: null,
    fileSystemNameBuffer: Buffer,
    fileSystemNameSize: number,
  ): number;
  setEnvironmentVariableW(name: string, value: string): number;
  setConsoleCtrlHandler(handler: null, add: number): number;
  createFileW(
    fileName: string,
    desiredAccess: number,
    shareMode: number,
    attributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ): NativePtr;
  lockFileEx(
    file: NativePtr,
    flags: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number;
  unlockFileEx(
    file: NativePtr,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number;
}

let cached: Win32Bindings | undefined;

function bindings(): Win32Bindings {
  if (cached !== undefined) return cached;
  const k = koffi();
  const { PVOID, PPVOID, STARTUPINFOW, PROCESS_INFORMATION } = types();
  const kernel32 = k.load("kernel32.dll");
  const advapi32 = k.load("advapi32.dll");
  const bind = (
    lib: ReturnType<Koffi["load"]>,
    name: string,
    result: Ptr | string,
    args: Array<Ptr | string>,
  ): unknown => lib.func("__stdcall", name, result, args);

  cached = {
    closeHandle: bind(kernel32, "CloseHandle", "int", [PVOID]),
    getLastError: bind(kernel32, "GetLastError", "uint32", []),
    formatMessageW: bind(kernel32, "FormatMessageW", "uint32", [
      "uint32",
      PVOID,
      "uint32",
      "uint32",
      PVOID,
      "uint32",
      PVOID,
    ]),
    setHandleInformation: bind(kernel32, "SetHandleInformation", "int", [PVOID, "uint32", "uint32"]),
    getStdHandle: bind(kernel32, "GetStdHandle", PVOID, ["int"]),
    createProcessAsUserW: bind(advapi32, "CreateProcessAsUserW", "int", [
      PVOID,
      "str16",
      "str16",
      PVOID,
      PVOID,
      "int",
      "uint32",
      PVOID,
      "str16",
      k.pointer(STARTUPINFOW),
      k.pointer(PROCESS_INFORMATION),
    ]),
    waitForSingleObject: bind(kernel32, "WaitForSingleObject", "uint32", [PVOID, "uint32"]),
    getExitCodeProcess: bind(kernel32, "GetExitCodeProcess", "int", [
      PVOID,
      k.pointer("uint32"),
    ]),
    createJobObjectW: bind(kernel32, "CreateJobObjectW", PVOID, [PVOID, "str16"]),
    setInformationJobObject: bind(kernel32, "SetInformationJobObject", "int", [
      PVOID,
      "int",
      PVOID,
      "uint32",
    ]),
    assignProcessToJobObject: bind(kernel32, "AssignProcessToJobObject", "int", [PVOID, PVOID]),
    resumeThread: bind(kernel32, "ResumeThread", "uint32", [PVOID]),
    terminateProcess: bind(kernel32, "TerminateProcess", "int", [PVOID, "uint32"]),
    openProcess: bind(kernel32, "OpenProcess", PVOID, ["uint32", "int", "uint32"]),
    openProcessToken: bind(advapi32, "OpenProcessToken", "int", [PVOID, "uint32", PPVOID]),
    localAlloc: bind(kernel32, "LocalAlloc", PVOID, ["uint32", "size_t"]),
    localFree: bind(kernel32, "LocalFree", PVOID, [PVOID]),
    convertStringSidToSidW: bind(advapi32, "ConvertStringSidToSidW", "int", ["str16", PPVOID]),
    createWellKnownSid: bind(advapi32, "CreateWellKnownSid", "int", [
      "int",
      PVOID,
      PVOID,
      k.pointer("uint32"),
    ]),
    isValidSid: bind(advapi32, "IsValidSid", "int", [PVOID]),
    getLengthSid: bind(advapi32, "GetLengthSid", "uint32", [PVOID]),
    copySid: bind(advapi32, "CopySid", "int", ["uint32", PVOID, PVOID]),
    getTokenInformation: bind(advapi32, "GetTokenInformation", "int", [
      PVOID,
      "int",
      PVOID,
      "uint32",
      k.pointer("uint32"),
    ]),
    setTokenInformation: bind(advapi32, "SetTokenInformation", "int", [
      PVOID,
      "int",
      PVOID,
      "uint32",
    ]),
    createRestrictedToken: bind(advapi32, "CreateRestrictedToken", "int", [
      PVOID,
      "uint32",
      "uint32",
      PVOID,
      "uint32",
      PVOID,
      "uint32",
      PVOID,
      PPVOID,
    ]),
    setEntriesInAclW: bind(advapi32, "SetEntriesInAclW", "uint32", [
      "uint32",
      PVOID,
      PVOID,
      PPVOID,
    ]),
    initializeAcl: bind(advapi32, "InitializeAcl", "int", [PVOID, "uint32", "uint32"]),
    addMandatoryAce: bind(advapi32, "AddMandatoryAce", "int", [
      PVOID,
      "uint32",
      "uint32",
      "uint32",
      PVOID,
    ]),
    deleteAce: bind(advapi32, "DeleteAce", "int", [PVOID, "uint32"]),
    setNamedSecurityInfoW: bind(advapi32, "SetNamedSecurityInfoW", "uint32", [
      "str16",
      "int",
      "uint32",
      PVOID,
      PVOID,
      PVOID,
      PVOID,
    ]),
    getNamedSecurityInfoW: bind(advapi32, "GetNamedSecurityInfoW", "uint32", [
      "str16",
      "int",
      "uint32",
      PPVOID,
      PPVOID,
      PPVOID,
      PPVOID,
      PPVOID,
    ]),
    getTempPathW: bind(kernel32, "GetTempPathW", "uint32", ["uint32", PVOID]),
    getVolumeInformationW: bind(kernel32, "GetVolumeInformationW", "int", [
      "str16",
      PVOID,
      "uint32",
      PVOID,
      PVOID,
      PVOID,
      PVOID,
      "uint32",
    ]),
    setEnvironmentVariableW: bind(kernel32, "SetEnvironmentVariableW", "int", ["str16", "str16"]),
    setConsoleCtrlHandler: bind(kernel32, "SetConsoleCtrlHandler", "int", [PVOID, "int"]),
    createFileW: bind(kernel32, "CreateFileW", PVOID, [
      "str16",
      "uint32",
      "uint32",
      PVOID,
      "uint32",
      "uint32",
      PVOID,
    ]),
    lockFileEx: bind(kernel32, "LockFileEx", "int", [
      PVOID,
      "uint32",
      "uint32",
      "uint32",
      "uint32",
      PVOID,
    ]),
    unlockFileEx: bind(kernel32, "UnlockFileEx", "int", [
      PVOID,
      "uint32",
      "uint32",
      "uint32",
      PVOID,
    ]),
  } as unknown as Win32Bindings;
  return cached;
}

export function win32(): Promise<Win32Bindings> {
  return Promise.resolve(bindings());
}

export function win32Sync(): Win32Bindings {
  return bindings();
}

export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as unknown as bigint) === 0n;
}

export function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true;
  const value = handle as unknown as bigint;
  return value === 0xffffffffffffffffn || value === -1n;
}

export function allocPtrSlot(): NativePtr {
  return koffi().alloc(types().PVOID, 1) as unknown as NativePtr;
}

export function allocUint32(): NativePtr {
  return koffi().alloc("uint32", 1) as unknown as NativePtr;
}

export function decodePtr(slot: NativePtr): NativePtr | null {
  const value = koffi().decode(slot, types().PVOID) as NativePtr | null;
  return isNullPtr(value) ? null : value;
}

export function decodeUint32(slot: NativePtr): number {
  return koffi().decode(slot, "uint32") as number;
}

export function encodeUint32(slot: NativePtr, value: number): void {
  koffi().encode(slot, "uint32", value);
}

export function freeNative(pointer: NativePtr | undefined): void {
  if (pointer !== undefined) koffi().free(pointer);
}

export function ptrAddress(pointer: NativePtr): bigint {
  return koffi().address(pointer);
}

export function allocBytes(length: number): NativePtr {
  return koffi().alloc("uint8", length) as unknown as NativePtr;
}

/** Koffi 3.1.1 对 LockFileEx/UnlockFileEx 传 NULL 会崩；零值 OVERLAPPED 等价。 */
export function allocOverlapped(): NativePtr {
  return allocBytes(32);
}

export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value = koffi().decode(buffer, offset, types().PVOID) as NativePtr | null;
  return isNullPtr(value) ? null : value;
}

export function decodeUint8At(pointer: NativePtr, offset: number): number {
  return koffi().decode(pointer, offset, "uint8") as number;
}

export function decodeUint16At(pointer: NativePtr, offset: number): number {
  return koffi().decode(pointer, offset, "uint16") as number;
}

export function decodeUint32At(pointer: NativePtr, offset: number): number {
  return koffi().decode(pointer, offset, "uint32") as number;
}

/** 逐字段比较内存里的两个 SID，避免转字符串/EqualSid 导致的指针偏移崩溃。 */
export function sameSidAt(
  left: NativePtr,
  leftOffset: number,
  right: NativePtr,
  rightOffset: number,
): boolean {
  if (decodeUint8At(left, leftOffset) !== decodeUint8At(right, rightOffset)) return false;
  const leftCount = decodeUint8At(left, leftOffset + 1);
  const rightCount = decodeUint8At(right, rightOffset + 1);
  if (leftCount !== rightCount || leftCount > abi.SID_MAX_SUB_AUTHORITIES) return false;
  for (let index = 0; index < 6; index += 1) {
    if (
      decodeUint8At(left, leftOffset + 2 + index) !==
      decodeUint8At(right, rightOffset + 2 + index)
    ) {
      return false;
    }
  }
  for (let index = 0; index < leftCount; index += 1) {
    if (
      decodeUint32At(left, leftOffset + 8 + index * 4) !==
      decodeUint32At(right, rightOffset + 8 + index * 4)
    ) {
      return false;
    }
  }
  return true;
}

export function errorText(api: Win32Bindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024);
  const length = api.formatMessageW(
    abi.FORMAT_MESSAGE_FROM_SYSTEM | abi.FORMAT_MESSAGE_IGNORE_INSERTS,
    null,
    win32Code,
    0,
    buffer,
    buffer.length / 2,
    null,
  );
  return length === 0 ? "" : buffer.subarray(0, length * 2).toString("utf16le").trim();
}

export function throwLastError(api: Win32Bindings, name: string, detail?: string): never {
  const win32Code = api.getLastError();
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code));
}

export function throwWin32(
  api: Win32Bindings,
  name: string,
  win32Code: number,
  detail?: string,
): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code));
}

export function allocStartupInfo(): NativePtr {
  return koffi().alloc(types().STARTUPINFOW, 1) as unknown as NativePtr;
}

export function encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoInput): void {
  koffi().encode(startupInfo, types().STARTUPINFOW, fields);
}

export function allocProcessInfo(): NativePtr {
  return koffi().alloc(types().PROCESS_INFORMATION, 1) as unknown as NativePtr;
}

export function decodeProcessInfo(processInfo: NativePtr): ProcessInfoOutput {
  return koffi().decode(processInfo, types().PROCESS_INFORMATION) as ProcessInfoOutput;
}

/** GetTempPathW：ACL 锁文件路径的稳定根，绝不能用 runner 私有 temp。 */
export function getTempPath(api: Win32Bindings): string {
  const buffer = Buffer.alloc((abi.MAX_PATH + 1) * 2);
  const length = api.getTempPathW(buffer.length / 2, buffer);
  if (length === 0) throwLastError(api, "GetTempPathW");
  if (length > buffer.length / 2) {
    throw new Win32Error(
      "GetTempPathW",
      122,
      `required ${length} chars exceed the ${buffer.length / 2}-char buffer`,
    );
  }
  return buffer.subarray(0, length * 2).toString("utf16le");
}
