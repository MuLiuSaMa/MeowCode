import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionStore } from "../agent/session-store";
import { searchIndexPath } from "../agent/session-search";
import { MAX_POLISH_INPUT_CHARS } from "../agent/prompt-polish";
import { startServer, type AgentServer } from "./server";

const TOKEN = "test-server-token";
let server: AgentServer;
let baseUrl = "";
let sessionsDir = "";
let memoryHomeDir = "";

beforeAll(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-server-"));
  memoryHomeDir = await mkdtemp(path.join(tmpdir(), "meowcode-server-home-"));
  process.env.MEOWCODE_SESSIONS_DIR = sessionsDir;
  process.env.MEOWCODE_PROVIDER_ID = "";
  process.env.MEOWCODE_WORKSPACE = "";
  process.env.MEOWCODE_HOME_DIR = memoryHomeDir;
  process.env.MEOWCODE_PROVIDERS = JSON.stringify([
    { id: "p1", name: "provider", baseUrl: "http://127.0.0.1:1", model: "m", apiKey: "secret" },
  ]);
  process.env.MEOWCODE_BROWSER_HOST_TOKEN = "browser-secret";
  process.env.MEOWCODE_SERVER_TOKEN = TOKEN;
  // 记忆总开关初值走 env：模拟桌面端关闭开关后启动 server（PUT 用例再实时打开）
  process.env.MEOWCODE_MEMORY = "0";

  server = await startServer({ port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server has no TCP address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server.shutdown("test");
  await rm(sessionsDir, { recursive: true, force: true });
  await rm(memoryHomeDir, { recursive: true, force: true });
  delete process.env.MEOWCODE_SESSIONS_DIR;
  delete process.env.MEOWCODE_PROVIDER_ID;
  delete process.env.MEOWCODE_WORKSPACE;
  delete process.env.MEOWCODE_HOME_DIR;
  delete process.env.MEOWCODE_MEMORY;
});

describe("agent server auth", () => {
  it("rejects requests without a token", async () => {
    for (const route of ["/global/health", "/sessions", "/event"]) {
      const response = await fetch(`${baseUrl}${route}`);
      expect(response.status).toBe(401);
    }
  });

  it("rejects requests with a wrong token", async () => {
    const response = await fetch(`${baseUrl}/global/health`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  it("accepts the bearer token", async () => {
    const health = await fetch(`${baseUrl}/global/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ healthy: true });

    const sessions = await fetch(`${baseUrl}/sessions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toEqual({ sessions: [] });
  });

  it("streams events for an authenticated client", async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/event`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    const chunk = await reader!.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("server.connected");
    await reader!.cancel();
    controller.abort();
  });

  it("accepts read-only mode on main and side permission routes", async () => {
    for (const route of ["/session/permissions", "/side/session/permissions"]) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "read-only" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ mode: "read-only" });

      const current = await fetch(`${baseUrl}${route}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(await current.json()).toEqual({ mode: "read-only" });
    }
  });

  it("rejects prompts when there is no active session", async () => {
    for (const route of ["/session/prompt", "/side/session/prompt"]) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      });
      expect(response.status).toBe(409);
    }
  });

  it("validates input suggestion requests", async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const missing = await fetch(`${baseUrl}/session/suggestion`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const unknown = await fetch(`${baseUrl}/session/suggestion`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "missing-session" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("removes secrets from the server environment after startup", () => {
    expect(process.env.MEOWCODE_PROVIDERS).toBeUndefined();
    expect(process.env.MEOWCODE_BROWSER_HOST_TOKEN).toBeUndefined();
    expect(process.env.MEOWCODE_SERVER_TOKEN).toBeUndefined();
  });

  it("reports whether a turn is running", async () => {
    const created = await fetch(`${baseUrl}/session/new`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ cwd: sessionsDir }),
    });
    expect(created.status).toBe(200);

    const current = await fetch(`${baseUrl}/session`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      createdAt: expect.any(String),
      running: false,
      runningSessionId: null,
      runningSessionIds: [],
      pendingApproval: null,
      pendingApprovals: [],
      queuedPrompts: [],
      recoveredPrompts: [],
      approvalMode: "auto",
      lastTurn: null,
      compactingSessionIds: [],
      lastError: null,
      usage: null,
      metrics: null,
    });
  });

  it("fails closed when no token is configured", async () => {
    await expect(startServer({ port: 0 })).rejects.toThrow("MEOWCODE_SERVER_TOKEN is required");
  });
});

