import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * 更新检查的逻辑在主进程（desktop/update-check.cjs，CJS）。
 * 这里用 createRequire 直接加载 —— 不依赖 electron，也不用把 main.cjs 拖进来。
 */
const require = createRequire(import.meta.url);
const {
  isNewerVersion,
  describeUpdateError,
  parseVersionParts,
  checkForUpdate,
} = require("../update-check.cjs") as {
  isNewerVersion: (current: string, latest: string) => boolean;
  describeUpdateError: (error: unknown, status?: number) => string;
  parseVersionParts: (value: string) => number[];
  checkForUpdate: (current: string) => Promise<unknown>;
};

describe("版本比较", () => {
  it("按数字段比较，缺位补 0", () => {
    expect(isNewerVersion("0.1.0", "v0.2.0")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.2.0", "v0.1.9")).toBe(false);
    expect(isNewerVersion("1.0", "1.0.1")).toBe(true);
    expect(isNewerVersion("1.0.1", "1.0")).toBe(false);
  });

  it("解析版本号", () => {
    expect(parseVersionParts("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersionParts("1.2.3-beta.1")).toEqual([1, 2, 3, 0, 1]);
    expect(parseVersionParts("")).toEqual([0]);
  });
});

describe("错误文案", () => {
  it("GitCode 没发过 Release 时是 400 + 未找到 release", () => {
    const message = describeUpdateError(
      { body: '{"error_message":"未找到 release"}', status: 400 },
      400,
    );
    expect(message).toContain("还没有发布版本");
  });

  it("404 / 鉴权 / 网络分别给不同的提示", () => {
    expect(describeUpdateError({ status: 404 }, 404)).toContain("还没有发布版本");
    expect(describeUpdateError({ status: 403 }, 403)).toContain("拒绝");
    expect(describeUpdateError(new Error("request timeout"), undefined)).toContain("超时");
    expect(describeUpdateError(new Error("getaddrinfo ENOTFOUND api.gitcode.com"))).toContain(
      "网络不可用",
    );
  });
});

describe("checkForUpdate", () => {
  it("拉不到 release 时返回错误而不是抛异常", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error_message":"未找到 release"}',
    })) as unknown as typeof fetch;
    try {
      const result = (await checkForUpdate("0.1.0")) as {
        ok: boolean;
        error: string;
        current: string;
      };
      expect(result.ok).toBe(false);
      expect(result.current).toBe("0.1.0");
      expect(result.error).toContain("还没有发布版本");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("有更新的 release 时给出版本与发布页地址", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v0.2.0",
        name: "MeowCode 0.2.0",
        published_at: "2026-11-01T10:00:00Z",
        body: "- 新增 Git 管理",
      }),
    })) as unknown as typeof fetch;
    try {
      const result = (await checkForUpdate("0.1.0")) as {
        ok: boolean;
        hasUpdate: boolean;
        latest: { version: string; url: string; notes: string };
      };
      expect(result.ok).toBe(true);
      expect(result.hasUpdate).toBe(true);
      expect(result.latest.version).toBe("v0.2.0");
      expect(result.latest.url).toBe(
        "https://gitcode.com/MuLiuSaMa/MeowCode/releases/tag/v0.2.0",
      );
      expect(result.latest.notes).toContain("Git 管理");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("同版本不算更新", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: "v0.1.0", name: "MeowCode 0.1.0" }),
    })) as unknown as typeof fetch;
    try {
      const result = (await checkForUpdate("0.1.0")) as { ok: boolean; hasUpdate: boolean };
      expect(result.ok).toBe(true);
      expect(result.hasUpdate).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("release 带安装包", () => {
  it("把 assets 规整并挑出当前平台的安装包", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v0.2.0",
        name: "MeowCode 0.2.0",
        assets: [
          {
            name: "MeowCode-0.2.0.exe",
            browser_download_url: "https://test.gitcode.net/dl/MeowCode-0.2.0.exe",
            size: 88_000_000,
          },
          { name: "MeowCode-0.2.0.dmg", browser_download_url: "https://gitcode.com/x.dmg", size: 90_000_000 },
        ],
      }),
    })) as unknown as typeof fetch;
    try {
      const result = (await checkForUpdate("0.1.0")) as {
        ok: boolean;
        latest: {
          assets: Array<{ name: string; url: string; size: number }>;
          asset: { name: string; url: string; size: number } | null;
        };
      };
      expect(result.latest.assets).toHaveLength(2);
      // 不可达的 test.gitcode.net 已被换成主站
      expect(result.latest.assets[0].url).toBe("https://gitcode.com/dl/MeowCode-0.2.0.exe");
      // 当前平台（测试机是 win32）挑 exe
      expect(result.latest.asset?.name).toBe("MeowCode-0.2.0.exe");
    } finally {
      globalThis.fetch = original;
    }
  });
});
