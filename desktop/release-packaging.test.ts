import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const desktop = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(desktop);
const source = readFileSync(path.join(desktop, "brand-packaged.cjs"), "utf8");

function loadHooks() {
  const execFileSync = vi.fn();
  const rmSync = vi.fn();
  const exports: Record<string, (...args: unknown[]) => Promise<void>> = {};
  vm.runInNewContext(source, {
    exports,
    __dirname: desktop,
    process: { platform: "win32", execPath: "node.exe" },
    Buffer,
    require(id: string) {
      if (id === "node:path") return path;
      if (id === "node:child_process") return { execFileSync };
      if (id === "node:fs") return { rmSync, existsSync: () => true, readFileSync: () => Buffer.alloc(0), writeFileSync: vi.fn() };
      if (id === "resedit") return {
        NtExecutable: { from: () => ({ generate: () => new ArrayBuffer(0) }) },
        NtExecutableResource: { from: () => ({ entries: [], outputResource: vi.fn() }) },
        Resource: { VersionInfo: { fromEntries: () => [] } },
      };
      throw new Error(`Unexpected module ${id}`);
    },
  });
  return { ...exports, execFileSync, rmSync };
}

describe("release packaging", () => {
  it("deploys locked production dependencies instead of copying only compiled files", async () => {
    const hooks = loadHooks();
    await hooks.beforePack();
    expect(hooks.rmSync).toHaveBeenCalledWith(path.join(root, ".tmp", "agent-release"), { recursive: true, force: true });
    expect(hooks.execFileSync).toHaveBeenCalledWith("cmd.exe", [
      "/d", "/s", "/c",
      "pnpm --filter meowcode --fail-if-no-match deploy --prod --config.inject-workspace-packages=true --config.node-linker=hoisted .tmp/agent-release",
    ], { cwd: root, stdio: "inherit" });
  });

  it("fails packaging if deployment fails", async () => {
    const hooks = loadHooks();
    hooks.execFileSync.mockImplementation(() => { throw new Error("deploy failed"); });
    await expect(hooks.beforePack()).rejects.toThrow("deploy failed");
  });

  it("runs the isolated smoke check on the actual packaged directory", async () => {
    const hooks = loadHooks();
    const appOutDir = path.join(desktop, "release", "win-unpacked");
    await hooks.afterPack({ appOutDir, packager: { appInfo: { productName: "MeowCode", version: "1.0.0" } } });
    expect(hooks.execFileSync).toHaveBeenCalledWith("node.exe", [path.join(root, "scripts", "release-smoke.mjs"), appOutDir], { stdio: "inherit" });
  });

  it("aligns shipped runtime files and the main-process entrypoint", () => {
    const pkg = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
    const agent = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const main = readFileSync(path.join(desktop, "main.cjs"), "utf8");
    expect(agent.files).toEqual(["dist"]);
    expect(pkg.build.beforePack).toBe("./brand-packaged.cjs");
    expect(pkg.build.afterPack).toBe("./brand-packaged.cjs");
    expect(pkg.build.files).toContain("*.cjs");
    expect(pkg.build.extraResources).toContainEqual({ from: "../.tmp/agent-release", to: "agent-server" });
    expect(pkg.build.extraResources).toContainEqual({ from: "../.tmp/agent-release/node_modules", to: "agent-server/node_modules" });
    expect(main).toContain('path.join(process.resourcesPath, "agent-server", "dist", "server", "server.js")');
    expect(main).toContain("cwd: devRepoRoot() ?? process.resourcesPath");
    expect(main).not.toContain("cwd: devRepoRoot() ?? app.getAppPath()");
  });
});