describe("memory config", () => {
  it("GET reflects the env boot value", async () => {
    // beforeAll 里 MEOWCODE_MEMORY="0"：桌面端关掉开关后重启 server 的形态
    const response = await fetch(`${baseUrl}/config/memory`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
  });

  it("PUT switches the flag live and rejects non-boolean values", async () => {
    const put = await fetch(`${baseUrl}/config/memory`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ enabled: true });

    const get = await fetch(`${baseUrl}/config/memory`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await get.json()).toEqual({ enabled: true });

    const invalid = await fetch(`${baseUrl}/config/memory`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe("provider fallback config", () => {
  it("默认关闭：没有 env 时不切备用服务商", async () => {
    const response = await fetch(`${baseUrl}/config/provider-fallback`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
  });

  it("PUT switches the flag live and rejects non-boolean values", async () => {
    const put = await fetch(`${baseUrl}/config/provider-fallback`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ enabled: true });

    const get = await fetch(`${baseUrl}/config/provider-fallback`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await get.json()).toEqual({ enabled: true });

    const invalid = await fetch(`${baseUrl}/config/provider-fallback`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(invalid.status).toBe(400);

    // 复原，避免影响后续用例
    await fetch(`${baseUrl}/config/provider-fallback`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
  });
});

describe("sandbox config", () => {
  it("GET returns the disabled defaults and platform support", async () => {
    const response = await fetch(`${baseUrl}/config/sandbox`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      enabled: false,
      mode: "workspace-write",
      writableRoots: [],
      allowTemp: true,
      grantTimeoutMs: 120_000,
      platform: process.platform,
      supported: process.platform === "win32",
    });
  });

  it("rejects a non-boolean enabled value", async () => {
    const response = await fetch(`${baseUrl}/config/sandbox`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(response.status).toBe(400);
  });

  it("cannot enable without a workspace", async () => {
    const response = await fetch(`${baseUrl}/config/sandbox`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(["sandbox_unavailable", "invalid_request"]).toContain(body.error?.code);
  });

  it("refuses probe and revoke without a workspace", async () => {
    for (const route of ["/config/sandbox/probe", "/config/sandbox/revoke"]) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(400);
    }
  });

  it("accepts disabling even with no workspace", async () => {
    const response = await fetch(`${baseUrl}/config/sandbox`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false });
  });
});

describe("harness endpoints", () => {
  it("GET /harness returns the builtin seed for a fresh workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-harness-ws-"));
    const response = await fetch(`${baseUrl}/harness?workspace=${encodeURIComponent(workspace)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      document: { nodes: Array<{ id: string }>; edges: unknown[] };
    };
    expect(body.document.nodes.map((node) => node.id)).toContain("G4");
    expect(body.document.edges.length).toBeGreaterThan(0);
    await rm(workspace, { recursive: true, force: true });
  });

  it("creates, lists, renames and deletes custom architectures", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-harness-ws-"));
    const auth = { authorization: `Bearer ${TOKEN}` };
    // 新建：默认复制标准 Agent 的图
    const created = await fetch(`${baseUrl}/harness/create`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, name: "自定义 Agent" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      id: string;
      name: string;
      document: {
        nodes: Array<{ id: string; type: string; data?: { name?: string } }>;
      };
    };
    expect(createdBody.id).toMatch(/^custom-\d+$/);
    expect(createdBody.name).toBe("自定义 Agent");
    // 副本 = 标准 Agent 的拓扑（含门禁 G4）
    expect(createdBody.document.nodes.map((node) => node.id)).toContain("G4");
    // 架构名同时写进主 Agent 节点名（与左栏列表一致）
    expect(createdBody.document.nodes.find((node) => node.type === "agent")?.data?.name).toBe(
      "自定义 Agent",
    );
    // 列表：内置三档 + 新建的自定义架构
    const listed = await fetch(`${baseUrl}/harness/list?workspace=${encodeURIComponent(workspace)}`, {
      headers: auth,
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      architectures: Array<{ id: string; name: string | null; builtin: boolean }>;
    };
    expect(listBody.architectures.filter((item) => item.builtin).map((item) => item.id)).toEqual([
      "standard",
      "minimal",
      "complex",
    ]);
    expect(listBody.architectures.some((item) => item.id === createdBody.id && !item.builtin)).toBe(
      true,
    );
    // 改名
    const renamed = await fetch(`${baseUrl}/harness/rename`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, id: createdBody.id, name: "我的 Agent" }),
    });
    expect(renamed.status).toBe(200);
    const afterRename = (await (
      await fetch(`${baseUrl}/harness/list?workspace=${encodeURIComponent(workspace)}`, {
        headers: auth,
      })
    ).json()) as { architectures: Array<{ id: string; name: string | null }> };
    expect(afterRename.architectures.find((item) => item.id === createdBody.id)?.name).toBe(
      "我的 Agent",
    );
    // 改名后图里的主 Agent 节点名也跟着变
    const renamedDoc = (await (
      await fetch(
        `${baseUrl}/harness?workspace=${encodeURIComponent(workspace)}&profile=${createdBody.id}`,
        { headers: auth },
      )
    ).json()) as {
      document: { nodes: Array<{ type: string; data?: { name?: string } }> };
    };
    expect(renamedDoc.document.nodes.find((node) => node.type === "agent")?.data?.name).toBe(
      "我的 Agent",
    );
    // 内置三档不可改名/删除
    const renameBuiltin = await fetch(`${baseUrl}/harness/rename`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, id: "standard", name: "x" }),
    });
    expect(renameBuiltin.status).toBe(400);
    // 删除
    const removed = await fetch(
      `${baseUrl}/harness/architecture?workspace=${encodeURIComponent(workspace)}&id=${createdBody.id}`,
      { method: "DELETE", headers: auth },
    );
    expect(removed.status).toBe(200);
    const afterDelete = (await (
      await fetch(`${baseUrl}/harness/list?workspace=${encodeURIComponent(workspace)}`, {
        headers: auth,
      })
    ).json()) as { architectures: Array<{ id: string }> };
    expect(afterDelete.architectures.some((item) => item.id === createdBody.id)).toBe(false);
    await rm(workspace, { recursive: true, force: true });
  });

  it("PUT /harness saves a valid document and rejects invalid ones", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-harness-ws-"));
    const valid = {
      version: 1,
      nodes: [
        { id: "T1", type: "tier", data: { name: "单车道" } },
        { id: "G4", type: "gate", data: { name: "实现" } },
        { id: "implementer", type: "role", data: { name: "实现" } },
      ],
      edges: [
        { id: "e1", source: "T1", target: "G4", type: "tier-gate", order: 1 },
        { id: "e2", source: "G4", target: "implementer", type: "gate-role" },
      ],
    };
    const saved = await fetch(`${baseUrl}/harness`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace, document: valid }),
    });
    expect(saved.status).toBe(200);

    const reread = await fetch(`${baseUrl}/harness?workspace=${encodeURIComponent(workspace)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await reread.json()) as { document: { nodes: Array<{ id: string }> } };
    const ids = body.document.nodes.map((node) => node.id);
    // 保存的节点原样保留；GET 会把该档位缺的内置角色节点补齐（架构图必须是完整装配）
    expect(ids.slice(0, 3)).toEqual(["T1", "G4", "implementer"]);
    expect(ids).toContain("planner");
    expect(ids).not.toContain("custom");

    const invalid = await fetch(`${baseUrl}/harness`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        document: { version: 1, nodes: [], edges: [{ id: "x", source: "ghost", target: "G4" }] },
      }),
    });
    expect(invalid.status).toBe(400);
    // 非法保存不覆盖（节点数保持上一次成功保存 + 自动补齐的结果）
    const after = await fetch(`${baseUrl}/harness?workspace=${encodeURIComponent(workspace)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const afterBody = (await after.json()) as { document: { nodes: Array<{ id: string }> } };
    expect(afterBody.document.nodes.map((node) => node.id)).toEqual(ids);
    await rm(workspace, { recursive: true, force: true });
  });

  it("keeps one architecture graph per agent profile", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-harness-ws-"));
    const auth = { authorization: `Bearer ${TOKEN}` };
    const read = async (profile: string) => {
      const response = await fetch(
        `${baseUrl}/harness?workspace=${encodeURIComponent(workspace)}&profile=${profile}`,
        { headers: auth },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        profile: string;
        document: { nodes: Array<{ id: string; type: string }> };
      };
    };

    // 极简档的图没有门禁节点，标准档有
    const minimal = await read("minimal");
    expect(minimal.profile).toBe("minimal");
    expect(minimal.document.nodes.map((node) => node.id)).not.toContain("G4");
    expect((await read("standard")).document.nodes.map((node) => node.id)).toContain("G4");

    // 只改极简图，标准图不受影响
    const minimalDoc = {
      version: 1,
      nodes: [
        { id: "main", type: "agent", data: { name: "极简 Agent" } },
        { id: "explore", type: "role", data: { name: "Explore", role: "explore" } },
      ],
      edges: [{ id: "e1", source: "main", target: "explore", type: "agent-role" }],
    };
    const saved = await fetch(`${baseUrl}/harness`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ workspace, profile: "minimal", document: minimalDoc }),
    });
    expect(saved.status).toBe(200);
    // 极简档只存了一个 explore 节点：GET 会把该档位缺的 general 补上，且不补出门禁
    const minimalAfter = await read("minimal");
    expect(minimalAfter.document.nodes.map((node) => node.id).sort()).toEqual([
      "explore",
      "general",
      "main",
    ]);
    expect(minimalAfter.document.nodes.map((node) => node.id)).not.toContain("G4");
    expect((await read("standard")).document.nodes.map((node) => node.id)).toContain("G4");

    // 非法 id（大写/非法字符）直接拒绝；合法形态的自定义 id 允许（回退标准种子）
    const invalidProfile = await fetch(
      `${baseUrl}/harness?workspace=${encodeURIComponent(workspace)}&profile=Not%20Valid!`,
      { headers: auth },
    );
    expect(invalidProfile.status).toBe(400);
    const customProfile = await fetch(
      `${baseUrl}/harness?workspace=${encodeURIComponent(workspace)}&profile=custom-99`,
      { headers: auth },
    );
    expect(customProfile.status).toBe(200);
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("agent profile endpoints", () => {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };

  it("accepts the three profiles and rejects unknown ones", async () => {
    const created = await fetch(`${baseUrl}/session/new`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: sessionsDir }),
    });
    expect(created.status).toBe(200);

    for (const profile of ["minimal", "complex", "standard"]) {
      const response = await fetch(`${baseUrl}/session/agent-profile`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ profile }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ profile });
    }

    const invalid = await fetch(`${baseUrl}/session/agent-profile`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ profile: "bogus" }),
    });
    expect(invalid.status).toBe(400);

    const current = (await (
      await fetch(`${baseUrl}/session`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as { agentProfile: string };
    expect(current.agentProfile).toBe("standard");
  });

  it("publishes the profile registry on /agent-definitions", async () => {
    const response = await fetch(`${baseUrl}/agent-definitions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      profiles: Array<{ id: string; roles: string[]; tools: string[] | null }>;
    };
    expect(body.profiles.map((profile) => profile.id)).toEqual([
      "standard",
      "minimal",
      "complex",
    ]);
    const minimal = body.profiles.find((profile) => profile.id === "minimal");
    expect(minimal?.roles).toEqual(["general", "explore"]);
    expect(minimal?.tools?.sort()).toEqual(["read_file", "run_command"]);
  });
});

describe("session recovery endpoints", () => {
  it("recovers an interrupted session and exposes/discards queued prompts", async () => {
    const filePath = path.join(sessionsDir, "recovery.jsonl");
    const store = await SessionStore.create(filePath, sessionsDir);
    await store.appendTurnStart({ turnId: "t1", text: "hello" });
    await store.appendMessage({ role: "user", content: "hello" });
    await store.appendQueuedPrompt("q1", "send later");
    await store.appendCompactionStarted({ compactionId: "c1", reason: "manual" });
    await store.close();

    const switched = await fetch(`${baseUrl}/session/switch`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ filePath }),
    });
    expect(switched.status).toBe(200);

    const current = (await (
      await fetch(`${baseUrl}/session`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as {
      lastTurn: { status: string };
      recoveredPrompts: Array<{ id: string; text: string }>;
      approvalMode: string;
    };
    expect(current.lastTurn.status).toBe("interrupted");
    expect(current.recoveredPrompts).toEqual([{ id: "q1", text: "send later" }]);
    expect(current.approvalMode).toBe("auto");

    const messages = (await (
      await fetch(`${baseUrl}/session/messages`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as {
      compactions: Array<{ messageIndex: number; status: string }>;
      compactionQuality: unknown;
    };
    expect(messages.compactions).toEqual([{ messageIndex: 1, status: "interrupted" }]);
    // 没有压缩质量观测时字段显式为 null（前端据此显示「—」）
    expect(messages.compactionQuality).toBeNull();

    const discard = await fetch(`${baseUrl}/session/recovered/discard`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "q1" }),
    });
    expect(discard.status).toBe(200);

    const after = (await (
      await fetch(`${baseUrl}/session`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as { recoveredPrompts: unknown[] };
    expect(after.recoveredPrompts).toEqual([]);
  });
});

type SsePayload = Record<string, unknown> & {
  type?: string;
  seq?: number;
  lastSeq?: number;
  reason?: string;
};

async function* readSse(response: Response): AsyncGenerator<SsePayload> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          try {
            yield JSON.parse(line.slice(5).trim()) as SsePayload;
          } catch {
            // Ignore malformed frames.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function nextSse(
  stream: AsyncGenerator<SsePayload>,
  timeoutMs = 3000,
): Promise<SsePayload | null> {
  return Promise.race([
    stream.next().then((result) => (result.done ? null : result.value)),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

describe("SSE sequencing and replay", () => {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    accept: "text/event-stream",
  };

  it("assigns ids, replays missed events, and resyncs after a gap", async () => {
    await fetch(`${baseUrl}/session/new`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ cwd: sessionsDir }),
    });
    // 先写标题：避免首条消息触发后台标题生成，让测试只留下本轮事件
    await fetch(`${baseUrl}/session/title`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "SSE test" }),
    });

    const liveController = new AbortController();
    const liveResponse = await fetch(`${baseUrl}/event`, {
      headers,
      signal: liveController.signal,
    });
    const live = readSse(liveResponse);
    expect((await nextSse(live))?.type).toBe("server.connected");

    await fetch(`${baseUrl}/session/prompt`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "sse test" }),
    });
    await fetch(`${baseUrl}/session/abort`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    let startSeq: number | undefined;
    let endSeq: number | undefined;
    for (let index = 0; index < 20; index += 1) {
      const event = await nextSse(live);
      if (!event) break;
      if (event.type === "message_start" && typeof event.seq === "number") startSeq = event.seq;
      if (event.type === "turn_complete" && typeof event.seq === "number") {
        endSeq = event.seq;
        break;
      }
    }
    liveController.abort();
    await live.return(undefined).catch(() => undefined);
    expect(startSeq).toBeGreaterThan(0);
    expect(endSeq).toBeGreaterThan(startSeq ?? 0);

    // 从 message_start 之后重连：补发 turn_complete，但不重复已有事件
    const replayController = new AbortController();
    const replayResponse = await fetch(`${baseUrl}/event`, {
      headers: { ...headers, "last-event-id": String(startSeq) },
      signal: replayController.signal,
    });
    const replay = readSse(replayResponse);
    expect((await nextSse(replay))?.type).toBe("server.connected");
    let replayedStart = false;
    let replayedEnd = false;
    for (let index = 0; index < 20; index += 1) {
      const event = await nextSse(replay);
      if (!event) break;
      if (event.type === "message_start") replayedStart = true;
      if (event.type === "turn_complete") {
        replayedEnd = true;
        break;
      }
    }
    replayController.abort();
    await replay.return(undefined).catch(() => undefined);
    expect(replayedStart).toBe(false);
    expect(replayedEnd).toBe(true);

    // 序号比服务端还大（重启）：要求全量重同步
    const gapController = new AbortController();
    const gapResponse = await fetch(`${baseUrl}/event`, {
      headers: { ...headers, "last-event-id": "999999" },
      signal: gapController.signal,
    });
    const gap = readSse(gapResponse);
    expect((await nextSse(gap))?.type).toBe("server.connected");
    let resync: SsePayload | null = null;
    for (let index = 0; index < 5; index += 1) {
      const event = await nextSse(gap);
      if (!event) break;
      if (event.type === "server.resync") {
        resync = event;
        break;
      }
    }
    gapController.abort();
    await gap.return(undefined).catch(() => undefined);
    expect(resync?.reason).toBe("restart");
    expect(typeof resync?.lastSeq).toBe("number");
  });
});

