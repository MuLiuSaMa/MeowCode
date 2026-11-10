import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { jobShellArgv, shellArgs, shellCandidates } = require("./terminals.cjs") as {
  jobShellArgv: (shell: string, command: string) => string[];
  shellArgs: (shell: string) => string[];
  shellCandidates: (env?: NodeJS.ProcessEnv) => string[];
};

describe("terminal shell selection", () => {
  it("prefers Program Files pwsh 7, then x86, then PATH entries", () => {
    const candidates = shellCandidates({
      ProgramFiles: "C:\\PF",
      "ProgramFiles(x86)": "C:\\PF86",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATH: 'C:\\scoop\\shims;"C:\\Program Files\\PowerShell\\7"',
    });

    expect(candidates.slice(0, 4)).toEqual([
      "C:\\PF\\PowerShell\\7\\pwsh.exe",
      "C:\\PF86\\PowerShell\\7\\pwsh.exe",
      "C:\\scoop\\shims\\pwsh.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ]);
    expect(candidates).toContain("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(candidates.at(-1)).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("dedupes candidates and skips empty PATH entries", () => {
    const candidates = shellCandidates({
      ProgramFiles: "C:\\PF",
      SystemRoot: "C:\\Windows",
      PATH: ";;C:\\PF\\PowerShell\\7",
    });

    expect(
      candidates.filter((candidate) => candidate === "C:\\PF\\PowerShell\\7\\pwsh.exe"),
    ).toHaveLength(1);
  });

  it("drops the banner for PowerShell shells only", () => {
    expect(shellArgs("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toEqual(["-NoLogo"]);
    expect(shellArgs("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toEqual([
      "-NoLogo",
    ]);
    expect(shellArgs("C:\\Windows\\System32\\cmd.exe")).toEqual([]);
    expect(shellArgs("/bin/bash")).toEqual([]);
  });
});

describe("job shell argv", () => {
  /** 任务终端：命令作为一次性脚本执行，跑完（含 Ctrl+C）进程就退出 */
  it("passes PowerShell commands as base64 UTF-16LE so quotes and newlines survive", () => {
    const command = 'while ($true) { Write-Host ("{0}" -f (Get-Date)) }\nWrite-Host "完成"';
    const argv = jobShellArgv("C:\\Program Files\\PowerShell\\7\\pwsh.exe", command);

    expect(argv.slice(0, 2)).toEqual(["-NoLogo", "-EncodedCommand"]);
    expect(Buffer.from(argv[2], "base64").toString("utf16le")).toBe(command);
    // 命令不再是命令行里的可见参数，不会被逐行输入到交互式 shell
    expect(argv.join(" ")).not.toContain("Write-Host");
  });

  it("keeps Windows PowerShell 5.1 on the same encoded path", () => {
    const argv = jobShellArgv("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "dir");
    expect(argv.slice(0, 2)).toEqual(["-NoLogo", "-EncodedCommand"]);
    expect(Buffer.from(argv[2], "base64").toString("utf16le")).toBe("dir");
  });

  it("runs cmd one-shot and POSIX shells as a login shell", () => {
    expect(jobShellArgv("C:\\Windows\\System32\\cmd.exe", "echo hi")).toEqual([
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
    expect(jobShellArgv("/bin/bash", "echo hi")).toEqual(["-lc", "echo hi"]);
  });
});
