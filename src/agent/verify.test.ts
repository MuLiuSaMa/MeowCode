import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VERIFY_INCLUDE,
  MAX_FEEDBACK_ERRORS,
  detectTypecheckCommand,
  formatVerifyFeedback,
  loadVerifyConfig,
  parseTscErrors,
  runVerification,
  type VerifyStepResult,
} from "./verify";

const { executeToolMock } = vi.hoisted(() => ({ executeToolMock: vi.fn() }));
// runVerification 通过 executeTool 跑命令：单测里整体替换，不付真实 PowerShell 的成本
vi.mock("./tools.js", () => ({ executeTool: executeToolMock }));

const linkType = process.platform === "win32" ? "junction" : "dir";

async function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "meowcode-verify-"));
}

async function writeConfig(workspace: string, config: unknown): Promise<void> {
  await mkdir(path.join(workspace, ".meowcode"), { recursive: true });
  await writeFile(
    path.join(workspace, ".meowcode", "verify.json"),
    typeof config === "string" ? config : JSON.stringify(config),
    "utf8",
  );
}

afterEach(() => {
  executeToolMock.mockReset();
  vi.restoreAllMocks();
});

describe("loadVerifyConfig", () => {
  it("returns no commands for an empty workspace", async () => {
    const workspace = await makeWorkspace();
    try {
      const config = await loadVerifyConfig(workspace);
      expect(config.commands).toEqual([]);
      expect(config.include).toEqual(DEFAULT_VERIFY_INCLUDE);
      expect(config.maxFeedbackPerTurn).toBe(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reads explicit typecheck/lint/test commands", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeConfig(workspace, {
        typecheck: "pnpm -s tsc --noEmit",
        lint: { command: "eslint ." },
        test: "vitest run",
      });
      const config = await loadVerifyConfig(workspace);
      expect(config.commands).toEqual([
        { id: "typecheck", command: "pnpm -s tsc --noEmit" },
        { id: "lint", command: "eslint ." },
        { id: "test", command: "vitest run" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to heuristics on broken JSON without throwing", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "tsconfig.json"), "{}", "utf8");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await writeConfig(workspace, "{ not json");
      const config = await loadVerifyConfig(workspace);
      expect(config.commands).toEqual([{ id: "typecheck", command: "npx --no-install tsc --noEmit" }]);
      expect(warn).toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to heuristics when the config is not an object", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "tsconfig.json"), "{}", "utf8");
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await writeConfig(workspace, ["typecheck"]);
      const config = await loadVerifyConfig(workspace);
      expect(config.commands).toEqual([{ id: "typecheck", command: "npx --no-install tsc --noEmit" }]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to heuristics when verify.json escapes the workspace via a link", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "tsconfig.json"), "{}", "utf8");
      await writeFile(path.join(outside, "verify.json"), JSON.stringify({ typecheck: "evil" }), "utf8");
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      // .meowcode 整个目录是指向工作区外的链接（Windows 上 junction 不需要管理员权限）
      await symlink(outside, path.join(workspace, ".meowcode"), linkType);
      const config = await loadVerifyConfig(workspace);
      expect(config.commands).toEqual([{ id: "typecheck", command: "npx --no-install tsc --noEmit" }]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("treats typecheck:false as an explicit disable even with tsconfig present", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "tsconfig.json"), "{}", "utf8");
      await writeConfig(workspace, { typecheck: false });
      const config = await loadVerifyConfig(workspace);
      expect(config.commands).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to heuristics for invalid typecheck values", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "tsconfig.json"), "{}", "utf8");
      await writeConfig(workspace, { typecheck: 42 });
      const config = await loadVerifyConfig(workspace);
      expect(config.commands).toEqual([{ id: "typecheck", command: "npx --no-install tsc --noEmit" }]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("normalizes include entries and honors an explicit empty list", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeConfig(workspace, { typecheck: false, include: [".TS", " Tsx "] });
      expect((await loadVerifyConfig(workspace)).include).toEqual(["ts", "tsx"]);

      await writeConfig(workspace, { typecheck: false, include: [] });
      expect((await loadVerifyConfig(workspace)).include).toEqual([]);

      await writeConfig(workspace, { typecheck: false, include: "ts" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect((await loadVerifyConfig(workspace)).include).toEqual(DEFAULT_VERIFY_INCLUDE);
      expect(warn).toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("clamps maxFeedbackPerTurn to the valid range with a default of 2", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeConfig(workspace, { typecheck: false, maxFeedbackPerTurn: 0 });
      expect((await loadVerifyConfig(workspace)).maxFeedbackPerTurn).toBe(0);
      await writeConfig(workspace, { typecheck: false, maxFeedbackPerTurn: 5 });
      expect((await loadVerifyConfig(workspace)).maxFeedbackPerTurn).toBe(5);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      for (const invalid of [-1, 99, "2", 1.5]) {
        await writeConfig(workspace, { typecheck: false, maxFeedbackPerTurn: invalid });
        expect((await loadVerifyConfig(workspace)).maxFeedbackPerTurn).toBe(2);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("detects npm scripts for the workspace (pnpm projects included)", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({ scripts: { typecheck: "tsc -p ." } }),
        "utf8",
      );
      const config = await loadVerifyConfig(workspace);
      expect(config.commands).toEqual([{ id: "typecheck", command: "npm run typecheck --silent" }]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("detectTypecheckCommand", () => {
  it("prefers typecheck over type-check over tsc", () => {
    const scripts = { typecheck: "a", "type-check": "b", tsc: "c" };
    expect(detectTypecheckCommand(scripts, true)).toBe("npm run typecheck --silent");
    expect(detectTypecheckCommand({ "type-check": "b", tsc: "c" }, true)).toBe(
      "npm run type-check --silent",
    );
    expect(detectTypecheckCommand({ tsc: "c" }, true)).toBe("npm run tsc --silent");
  });

  it("ignores non-string script values and falls back to tsconfig", () => {
    expect(detectTypecheckCommand({ typecheck: 123 }, true)).toBe("npx --no-install tsc --noEmit");
    expect(detectTypecheckCommand(undefined, true)).toBe("npx --no-install tsc --noEmit");
    expect(detectTypecheckCommand({}, false)).toBeUndefined();
  });
});

describe("parseTscErrors", () => {
  it("parses standard and Windows-style diagnostic lines", () => {
    const output = [
      "src/a.ts(1,2): error TS2345: Argument of type 'string' is not assignable.",
      "src\\agent\\foo.ts(12,5): error TS2307: Cannot find module './missing'.",
    ].join("\n");
    const diagnostics = parseTscErrors(output);
    expect(diagnostics).toEqual([
      { file: "src/a.ts", line: 1, col: 2, code: "TS2345", msg: "Argument of type 'string' is not assignable." },
      { file: "src\\agent\\foo.ts", line: 12, col: 5, code: "TS2307", msg: "Cannot find module './missing'." },
    ]);
  });

  it("collects warnings but ignores prose and summary lines", () => {
    const output = [
      "Starting compilation in watch mode...",
      "",
      "src/a.ts(3,1): warning TS6133: 'x' is declared but never used.",
      "see notes(1,2) for details",
      "Found 2 errors. Watching for file changes.",
    ].join("\n");
    const diagnostics = parseTscErrors(output);
    expect(diagnostics).toEqual([
      { file: "src/a.ts", line: 3, col: 1, code: "TS6133", msg: "'x' is declared but never used." },
    ]);
  });

  it("deduplicates identical diagnostics", () => {
    const line = "src/a.ts(1,2): error TS2345: bad";
    expect(parseTscErrors([line, line, line].join("\n"))).toHaveLength(1);
  });
});

describe("formatVerifyFeedback", () => {
  function step(overrides: Partial<VerifyStepResult>): VerifyStepResult {
    return { id: "typecheck", command: "tsc --noEmit", passed: false, output: "", ...overrides };
  }

  it("renders tsc diagnostics with a header and an instruction line", () => {
    const feedback = formatVerifyFeedback([
      step({ output: "src/a.ts(1,2): error TS2345: bad" }),
    ]);
    expect(feedback).toContain("--- auto-verify: typecheck FAILED (tsc --noEmit) ---");
    expect(feedback).toContain("src/a.ts(1,2): TS2345: bad");
    expect(feedback).toContain("[Automatic verification feedback.");
  });

  it("caps errors globally and reports the omitted count", () => {
    // 25 条错误分布在 5 个文件（每文件 5 条 = 刚好不吃到每文件上限），全局 cap 20 生效
    const errors = Array.from({ length: MAX_FEEDBACK_ERRORS + 5 }, (_, index) => {
      const file = `src/file${Math.floor(index / 5)}.ts`;
      return `${file}(${index + 1},1): error TS1000: e${index}`;
    }).join("\n");
    const feedback = formatVerifyFeedback([step({ output: errors })]);
    expect(feedback).toContain("src/file3.ts(20,1): TS1000: e19");
    expect(feedback).not.toContain("e20");
    expect(feedback).toContain("... [5 more errors in 1 file omitted");
  });

  it("guides the model away from fixing source when the command did not run", () => {
    const feedback = formatVerifyFeedback([
      step({ output: "", commandError: "spawn pwsh.exe ENOENT" }),
    ]);
    expect(feedback).toContain("Verification command could not run:");
    expect(feedback).toContain("Do not attempt to fix source code for this.");
    expect(feedback).not.toContain("[Automatic verification feedback. Fix");
  });

  it("falls back to head/tail clipping for unstructured output", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    const feedback = formatVerifyFeedback([step({ output: lines })]);
    expect(feedback).toContain("line 0");
    expect(feedback).toContain("line 59");
    expect(feedback).toContain("lines omitted");
  });

  it("renders one section per failed step", () => {
    const feedback = formatVerifyFeedback([
      step({ id: "typecheck", output: "src/a.ts(1,2): error TS2345: bad" }),
      step({ id: "lint", command: "eslint .", output: "oops" }),
    ]);
    expect(feedback).toContain("--- auto-verify: typecheck FAILED");
    expect(feedback).toContain("--- auto-verify: lint FAILED (eslint .) ---");
  });
});

describe("runVerification", () => {
  const config = {
    commands: [
      { id: "typecheck", command: "tsc --noEmit" },
      { id: "lint", command: "eslint ." },
    ],
    maxFeedbackPerTurn: 2,
    include: DEFAULT_VERIFY_INCLUDE,
  };

  it("passes silently when every command exits zero", async () => {
    executeToolMock.mockResolvedValue({ ok: true, output: "" });
    const result = await runVerification(config, "ws");
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.feedback).toBeUndefined();
    expect(executeToolMock).toHaveBeenCalledTimes(2);
  });

  it("feeds structured feedback when a command reports tsc errors", async () => {
    executeToolMock
      .mockResolvedValueOnce({ ok: false, output: "src/a.ts(1,2): error TS2345: bad" })
      .mockResolvedValueOnce({ ok: true, output: "" });
    const result = await runVerification(config, "ws");
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("TS2345");
    expect(result.steps[0]!.passed).toBe(false);
    expect(result.steps[1]!.passed).toBe(true);
  });

  it("marks unrunnable commands as commandError instead of code errors", async () => {
    executeToolMock
      .mockResolvedValueOnce({ ok: false, output: "spawn pwsh.exe ENOENT" })
      .mockResolvedValueOnce({ ok: false, output: "12 problems (12 errors)" });
    const result = await runVerification(config, "ws");
    expect(result.steps[0]!.commandError).toContain("ENOENT");
    expect(result.steps[1]!.commandError).toBeUndefined();
    expect(result.feedback).toContain("Do not attempt to fix source code for this.");
  });

  it("treats a timeout as a command error", async () => {
    executeToolMock.mockResolvedValue({
      ok: false,
      output: "Command timed out after 120s and was terminated.",
    });
    const result = await runVerification(
      { ...config, commands: [config.commands[0]!] },
      "ws",
    );
    expect(result.steps[0]!.commandError).toContain("timed out");
  });

  it("skips entirely when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runVerification(config, "ws", controller.signal);
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe("aborted");
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("abandons the remaining steps when aborted mid-run", async () => {
    const controller = new AbortController();
    executeToolMock.mockImplementation(async () => {
      controller.abort();
      return { ok: false, output: "Command aborted by the user." };
    });
    const result = await runVerification(config, "ws", controller.signal);
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe("aborted");
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("reports no-commands without executing anything", async () => {
    const result = await runVerification(
      { ...config, commands: [] },
      "ws",
    );
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe("no-commands");
    expect(executeToolMock).not.toHaveBeenCalled();
  });
});
