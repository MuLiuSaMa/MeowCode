import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BrowserHostClient, BrowserHostCommand, BrowserHostResult } from "./browser-host.js";
import { browserToolDefinitions, executeBrowserTool, isBrowserTool } from "./browser-tools.js";

function makeHost(
  result: BrowserHostResult = { ok: true, url: "http://localhost:4173/", title: "Demo" },
): { host: BrowserHostClient; commands: BrowserHostCommand[] } {
  const commands: BrowserHostCommand[] = [];
  return {
    commands,
    host: {
      async execute(command) {
        commands.push(command);
        return result;
      },
    },
  };
}

describe("browser tool definitions", () => {
  it("exposes the seven browser tools", () => {
    expect(browserToolDefinitions.map((definition) => definition.function.name)).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_screenshot",
      "browser_back",
      "browser_reload",
    ]);
    expect(isBrowserTool("browser_click")).toBe(true);
    expect(isBrowserTool("read_file")).toBe(false);
  });
});

describe("executeBrowserTool", () => {
  it("maps tool inputs to host commands", async () => {
    const { host, commands } = makeHost();
    await executeBrowserTool("browser_navigate", { url: " http://localhost:4173/ " }, host, { keepImages: false });
    await executeBrowserTool("browser_click", { ref: "e3" }, host, { keepImages: false });
    await executeBrowserTool(
      "browser_type",
      { text: "hello", ref: "e4", submit: true },
      host,
      { keepImages: false },
    );
    await executeBrowserTool("browser_back", {}, host, { keepImages: false });
    await executeBrowserTool("browser_reload", {}, host, { keepImages: false });

    expect(commands).toEqual([
      { op: "navigate", url: "http://localhost:4173/" },
      { op: "click", ref: "e3" },
      { op: "type", text: "hello", ref: "e4", submit: true },
      { op: "back" },
      { op: "reload" },
    ]);
  });

  it("returns page metadata and truncates large snapshots", async () => {
    const { host } = makeHost({ ok: true, snapshot: "x".repeat(25_000) });
    const result = await executeBrowserTool("browser_snapshot", {}, host, { keepImages: false });
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThan(20_100);
    expect(result.output).toContain("[truncated");
  });

  it("attaches screenshot images when the model accepts images", async () => {
    const { host } = makeHost({
      ok: true,
      screenshotBase64: "AAA",
      mimeType: "image/png",
      viewportWidth: 800,
      viewportHeight: 600,
    });
    const result = await executeBrowserTool("browser_screenshot", {}, host, { keepImages: true });
    expect(result.ok).toBe(true);
    expect(result.images).toEqual([{ data: "AAA", mimeType: "image/png" }]);
    expect(result.output).toContain("attached");
  });

  it("saves screenshots to a temp file when the model cannot accept images", async () => {
    const { host } = makeHost({
      ok: true,
      screenshotBase64: Buffer.from("png").toString("base64"),
      mimeType: "image/png",
    });
    const result = await executeBrowserTool("browser_screenshot", {}, host, { keepImages: false });
    expect(result.ok).toBe(true);
    expect(result.images).toBeUndefined();
    expect(result.output).toContain("meowcode-screenshots");
    const file = result.output.split("\n").at(-1) ?? "";
    expect(file).toContain("meowcode-screenshots");
    await expect(fs.stat(file)).resolves.toBeTruthy();
  });

  it("propagates host errors and rejects unknown tools", async () => {
    const { host } = makeHost({ ok: false, error: "浏览器页签未打开" });
    const failed = await executeBrowserTool("browser_snapshot", {}, host, { keepImages: false });
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain("浏览器页签未打开");

    const unknown = await executeBrowserTool("browser_dance", {}, host, { keepImages: false });
    expect(unknown.ok).toBe(false);
  });
});
