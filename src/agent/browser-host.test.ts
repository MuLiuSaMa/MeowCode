import http from "node:http";
import { describe, expect, it } from "vitest";
import { createBrowserHostFromEnv, createHttpBrowserHostClient } from "./browser-host.js";

async function startHost(
  handler: (
    request: http.IncomingMessage,
    body: string,
  ) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", async () => {
      const result = await handler(request, raw);
      const text = JSON.stringify(result.body);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("createBrowserHostFromEnv", () => {
  it("returns undefined when the env is absent", () => {
    expect(createBrowserHostFromEnv({})).toBeUndefined();
  });

  it("rejects non-loopback or invalid hosts", () => {
    expect(createBrowserHostFromEnv({ MEOWCODE_BROWSER_HOST: "http://10.0.0.5:1234" })).toBeUndefined();
    expect(createBrowserHostFromEnv({ MEOWCODE_BROWSER_HOST: "ftp://127.0.0.1:1" })).toBeUndefined();
    expect(createBrowserHostFromEnv({ MEOWCODE_BROWSER_HOST: "not a url" })).toBeUndefined();
  });

  it("accepts loopback hosts", async () => {
    const client = createBrowserHostFromEnv({ MEOWCODE_BROWSER_HOST: "http://127.0.0.1:9/" });
    expect(client).toBeDefined();
    const localhost = createBrowserHostFromEnv({ MEOWCODE_BROWSER_HOST: "http://localhost:9" });
    expect(localhost).toBeDefined();
  });
});

describe("http browser host client", () => {
  it("posts commands with the token and parses the result", async () => {
    let seenToken = "";
    let seenBody = "";
    const host = await startHost((request, body) => {
      seenToken = String(request.headers["x-meow-browser-token"] ?? "");
      seenBody = body;
      return { status: 200, body: { ok: true, url: "http://localhost:3000/", title: "Demo" } };
    });
    try {
      const client = createHttpBrowserHostClient({ baseUrl: host.baseUrl, token: "secret" });
      const result = await client.execute({ op: "navigate", url: "http://localhost:3000/" });
      expect(result).toMatchObject({ ok: true, url: "http://localhost:3000/", title: "Demo" });
      expect(seenToken).toBe("secret");
      expect(JSON.parse(seenBody)).toEqual({ op: "navigate", url: "http://localhost:3000/" });
    } finally {
      await host.close();
    }
  });

  it("maps HTTP errors to ok:false", async () => {
    const failing = await startHost(() => ({ status: 401, body: { ok: false, error: "invalid token" } }));
    try {
      const client = createHttpBrowserHostClient({ baseUrl: failing.baseUrl });
      const error = await client.execute({ op: "snapshot" });
      expect(error.ok).toBe(false);
      expect(error.error).toContain("invalid token");
    } finally {
      await failing.close();
    }
  });

  it("returns an aborted error when the caller aborts", async () => {
    const host = await startHost(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { status: 200, body: { ok: true } };
    });
    try {
      const client = createHttpBrowserHostClient({ baseUrl: host.baseUrl });
      const controller = new AbortController();
      const pending = client.execute({ op: "snapshot" }, controller.signal);
      controller.abort();
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("aborted");
    } finally {
      await host.close();
    }
  });

  it("times out long requests", async () => {
    const host = await startHost(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: 200, body: { ok: true } };
    });
    try {
      const client = createHttpBrowserHostClient({ baseUrl: host.baseUrl, timeoutMs: 50 });
      const result = await client.execute({ op: "snapshot" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Browser host request failed");
    } finally {
      await host.close();
    }
  });
});