describe("subagent endpoints", () => {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };

  it("exposes summaries and only serves transcripts under the active parent", async () => {
    const parentFile = path.join(sessionsDir, `subagent-parent-${randomUUID()}.jsonl`);
    const parent = await SessionStore.create(parentFile, sessionsDir);
    const agentId = randomUUID();
    await parent.appendSubagent({
      agentId,
      callId: "task-1",
      description: "Inspect the repo",
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    });
    await parent.close();

    const switched = await fetch(`${baseUrl}/session/switch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath: parentFile }),
    });
    expect(switched.status).toBe(200);

    const child = await SessionStore.create(
      path.join(sessionsDir, "subagents", parent.id, `${agentId}.jsonl`),
      sessionsDir,
      {
        id: agentId,
        parentSessionId: parent.id,
        rootSessionId: parent.id,
        agentKind: "subagent",
        parentCallId: "task-1",
        description: "Inspect the repo",
      },
    );
    await child.appendTurnStart({ turnId: "t1", text: "inspect" });
    await child.appendMessage({ role: "user", content: "inspect" });
    await child.appendMessage({ role: "assistant", content: "done inspecting" });
    await child.appendTurnEnd({ turnId: "t1", status: "completed" });
    await child.close();

    const current = (await (
      await fetch(`${baseUrl}/session`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as {
      id: string;
      subagents: Array<{ agentId: string; callId: string; status: string }>;
    };
    expect(current.id).toBe(parent.id);
    expect(current.subagents).toMatchObject([
      { agentId, callId: "task-1", status: "completed", description: "Inspect the repo" },
    ]);

    const transcript = await fetch(`${baseUrl}/session/subagents/${agentId}/messages`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toMatchObject({
      agentId,
      parentSessionId: parent.id,
      callId: "task-1",
      description: "Inspect the repo",
      status: "completed",
      messages: [
        { role: "user", content: "inspect" },
        { role: "assistant", content: "done inspecting" },
      ],
    });

    const invalid = await fetch(`${baseUrl}/session/subagents/not-a-uuid/messages`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(invalid.status).toBe(400);

    const otherAgent = randomUUID();
    const other = await SessionStore.create(
      path.join(sessionsDir, "subagents", randomUUID(), `${otherAgent}.jsonl`),
      sessionsDir,
      {
        id: otherAgent,
        parentSessionId: randomUUID(),
        agentKind: "subagent",
        parentCallId: "task-other",
        description: "Other parent",
      },
    );
    await other.close();
    const foreign = await fetch(`${baseUrl}/session/subagents/${otherAgent}/messages`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(foreign.status).toBe(404);

    const missingAbort = await fetch(
      `${baseUrl}/session/subagents/${randomUUID()}/abort`,
      {
        method: "POST",
        headers,
        body: "{}",
      },
    );
    expect(missingAbort.status).toBe(409);

    const missingPrompt = await fetch(
      `${baseUrl}/session/subagents/${randomUUID()}/prompt`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "continue" }),
      },
    );
    expect(missingPrompt.status).toBe(404);

    const deleted = await fetch(`${baseUrl}/sessions/delete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath: parentFile }),
    });
    expect(deleted.status).toBe(200);
    await expect(stat(path.join(sessionsDir, "subagents", parent.id))).rejects.toThrow();
  });
});

