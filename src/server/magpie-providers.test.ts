import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMagpieProviders } from "./server.js";

const tempDirs: string[] = [];
const saved = {
  file: process.env.MEOWCODE_MAGPIE_FILE,
  prefs: process.env.MEOWCODE_PROVIDER_PREFS,
};

function writeOverlay(value: unknown) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meowcode-magpie-server-"));
  tempDirs.push(dir);
  const file = path.join(dir, "magpie.json");
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

afterEach(() => {
  if (saved.file === undefined) delete process.env.MEOWCODE_MAGPIE_FILE;
  else process.env.MEOWCODE_MAGPIE_FILE = saved.file;
  if (saved.prefs === undefined) delete process.env.MEOWCODE_PROVIDER_PREFS;
  else process.env.MEOWCODE_PROVIDER_PREFS = saved.prefs;
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("readMagpieProviders", () => {
  it("answers nothing without a file", () => {
    delete process.env.MEOWCODE_MAGPIE_FILE;
    expect(readMagpieProviders()).toEqual([]);
  });

  it("reads magpie's models, with the gateway key in a header and the user's effort", () => {
    const file = writeOverlay({
      providerId: "magpie/kimi/k2",
      providers: [
        {
          id: "magpie/deepseek/pro",
          name: "Magpie",
          baseUrl: "http://127.0.0.1:3425/v1",
          model: "deepseek/pro",
          contextWindow: 128000,
          maxTokens: 8192,
          apiKey: "sk-leak",
          extraHeaders: { Authorization: "Bearer magpie-meowcode\r\nX-Evil: 1" },
        },
        {
          id: "magpie/kimi/k2",
          baseUrl: "http://localhost:3425/v1",
          model: "kimi/k2",
          inputModalities: ["text", "image"],
        },
      ],
    });
    process.env.MEOWCODE_MAGPIE_FILE = file;
    process.env.MEOWCODE_PROVIDER_PREFS = JSON.stringify({
      "magpie/kimi/k2": { reasoningEffort: "high" },
    });
    const providers = readMagpieProviders();
    expect(providers.map((p) => p.id)).toEqual(["magpie/deepseek/pro", "magpie/kimi/k2"]);
    expect(providers[0].authStyle).toBe("none");
    expect(providers[0].apiKey).toBeUndefined();
    expect(providers[0].extraHeaders).toEqual({ Authorization: "Bearer magpie-meowcode X-Evil: 1" });
    expect(providers[0].contextWindow).toBe(128000);
    expect(providers[1].reasoningEffort).toBe("high");
    expect(providers[1].inputModalities).toEqual(["text", "image"]);
  });

  it("turns away records that are not magpie's or not on this computer", () => {
    const file = writeOverlay({
      providers: [
        { id: "user/own", baseUrl: "http://127.0.0.1:3425/v1", model: "x" },
        { id: "magpie/remote", baseUrl: "https://api.example.com/v1", model: "x" },
        { id: "magpie/nomodel", baseUrl: "http://127.0.0.1:3425/v1" },
      ],
    });
    process.env.MEOWCODE_MAGPIE_FILE = file;
    expect(readMagpieProviders()).toEqual([]);
  });

  it("answers nothing for a file it cannot read", () => {
    process.env.MEOWCODE_MAGPIE_FILE = writeOverlay("{ not json");
    expect(readMagpieProviders()).toEqual([]);
    process.env.MEOWCODE_MAGPIE_FILE = path.join(os.tmpdir(), "meowcode-missing-magpie.json");
    expect(readMagpieProviders()).toEqual([]);
  });
});
