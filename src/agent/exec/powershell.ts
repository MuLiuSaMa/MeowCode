import { spawn } from "node:child_process";
import { commandEnv } from "./env.js";

/**
 * PowerShell 5.1 默认按系统 OEM 码页输出；显式切到 UTF-8 才能和上面的解码对上。
 * $OutputEncoding 管的是 PowerShell → 原生进程的管道编码（5.1 默认 us-ascii，中文会变 ?）。
 */
export const UTF8_OUTPUT_PREAMBLE =
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { };\n" +
  "try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { };\n";

export function powerShellArgv(command: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", UTF8_OUTPUT_PREAMBLE + command];
}

let powershellProbe: Promise<string> | undefined;

/** 探测结果在一次进程生命周期内不会变，避免每条命令都付一次 spawn（最坏 5 秒）。 */
export function resolvePowerShell(): Promise<string> {
  const override = process.env.MEOWCODE_POWERSHELL;
  if (override) return Promise.resolve(override);
  powershellProbe ??= findPowerShell();
  return powershellProbe;
}

function findPowerShell(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("pwsh.exe", ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      windowsHide: true,
      // 探测进程同样不能继承完整环境（里面可能有服务商密钥）
      env: commandEnv(),
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (name: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill();
      resolve(name);
    };
    child.on("error", () => finish("powershell.exe"));
    child.on("close", (code) => finish(code === 0 ? "pwsh.exe" : "powershell.exe"));
    // pwsh 探测本身也不能无限等
    timer = setTimeout(() => finish("powershell.exe"), 5_000);
  });
}