describe("session management", () => {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };

  type CreatedSession = {
    id: string;
    filePath: string;
    cwd: string;
    createdAt: string;
  };

  async function newSession(): Promise<CreatedSession> {
    const response = await fetch(`${baseUrl}/session/new`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: sessionsDir }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as CreatedSession;
  }

  it("renames, branches, and deletes session files", async () => {
    const source = await newSession();

    const renamed = await fetch(`${baseUrl}/sessions/title`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ filePath: source.filePath, title: "主线" }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ title: "主线" });
    const listed = (await (
      await fetch(`${baseUrl}/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as { sessions: Array<{ filePath: string; title: string | null }> };
    expect(listed.sessions.find((item) => item.filePath === source.filePath)?.title).toBe("主线");

    const branchResponse = await fetch(`${baseUrl}/sessions/branch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath: source.filePath }),
    });
    expect(branchResponse.status).toBe(200);
    const branch = (await branchResponse.json()) as CreatedSession;
    expect(branch.id).not.toBe(source.id);
    expect(branch.filePath).not.toBe(source.filePath);
    const branchStore = await SessionStore.load(branch.filePath);
    expect(branchStore.id).toBe(branch.id);
    expect(branchStore.title).toBe("主线（分支）");
    const current = (await (
      await fetch(`${baseUrl}/session`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as { id: string };
    expect(current.id).toBe(branch.id);

    const deleted = await fetch(`${baseUrl}/sessions/delete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath: branch.filePath }),
    });
    expect(deleted.status).toBe(200);
    await expect(SessionStore.load(branch.filePath)).rejects.toThrow();
    const next = (await (
      await fetch(`${baseUrl}/session`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as { id: string; cwd: string };
    expect(next.id).not.toBe(branch.id);
    expect(next.cwd).toBe(sessionsDir);
  });

  it("rejects session paths outside the sessions directory", async () => {
    const outside = path.join(sessionsDir, "..", "evil.jsonl");
    const response = await fetch(`${baseUrl}/sessions/title`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ filePath: outside, title: "越界" }),
    });
    expect(response.status).toBe(400);
    const switched = await fetch(`${baseUrl}/session/switch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath: outside }),
    });
    expect(switched.status).toBe(400);
  });

  it("searches session content and cleans the shadow index on delete", async () => {
    const filePath = path.join(sessionsDir, "searchable.jsonl");
    const store = await SessionStore.create(filePath, sessionsDir);
    await store.appendMessage({ role: "user", content: "珊瑚绒毯的清洗指南" });
    await store.appendMessage({ role: "assistant", content: "珊瑚绒毯要用冷水手洗。" });
    await store.close();

    const authed = { authorization: `Bearer ${TOKEN}` };

    const hit = await fetch(`${baseUrl}/sessions/search?q=${encodeURIComponent("珊瑚绒毯")}`, {
      headers: authed,
    });
    expect(hit.status).toBe(200);
    const hitBody = (await hit.json()) as {
      hits: Array<{ filePath: string; totalMatches: number; snippets: unknown[] }>;
    };
    expect(hitBody.hits).toHaveLength(1);
    expect(hitBody.hits[0].filePath).toBe(filePath);
    expect(hitBody.hits[0].totalMatches).toBe(2);
    expect(hitBody.hits[0].snippets.length).toBeGreaterThan(0);

    const empty = await fetch(`${baseUrl}/sessions/search?q=`, { headers: authed });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { hits: unknown[] }).hits).toEqual([]);

    const tooLong = await fetch(`${baseUrl}/sessions/search?q=${encodeURIComponent("长".repeat(201))}`, {
      headers: authed,
    });
    expect(tooLong.status).toBe(400);

    const clamped = await fetch(
      `${baseUrl}/sessions/search?q=${encodeURIComponent("珊瑚绒毯")}&limit=999`,
      { headers: authed },
    );
    expect(clamped.status).toBe(200);

    // 等首次搜索的异步影子落盘，确认存在后再验证删除联动
    const shadowPath = searchIndexPath(sessionsDir, path.basename(filePath));
    let shadowExists = false;
    for (let attempt = 0; attempt < 40 && !shadowExists; attempt += 1) {
      shadowExists = await stat(shadowPath).then(
        () => true,
        () => false,
      );
      if (!shadowExists) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(shadowExists).toBe(true);

    const deleted = await fetch(`${baseUrl}/sessions/delete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath }),
    });
    expect(deleted.status).toBe(200);
    await expect(stat(shadowPath)).rejects.toThrow();
  });
});

describe("session mode endpoints", () => {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };

  it("accepts plan/goal on main and side mode routes and rejects unknown values", async () => {
    for (const route of ["/session/mode", "/side/session/mode"]) {
      for (const mode of ["plan", "goal", "default"]) {
        const response = await fetch(`${baseUrl}${route}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ mode }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ mode });
      }
      const invalid = await fetch(`${baseUrl}${route}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ mode: "bogus" }),
      });
      expect(invalid.status).toBe(400);
    }
  });

  it("exports a session as markdown, html and json", async () => {
    const created = await fetch(`${baseUrl}/session/new`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: sessionsDir }),
    });
    expect(created.status).toBe(200);
    const { filePath } = (await created.json()) as { filePath: string };
    // 造一条内容：用户消息 + assistant 回复 + turn 收尾（走真实 HTTP 会触发模型，这里直接写文件）
    const store = await SessionStore.load(filePath);
    try {
      await store.appendTurnStart({ turnId: "t1", providerId: "p1", model: "m" });
      await store.appendMessage({ role: "user", content: "导出测试的问题" });
      await store.appendMessage({ role: "assistant", content: "导出测试的回答" });
      await store.appendTurnEnd({ turnId: "t1", status: "completed" });
      await store.flush();
    } finally {
      await store.close();
    }

    const markdown = await fetch(`${baseUrl}/session/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath, format: "markdown" }),
    });
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    const markdownText = await markdown.text();
    expect(markdownText).toContain("> 导出测试的问题");
    expect(markdownText).toContain("导出测试的回答");

    const html = await fetch(`${baseUrl}/session/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath, format: "html" }),
    });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("<!doctype html>");

    const json = await fetch(`${baseUrl}/session/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath, format: "json" }),
    });
    expect(json.status).toBe(200);
    expect(((await json.json()) as { format: string }).format).toBe("meowcode.session.export");
  });

  it("rejects an export path outside the sessions dir", async () => {
    const response = await fetch(`${baseUrl}/session/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filePath: path.join(sessionsDir, "..", "evil.jsonl") }),
    });
    expect(response.status).toBe(400);
  });

  it("exposes the session mode on GET /session and persists it", async () => {
    const created = await fetch(`${baseUrl}/session/new`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: sessionsDir }),
    });
    expect(created.status).toBe(200);

    const put = await fetch(`${baseUrl}/session/mode`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ mode: "plan" }),
    });
    expect(await put.json()).toEqual({ mode: "plan" });

    const current = (await (
      await fetch(`${baseUrl}/session`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as { mode: string };
    expect(current.mode).toBe("plan");
  });
});

describe("prompt attachments (PDF)", () => {
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const pdf = { mimeType: "application/pdf", data: "UERG", name: "r.pdf" };

  async function post(body: Record<string, unknown>) {
    await fetch(`${baseUrl}/session/new`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: sessionsDir }),
    });
    return fetch(`${baseUrl}/session/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("rejects a PDF when the model has no pdf modality", async () => {
    const response = await post({ message: "read it", documents: [pdf] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "pdf_disabled" } });
  });

  it("accepts a PDF-only prompt shape up to the attachment limit", async () => {
    // 上限内但缺文件内容以外的字段仍应通过"非空"校验（这里卡在 pdf_disabled 之前）
    const response = await post({ message: "", documents: [pdf] });
    expect(response.status).toBe(400);
    // 空文本 + 有附件是合法输入，因此失败原因只可能是模态门禁
    expect(await response.json()).toMatchObject({ error: { code: "pdf_disabled" } });
  });

  it("rejects oversized prompt text before starting a turn", async () => {
    const response = await post({ message: "x".repeat(1_000_001) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "prompt_too_large" } });
  });

  it("rejects unsupported document types", async () => {
    const response = await post({
      message: "hi",
      documents: [{ mimeType: "video/mp4", data: "AAAA", name: "clip.mp4" }],
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("invalid_request");
    expect(payload.error.message).toContain("PDF only");
  });

  it("rejects too many documents in one message", async () => {
    const response = await post({
      message: "hi",
      documents: [pdf, { ...pdf, name: "b.pdf" }, { ...pdf, name: "c.pdf" }],
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toContain("at most 2 documents");
  });
});

/** git 是否可用：没装 git 的机器跳过整个路由用例（模块顶层才能用 await）。 */
const gitAvailable = await (await import("../git/git.js")).isGitAvailable();

describe("git routes", () => {
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  let repo = "";

  const describeGit = gitAvailable ? describe : describe.skip;

  /** git 命令在 Windows 上偏慢，并行跑时放宽超时 */
  const slow = (name: string, fn: () => Promise<void>, timeout = 30_000) => it(name, fn, timeout);

  describeGit("with a real repository", () => {
    beforeAll(async () => {
      const { runGit } = await import("../git/git.js");
      repo = await mkdtemp(path.join(tmpdir(), "meowcode-server-git-"));
      process.env.GIT_AUTHOR_NAME = "MeowCode Test";
      process.env.GIT_AUTHOR_EMAIL = "test@example.com";
      process.env.GIT_COMMITTER_NAME = "MeowCode Test";
      process.env.GIT_COMMITTER_EMAIL = "test@example.com";
      await runGit(repo, ["init", "-q"]).catch(async () => {
        await runGit(repo, ["init", "-q"]);
      });
      await fetch(`${baseUrl}/session/new`, {
        method: "POST",
        headers,
        body: JSON.stringify({ cwd: repo }),
      });
    });

    afterAll(async () => {
      delete process.env.GIT_AUTHOR_NAME;
      delete process.env.GIT_AUTHOR_EMAIL;
      delete process.env.GIT_COMMITTER_NAME;
      delete process.env.GIT_COMMITTER_EMAIL;
      if (repo) await rm(repo, { recursive: true, force: true });
    });

    slow("reports status, stages a file and commits it", async () => {
      await writeFile(path.join(repo, "a.txt"), "hello\n", "utf8");

      const status = await fetch(`${baseUrl}/git/status`, { headers });
      expect(status.status).toBe(200);
      const body = (await status.json()) as {
        isRepo: boolean;
        unstaged: Array<{ path: string; worktree: string }>;
        staged: unknown[];
      };
      expect(body.isRepo).toBe(true);
      expect(body.unstaged).toMatchObject([{ path: "a.txt", worktree: "untracked" }]);

      const diff = await fetch(`${baseUrl}/git/diff?path=a.txt&scope=worktree`, { headers });
      expect(diff.status).toBe(200);
      expect(((await diff.json()) as { patch: string }).patch).toContain("+hello");

      const staged = await fetch(`${baseUrl}/git/stage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ paths: ["a.txt"] }),
      });
      expect(staged.status).toBe(200);

      const afterStage = (await (await fetch(`${baseUrl}/git/status`, { headers })).json()) as {
        staged: Array<{ path: string; index: string }>;
        unstaged: unknown[];
      };
      expect(afterStage.staged).toMatchObject([{ path: "a.txt", index: "added" }]);
      expect(afterStage.unstaged).toEqual([]);

      const committed = await fetch(`${baseUrl}/git/commit`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "feat: add a" }),
      });
      expect(committed.status).toBe(200);
      const created = (await committed.json()) as { sha: string; subject: string };
      expect(created.subject).toBe("feat: add a");

      const log = (await (await fetch(`${baseUrl}/git/log?limit=5`, { headers })).json()) as {
        commits: Array<{ sha: string; subject: string }>;
      };
      expect(log.commits[0]).toMatchObject({ sha: created.sha, subject: "feat: add a" });

      const detail = await fetch(`${baseUrl}/git/commit?sha=${created.sha}`, { headers });
      expect(detail.status).toBe(200);
      const shown = (await detail.json()) as { files: Array<{ path: string }> };
      expect(shown.files.map((file) => file.path)).toEqual(["a.txt"]);

      const branches = (await (await fetch(`${baseUrl}/git/branches`, { headers })).json()) as {
        branches: Array<{ name: string; current: boolean }>;
      };
      expect(branches.branches.some((branch) => branch.current)).toBe(true);
    });

    slow("rejects path traversal attempts", async () => {
      const response = await fetch(`${baseUrl}/git/stage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ paths: ["../outside.txt"] }),
      });
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("invalid_path");
    });

    slow("fails commit-message gracefully when the model endpoint is unreachable", async () => {
      const response = await fetch(`${baseUrl}/git/commit-message`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      // provider 指向 127.0.0.1:1：生成失败必须是 502，而不是把回合打挂
      expect(response.status).toBe(502);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("commit_message_failed");
    }, 45_000);
  });

  slow("returns isRepo:false for a non-repository workspace", async () => {
    await fetch(`${baseUrl}/session/new`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: sessionsDir }),
    });
    const response = await fetch(`${baseUrl}/git/status`, { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { isRepo: boolean; reason?: string };
    expect(body.isRepo).toBe(false);
    expect(body.reason).toBe("not_a_repo");

    // 其余端点在没有仓库时返回 409，而不是 500
    const stage = await fetch(`${baseUrl}/git/stage`, {
      method: "POST",
      headers,
      body: JSON.stringify({ paths: ["a.txt"] }),
    });
    expect(stage.status).toBe(409);
  });
});

