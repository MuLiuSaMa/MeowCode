/**
 * Ported from deepseek-harness packages/sandbox/sandbox-windows-acl/src/index.ts
 * (MIT License, Copyright (c) 2026 DeepSeek). MeowCode: OS-level run_command isolation.
 *
 * 只被 runner 进程加载。工作区 ACE 是常驻缓存（dispose 不撤）；
 * 私有 temp ACE 每次执行后撤销；显式「撤销授权」走 revokeSandboxGrants。
 */

import { existsSync, statSync } from "node:fs";
import * as abi from "./abi.js";
import { grantWrite, revokeGrant, revokeWrite } from "./acl.js";
import {
  allocPtrSlot,
  decodePtr,
  freeNative,
  isNullPtr,
  throwLastError,
  win32,
  win32Sync,
  type NativePtr,
  type Win32Bindings,
} from "./ffi.js";
import { assertPrivateTempDisjoint } from "./path-boundary.js";
import { canonicalizeExistingPath, tempWriteSid, workspaceWriteSid } from "./sid.js";
import {
  createRestrictedToken,
  findLogonSid,
  makeWellKnownSid,
  openCurrentProcessToken,
  restrictTokenIntegrity,
  setTokenDefaultDaclGrant,
} from "./token.js";

export type SandboxSessionOptions = {
  workspace: string;
  /** 工作区之外的额外可写根 */
  writableRoots: readonly string[];
  /** null = 不授予私有 temp */
  tempDir: string | null;
  mode: "workspace-write";
};

