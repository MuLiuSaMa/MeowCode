import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  displayPath,
  isWithinWorkspace,
  resolveToolPath,
  resolveWithinWorkspace,
  setAppDataRoot,
} from "./paths";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

const linkType = process.platform === "win32" ? "junction" : "dir";

describe("workspace path guard", () => {
  it("allows paths inside the workspace", async () => {
    expect(isWithinWorkspace("D:/work", "D:/work/file.txt")).toBe(true);
    expect(await resolveWithinWorkspace("D:/work", "src/file.txt")).toContain("work");
  });

  it("rejects paths outside the workspace", async () => {
    expect(isWithinWorkspace("D:/work", "D:/other/file.txt")).toBe(false);
    await expect(resolveWithinWorkspace("D:/work", "../other/file.txt")).rejects.toThrow();
  });

  it("allows outside paths only in full access mode", async () => {
    await expect(resolveToolPath("D:/work", "D:/other/file.txt")).rejects.toThrow();
    expect(await resolveToolPath("D:/work", "D:/other/file.txt", true)).toBe(
      path.resolve("D:/other/file.txt"),
    );
    expect(await resolveToolPath("D:/work", "src/a.ts", true)).toBe(
      path.resolve("D:/work/src/a.ts"),
    );
  });

  it("allows reads under explicitly attached roots without full access", async () => {
    const workspace = await tempDir("meowcode-ws-");
    const attached = await tempDir("meowcode-attached-");
    const sibling = await tempDir("meowcode-sibling-");
    try {
      const file = path.join(attached, "note.txt");
      const other = path.join(sibling, "other.txt");
      await writeFile(file, "attached");
      await writeFile(other, "sibling");

      await expect(resolveToolPath(workspace, file)).rejects.toThrow("outside the workspace");
      expect(await resolveToolPath(workspace, file, false, [attached])).toBe(path.resolve(file));
      await expect(
        resolveToolPath(workspace, other, false, [attached]),
      ).rejects.toThrow("outside the workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(attached, { recursive: true, force: true });
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("still rejects junction escapes inside an attached root", async () => {
    const workspace = await tempDir("meowcode-ws-");
    const attached = await tempDir("meowcode-attached-");
    const outside = await tempDir("meowcode-outside-");
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(outside, path.join(attached, "escape"), linkType);
      await expect(
        resolveToolPath(workspace, path.join(attached, "escape", "secret.txt"), false, [
          attached,
        ]),
      ).rejects.toThrow("outside the workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(attached, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("treats the app data root (home/.meowcode) as trusted", async () => {
    const workspace = await tempDir("meowcode-ws-");
    const appRoot = await tempDir("meowcode-app-");
    const realAppRoot = await realpath(appRoot);
    try {
      setAppDataRoot(appRoot);
      // 存在与不存在的文件都能解析（memory/ 目录通常是新建的）
      await writeFile(path.join(appRoot, "memory-note.md"), "note");
      expect(await resolveToolPath(workspace, path.join(appRoot, "memory-note.md"))).toBe(
        path.join(realAppRoot, "memory-note.md"),
      );
      expect(await resolveToolPath(workspace, path.join(appRoot, "memory", "new.md"))).toBe(
        path.join(realAppRoot, "memory", "new.md"),
      );
      // 应用根外仍然是工作区外
      await expect(resolveToolPath(workspace, path.join(appRoot, "..", "outside.txt"))).rejects.toThrow(
        "outside the workspace",
      );
    } finally {
      setAppDataRoot(path.join(os.homedir(), ".meowcode"));
      await rm(workspace, { recursive: true, force: true });
      await rm(appRoot, { recursive: true, force: true });
    }
  });

  it("resolves new files under the real workspace path", async () => {
    const root = await tempDir("meowcode-paths-");
    try {
      const realRoot = await realpath(root);
      expect(await resolveToolPath(root, "nested/new.txt")).toBe(
        path.join(realRoot, "nested", "new.txt"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects junction escapes for existing and new files", async () => {
    const root = await tempDir("meowcode-paths-");
    const outside = await tempDir("meowcode-outside-");
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(outside, path.join(root, "escape"), linkType);

      await expect(resolveToolPath(root, "escape/secret.txt")).rejects.toThrow(
        "outside the workspace",
      );
      await expect(resolveToolPath(root, "escape/new.txt")).rejects.toThrow(
        "outside the workspace",
      );
      expect(await resolveToolPath(root, "escape/secret.txt", true)).toBe(
        path.join(path.resolve(root), "escape", "secret.txt"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("canonicalizes a workspace that is itself a junction", async () => {
    const real = await tempDir("meowcode-real-");
    const linkParent = await tempDir("meowcode-link-");
    const linked = path.join(linkParent, "work");
    try {
      await writeFile(path.join(real, "a.txt"), "hello");
      await symlink(real, linked, linkType);
      const resolved = await resolveToolPath(linked, "a.txt");
      expect(resolved).toBe(path.join(await realpath(real), "a.txt"));
    } finally {
      await rm(linked, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
      await rm(real, { recursive: true, force: true });
    }
  });

  it("displays outside paths as absolute paths", () => {
    expect(displayPath("D:/work", "src/a.ts").replace(/\\/g, "/")).toBe("src/a.ts");
    expect(displayPath("D:/work", "D:/other/file.txt")).toBe(path.resolve("D:/other/file.txt"));
  });
});
