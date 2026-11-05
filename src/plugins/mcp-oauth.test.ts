import { promises as fs } from "node:fs";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpOAuthProvider } from "./mcp-oauth";
import { readJsonFile } from "../agent/atomic-json";

/**
 * 假授权服务器：发现 / 动态注册 / 换 token 三件套。
 * 授权端点不会被真的访问（浏览器由 openBrowser 捕获），code 由测试直接喂给回环回调。
 */
let fakeOrigin = "";
let fakeServer: http.Server | null = null;
let tokenRequests: URLSearchParams[] = [];

async function startFakeServer(): Promise<void> {
  fakeServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const json = (body: unknown): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json({
        issuer: fakeOrigin,
        authorization_endpoint: `${fakeOrigin}/authorize`,
        token_endpoint: `${fakeOrigin}/token`,
        registration_endpoint: `${fakeOrigin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const metadata = JSON.parse(body) as { redirect_uris?: string[] };
        expect(metadata.redirect_uris?.[0]).toContain("http://127.0.0.1:");
        json({ client_id: "fake-client-id", redirect_uris: metadata.redirect_uris });
      });
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const form = new URLSearchParams(body);
        tokenRequests.push(form);
        json({
          access_token: form.get("grant_type") === "refresh_token" ? "access-2" : "access-1",
          token_type: "Bearer",
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => fakeServer!.listen(0, "127.0.0.1", () => resolve()));
  const address = fakeServer!.address();
  fakeOrigin = `http://127.0.0.1:${typeof address === "object" ? address.port : 0}`;
}

describe("McpOAuthProvider", () => {
  let homeDir = "";

  beforeAll(async () => {
    await startFakeServer();
  });

  afterEach(async () => {
    if (homeDir) {
      await fs.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
      homeDir = "";
    }
    tokenRequests = [];
  });

  const makeProvider = (overrides: Partial<ConstructorParameters<typeof McpOAuthProvider>[0]> = {}) => {
    const captured: string[] = [];
    const provider = new McpOAuthProvider({
      serverName: "test-server",
      serverUrl: `${fakeOrigin}/mcp`,
      homeDir,
      openBrowser: (url) => {
        captured.push(url);
        // 模拟用户在浏览器完成授权 → 回环回调送达（state 用 authorize URL 里的）
        const authorizeUrl = new URL(url);
        provider.resolveAuthorizationCode(
          new URL(
            `http://127.0.0.1:${new URL(provider.redirectUrl!).port}/callback?code=auth-code-1&state=${authorizeUrl.searchParams.get("state")}`,
          ),
        );
      },
      ...overrides,
    });
    return { provider, captured };
  };

  it("全流程：发现 → 动态注册 → 回环回调 → 换 token 落盘", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "meowcode-mcp-oauth-"));
    const { provider, captured } = makeProvider();
    await provider.ensureAuthorized();

    // 浏览器被拉起且授权 URL 指向假服务器，带 PKCE challenge 与 scope
    expect(captured).toHaveLength(1);
    const authorizeUrl = new URL(captured[0]);
    expect(authorizeUrl.origin).toBe(fakeOrigin);
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    // 换 token 走了 authorization_code grant
    expect(tokenRequests.some((form) => form.get("grant_type") === "authorization_code")).toBe(true);

    // token 持久化：新实例直接读到，不再走授权
    const second = new McpOAuthProvider({
      serverName: "test-server",
      serverUrl: `${fakeOrigin}/mcp`,
      homeDir,
      openBrowser: () => {
        throw new Error("must not open browser when tokens exist");
      },
    });
    await second.ensureAuthorized();
    expect((await second.tokens())?.access_token).toBe("access-1");

    const stored = await readJsonFile<{ issuer?: string; tokens?: { access_token?: string } }>(
      path.join(homeDir, ".meowcode", "mcp-oauth", "test-server.json"),
    );
    expect(stored?.issuer).toBe(`${fakeOrigin}/mcp`);
    expect(stored?.tokens?.access_token).toBe("access-1");
  });

  it("state 不匹配拒绝（CSRF 防护），错误回调也送达等待方", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "meowcode-mcp-oauth-"));
    const provider = new McpOAuthProvider({
      serverName: "csrf",
      serverUrl: `${fakeOrigin}/mcp`,
      homeDir,
      openBrowser: (_url) => {
        provider.resolveAuthorizationCode(
          new URL(`http://127.0.0.1/callback?code=x&state=wrong-state`),
        );
      },
    });
    await expect(provider.ensureAuthorized()).rejects.toThrow(/state mismatch/);
  });

  it("issuer 换了就作废本地注册信息与 token", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "meowcode-mcp-oauth-"));
    const { provider } = makeProvider();
    await provider.ensureAuthorized();

    const reopened = new McpOAuthProvider({
      serverName: "test-server",
      serverUrl: `${fakeOrigin}/other-mcp`, // 服务器换了路径 → issuer 不同
      homeDir,
      openBrowser: () => undefined,
    });
    expect(await reopened.tokens()).toBeUndefined();
  });

  it("close() 后回环端口释放", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "meowcode-mcp-oauth-"));
    const { provider, captured } = makeProvider();
    await provider.ensureAuthorized();
    // ensureAuthorized 收尾自带 close；显式再关一次也幂等
    await provider.close();
    expect(provider.redirectUrl).toBeUndefined();
    expect(captured).toHaveLength(1);
  });
});
