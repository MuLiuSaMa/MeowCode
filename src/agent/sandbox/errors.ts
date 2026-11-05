/** 沙箱配置/运行失败的稳定错误码；server 路由与 UI 都按 code 分支，不靠文案匹配。 */

export type SandboxConfigErrorCode =
  | "not_win32"
  | "not_ntfs"
  | "network_path"
  | "no_write_owner"
  | "temp_inside_workspace"
  | "writable_root_missing"
  | "grant_timeout"
  | "koffi_missing"
  | "runner_missing"
  | "read_only_unsupported"
  | "probe_failed";

export class SandboxConfigError extends Error {
  readonly code: SandboxConfigErrorCode;
  readonly detail: string | undefined;

  constructor(code: SandboxConfigErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "SandboxConfigError";
    this.code = code;
    this.detail = detail;
  }
}

const MESSAGES: Record<SandboxConfigErrorCode, string> = {
  not_win32: "The command sandbox is only available on Windows.",
  not_ntfs: "The workspace must be on a local NTFS volume.",
  network_path: "Network (UNC) paths cannot be sandboxed.",
  no_write_owner: "The workspace directory must be owned by the current user and grant WRITE_OWNER.",
  temp_inside_workspace: "The sandbox temp root must be outside the workspace.",
  writable_root_missing: "An extra writable root does not exist or is not a directory.",
  grant_timeout: "Granting the workspace write ACL timed out.",
  koffi_missing: "koffi is not installed; the Windows sandbox runner cannot load.",
  runner_missing: "The sandbox runner entry point is missing.",
  read_only_unsupported: "read-only sandbox mode is not implemented yet.",
  probe_failed: "The sandbox capability probe failed.",
};

export function sandboxErrorMessage(code: SandboxConfigErrorCode): string {
  return MESSAGES[code];
}
