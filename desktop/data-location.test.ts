import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultDataDir,
  locationPointerPath,
  migrateData,
  readDataLocation,
  validateDataTarget,
} from "./data-location.cjs";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "meowcode-data-loc-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("data location", () => {
  it("falls back to the default dir when the pointer is missing or points nowhere", () => {
    const root = makeRoot();
    expect(readDataLocation(root)).toBe(defaultDataDir(root));

    mkdirSync(defaultDataDir(root), { recursive: true });
    writeFileSync(locationPointerPath(root), JSON.stringify({ path: path.join(root, "missing") }));
    expect(readDataLocation(root)).toBe(defaultDataDir(root));
  });

  it("reads a valid custom location", () => {
    const root = makeRoot();
    const custom = path.join(root, "custom");
    mkdirSync(custom, { recursive: true });
    writeFileSync(locationPointerPath(root), JSON.stringify({ path: custom }));
    expect(readDataLocation(root)).toBe(custom);
  });

  it("validates same / nested / non-empty / empty / default targets", () => {
    const root = makeRoot();
    const current = path.join(root, "current");
    const defaultDir = defaultDataDir(root);
    mkdirSync(current, { recursive: true });

    expect(validateDataTarget({ current, target: current, defaultDir })).toBe("same_path");
    expect(validateDataTarget({ current, target: path.join(current, "nested"), defaultDir })).toBe(
      "invalid_target",
    );
    expect(validateDataTarget({ current, target: root, defaultDir })).toBe("invalid_target");

    const nonEmpty = path.join(root, "nonempty");
    mkdirSync(nonEmpty);
    writeFileSync(path.join(nonEmpty, "keep.txt"), "x");
    expect(validateDataTarget({ current, target: nonEmpty, defaultDir })).toBe("not_empty");

    expect(validateDataTarget({ current, target: path.join(root, "new"), defaultDir })).toBeNull();
    expect(validateDataTarget({ current, target: defaultDir, defaultDir })).toBeNull();
  });

  it("copies app data entries and the pointer while skipping caches", () => {
    const root = makeRoot();
    const current = path.join(root, "current");
    mkdirSync(path.join(current, "agent", "sessions"), { recursive: true });
    writeFileSync(path.join(current, "agent", "settings.json"), "{}");
    writeFileSync(path.join(current, "agent", "sessions", "s.jsonl"), "x");
    mkdirSync(path.join(current, "fonts"));
    writeFileSync(path.join(current, "fonts", "a.ttf"), "font");
    writeFileSync(path.join(current, "oauth-apps.json"), "{}");
    mkdirSync(path.join(current, "Cache"));
    writeFileSync(path.join(current, "Cache", "big"), "cache");

    const target = path.join(root, "target");
    const pointer = locationPointerPath(root);
    expect(
      migrateData({ current, target, defaultDir: defaultDataDir(root), pointerPath: pointer }),
    ).toEqual({ ok: true });

    expect(readFileSync(path.join(target, "agent", "settings.json"), "utf8")).toBe("{}");
    expect(readFileSync(path.join(target, "agent", "sessions", "s.jsonl"), "utf8")).toBe("x");
    expect(readFileSync(path.join(target, "fonts", "a.ttf"), "utf8")).toBe("font");
    expect(existsSync(path.join(target, "Cache"))).toBe(false);
    expect(JSON.parse(readFileSync(pointer, "utf8")).path).toBe(path.resolve(target));
    expect(readDataLocation(root)).toBe(path.resolve(target));
  });

  it("does not copy into a non-empty target", () => {
    const root = makeRoot();
    const current = path.join(root, "current");
    mkdirSync(current, { recursive: true });
    const target = path.join(root, "target");
    mkdirSync(target);
    writeFileSync(path.join(target, "keep.txt"), "x");

    expect(
      migrateData({
        current,
        target,
        defaultDir: defaultDataDir(root),
        pointerPath: locationPointerPath(root),
      }),
    ).toEqual({ ok: false, code: "not_empty" });
    expect(existsSync(path.join(target, "keep.txt"))).toBe(true);
  });

  it("switching back to the default removes the pointer", () => {
    const root = makeRoot();
    const current = path.join(root, "custom");
    mkdirSync(current, { recursive: true });
    const pointer = locationPointerPath(root);
    writeFileSync(pointer, JSON.stringify({ path: current }));

    expect(
      migrateData({
        current,
        target: defaultDataDir(root),
        defaultDir: defaultDataDir(root),
        pointerPath: pointer,
      }),
    ).toEqual({ ok: true, resetToDefault: true });
    expect(existsSync(pointer)).toBe(false);
  });
});
