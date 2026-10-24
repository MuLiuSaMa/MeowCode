import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCodeInSandbox, type HostToolBridge } from "./code-mode";
import { executeTool } from "./tools";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meowcode-ptc-bridge-"));
  workspaces.push(root);
  return root;
}

type Call = { tool: string; args: Record<string, unknown> };

function recordingBridge(
  handler?: (call: Call) => { ok: boolean; output: string } | undefined,
): { bridge: HostToolBridge; calls: Call[] } {
  const calls: Call[] = [];
  const bridge: HostToolBridge = async (tool, args) => {
    const call = { tool, args };
    calls.push(call);
    return handler?.(call) ?? { ok: true, output: `${tool} ok` };
  };
  return { bridge, calls };
}

describe("run_code host bridge", () => {
  it("没有注入宿主桥时保持只读语义：write 报错且不落盘", async () => {
    const root = await tempWorkspace();
    const result = await runCodeInSandbox({
      workspace: root,
      code: `await meow.write("new.txt", "hello"); return "wrote";`,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("read-only run_code");
    await expect(readFile(path.join(root, "new.txt"), "utf8")).rejects.toThrow();
  });

  it("把 write/edit/multiEdit/run 按宿主工具参数原样转发", async () => {
    const root = await tempWorkspace();
    const { bridge, calls } = recordingBridge();
    const result = await runCodeInSandbox({
      workspace: root,
      code: `
        const a = await meow.write("a.txt", "alpha", { force: true });
        const b = await meow.edit("a.txt", "alpha", "beta", { replaceAll: true });
        const c = await meow.multiEdit([{ path: "a.txt", oldString: "beta", newString: "gamma" }]);
        const d = await meow.run("echo hi");
        return [a.ok, b.ok, c.ok, d.ok];
      `,
      hostToolBridge: bridge,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { tool: "write_file", args: { path: "a.txt", content: "alpha", force: true } },
      {
        tool: "edit_file",
        args: { path: "a.txt", oldString: "alpha", newString: "beta", replaceAll: true },
      },
      {
        tool: "multi_edit",
        args: { edits: [{ path: "a.txt", oldString: "beta", newString: "gamma" }] },
      },
      { tool: "run_command", args: { command: "echo hi" } },
    ]);
  });

  it("宿主拒绝时返回 ok=false 而不是抛异常，模型代码可以分支处理", async () => {
    const root = await tempWorkspace();
    const { bridge } = recordingBridge((call) =>
      call.tool === "write_file"
        ? { ok: false, output: "User denied this tool call." }
        : undefined,
    );
    const result = await runCodeInSandbox({
      workspace: root,
      code: `
        const write = await meow.write("blocked.txt", "x");
        if (!write.ok) return "denied:" + write.output;
        return "unexpected";
      `,
      hostToolBridge: bridge,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("denied:User denied this tool call.");
  });

  it("宿主桥调用计入内部调用预算", async () => {
    const root = await tempWorkspace();
    const { bridge, calls } = recordingBridge();
    const result = await runCodeInSandbox({
      workspace: root,
      code: `
        for (let i = 0; i < 5; i += 1) await meow.run("echo " + i);
        return "done";
      `,
      hostToolBridge: bridge,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(5);
    expect(result.output).toContain("5 internal call(s)");
  });

  it("executeTool 透传宿主桥，真实写入走宿主执行器", async () => {
    const root = await tempWorkspace();
    const result = await executeTool(
      "run_code",
      { code: `await meow.write("made.txt", "from sandbox"); return "ok";` },
      root,
      {
        hostToolBridge: async (tool, args) => {
          const written = await executeTool(tool, args, root, {});
          return { ok: written.ok, output: written.output };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(root, "made.txt"), "utf8")).toBe("from sandbox");
  });

  it("非法的 multiEdit 参数在沙箱内就被拒绝，不触达宿主", async () => {
    const root = await tempWorkspace();
    const { bridge, calls } = recordingBridge();
    const result = await runCodeInSandbox({
      workspace: root,
      code: `try { await meow.multiEdit([]); return "no-error"; } catch (error) { return String(error.message); }`,
      hostToolBridge: bridge,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("non-empty array");
    expect(calls).toHaveLength(0);
  });
});

describe("run_code host bridge with real workspace files", () => {
  it("写入后同一段代码可以读到新内容", async () => {
    const root = await tempWorkspace();
    await writeFile(path.join(root, "seed.txt"), "seed");
    const result = await runCodeInSandbox({
      workspace: root,
      code: `
        await meow.write("seed.txt", "rewritten");
        const text = await meow.read("seed.txt");
        return text;
      `,
      hostToolBridge: async (tool, args) => {
        const written = await executeTool(tool, args, root, {});
        return { ok: written.ok, output: written.output };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("rewritten");
  });
});
