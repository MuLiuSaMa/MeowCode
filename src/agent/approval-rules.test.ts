import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addApprovalRule,
  clearApprovalRules,
  commandPrefix,
  matchApprovalRule,
  readApprovalRules,
  removeApprovalRule,
  toRulePath,
} from "./approval-rules.js";

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "meowcode-rules-"));
}

describe("approval rules storage", () => {
  it("写入、读取、去重与删除", async () => {
    const dir = await workspace();
    const first = await addApprovalRule(dir, {
      tool: "run_command",
      kind: "command-exact",
      value: "pnpm test",
    });
    const second = await addApprovalRule(dir, {
      tool: "run_command",
      kind: "command-exact",
      value: "pnpm test",
    });
    const rules = await readApprovalRules(dir);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe(second.id);
    expect(rules[0].id).not.toBe(first.id);

    const raw = JSON.parse(await readFile(path.join(dir, ".meowcode", "approvals.json"), "utf8")) as {
      version: number;
    };
    expect(raw.version).toBe(1);

    expect(await removeApprovalRule(dir, second.id)).toBe(true);
    expect(await readApprovalRules(dir)).toEqual([]);
  });

  it("清空返回删除条数", async () => {
    const dir = await workspace();
    await addApprovalRule(dir, { tool: "write_file", kind: "path", value: "a.ts" });
    await addApprovalRule(dir, { tool: "browser_click", kind: "tool", value: "browser_click" });
    expect(await clearApprovalRules(dir)).toBe(2);
    expect(await readApprovalRules(dir)).toEqual([]);
  });

  it("损坏文件按空规则处理", async () => {
    const dir = await workspace();
    await addApprovalRule(dir, { tool: "x", kind: "tool", value: "x" });
    await readFile(path.join(dir, ".meowcode", "approvals.json"), "utf8");
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(dir, ".meowcode", "approvals.json"), "{not json", "utf8");
    expect(await readApprovalRules(dir)).toEqual([]);
  });
});

describe("approval rule matching", () => {
  it("工具级规则匹配任意输入", () => {
    const rules = [
      {
        id: "1",
        tool: "browser_click",
        match: { kind: "tool" as const, value: "browser_click" },
        createdAt: "",
      },
    ];
    expect(matchApprovalRule(rules, { tool: "browser_click" })?.id).toBe("1");
    expect(matchApprovalRule(rules, { tool: "write_file" })).toBeUndefined();
  });

  it("文件规则要求所有目标匹配且版本一致", () => {
    const rules = [
      {
        id: "p1",
        tool: "write_file",
        match: { kind: "path" as const, value: "src/a.ts", fileSha: "v1" },
        createdAt: "",
      },
    ];
    expect(
      matchApprovalRule(rules, {
        tool: "write_file",
        targets: [{ path: "src/a.ts", version: "v1" }],
      })?.id,
    ).toBe("p1");
    // 文件已改动：规则自动失效
    expect(
      matchApprovalRule(rules, {
        tool: "write_file",
        targets: [{ path: "src/a.ts", version: "v2" }],
      }),
    ).toBeUndefined();
    // 多目标必须全部覆盖
    expect(
      matchApprovalRule(rules, {
        tool: "write_file",
        targets: [
          { path: "src/a.ts", version: "v1" },
          { path: "src/b.ts", version: "v1" },
        ],
      }),
    ).toBeUndefined();
  });

  it("命令精确与前缀规则", () => {
    const exact = [
      {
        id: "c1",
        tool: "run_command",
        match: { kind: "command-exact" as const, value: "pnpm test" },
        createdAt: "",
      },
    ];
    expect(matchApprovalRule(exact, { tool: "run_command", command: "pnpm  test" })?.id).toBe(
      "c1",
    );
    expect(
      matchApprovalRule(exact, { tool: "run_command", command: "pnpm test --watch" }),
    ).toBeUndefined();

    const prefix = [
      {
        id: "c2",
        tool: "run_command",
        match: { kind: "command-prefix" as const, value: "pnpm run test" },
        createdAt: "",
      },
    ];
    expect(
      matchApprovalRule(prefix, { tool: "run_command", command: "pnpm run test:unit" })?.id,
    ).toBe("c2");
    expect(
      matchApprovalRule(prefix, { tool: "run_command", command: "pnpm run test; rm -rf ." }),
    ).toBeUndefined();
  });

  it("前缀建议拒绝 shell 元字符与过宽入口", () => {
    expect(commandPrefix("git status")).toBe("git status");
    expect(commandPrefix("pnpm run test:unit")).toBe("pnpm run test:unit");
    expect(commandPrefix("pnpm exec vitest run")).toBeUndefined();
    expect(commandPrefix("npm test")).toBe("npm test");
    expect(commandPrefix("echo hi > out.txt")).toBeUndefined();
    expect(commandPrefix("rm -rf .")).toBe("rm -rf");
    expect(commandPrefix("cls")).toBeUndefined();
  });

  it("路径规则存工作区相对形式", () => {
    const dir = path.resolve("D:/work/project");
    expect(toRulePath(dir, path.join(dir, "src", "a.ts"))).toBe("src/a.ts");
  });
});
