import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSandboxSettings,
  normalizeSandboxSettings,
  readSandboxSettingsFromEnv,
  resetSandboxSettingsForTests,
  setSandboxSettings,
} from "./policy.js";
import { DEFAULT_SANDBOX_TIMEOUT_MS } from "./types.js";

afterEach(() => {
  resetSandboxSettingsForTests();
  vi.restoreAllMocks();
});

describe("normalizeSandboxSettings", () => {
  it("is off by default", () => {
    expect(normalizeSandboxSettings(undefined, "win32")).toEqual({
      enabled: false,
      mode: "workspace-write",
      writableRoots: [],
      allowTemp: true,
      grantTimeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
      confirmDelete: false,
    });
  });

  it("enables only on win32 with a supported mode", () => {
    expect(normalizeSandboxSettings({ enabled: true }, "win32").enabled).toBe(true);
    expect(normalizeSandboxSettings({ enabled: true }, "linux").enabled).toBe(false);
    expect(normalizeSandboxSettings({ enabled: true, mode: "read-only" }, "win32").enabled).toBe(
      false,
    );
    expect(
      normalizeSandboxSettings({ enabled: true, mode: "workspace-write" }, "win32").enabled,
    ).toBe(true);
  });

  it("keeps absolute, deduplicated writable roots", () => {
    const root = path.resolve(process.cwd(), "extra-cache");
    const normalized = normalizeSandboxSettings(
      {
        writableRoots: [root, `  ${root}  `, "relative/path", 42, ""],
      },
      "win32",
    );
    expect(normalized.writableRoots).toEqual([root]);
  });

  it("dedupes writable roots case-insensitively on win32", () => {
    const root = path.resolve(process.cwd(), "Extra");
    const normalized = normalizeSandboxSettings(
      { writableRoots: [root, root.toUpperCase()] },
      "win32",
    );
    expect(normalized.writableRoots).toHaveLength(1);
  });

  it("defaults allowTemp to true and clamps the grant timeout", () => {
    expect(normalizeSandboxSettings({ allowTemp: false }, "win32").allowTemp).toBe(false);
    expect(normalizeSandboxSettings({}, "win32").allowTemp).toBe(true);
    expect(normalizeSandboxSettings({ grantTimeoutMs: 1 }, "win32").grantTimeoutMs).toBe(10_000);
    expect(normalizeSandboxSettings({ grantTimeoutMs: 99_999_999 }, "win32").grantTimeoutMs).toBe(
      600_000,
    );
    expect(normalizeSandboxSettings({ grantTimeoutMs: 30_000 }, "win32").grantTimeoutMs).toBe(
      30_000,
    );
  });
});

describe("readSandboxSettingsFromEnv", () => {
  it("is off when the env var is absent", () => {
    expect(readSandboxSettingsFromEnv({}).enabled).toBe(false);
  });

  it("parses the JSON settings", () => {
    const settings = readSandboxSettingsFromEnv({
      MEOWCODE_SANDBOX: JSON.stringify({ enabled: true, allowTemp: false }),
    });
    expect(settings.enabled).toBe(process.platform === "win32");
    expect(settings.allowTemp).toBe(false);
  });

  it("fails closed and logs on invalid JSON", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readSandboxSettingsFromEnv({ MEOWCODE_SANDBOX: "{not-json" }).enabled).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("policy singleton", () => {
  it("stores and resets the current settings", () => {
    expect(getSandboxSettings().enabled).toBe(false);
    setSandboxSettings({ enabled: true, grantTimeoutMs: 20_000 });
    expect(getSandboxSettings().enabled).toBe(process.platform === "win32");
    expect(getSandboxSettings().grantTimeoutMs).toBe(20_000);
    resetSandboxSettingsForTests();
    expect(getSandboxSettings().enabled).toBe(false);
  });
});
