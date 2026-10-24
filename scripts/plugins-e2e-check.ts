import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeTool, hasDynamicTool } from "../src/agent/tools.js";
import { createPluginSystem } from "../src/plugins/index.js";

const ws = await mkdtemp(path.join(tmpdir(), "meow-e2e-"));
try {
  await mkdir(path.join(ws, ".meowcode", "plugins"), { recursive: true });
  await cp("examples/plugins/hello-tool.ts", path.join(ws, ".meowcode", "plugins", "hello-tool.ts"));
  await cp("examples/plugins/guard.ts", path.join(ws, ".meowcode", "plugins", "guard.ts"));

  const system = await createPluginSystem({ workspace: ws, homeDir: ws });
  console.log(
    "descriptors:",
    JSON.stringify(
      system.descriptors().map((d) => ({
        id: d.id,
        enabled: d.enabled,
        tools: d.toolNames,
        hooks: d.hookEvents,
        error: d.error,
      })),
    ),
  );
  console.log("hello_greet registered:", hasDynamicTool("hello_greet"));

  const result = await executeTool("hello_greet", { name: "MeowCode" }, ws);
  console.log("execute result:", JSON.stringify(result));

  // hook 端到端：模拟危险命令被 guard 拦截
  const blocked = await (async () => {
    const registry = system.registry;
    const handlers = registry.getHookHandlers("tool_call");
    for (const h of handlers) {
      const r = await (h.handler as (e: unknown) => unknown)({
        hook: "tool_call",
        sessionId: "s",
        callId: "c",
        tool: "run_command",
        input: { command: "rm -rf /" },
      });
      if (r && typeof r === "object" && (r as { block?: boolean }).block) return true;
    }
    return false;
  })();
  console.log("guard blocks rm -rf:", blocked);

  await system.dispose();
  console.log("after dispose registered:", hasDynamicTool("hello_greet"));
  console.log("E2E OK");
} finally {
  await rm(ws, { recursive: true, force: true });
}
