import { describe, expect, it } from "vitest";
import {
  canonicalizeExistingPath,
  tempWriteSid,
  workspaceWriteSid,
} from "./sid.js";

describe("workspaceWriteSid", () => {
  it("is deterministic for the same path", () => {
    expect(workspaceWriteSid("C:\\work")).toBe(workspaceWriteSid("C:\\work"));
  });

  it("derives distinct SIDs for distinct paths", () => {
    expect(workspaceWriteSid("C:\\work-a")).not.toBe(workspaceWriteSid("C:\\work-b"));
  });

  it("uses the S-1-4-x-y shape with 30-bit subauthorities", () => {
    const match = /^S-1-4-(\d+)-(\d+)$/.exec(workspaceWriteSid("D:\\项目"));
    expect(match).not.toBeNull();
    for (const value of match!.slice(1)) {
      expect(Number(value)).toBeGreaterThan(0);
      expect(Number(value)).toBeLessThan(2 ** 30);
    }
  });

  it("domain-separates the temp SID", () => {
    const workspace = "C:\\work";
    expect(tempWriteSid(workspace)).toMatch(/^S-1-4-\d+-\d+-1$/);
    expect(tempWriteSid(workspace)).not.toBe(workspaceWriteSid(workspace));
  });
});

describe("canonicalizeExistingPath", () => {
  it("returns the native real path of an existing directory", () => {
    const canonical = canonicalizeExistingPath(process.cwd());
    expect(canonical.length).toBeGreaterThan(0);
  });
});
