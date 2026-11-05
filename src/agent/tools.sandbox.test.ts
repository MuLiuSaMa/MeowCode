import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetSandboxSettingsForTests, setSandboxSettings } from "./sandbox/policy.js";
import { executeTool } from "./tools.js";

const isWindows = process.platform === "win32";
let dir = "";
let denyRunner = "";
let unknownRunner = "";
let okRunner = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "meow-sandbox-tools-"));
  denyRunner = join(dir, "deny-runner.mjs");
  writeFileSync(
    denyRunner,
    "process.stderr.write('Set-Content : Access is denied.\\n'); process.exit(1);\n",
  );
  unknownRunner = join(dir, "unknown-runner.mjs");
  writeFileSync(
    unknownRunner,
    "process.stderr.write('fatal: Permission denied (publickey).\\n'); process.exit(1);\n",
  );
  okRunner = join(dir, "ok-runner.mjs");
  writeFileSync(okRunner, "process.stdout.write('fake-ok\\n'); process.exit(0);\n");
  process.env.MEOWCODE_SANDBOX_NODE = process.execPath;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MEOWCODE_SANDBOX_RUNNER;
  delete process.env.MEOWCODE_SANDBOX_NODE;
});

afterEach(() => {
  resetSandboxSettingsForTests();
  delete process.env.MEOWCODE_SANDBOX_RUNNER;
});

function enableSandbox(): void {
  setSandboxSettings({
    enabled: true,
    mode: "workspace-write",
    writableRoots: [],
    allowTemp: false,
    grantTimeoutMs: 30_000,
    confirmDelete: false,
  });
}

describe.skipIf(!isWindows)("run_command sandbox wiring", () => {
  it("classifies an access-denied runner failure as a write denial", async () => {
    enableSandbox();
    process.env.MEOWCODE_SANDBOX_RUNNER = denyRunner;
    const result = await executeTool(
      "run_command",
      { command: "Set-Content out.txt hello" },
      dir,
    );
    expect(result.ok).toBe(false);
    expect(result.sandboxDenial?.kind).toBe("write_denied");
    expect(result.output).toContain("[sandbox] The command was blocked");
  });

  it("does not escalate a bare permission denied without write context", async () => {
    enableSandbox();
    process.env.MEOWCODE_SANDBOX_RUNNER = unknownRunner;
    const result = await executeTool("run_command", { command: "git push" }, dir);
    expect(result.sandboxDenial?.kind).toBe("unknown_denied");
  });

  it("returns the runner output when the sandboxed command succeeds", async () => {
    enableSandbox();
    process.env.MEOWCODE_SANDBOX_RUNNER = okRunner;
    const result = await executeTool("run_command", { command: "Write-Output plain" }, dir);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("fake-ok\n");
    expect(result.sandboxDenial).toBeUndefined();
  });

  it("fails closed without executing when the runner is missing", async () => {
    enableSandbox();
    process.env.MEOWCODE_SANDBOX_RUNNER = join(dir, "missing-runner.mjs");
    const sentinel = join(dir, "not-run.txt");
    const result = await executeTool(
      "run_command",
      { command: `Set-Content -Path '${sentinel}' -Value x` },
      dir,
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Command was not run");
    expect(result.sandboxDenial).toBeUndefined();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("bypasses the sandbox for one call when requested", async () => {
    enableSandbox();
    process.env.MEOWCODE_SANDBOX_RUNNER = denyRunner;
    const target = join(tmpdir(), `meow-sandbox-bypass-${Date.now()}.txt`);
    try {
      const result = await executeTool(
        "run_command",
        { command: `Set-Content -Path '${target}' -Value ok` },
        dir,
        { sandbox: "bypass" },
      );
      expect(result.ok).toBe(true);
      expect(result.sandboxDenial).toBeUndefined();
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(target, { force: true });
    }
  });
});
