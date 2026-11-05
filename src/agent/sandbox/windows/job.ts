/**
 * Ported from deepseek-harness packages/subprocess/win32-process/src/process.ts
 * (MIT License, Copyright (c) 2026 DeepSeek). MeowCode: kill-on-close Job 包装。
 */

import * as abi from "./abi.js";
import {
  allocUint32,
  decodeUint32,
  freeNative,
  isNullPtr,
  throwLastError,
  throwWin32,
  type NativePtr,
  type Win32Bindings,
} from "./ffi.js";

/** 创建 KILL_ON_JOB_CLOSE 的匿名 Job：最后一个句柄关闭时整棵树被杀。 */
export function createKillOnCloseJob(api: Win32Bindings): NativePtr {
  const job = api.createJobObjectW(null, null);
  if (isNullPtr(job)) throwLastError(api, "CreateJobObjectW");
  const information = Buffer.alloc(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE);
  information.writeUInt32LE(
    abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET,
  );
  if (
    api.setInformationJobObject(
      job,
      abi.JobObjectExtendedLimitInformation,
      information,
      information.length,
    ) === 0
  ) {
    const win32Code = api.getLastError();
    api.closeHandle(job);
    throwWin32(api, "SetInformationJobObject", win32Code);
  }
  return job;
}

/** 等子进程退出并关闭进程句柄；返回完整 32 位退出码。 */
export function waitForProcessExit(api: Win32Bindings, processHandle: NativePtr): number {
  let exitCodeSlot: NativePtr | undefined;
  try {
    if (api.waitForSingleObject(processHandle, abi.INFINITE) === 0xffffffff) {
      throwLastError(api, "WaitForSingleObject");
    }
    exitCodeSlot = allocUint32();
    if (api.getExitCodeProcess(processHandle, exitCodeSlot) === 0) {
      throwLastError(api, "GetExitCodeProcess");
    }
    return decodeUint32(exitCodeSlot);
  } finally {
    freeNative(exitCodeSlot);
    api.closeHandle(processHandle);
  }
}
