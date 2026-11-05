import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  deleteRule,
  isValidRuleName,
  listRules,
  loadRulesForInstructions,
  readRule,
  writeRule,
} from "./rules";

const dirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-rules-"));
  dirs.push(workspace);
  return workspace;
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("project rules", () => {
  it("creates, lists, reads, and deletes a rule", async () => {
    const workspace = await makeWorkspace();
    await writeRule(workspace, "code-style", "# Style\n\nUSE TABS");
    const rules = await listRules(workspace);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe("code-style");
    expect(rules[0].title).toBe("Style");

    const record = await readRule(workspace, "code-style");
    expect(record?.content).toContain("USE TABS");

    expect(await deleteRule(workspace, "code-style")).toBe(true);
    expect(await listRules(workspace)).toEqual([]);
    expect(await readRule(workspace, "code-style")).toBeNull();
    expect(await deleteRule(workspace, "code-style")).toBe(false);
  });

  it("rejects unsafe names", async () => {
    const workspace = await makeWorkspace();
    expect(isValidRuleName("code-style")).toBe(true);
    expect(isValidRuleName("../escape")).toBe(false);
    expect(isValidRuleName("Code Style")).toBe(false);
    await expect(writeRule(workspace, "../escape", "x")).rejects.toThrow();
  });

  it("renders rules for the system prompt", async () => {
    const workspace = await makeWorkspace();
    await writeRule(workspace, "no-generated", "Do not edit generated/.");
    const prompt = await loadRulesForInstructions(workspace);
    expect(prompt).toContain("Project rules");
    expect(prompt).toContain("### no-generated");
    expect(prompt).toContain("Do not edit generated/.");
  });
});