function parseSid(api: Win32Bindings, sddl: string): NativePtr {
  const slot = allocPtrSlot();
  try {
    if (api.convertStringSidToSidW(sddl, slot) === 0) {
      throwLastError(api, "ConvertStringSidToSidW", sddl);
    }
    const sid = decodePtr(slot);
    if (sid === null) throw new Error(`ConvertStringSidToSidW returned null for ${sddl}`);
    return sid;
  } finally {
    freeNative(slot);
  }
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} is not an existing directory: ${path}`);
  }
}

export class SandboxSession {
  readonly workspace: string;
  readonly writableDirs: string[];
  readonly tempDir: string | null;
  readonly mode: "workspace-write";

  private api: Win32Bindings | undefined;
  private token: NativePtr | undefined;
  /** ConvertStringSidToSidW 分配的能力 SID → LocalFree */
  private localSids: NativePtr[] = [];
  /** CreateWellKnownSid / CopySid 分配 → koffi.free */
  private koffiSids: NativePtr[] = [];
  private tempGrant: { path: string; sidPtr: NativePtr } | undefined;

  constructor(options: SandboxSessionOptions) {
    this.mode = options.mode;
    this.workspace = canonicalizeExistingPath(options.workspace);
    const roots = [this.workspace, ...options.writableRoots.map((root) => canonicalizeExistingPath(root))];
    this.writableDirs = [...new Set(roots)];
    for (const dir of this.writableDirs) requireDirectory("writable root", dir);
    this.tempDir = options.tempDir === null ? null : canonicalizeExistingPath(options.tempDir);
    if (this.tempDir !== null) {
      requireDirectory("temp dir", this.tempDir);
      assertPrivateTempDisjoint(this.writableDirs, this.tempDir);
    }
  }

  get tokenHandle(): NativePtr {
    if (this.token === undefined) throw new Error("SandboxSession is not initialized");
    return this.token;
  }

  async init(): Promise<void> {
    if (this.api !== undefined) throw new Error("SandboxSession is already initialized");
    const api = await win32();
    this.api = api;
    const currentToken = openCurrentProcessToken(api);
    let currentTokenOpen = true;
    let restrictedToken: NativePtr | undefined;

    try {
      const lowLabelSid = makeWellKnownSid(api, abi.WinLowLabelSid);
      this.koffiSids.push(lowLabelSid);
      const worldSid = makeWellKnownSid(api, abi.WinWorldSid);
      this.koffiSids.push(worldSid);

      const writeSidPtr = parseSid(api, workspaceWriteSid(this.workspace));
      this.localSids.push(writeSidPtr);
      let tempSidPtr: NativePtr | undefined;
      if (this.tempDir !== null) {
        tempSidPtr = parseSid(api, tempWriteSid(this.tempDir));
        this.localSids.push(tempSidPtr);
      }

      for (const dir of this.writableDirs) {
        grantWrite(api, dir, writeSidPtr, lowLabelSid, worldSid);
      }
      if (this.tempDir !== null && tempSidPtr !== undefined) {
        // 先记账再授权：grantWrite 可能在 SetNamedSecurityInfoW 成功后抛 LocalFree 错误。
        this.tempGrant = { path: this.tempDir, sidPtr: tempSidPtr };
        grantWrite(api, this.tempDir, tempSidPtr, lowLabelSid, worldSid);
      }

      const logonSid = findLogonSid(api, currentToken);
      this.koffiSids.push(logonSid);
      restrictedToken = createRestrictedToken(
        api,
        currentToken,
        logonSid,
        tempSidPtr === undefined ? [writeSidPtr] : [writeSidPtr, tempSidPtr],
        { world: worldSid },
        this.mode,
      );
      this.token = restrictedToken;
      restrictTokenIntegrity(api, restrictedToken, lowLabelSid);
      setTokenDefaultDaclGrant(api, restrictedToken, tempSidPtr ?? writeSidPtr);

      if (api.closeHandle(currentToken) === 0) {
        throwLastError(api, "CloseHandle", "current process token");
      }
      currentTokenOpen = false;
    } catch (error) {
      const failures: unknown[] = [];
      if (this.tempGrant !== undefined) {
        try {
          revokeWrite(api, this.tempGrant.path, this.tempGrant.sidPtr);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (restrictedToken !== undefined) {
        try {
          if (api.closeHandle(restrictedToken) === 0) {
            throwLastError(api, "CloseHandle", "restricted token after init failure");
          }
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (currentTokenOpen) {
        try {
          if (api.closeHandle(currentToken) === 0) {
            throwLastError(api, "CloseHandle", "current process token after init failure");
          }
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      this.freeSids(api, failures);
      this.token = undefined;
      this.tempGrant = undefined;
      this.api = undefined;
      if (failures.length > 0) {
        throw new AggregateError(
          [error, ...failures],
          `SandboxSession init failed and ${failures.length} cleanup operation(s) also failed`,
        );
      }
      throw error;
    }
  }

  dispose(): void {
    const api = this.api;
    if (api === undefined) return;
    const failures: unknown[] = [];
    if (this.tempGrant !== undefined) {
      try {
        revokeWrite(api, this.tempGrant.path, this.tempGrant.sidPtr);
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.token !== undefined) {
      try {
        if (api.closeHandle(this.token) === 0) {
          throwLastError(api, "CloseHandle", "restricted token");
        }
      } catch (error) {
        failures.push(error);
      }
    }
    this.freeSids(api, failures);
    this.token = undefined;
    this.tempGrant = undefined;
    this.api = undefined;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `SandboxSession dispose completed with ${failures.length} cleanup failure(s)`,
      );
    }
  }

  private freeSids(api: Win32Bindings, failures: unknown[]): void {
    for (const sid of this.koffiSids.splice(0)) {
      try {
        freeNative(sid);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const sid of this.localSids.splice(0)) {
      try {
        const freed = api.localFree(sid);
        if (!isNullPtr(freed)) throwLastError(api, "LocalFree", "capability SID");
      } catch (error) {
        failures.push(error);
      }
    }
  }
}

/**
 * 完整撤销工作区 + 额外可写根的授权：删能力 ACE、Everyone deny、Low 标签。
 * 不存在的根跳过（目录被删后 ACE 随之消失）。
 */
export function revokeSandboxGrants(
  workspace: string,
  writableRoots: readonly string[],
): boolean {
  const api = win32Sync();
  const lowLabelSid = makeWellKnownSid(api, abi.WinLowLabelSid);
  const worldSid = makeWellKnownSid(api, abi.WinWorldSid);
  let writeSidPtr: NativePtr | undefined;
  try {
    writeSidPtr = parseSid(api, workspaceWriteSid(canonicalizeExistingPath(workspace)));
    let revoked = false;
    for (const dir of [workspace, ...writableRoots]) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      const canonical = canonicalizeExistingPath(dir);
      revoked = revokeGrant(api, canonical, writeSidPtr, worldSid, lowLabelSid) || revoked;
    }
    return revoked;
  } finally {
    freeNative(lowLabelSid);
    freeNative(worldSid);
    if (writeSidPtr !== undefined) api.localFree(writeSidPtr);
  }
}
