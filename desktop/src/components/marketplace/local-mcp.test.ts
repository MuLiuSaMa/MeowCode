import { describe, expect, it } from "vitest";
import type { InstalledMcpEntry } from "../../api";
import { localMcpEntries } from "./local-mcp";

const installed: InstalledMcpEntry[] = [
  { id: "in-index", enabled: true, source: "market", target: "https://mcp.example.com" },
  { id: "manual-one", enabled: true, source: "manual", target: "npx -y example-mcp" },
  { id: "hand-written", enabled: false, source: "local", target: "" },
];

describe("localMcpEntries", () => {
  it("索引里已有的条目不合成：它本来就带完整信息", () => {
    const result = localMcpEntries(new Set(["in-index"]), installed, "本机 MCP 服务");
    expect(result.map((entry) => entry.id)).toEqual(["manual-one", "hand-written"]);
  });

  it("合成的条目一律算「已安装」，并带上来源与启停状态", () => {
    const result = localMcpEntries(new Set(), installed, "本机 MCP 服务");
    expect(result.find((entry) => entry.id === "manual-one")).toMatchObject({
      type: "mcp",
      name: "manual-one",
      description: "npx -y example-mcp",
      installed: true,
      localMcpSource: "manual",
      localMcpEnabled: true,
    });
    expect(result.find((entry) => entry.id === "hand-written")).toMatchObject({
      installed: true,
      localMcpSource: "local",
      localMcpEnabled: false,
    });
  });

  it("连接方式摘要为空时用兜底说明", () => {
    const result = localMcpEntries(new Set(), installed, "本机 MCP 服务");
    expect(result.find((entry) => entry.id === "hand-written")?.description).toBe("本机 MCP 服务");
  });

  it("索引为空集合时全部本机条目都要合成", () => {
    const result = localMcpEntries(new Set(), installed, "本机 MCP 服务");
    expect(result).toHaveLength(3);
  });
});