describe("prompt polish", () => {
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const post = (body: unknown) =>
    fetch(`${baseUrl}/prompt/polish`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  it("rejects empty text", async () => {
    const response = await post({ text: "   " });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_request");
  });

  it("rejects oversized text", async () => {
    const response = await post({ text: "x".repeat(MAX_POLISH_INPUT_CHARS + 1) });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_request");
  });

  it("rejects a non-boolean side flag", async () => {
    const response = await post({ text: "修复登录", side: "yes" });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_request");
  });

  it("fails gracefully when the model endpoint is unreachable", async () => {
    const response = await post({ text: "修复登录" });
    // provider 指向 127.0.0.1:1：模型失败必须是 502，而不是把路由打挂
    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("prompt_polish_failed");
  }, 45_000);
});

describe("memory routes", () => {
  it("manages memories in both scopes for a given cwd", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-memory-ws-"));
    const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    try {
      const put = await fetch(`${baseUrl}/memory/file`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({
          scope: "project",
          name: "build-setup",
          content: "---\ndescription: 构建走 pnpm\ncreated: 2026-10-25\n---\n用 pnpm。",
          cwd: workspace,
        }),
      });
      expect(put.status).toBe(200);

      const putUser = await fetch(`${baseUrl}/memory/file`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({
          scope: "user",
          name: "user-pref",
          content: "---\ndescription: 用户偏好\ncreated: 2026-10-25\n---\n偏好简洁回复。",
          cwd: workspace,
        }),
      });
      expect(putUser.status).toBe(200);

      const list = (await (
        await fetch(`${baseUrl}/memory?cwd=${encodeURIComponent(workspace)}`, { headers: auth })
      ).json()) as {
        user: Array<{ name: string; description: string }>;
        project: Array<{ name: string; description: string }>;
      };
      expect(list.user.map((item) => item.name)).toEqual(["user-pref"]);
      expect(list.project.map((item) => item.name)).toEqual(["build-setup"]);
      expect(list.project[0].description).toBe("构建走 pnpm");

      const file = (await (
        await fetch(
          `${baseUrl}/memory/file?scope=project&name=build-setup&cwd=${encodeURIComponent(workspace)}`,
          { headers: auth },
        )
      ).json()) as { content: string };
      expect(file.content).toContain("pnpm");

      const remove = await fetch(
        `${baseUrl}/memory/file?scope=project&name=build-setup&cwd=${encodeURIComponent(workspace)}`,
        { method: "DELETE", headers: auth },
      );
      expect(remove.status).toBe(200);
      const again = await fetch(
        `${baseUrl}/memory/file?scope=project&name=build-setup&cwd=${encodeURIComponent(workspace)}`,
        { method: "DELETE", headers: auth },
      );
      expect(again.status).toBe(404);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("clears each memory scope independently", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-memory-ws-"));
    const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    try {
      for (const [scope, name] of [
        ["user", "clear-user"],
        ["project", "clear-project"],
      ] as const) {
        const put = await fetch(`${baseUrl}/memory/file`, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({
            scope,
            name,
            content: "---\ndescription: 清空测试\n---\n内容",
            cwd: workspace,
          }),
        });
        expect(put.status).toBe(200);
      }

      const missingScope = await fetch(`${baseUrl}/memory?cwd=${encodeURIComponent(workspace)}`, {
        method: "DELETE",
        headers: auth,
      });
      expect(missingScope.status).toBe(400);
      expect(((await missingScope.json()) as { error: { code: string } }).error.code).toBe(
        "invalid_scope",
      );

      const clearedProject = await fetch(
        `${baseUrl}/memory?scope=project&cwd=${encodeURIComponent(workspace)}`,
        { method: "DELETE", headers: auth },
      );
      expect(clearedProject.status).toBe(200);
      const projectBody = (await clearedProject.json()) as { scope: string; cleared: number };
      expect(projectBody.scope).toBe("project");
      expect(projectBody.cleared).toBe(1);

      const afterProject = (await (
        await fetch(`${baseUrl}/memory?cwd=${encodeURIComponent(workspace)}`, { headers: auth })
      ).json()) as { user: Array<{ name: string }>; project: unknown[] };
      expect(afterProject.project).toEqual([]);
      expect(afterProject.user.some((item) => item.name === "clear-user")).toBe(true);

      const clearedUser = await fetch(
        `${baseUrl}/memory?scope=user&cwd=${encodeURIComponent(workspace)}`,
        { method: "DELETE", headers: auth },
      );
      expect(clearedUser.status).toBe(200);
      const userBody = (await clearedUser.json()) as { scope: string; cleared: number };
      expect(userBody.scope).toBe("user");
      // 用户层是测试进程的临时 home，可能已有别的用例写入的条目；只要求至少清掉本次这条
      expect(userBody.cleared).toBeGreaterThanOrEqual(1);

      const afterUser = (await (
        await fetch(`${baseUrl}/memory?cwd=${encodeURIComponent(workspace)}`, { headers: auth })
      ).json()) as { user: unknown[]; project: unknown[] };
      expect(afterUser.user).toEqual([]);
      expect(afterUser.project).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects invalid scope and name", async () => {
    const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-memory-ws-"));
    try {
      const scope = await fetch(`${baseUrl}/memory/file`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ scope: "global", name: "x", content: "c", cwd: workspace }),
      });
      expect(scope.status).toBe(400);
      expect(((await scope.json()) as { error: { code: string } }).error.code).toBe("invalid_scope");

      const name = await fetch(`${baseUrl}/memory/file`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ scope: "project", name: "../evil", content: "c", cwd: workspace }),
      });
      expect(name.status).toBe(400);
      expect(((await name.json()) as { error: { code: string } }).error.code).toBe("invalid_name");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
