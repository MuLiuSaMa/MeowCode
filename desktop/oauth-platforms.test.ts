import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  OAUTH_PLATFORMS,
  resolveClientId,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshPlatformToken,
} = require("./oauth-platforms.cjs") as {
  OAUTH_PLATFORMS: Record<
    string,
    {
      label: string;
      authorizeUrl: string;
      tokenUrl: string;
      scope: string;
      localCallbackPath: string;
      tokenEnv: string;
      defaultClientId?: string;
    }
  >;
  resolveClientId: (
    config: { defaultClientId?: string },
    app?: { clientId?: string },
  ) => string;
  buildAuthorizeUrl: (
    config: { authorizeUrl: string; scope: string },
    params: { clientId: string; redirectUri: string; state: string },
  ) => string;
  exchangeCodeForToken: (
    config: { tokenUrl: string },
    params: { clientId: string; clientSecret: string; code: string; redirectUri: string },
    fetchImpl: typeof fetch,
  ) => Promise<
    | { ok: true; token: { accessToken: string; refreshToken: string; tokenType: string; scope: string; expiresIn: number } }
    | { ok: false; code: string; message: string }
  >;
  refreshPlatformToken: (
    config: { tokenUrl: string },
    params: { clientId: string; clientSecret: string; refreshToken: string },
    fetchImpl: typeof fetch,
  ) => Promise<
    | { ok: true; token: { accessToken: string; refreshToken: string; tokenType: string; scope: string; expiresIn: number } }
    | { ok: false; code: string; message: string }
  >;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse(body, status);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function formBody(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

describe("Gitee / GitCode OAuth helpers", () => {
  it("ships built-in client ids so connecting needs no self-registered app", () => {
    expect(OAUTH_PLATFORMS.gitee.defaultClientId).toBe(
      "cbe8604db051ea4fc5e21b6952330cb194e24c1cbd2e7c1bcb1fd34cc44e7dcd",
    );
    expect(OAUTH_PLATFORMS.gitcode.defaultClientId).toBe("b23b63eaf5764ea9a95e2613e5bf918a");
    expect(OAUTH_PLATFORMS.gitee.localCallbackPath).toBe("/oauth/gitee/callback");
    expect(OAUTH_PLATFORMS.gitcode.localCallbackPath).toBe("/oauth/gitcode/callback");
  });

  it("prefers a stored client id and falls back to the built-in one", () => {
    expect(resolveClientId(OAUTH_PLATFORMS.gitee, { clientId: "own-app" })).toBe("own-app");
    expect(resolveClientId(OAUTH_PLATFORMS.gitee, { clientId: "  " })).toBe(
      OAUTH_PLATFORMS.gitee.defaultClientId,
    );
    expect(resolveClientId(OAUTH_PLATFORMS.gitcode, {})).toBe(
      OAUTH_PLATFORMS.gitcode.defaultClientId,
    );
  });

  it("builds authorize urls with scope and state", () => {
    const url = buildAuthorizeUrl(OAUTH_PLATFORMS.gitee, {
      clientId: "client-1",
      redirectUri: "http://127.0.0.1:53682/oauth/gitee/callback",
      state: "state-1",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(OAUTH_PLATFORMS.gitee.authorizeUrl);
    expect(parsed.searchParams.get("client_id")).toBe("client-1");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53682/oauth/gitee/callback");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("state")).toBe("state-1");
    expect(parsed.searchParams.get("scope")).toContain("projects");
  });

  it("exchanges an authorization code and normalizes the token", async () => {
    const { fetchImpl, calls } = mockFetch({
      access_token: "oauth-access",
      token_type: "bearer",
      scope: "user_info projects",
      refresh_token: "oauth-refresh",
      expires_in: 86400,
    });

    const result = await exchangeCodeForToken(
      OAUTH_PLATFORMS.gitcode,
      {
        clientId: "client-2",
        clientSecret: "secret-2",
        code: "code-1",
        redirectUri: "http://127.0.0.1:53682/oauth/gitcode/callback",
      },
      fetchImpl,
    );

    expect(result).toMatchObject({
      ok: true,
      token: { accessToken: "oauth-access", refreshToken: "oauth-refresh", expiresIn: 86400 },
    });
    expect(calls[0]?.url).toBe(OAUTH_PLATFORMS.gitcode.tokenUrl);
    const body = formBody(calls[0]?.init);
    expect(body.get("client_id")).toBe("client-2");
    expect(body.get("client_secret")).toBe("secret-2");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("surfaces platform errors from the token exchange", async () => {
    const { fetchImpl } = mockFetch({
      error: "bad_verification_code",
      error_description: "授权码无效",
    });

    const result = await exchangeCodeForToken(
      OAUTH_PLATFORMS.gitee,
      { clientId: "c", clientSecret: "s", code: "bad", redirectUri: "http://127.0.0.1/cb" },
      fetchImpl,
    );

    expect(result).toEqual({ ok: false, code: "bad_verification_code", message: "授权码无效" });
  });

  it("refreshes tokens with the client secret", async () => {
    const { fetchImpl, calls } = mockFetch({
      access_token: "oauth-new",
      refresh_token: "refresh-new",
      expires_in: 1296000,
    });

    const result = await refreshPlatformToken(
      OAUTH_PLATFORMS.gitcode,
      { clientId: "client-2", clientSecret: "secret-2", refreshToken: "refresh-old" },
      fetchImpl,
    );

    expect(result).toMatchObject({
      ok: true,
      token: { accessToken: "oauth-new", refreshToken: "refresh-new" },
    });
    const body = formBody(calls[0]?.init);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-old");
    expect(body.get("client_secret")).toBe("secret-2");
  });
});
