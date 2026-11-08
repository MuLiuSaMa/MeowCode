import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  MANUAL_MCP_TOKEN_CHECKS,
  MANUAL_MCP_CREDENTIAL_GROUPS,
  credentialGroupOf,
  credentialCheckName,
  validateManualMcpToken,
} = require("./mcp-token-checks.cjs") as {
  MANUAL_MCP_TOKEN_CHECKS: Record<
    string,
    {
      url: (values: Record<string, string>) => string;
      method?: string;
      headers?: (values: Record<string, string>) => Record<string, string>;
      body?: (values: Record<string, string>) => string;
      evaluate?: (response: unknown, body: string) => true | string;
    }
  >;
  MANUAL_MCP_CREDENTIAL_GROUPS: string[][];
  credentialGroupOf: (name: string) => string[];
  credentialCheckName: (name: string) => string;
  validateManualMcpToken: (
    name: string,
    values: Record<string, string>,
    options?: { fetchImpl?: typeof fetch },
  ) => Promise<{ ok: boolean; message?: string }>;
};

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("mcp-token-checks", () => {
  it("成组表：飞书双凭据成组，单值条目自成一组", () => {
    expect(MANUAL_MCP_CREDENTIAL_GROUPS).toContainEqual([
      "MEOWCODE_LARK_APP_ID",
      "MEOWCODE_LARK_APP_SECRET",
    ]);
    expect(credentialGroupOf("MEOWCODE_LARK_APP_SECRET")).toEqual([
      "MEOWCODE_LARK_APP_ID",
      "MEOWCODE_LARK_APP_SECRET",
    ]);
    expect(credentialGroupOf("MEOWCODE_FIGMA_TOKEN")).toEqual(["MEOWCODE_FIGMA_TOKEN"]);
    // 组代表（校验登记名）= 组内第一个成员
    expect(credentialCheckName("MEOWCODE_LARK_APP_SECRET")).toBe("MEOWCODE_LARK_APP_ID");
  });

  it("飞书校验：code=0 通过", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200 })),
    );
    const result = await validateManualMcpToken(
      "MEOWCODE_LARK_APP_ID",
      { MEOWCODE_LARK_APP_ID: "cli_x", MEOWCODE_LARK_APP_SECRET: "s" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("tenant_access_token/internal");
    expect(JSON.parse(String(init.body))).toEqual({ app_id: "cli_x", app_secret: "s" });
  });

  it("飞书校验：HTTP 200 但 code!=0 必须判失败（平台策略 21001 等）", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, JSON.stringify({ code: 21001, msg: "Access denied due to platform policy." })),
    );
    const result = await validateManualMcpToken(
      "MEOWCODE_LARK_APP_ID",
      { MEOWCODE_LARK_APP_ID: "cli_x", MEOWCODE_LARK_APP_SECRET: "bad" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("21001");
  });

  it("飞书校验：Secret 缺失时 body 里是空串（值由调用侧成组保证）", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, JSON.stringify({ code: 0 })),
    );
    await validateManualMcpToken(
      "MEOWCODE_LARK_APP_ID",
      { MEOWCODE_LARK_APP_ID: "cli_x" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).app_secret).toBe("");
  });

  it("figma 校验：token 走 X-Figma-Token 头（values 化后行为不变）", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, "{}"));
    const result = await validateManualMcpToken(
      "MEOWCODE_FIGMA_TOKEN",
      { MEOWCODE_FIGMA_TOKEN: "tok" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Figma-Token"]).toBe("tok");
  });

  it("HTTP 401 → 校验失败", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, "{}"));
    const result = await validateManualMcpToken(
      "MEOWCODE_FIGMA_TOKEN",
      { MEOWCODE_FIGMA_TOKEN: "bad" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("401");
  });

  it("未登记的 env 名 → 不支持", async () => {
    const result = await validateManualMcpToken("NOT_A_TOKEN", {}, {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不支持");
    // 每组的组代表（第一个成员）必须有 check（组员凭组代表的校验器整组提交）
    for (const group of MANUAL_MCP_CREDENTIAL_GROUPS) {
      expect(MANUAL_MCP_TOKEN_CHECKS[credentialCheckName(group[0])]).toBeTruthy();
    }
  });
});
