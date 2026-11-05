import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { shellArgs, shellCandidates } = require("./terminals.cjs") as {
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
