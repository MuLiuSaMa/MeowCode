import { describe, expect, it } from "vitest";
import {
  buildRunnerArgv,
  buildWindowsCommandLine,
  parseRunnerArgv,
  resolveExecutableOnPath,
  SandboxRunnerArgumentError,
} from "./runner-args.js";

describe("runner argv round-trip", () => {
  it("round-trips workspace-write with temp, extra roots and an argv tail", () => {
    const invocation = {
      action: "run" as const,
      workspace: "C:\\work space\\项目",
      writableRoots: ["C:\\cache one", "D:\\其他"],
      tempRoot: "C:\\Users\\x\\AppData\\Local\\Temp",
      mode: "workspace-write" as const,
      executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      args: ["-NoLogo", "-Command", "Write-Output 'a b'; echo \"x\""],
    };
    expect(parseRunnerArgv(buildRunnerArgv(invocation))).toEqual(invocation);
  });

  it("round-trips --no-temp", () => {
    const invocation = {
      action: "run" as const,
      workspace: "C:\\work",
      writableRoots: [],
      tempRoot: null,
      mode: "workspace-write" as const,
      executable: "cmd.exe",
      args: ["/c", "exit 0"],
    };
    expect(parseRunnerArgv(buildRunnerArgv(invocation))).toEqual(invocation);
  });

  it("round-trips revoke", () => {
    const invocation = {
      action: "revoke" as const,
      workspace: "C:\\work",
      writableRoots: ["C:\\cache"],
    };
    expect(parseRunnerArgv(buildRunnerArgv(invocation))).toEqual(invocation);
  });

  it("rejects malformed argv", () => {
    expect(() => parseRunnerArgv([])).toThrow(SandboxRunnerArgumentError);
    expect(() => parseRunnerArgv(["--workspace", "C:\\w", "--mode", "workspace-write"])).toThrow(
      /missing --temp/,
    );
    expect(() =>
      parseRunnerArgv(["--workspace", "C:\\w", "--temp", "T", "--mode", "workspace-write", "--"]),
    ).toThrow(/missing command/);
    expect(() => parseRunnerArgv(["--workspace"])).toThrow(/missing value/);
    expect(() => parseRunnerArgv(["--nope", "x"])).toThrow(/unknown argument/);
    expect(() =>
      parseRunnerArgv(["--workspace", "C:\\w", "--temp", "T", "--mode", "bogus", "--", "x"]),
    ).toThrow(/unknown mode/);
  });
});

describe("buildWindowsCommandLine", () => {
  it("leaves simple arguments unquoted", () => {
    expect(buildWindowsCommandLine("pwsh.exe", ["-NoLogo", "-Command", "1+1"])).toBe(
      "pwsh.exe -NoLogo -Command 1+1",
    );
  });

  it("quotes spaces and Chinese text", () => {
    expect(buildWindowsCommandLine("pwsh.exe", ["-Command", "Write-Output '你好 世界'"])).toBe(
      'pwsh.exe -Command "Write-Output \'你好 世界\'"',
    );
  });

  it("escapes embedded quotes and trailing backslashes", () => {
    expect(buildWindowsCommandLine("a.exe", ['say "hi"'])).toBe('a.exe "say \\"hi\\""');
    expect(buildWindowsCommandLine("a.exe", ["C:\\my dir\\"])).toBe('a.exe "C:\\my dir\\\\"');
    // 无反斜杠/空格/引号的尾反斜杠不需要加引号，加了反而会改变参数
    expect(buildWindowsCommandLine("a.exe", ["C:\\dir\\"])).toBe("a.exe C:\\dir\\");
  });

  it("quotes empty arguments", () => {
    expect(buildWindowsCommandLine("a.exe", ["", "x"])).toBe('a.exe "" x');
  });
});

describe("resolveExecutableOnPath", () => {
  it("resolves an absolute existing file", () => {
    expect(resolveExecutableOnPath(process.execPath)).toBe(process.execPath);
  });

  it("returns undefined for a missing file", () => {
    expect(resolveExecutableOnPath("meowcode-definitely-missing-binary")).toBeUndefined();
  });
});
