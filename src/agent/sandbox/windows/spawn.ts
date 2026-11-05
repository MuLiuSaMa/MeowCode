/**
 * Ported from deepseek-harness packages/subprocess/win32-process/src/process.ts
 * (MIT License, Copyright (c) 2026 DeepSeek). MeowCode: restricted-token spawn
 * with the caller's stdio inherited, wrapped in a kill-on-close Job.
 */

import * as abi from "./abi.js";
import {
  allocProcessInfo,
  allocStartupInfo,
  decodeProcessInfo,
  encodeStartupInfo,
  freeNative,
  isNullPtr,
  throwLastError,
  throwWin32,
  type NativePtr,
  type Win32Bindings,
} from "./ffi.js";
import { createKillOnCloseJob } from "./job.js";
import { buildWindowsCommandLine } from "../runner-args.js";

export type SpawnedJobProcess = {
  pid: number;
  /** 调用方用 waitForProcessExit 关闭 */
  process: NativePtr;
  /** 调用方在子进程退出后关闭 */
  job: NativePtr;
};

export type SpawnInheritedOptions = {
  token: NativePtr;
  command: string;
  args: readonly string[];
  cwd: string;
};

function standardHandle(api: Win32Bindings, selector: number, label: string): NativePtr {
  const handle = api.getStdHandle(selector);
  if (isNullPtr(handle)) throwLastError(api, "GetStdHandle", `null ${label} handle`);
  return handle;
}

/**
 * 以受限令牌创建挂起进程，挂进 Job 后恢复运行。
 * stdio 直接继承 runner 的句柄（server 建的管道），字节不经过第二层缓冲。
 * Node 启动时会清掉 std 句柄的继承位，这里临时恢复、创建后还原。
 */
export function spawnInheritedJobProcess(
  api: Win32Bindings,
  options: SpawnInheritedOptions,
): SpawnedJobProcess {
  const job = createKillOnCloseJob(api);
  const enabled: NativePtr[] = [];
  let startupInfo: NativePtr | undefined;
  let processInfo: NativePtr | undefined;
  let created = 0;
  let createFailureCode = 0;

  try {
    const stdin = standardHandle(api, abi.STD_INPUT_HANDLE, "stdin");
    const stdout = standardHandle(api, abi.STD_OUTPUT_HANDLE, "stdout");
    const stderr = standardHandle(api, abi.STD_ERROR_HANDLE, "stderr");
    for (const [handle, label] of [
      [stdin, "stdin"],
      [stdout, "stdout"],
      [stderr, "stderr"],
    ] as const) {
      if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
        throwLastError(api, "SetHandleInformation", `${label} (enable inherit)`);
      }
      enabled.push(handle);
    }
    startupInfo = allocStartupInfo();
    encodeStartupInfo(startupInfo, {
      cb: abi.STARTUPINFOW_SIZE,
      // 不能加 CREATE_NO_WINDOW：受限令牌下会破坏 DLL 初始化。
      dwFlags: abi.STARTF_USESTDHANDLES | abi.STARTF_USESHOWWINDOW,
      wShowWindow: abi.SW_HIDE,
      hStdInput: stdin,
      hStdOutput: stdout,
      hStdError: stderr,
    });
    processInfo = allocProcessInfo();
    created = api.createProcessAsUserW(
      options.token,
      null,
      buildWindowsCommandLine(options.command, options.args),
      null,
      null,
      1,
      abi.CREATE_SUSPENDED,
      null,
      options.cwd,
      startupInfo,
      processInfo,
    );
    if (created === 0) createFailureCode = api.getLastError();
  } catch (error) {
    freeNative(processInfo);
    api.closeHandle(job);
    throw error;
  } finally {
    freeNative(startupInfo);
    for (const handle of enabled) {
      api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, 0);
    }
  }

  if (created === 0) {
    freeNative(processInfo);
    api.closeHandle(job);
    throwWin32(
      api,
      "CreateProcessAsUserW",
      createFailureCode,
      `command: ${options.command}, cwd: ${options.cwd}`,
    );
  }

  let info: ReturnType<typeof decodeProcessInfo>;
  try {
    info = decodeProcessInfo(processInfo);
  } finally {
    freeNative(processInfo);
  }
  if (info.hProcess === null || info.hThread === null) {
    if (info.hProcess !== null) api.terminateProcess(info.hProcess, 1);
    api.closeHandle(job);
    if (info.hThread !== null) api.closeHandle(info.hThread);
    if (info.hProcess !== null) api.closeHandle(info.hProcess);
    throw new Error(
      `CreateProcessAsUserW succeeded but returned null process/thread handles (pid ${info.dwProcessId})`,
    );
  }
  if (api.assignProcessToJobObject(job, info.hProcess) === 0) {
    const win32Code = api.getLastError();
    api.terminateProcess(info.hProcess, 1);
    api.closeHandle(info.hThread);
    api.closeHandle(info.hProcess);
    api.closeHandle(job);
    throwWin32(api, "AssignProcessToJobObject", win32Code, `pid ${info.dwProcessId}`);
  }
  if (api.resumeThread(info.hThread) === 0xffffffff) {
    const win32Code = api.getLastError();
    api.terminateProcess(info.hProcess, 1);
    api.closeHandle(info.hThread);
    api.closeHandle(info.hProcess);
    api.closeHandle(job);
    throwWin32(api, "ResumeThread", win32Code, `pid ${info.dwProcessId}`);
  }
  api.closeHandle(info.hThread);
  return { pid: info.dwProcessId, process: info.hProcess, job };
}
