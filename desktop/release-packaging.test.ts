import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const desktop = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(desktop);
const source = readFileSync(path.join(desktop, "brand-packaged.cjs"), "utf8");
const requireFromTest = createRequire(import.meta.url);

/** 直接读 PNG 的 IHDR（16..23 字节）：够验证商店资源图的尺寸契约。 */
function pngSize(file: string): { width: number; height: number } {
  const buffer = readFileSync(file);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

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
    const agentResource = pkg.build.extraResources.find(
      (entry: { to?: string }) => entry.to === "agent-server",
    );
    expect(agentResource?.from).toBe("../.tmp/agent-release");
    // 部署的 node_modules 只带运行时文件：类型声明/源码映射/测试夹具不进安装包，
    // 否则 5 千多个碎文件会让 Inno 的「提取文件」一步拖很久
    expect(agentResource?.filter).toContain("!**/*.d.ts");
    expect(agentResource?.filter).toContain("!**/@mixmark-io/domino/test/**");
    const modulesResource = pkg.build.extraResources.find(
      (entry: { to?: string }) => entry.to === "agent-server/node_modules",
    );
    expect(modulesResource?.from).toBe("../.tmp/agent-release/node_modules");
    expect(modulesResource?.filter).toContain("!**/pdfjs-dist/build/**");
    expect(main).toContain('path.join(process.resourcesPath, "agent-server", "dist", "server", "server.js")');
    expect(main).toContain("cwd: devRepoRoot() ?? process.resourcesPath");
    expect(main).not.toContain("cwd: devRepoRoot() ?? app.getAppPath()");
  });

  it("ships a Microsoft Store MSIX target without touching the NSIS release", () => {
    const pkg = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
    expect(pkg.scripts["package:msix"]).toBe(
      "pnpm build && electron-builder --win --x64 --config electron-builder.msix.config.cjs",
    );
    // 常规发版仍是 NSIS，互不影响
    expect(pkg.build.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);

    const msix = requireFromTest(path.join(desktop, "electron-builder.msix.config.cjs"));
    expect(msix.win.target).toEqual([{ target: "appx", arch: ["x64"] }]);
    expect(msix.directories.buildResources).toBe("../resources");
    expect(msix.appx.artifactName).toBe("${productName}-${version}-${arch}.msix");
    // 商店身份：缺省值与 Partner Center 产品标识一致，仍可被环境变量覆盖
    expect(msix.appx.identityName).toBe(
      process.env.MEOWCODE_MSIX_IDENTITY_NAME || "MuLiuSaMa.MeowCode",
    );
    expect(msix.appx.publisher).toBe(
      process.env.MEOWCODE_MSIX_PUBLISHER || "CN=30F199CB-855A-42F4-96A9-F43088B508BF",
    );
    expect(msix.appx.publisherDisplayName).toBe(
      process.env.MEOWCODE_MSIX_PUBLISHER_DISPLAY_NAME || "MuLiu_SaMa",
    );

    // 资源图尺寸必须与 AppxManifest 的引用匹配（electron-builder 只按文件名映射）
    const assets: Record<string, [number, number]> = {
      "Square44x44Logo.png": [44, 44],
      "Square150x150Logo.png": [150, 150],
      "StoreLogo.png": [50, 50],
      "Wide310x150Logo.png": [310, 150],
    };
    for (const [name, [width, height]] of Object.entries(assets)) {
      expect(pngSize(path.join(root, "resources", "appx", name))).toEqual({ width, height });
    }

    // 本地侧载：测试签名脚本由根 package.json 暴露，只清自己创建的证书
    const agentPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(agentPkg.scripts["test:msix"]).toContain("scripts/msix-test-sign.ps1");
    const signScript = readFileSync(path.join(root, "scripts", "msix-test-sign.ps1"), "utf8");
    expect(signScript).toContain("-NoInstall");
    expect(signScript).toContain("signtool");
    expect(signScript).toContain("created-cert.txt");
  });
});
