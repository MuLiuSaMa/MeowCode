import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isMagpieProviderId,
  loadMagpieOverlay,
  mergeMagpieSettings,
  parseMagpieFile,
  resetMagpieOverlayCache,
  stripMagpieProviders,
} from "./magpie-overlay.cjs";

const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meowcode-magpie-"));
  tempDirs.push(dir);
  return dir;
}

function writeOverlay(dir: string, value: unknown) {
  const file = path.join(dir, "magpie.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

const record = (id: string, model = id.slice("magpie/".length)) => ({
  id,
  name: "Magpie",
  baseUrl: "http://127.0.0.1:3425/v1",
  model,
  protocol: "openai-chat-completions",
  authStyle: "none",
  extraHeaders: { Authorization: "Bearer magpie-meowcode" },
  enabled: true,
});

afterEach(() => {
  resetMagpieOverlayCache();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseMagpieFile", () => {
  it("keeps magpie's records and drops what it has no answer for", () => {
    const overlay = parseMagpieFile(
      JSON.stringify({
        magpieKey: "magpie-meowcode",
        providerId: "magpie/kimi/k2",
        providers: [
          {
            ...record("magpie/deepseek/pro"),
            apiKey: "sk-leak",
            apiKeyEncrypted: "dpapi-blob",
            authStyle: "bearer",
            extraHeaders: { Authorization: "Bearer magpie-meowcode\r\nX-Evil: 1" },
            contextWindow: 128000,
            maxTokens: 8192,
            inputModalities: ["text", "image", "video"],
          },
          record("user/own"),
          { ...record("magpie/remote"), baseUrl: "https://api.example.com/v1" },
          { id: "magpie/nomodel", baseUrl: "http://localhost:3425/v1" },
          { ...record("magpie/deepseek/pro"), model: "again" },
          "nope",
        ],
      }),
    );
    expect(overlay.providers).toHaveLength(1);
    expect(overlay.providerId).toBe("magpie/deepseek/pro");
    const provider = overlay.providers[0];
    expect(provider.apiKey).toBeUndefined();
    expect(provider.apiKeyEncrypted).toBeUndefined();
    expect(provider.authStyle).toBe("none");
    expect(provider.extraHeaders).toEqual({ Authorization: "Bearer magpie-meowcode X-Evil: 1" });
    expect(provider.inputModalities).toEqual(["text", "image"]);
  });

  it("answers null for anything it cannot read", () => {
    expect(parseMagpieFile("{")).toBeNull();
    expect(parseMagpieFile("[]")).toBeNull();
    expect(parseMagpieFile("{}")).toBeNull();
    expect(parseMagpieFile(JSON.stringify({ providers: [record("user/own")] }))).toBeNull();
  });

  it("picks the first record when providerId names none of them", () => {
    const overlay = parseMagpieFile(
      JSON.stringify({ providerId: "magpie/gone", providers: [record("magpie/a"), record("magpie/b")] }),
    );
    expect(overlay.providerId).toBe("magpie/a");
  });
});

describe("mergeMagpieSettings", () => {
  const own = [
    { id: "p1", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    { id: "p2", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2" },
  ];
  const overlay = { providerId: "magpie/a", providers: [record("magpie/a"), record("magpie/b")] };

  it("appends magpie's models after the user's own, and switches to the one magpie picked", () => {
    const merged = mergeMagpieSettings({ providers: own, providerId: "p1" }, overlay);
    expect(merged.providers.map((p: { id: string }) => p.id)).toEqual([
      "p1",
      "p2",
      "magpie/a",
      "magpie/b",
    ]);
    expect(merged.providerId).toBe("magpie/a");
    expect(merged.magpieAppliedId).toBe("magpie/a");
  });

  it("does not take back a model the user switched to after magpie's pick", () => {
    const merged = mergeMagpieSettings(
      { providers: own, providerId: "p2", magpieAppliedId: "magpie/a" },
      overlay,
    );
    expect(merged.providerId).toBe("p2");
  });

  it("follows magpie when it picks another of its models", () => {
    const merged = mergeMagpieSettings(
      { providers: own, providerId: "p2", magpieAppliedId: "magpie/a" },
      { providerId: "magpie/b", providers: overlay.providers },
    );
    expect(merged.providerId).toBe("magpie/b");
  });

  it("goes back to the user's providers, and a usable one, when magpie is gone", () => {
    const merged = mergeMagpieSettings(
      { providers: [...own, record("magpie/a")], providerId: "magpie/a", magpieAppliedId: "magpie/a" },
      null,
    );
    expect(merged.providers.map((p: { id: string }) => p.id)).toEqual(["p1", "p2"]);
    expect(merged.providerId).toBe("p1");
    expect(merged.magpieAppliedId).toBeUndefined();
  });

  it("keeps the enabled state and reasoning effort the user set in MeowCode", () => {
    const merged = mergeMagpieSettings(
      {
        providers: own,
        providerId: "p1",
        providerPrefs: { "magpie/a": { enabled: false, reasoningEffort: "high" }, p1: { enabled: false } },
      },
      overlay,
    );
    const a = merged.providers.find((p: { id: string }) => p.id === "magpie/a");
    expect(a.enabled).toBe(false);
    expect(a.reasoningEffort).toBe("high");
    // 预设只作用于 magpie 的模型
    expect(merged.providers.find((p: { id: string }) => p.id === "p1").enabled).toBeUndefined();
  });

  it("falls back to a model that is on when the picked one is off", () => {
    const merged = mergeMagpieSettings(
      {
        providers: own,
        providerId: "p1",
        providerPrefs: { "magpie/a": { enabled: false } },
      },
      overlay,
    );
    expect(merged.providerId).toBe("p1");
  });
});

describe("stripMagpieProviders", () => {
  it("leaves the user's records exactly as they were", () => {
    const providers = [{ id: "p1" }, { id: "magpie/a" }, { id: "p2" }];
    const kept = stripMagpieProviders(providers);
    expect(kept).toEqual([{ id: "p1" }, { id: "p2" }]);
    expect(providers).toHaveLength(3);
    expect(stripMagpieProviders(kept)).toEqual(kept);
    expect(stripMagpieProviders(undefined)).toEqual([]);
  });

  it("closes the loop: what is merged never comes back through a write", () => {
    const merged = mergeMagpieSettings(
      { providers: [{ id: "p1" }], providerId: "p1" },
      { providerId: "magpie/a", providers: [record("magpie/a")] },
    );
    expect(stripMagpieProviders(merged.providers)).toEqual([{ id: "p1" }]);
  });
});

describe("loadMagpieOverlay", () => {
  it("reads the file magpie left, and answers null when there is none", () => {
    const dir = tempDir();
    expect(loadMagpieOverlay([path.join(dir, "magpie.json")])).toBeNull();
    resetMagpieOverlayCache();
    const file = writeOverlay(dir, { providerId: "magpie/a", providers: [record("magpie/a")] });
    const loaded = loadMagpieOverlay([file]);
    expect(loaded.path).toBe(file);
    expect(loaded.overlay.providers).toHaveLength(1);
  });

  it("takes the newer of the two places it looks", () => {
    const older = tempDir();
    const newer = tempDir();
    const a = writeOverlay(older, { providerId: "magpie/old", providers: [record("magpie/old")] });
    const b = writeOverlay(newer, { providerId: "magpie/new", providers: [record("magpie/new")] });
    utimesSync(a, new Date(1_000), new Date(1_000));
    const loaded = loadMagpieOverlay([a, b]);
    expect(loaded.path).toBe(b);
    expect(loaded.overlay.providerId).toBe("magpie/new");
  });

  it("leaves a broken file where it is", () => {
    const dir = tempDir();
    const file = path.join(dir, "magpie.json");
    writeFileSync(file, "{ not json");
    expect(loadMagpieOverlay([file])).toBeNull();
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(dir)).toEqual(["magpie.json"]);
  });

  it("reads once per process, so the UI and the server agree until a restart", () => {
    const dir = tempDir();
    const file = writeOverlay(dir, { providerId: "magpie/a", providers: [record("magpie/a")] });
    const first = loadMagpieOverlay([file]);
    writeOverlay(dir, { providerId: "magpie/b", providers: [record("magpie/b")] });
    expect(loadMagpieOverlay([file])).toBe(first);
    resetMagpieOverlayCache();
    expect(loadMagpieOverlay([file]).overlay.providerId).toBe("magpie/b");
  });
});

describe("isMagpieProviderId", () => {
  it("knows magpie's records apart", () => {
    expect(isMagpieProviderId("magpie/kimi/k2")).toBe(true);
    expect(isMagpieProviderId("p1")).toBe(false);
    expect(isMagpieProviderId(undefined)).toBe(false);
    expect(isMagpieProviderId("MAGPIE/x")).toBe(false);
  });
});
