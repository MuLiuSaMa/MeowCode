import { spawn } from "node:child_process";
import { commandEnv } from "./env.js";

/**
 * PowerShell 5.1 默认按系统 OEM 码页输出；显式切到 UTF-8 才能和上面的解码对上。
 * $OutputEncoding 管的是 PowerShell → 原生进程的管道编码（5.1 默认 us-ascii，中文会变 ?）。
 *
 * 后面几条都是「同一份代码要在 5.1 和 7 上跑出同样行为」的补丁，全部用 try/catch 包住：
 * 5.1 上没有 $PSStyle / $PSNativeCommandArgumentPassing，赋值会报错，但绝不能连累命令本身。
 */
export const UTF8_OUTPUT_PREAMBLE =
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { };\n" +
  "try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { };\n" +
  // 进度记录在重定向输出里是纯噪音（Invoke-WebRequest / npm / git clone 都爱刷）
  "try { $ProgressPreference = 'SilentlyContinue' } catch { };\n" +
  // PS7.2+：别让 PowerShell 自己往管道里写 ANSI（原生工具的彩色由采集层清理）
  "try { $PSStyle.OutputRendering = 'PlainText' } catch { };\n" +
  // PS7.3+：原生命令参数按 Win32 规则传，与 5.1 对齐；不 pin 的话同一命令两边行为不同
  "try { $PSNativeCommandArgumentPassing = 'Standard' } catch { };\n" +
  // 退出码会跨命令残留：不清掉会把上一段的失败记到这一次头上
  "try { Remove-Variable LASTEXITCODE -ErrorAction SilentlyContinue } catch { };\n";

/**
 * 退出码后缀：把原生命令的真实退出码变成 PowerShell 进程的退出码。
 *
 * 不这么做的话 `git status` / `npm test` 失败时进程码仍是 0，工具层会把失败当成功。
 * 必须**新起一行**：命令最后一行常是注释或 here-string 结束符 `'@`，
 * 接在同一行会被注释吞掉，或破坏 here-string 的边界。
 * 纯 cmdlet 脚本没有原生命令时 $LASTEXITCODE 为 $null，保持 PowerShell 自己的退出码。
 */
export const EXIT_CODE_SUFFIX = "\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n";

export function powerShellArgv(command: string): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    // 只影响本进程执行 .ps1 文件：默认 Restricted 的机器上模型跑脚本会被拦，
    // 而 -Command 的内联代码本来就不受执行策略约束（这里是补上脚本那条路）
    ...(process.platform === "win32" ? ["-ExecutionPolicy", "Bypass"] : []),
    "-Command",
    UTF8_OUTPUT_PREAMBLE + command + EXIT_CODE_SUFFIX,
  ];
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
