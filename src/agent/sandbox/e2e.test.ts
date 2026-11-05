import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runShellCommand } from "../exec/shell.js";
import { resetSandboxSettingsForTests, setSandboxSettings } from "./policy.js";
import { probeSandbox, revokeSandboxGrantsRemote } from "./runner-client.js";
import type { SandboxSettings } from "./types.js";
import { executeTool } from "../tools.js";

const enabled = process.platform === "win32" && process.env.MEOWCODE_SANDBOX_E2E === "1";
const distRunner = fileURLToPath(
  new URL("../../../dist/agent/sandbox/windows/runner.js", import.meta.url),
);

let workspace = "";
let outsideDir = "";
let savedLocalAppData: string | undefined;

const settings: SandboxSettings = {
  enabled: true,
  mode: "workspace-write",
  writableRoots: [],
  allowTemp: true,
  grantTimeoutMs: 120_000,
  confirmDelete: false,
};

function listIcacls(target: string): string {
  return execFileSync("icacls", [target], { encoding: "utf8", windowsHide: true });
}

function countCapabilitySids(target: string): number {
  return listIcacls(target).split(/\r?\n/).filter((line) => line.includes("S-1-4-")).length;
}

function hasLowLabel(target: string): boolean {
  return /\(NW\)/i.test(listIcacls(target));
}

describe.skipIf(!enabled)("Windows command sandbox e2e", () => {
  beforeAll(() => {
    if (!existsSync(distRunner)) {
      throw new Error(`compiled sandbox runner missing: ${distRunner}; run pnpm build:agent first`);
    }
    savedLocalAppData = process.env.LOCALAPPDATA;
    process.env.MEOWCODE_SANDBOX_RUNNER = distRunner;
    process.env.MEOWCODE_SANDBOX_NODE = process.execPath;
    workspace = mkdtempSync(join(tmpdir(), "meow-sandbox-e2e-ws-"));
    outsideDir = mkdtempSync(join(tmpdir(), "meow-sandbox-e2e-out-"));
  });

  afterAll(async () => {
    resetSandboxSettingsForTests();
    await revokeSandboxGrantsRemote({ workspace, settings }).catch(() => undefined);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
    delete process.env.MEOWCODE_SANDBOX_RUNNER;
    delete process.env.MEOWCODE_SANDBOX_NODE;
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocalAppData;
  });

  beforeEach(() => {
    setSandboxSettings(settings);
  });

  afterEach(() => {
    resetSandboxSettingsForTests();
  });

  it("writes inside the workspace", async () => {
    const result = await executeTool(
      "run_command",
      { command: "Set-Content -Path 'inside.txt' -Value 'hello' -Encoding utf8" },
      workspace,
    );
    expect(result.ok).toBe(true);
    expect(existsSync(join(workspace, "inside.txt"))).toBe(true);
  });

  it("blocks writes outside the workspace and classifies the denial", async () => {
    const target = join(outsideDir, "escape.txt");
    const result = await executeTool(
      "run_command",
      { command: `Set-Content -Path '${target}' -Value x` },
      workspace,
    );
    expect(result.ok).toBe(false);
    expect(result.sandboxDenial?.kind).toBe("write_denied");
    expect(existsSync(target)).toBe(false);
  });

  it("blocks deletes outside the workspace", async () => {
    const target = join(outsideDir, "keep.txt");
    writeFileSync(target, "keep");
    const result = await executeTool(
      "run_command",
      { command: `Remove-Item -Path '${target}'` },
      workspace,
    );
    expect(result.ok).toBe(false);
    expect(result.sandboxDenial?.kind).toBe("delete_denied");
    expect(existsSync(target)).toBe(true);
  });

  it("gives the command a private temp directory and removes it afterwards", async () => {
    const localAppData = join(outsideDir, "localappdata");
    mkdirSync(localAppData, { recursive: true });
    process.env.LOCALAPPDATA = localAppData;
    const tempRoot = join(localAppData, "MeowCode", "sandbox-temp");

    const result = await executeTool(
      "run_command",
      {
        command:
          "Set-Content -Path 'temp-path.txt' -Value $env:TEMP -Encoding utf8; Get-Content -Path 'temp-path.txt' -Raw",
      },
      workspace,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("sandbox-temp");
    expect(result.output).toContain("mb-");
    const leftovers = existsSync(tempRoot)
      ? readdirSync(tempRoot).filter((name) => name.startsWith("mb-"))
      : [];
    expect(leftovers).toEqual([]);
  });

  it("still blocks a directory that grants Everyone Modify (Low label)", async () => {
    const shared = join(outsideDir, "everyone");
    mkdirSync(shared, { recursive: true });
    execFileSync("icacls", [shared, "/grant", "*S-1-1-0:(OI)(CI)M"], { windowsHide: true });
    try {
      const result = await executeTool(
        "run_command",
        { command: `Set-Content -Path '${join(shared, "escape.txt")}' -Value x` },
        workspace,
      );
      expect(result.ok).toBe(false);
      expect(result.sandboxDenial?.kind).toBe("write_denied");
      expect(existsSync(join(shared, "escape.txt"))).toBe(false);
    } finally {
      execFileSync("icacls", [shared, "/remove:g", "*S-1-1-0"], { windowsHide: true });
      rmSync(shared, { recursive: true, force: true });
    }
  });

  it("is idempotent across probes and revokes both ACEs and the Low label", async () => {
    const idempotentWs = mkdtempSync(join(tmpdir(), "meow-sandbox-e2e-idem-"));
    try {
      const first = await probeSandbox({ workspace: idempotentWs, settings });
      expect(first.ok).toBe(true);
      const second = await probeSandbox({ workspace: idempotentWs, settings });
      expect(second.ok).toBe(true);
      expect(countCapabilitySids(idempotentWs)).toBe(1);
      expect(hasLowLabel(idempotentWs)).toBe(true);

      const revoked = await revokeSandboxGrantsRemote({ workspace: idempotentWs, settings });
      expect(revoked.ok).toBe(true);
      expect(revoked.revoked).toBe(true);
      expect(countCapabilitySids(idempotentWs)).toBe(0);
      expect(hasLowLabel(idempotentWs)).toBe(false);
      // 第二次撤销是幂等的
      const again = await revokeSandboxGrantsRemote({ workspace: idempotentWs, settings });
      expect(again.ok).toBe(true);
      expect(again.revoked).toBe(false);
    } finally {
      rmSync(idempotentWs, { recursive: true, force: true });
    }
  });

  it("keeps stdout and stderr byte-identical to the unsandboxed run", async () => {
    const command = "1..300 | % { '行 ' + $_ }";
    const plain = await runShellCommand({ workspace, command, sandbox: "bypass" });
    const sandboxed = await runShellCommand({ workspace, command });
    expect(plain.aborted).toBe(false);
    expect(sandboxed.aborted).toBe(false);
    expect(sandboxed.stdout.equals(plain.stdout)).toBe(true);
    expect(sandboxed.stderr.equals(plain.stderr)).toBe(true);
  });
});
