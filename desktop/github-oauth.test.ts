import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  DEFAULT_CLIENT_ID,
  DEVICE_CODE_URL,
  TOKEN_URL,
  startDeviceFlow,
  pollDeviceFlow,
  refreshAccessToken,
} = require("./github-oauth.cjs") as {
  DEFAULT_CLIENT_ID: string;
  DEVICE_CODE_URL: string;
  TOKEN_URL: string;
  startDeviceFlow: (
    clientId: string,
    fetchImpl: typeof fetch,
  ) => Promise<
    | { ok: true; flow: { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number } }
    | { ok: false; error: { code: string; message: string } }
  >;
  pollDeviceFlow: (
    clientId: string,
    deviceCode: string,
    fetchImpl: typeof fetch,
  ) => Promise<
    | { status: "pending" }
    | { status: "slow_down"; interval: number }
    | { status: "success"; token: { accessToken: string; refreshToken: string; tokenType: string; scope: string; expiresIn: number } }
    | { status: "error"; code: string; message: string }
  >;
  refreshAccessToken: (
    clientId: string,
    refreshToken: string,
    fetchImpl: typeof fetch,
  ) => Promise<
    | { ok: true; token: { accessToken: string; refreshToken: string; tokenType: string; scope: string; expiresIn: number } }
    | { ok: false; code: string; message: string }
  >;
};

type Call = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse(body, status);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function formBody(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

describe("GitHub device flow client", () => {
  it("starts a device flow with the public client id", async () => {
    const { fetchImpl, calls } = mockFetch({
      device_code: "device-123",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });

    const result = await startDeviceFlow(DEFAULT_CLIENT_ID, fetchImpl);

    expect(result).toMatchObject({
      ok: true,
      flow: {
        deviceCode: "device-123",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 5,
      },
    });
    expect(calls[0]?.url).toBe(DEVICE_CODE_URL);
    expect(formBody(calls[0]?.init).get("client_id")).toBe(DEFAULT_CLIENT_ID);
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("surfaces device_flow_disabled with an actionable message", async () => {
    const { fetchImpl } = mockFetch({
      error: "device_flow_disabled",
      error_description: "device flow is not enabled",
    });

    const result = await startDeviceFlow("client", fetchImpl);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "device_flow_disabled",
        message: "GitHub App 还没有启用 Device flow。请到 GitHub App 设置勾选 Enable device flow 后重试。",
      },
    });
  });

  it("keeps polling while authorization is pending", async () => {
    const { fetchImpl, calls } = mockFetch({ error: "authorization_pending" });

    const result = await pollDeviceFlow("client", "device-123", fetchImpl);

    expect(result).toEqual({ status: "pending" });
    expect(calls[0]?.url).toBe(TOKEN_URL);
    const body = formBody(calls[0]?.init);
    expect(body.get("client_id")).toBe("client");
    expect(body.get("device_code")).toBe("device-123");
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
  });

  it("asks the caller to slow down and returns the next interval", async () => {
    const { fetchImpl } = mockFetch({ error: "slow_down", interval: 10 });

    await expect(pollDeviceFlow("client", "device-123", fetchImpl)).resolves.toEqual({
      status: "slow_down",
      interval: 10,
    });
  });

  it("returns the access token and refresh metadata on success", async () => {
    const { fetchImpl } = mockFetch({
      access_token: "ghu_access",
      token_type: "bearer",
      scope: "",
      refresh_token: "ghr_refresh",
      expires_in: 28800,
    });

    const result = await pollDeviceFlow("client", "device-123", fetchImpl);

    expect(result).toMatchObject({
      status: "success",
      token: {
        accessToken: "ghu_access",
        refreshToken: "ghr_refresh",
        tokenType: "bearer",
        scope: "",
        expiresIn: 28800,
      },
    });
  });

  it("rejects an access_denied response", async () => {
    const { fetchImpl } = mockFetch({ error: "access_denied" });

    await expect(pollDeviceFlow("client", "device-123", fetchImpl)).resolves.toEqual({
      status: "error",
      code: "access_denied",
      message: "你取消了 GitHub 授权。",
    });
  });

  it("refreshes an expiring token", async () => {
    const { fetchImpl, calls } = mockFetch({
      access_token: "ghu_new",
      token_type: "bearer",
      refresh_token: "ghr_new",
      expires_in: 28800,
    });

    const result = await refreshAccessToken("client", "ghr_old", fetchImpl);

    expect(result).toMatchObject({
      ok: true,
      token: { accessToken: "ghu_new", refreshToken: "ghr_new", expiresIn: 28800 },
    });
    const body = formBody(calls[0]?.init);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ghr_old");
  });

  it("throws on HTTP failures", async () => {
    const { fetchImpl } = mockFetch({ message: "boom" }, 500);
    await expect(startDeviceFlow("client", fetchImpl)).rejects.toThrow("GitHub OAuth request failed (500)");
  });
});
