import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime.js";

function toolNames(runtime: AgentRuntime): string[] {
  // activeTools 是私有 getter；这里只读它的结果，验证能力门控
  const tools = (
    runtime as unknown as { activeTools: Array<{ function: { name: string } }> }
  ).activeTools;
  return tools.map((tool) => tool.function.name);
}

describe("web tool gating", () => {
  it("exposes web_search only when the provider has its own search backend", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-web-tools-"));

    const anthropic = new AgentRuntime({
      providers: [
        {
          id: "a",
          name: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          protocol: "anthropic-messages",
          model: "m",
          apiKey: "key",
        },
      ],
      sessionsDir: dir,
      homeDir: dir,
    });
    expect(toolNames(anthropic)).toContain("web_search");
    expect(toolNames(anthropic)).toContain("web_fetch");

    const local = new AgentRuntime({
      providers: [{ id: "p", name: "Local", baseUrl: "http://localhost:11434/v1", model: "m" }],
      sessionsDir: dir,
      homeDir: dir,
    });
    expect(toolNames(local)).not.toContain("web_search");
    expect(toolNames(local)).toContain("web_fetch");
  });
});
