import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * 更新包下载逻辑在主进程（desktop/update-download.cjs，CJS）。
 * 用 createRequire 直接加载 —— 不依赖 electron。
 */
const require = createRequire(import.meta.url);
const {
  pickInstallerAsset,
  normalizeAssetUrl,
  safeAssetFileName,
  normalizeAssets,
  downloadToFile,
} = require("../update-download.cjs") as {
  pickInstallerAsset: (
    assets: Array<{ name: string }> | null,
    platform?: string,
  ) => { name: string } | null;
  normalizeAssetUrl: (url: string) => string;
  safeAssetFileName: (name: string) => string;
  normalizeAssets: (assets: unknown) => Array<{ name: string; url: string; size: number }>;
  downloadToFile: (options: {
    url: string;
    target: string;
    onProgress?: (progress: { received: number; total: number; percent: number }) => void;
    fetchImpl?: typeof fetch;
  }) => Promise<{ path: string; received: number; total: number }>;
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("安装包挑选", () => {
  const assets = [
    { name: "MeowCode-1.0.0.dmg" },
    { name: "MeowCode-1.0.0.exe" },
    { name: "MeowCode-1.0.0.msi" },
    { name: "MeowCode-1.0.0.AppImage" },
  ];

  it("Windows 优先 exe，其次 msi", () => {
    expect(pickInstallerAsset(assets, "win32")?.name).toBe("MeowCode-1.0.0.exe");
    expect(pickInstallerAsset([{ name: "a.msi" }], "win32")?.name).toBe("a.msi");
  });

  it("macOS 优先 dmg，Linux 优先 AppImage", () => {
    expect(pickInstallerAsset(assets, "darwin")?.name).toBe("MeowCode-1.0.0.dmg");
    expect(pickInstallerAsset(assets, "linux")?.name).toBe("MeowCode-1.0.0.AppImage");
  });

  it("没有匹配就返回 null", () => {
    expect(pickInstallerAsset([{ name: "readme.txt" }], "win32")).toBeNull();
    expect(pickInstallerAsset(null, "win32")).toBeNull();
  });
});

describe("下载地址", () => {
  it("把不可达的 test.gitcode.net 换成主站", () => {
    expect(normalizeAssetUrl("https://test.gitcode.net/a/b.exe")).toBe("https://gitcode.com/a/b.exe");
    expect(normalizeAssetUrl("https://file-cdn.gitcode.com/x.exe")).toBe(
      "https://file-cdn.gitcode.com/x.exe",
    );
  });

  it("规整 release 资产列表", () => {
    expect(
      normalizeAssets([
        { name: "a.exe", browser_download_url: "https://test.gitcode.net/a.exe", size: 10 },
        { name: "b.txt" },
        null,
      ]),
    ).toEqual([
      { name: "a.exe", url: "https://gitcode.com/a.exe", size: 10 },
      { name: "b.txt", url: "", size: 0 },
    ]);
  });
});

describe("文件名清洗", () => {
  it("去掉路径与非法字符", () => {
    expect(safeAssetFileName("../../evil.exe")).toBe("evil.exe");
    expect(safeAssetFileName("a:b*c?.exe")).toBe("a_b_c_.exe");
    expect(safeAssetFileName("")).toBe("MeowCode-Setup.exe");
  });
});

describe("downloadToFile", () => {
  it("写盘并回报进度", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-dl-"));
    tempDirs.push(dir);
    const target = path.join(dir, "MeowCode-Setup.exe");
    const payload = new TextEncoder().encode("hello installer");

    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(payload.length) },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      }),
    })) as unknown as typeof fetch;

    const progress: number[] = [];
    const result = await downloadToFile({
      url: "https://test.gitcode.net/a/Setup.exe",
      target,
      onProgress: (event) => progress.push(event.percent),
      fetchImpl,
    });

    expect(result.received).toBe(payload.length);
    expect(result.total).toBe(payload.length);
    expect(await readFile(target, "utf8")).toBe("hello installer");
    expect(progress.at(-1)).toBe(100);
  });

  it("HTTP 失败时抛错", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-dl-"));
    tempDirs.push(dir);
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      headers: { get: () => "0" },
      body: null,
    })) as unknown as typeof fetch;

    await expect(
      downloadToFile({ url: "https://gitcode.com/a.exe", target: path.join(dir, "x.exe"), fetchImpl }),
    ).rejects.toThrow(/HTTP 404/);
  });
});
