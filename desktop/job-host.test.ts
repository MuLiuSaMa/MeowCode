import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createJobHost } = require("../desktop/job-host.cjs") as {
  createJobHost: (options: {
    terminals: Record<string, (...args: never[]) => unknown>;
    notify?: (event: Record<string, unknown>) => void;
    token?: string;
  }) => {
    token: string;
    baseUrl: string;
    start(): Promise<string>;
    close(): void;
  };
};

function fakeTerminals() {
  const sessions = new Map<string, { buffer: string; exited: boolean; command: string }>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let seq = 0;
  return {
    calls,
    createSession(options: { command?: string }) {
      seq += 1;
      const id = `term-${seq}`;
      sessions.set(id, { buffer: "", exited: false, command: options.command ?? "" });
      calls.push({ method: "create", args: [options] });
      return { id, shell: "pwsh" };
    },
    readSession(id: string, offset?: number) {
      const entry = sessions.get(id);
      if (!entry) return null;
      const start = offset ?? 0;
      return {
        id,
        data: entry.buffer.slice(start),
        offset: entry.buffer.length,
        bufferStart: 0,
        truncated: false,
        exited: entry.exited,
        code: entry.exited ? 0 : null,
      };
    },
    attachSession(id: string) {
      const entry = sessions.get(id);
      if (!entry) return null;
      return { id, data: entry.buffer, offset: entry.buffer.length, exited: entry.exited };
    },
    listSessions() {
      return [...sessions.entries()].map(([id, entry]) => ({
        id,
        command: entry.command,
        exited: entry.exited,
        code: entry.exited ? 0 : null,
      }));
    },
    writeSession(id: string, data: string) {
      const entry = sessions.get(id);
      if (entry) entry.buffer += data;
      calls.push({ method: "write", args: [id, data] });
    },
    resizeSession(id: string, cols: number, rows: number) {
      calls.push({ method: "resize", args: [id, cols, rows] });
    },
    killSession(id: string) {
      sessions.delete(id);
      calls.push({ method: "kill", args: [id] });
    },
  };
}

describe("desktop job host", () => {
  it("token 鉴权与 start/read/list/kill 往返", async () => {
    const terminals = fakeTerminals();
    const events: Array<Record<string, unknown>> = [];
    const host = createJobHost({ terminals, notify: (event) => events.push(event) });
    await host.start();
    try {
      const unauthorized = await fetch(`${host.baseUrl}/job/list`);
      expect(unauthorized.status).toBe(401);

      const headers = { "content-type": "application/json", "x-meow-job-token": host.token };
      const started = (await (
        await fetch(`${host.baseUrl}/job/start`, {
          method: "POST",
          headers,
          body: JSON.stringify({ command: "pnpm dev", cwd: process.cwd() }),
        })
      ).json()) as { id: string };
      expect(started.id).toBe("term-1");
      expect(events[0]).toMatchObject({ type: "start", id: "term-1", command: "pnpm dev" });

      await fetch(`${host.baseUrl}/job/input`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: started.id, data: "hello" }),
      });
      const chunk = (await (
        await fetch(`${host.baseUrl}/job/read?id=${started.id}&offset=0`, { headers })
      ).json()) as { data: string; offset: number };
      expect(chunk.data).toBe("hello");
      expect(chunk.offset).toBe(5);

      const list = (await (await fetch(`${host.baseUrl}/job/list`, { headers })).json()) as {
        jobs: Array<{ id: string; command: string }>;
      };
      expect(list.jobs[0]).toMatchObject({ id: "term-1", command: "pnpm dev" });

      const missing = await fetch(`${host.baseUrl}/job/read?id=nope`, { headers });
      expect(missing.status).toBe(404);

      await fetch(`${host.baseUrl}/job/kill`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: started.id }),
      });
      expect(events.at(-1)).toMatchObject({ type: "kill", id: "term-1" });
    } finally {
      host.close();
    }
  });
});
