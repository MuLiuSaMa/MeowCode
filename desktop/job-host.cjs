/**
 * agent 后台任务控制面：loopback HTTP + token，只暴露终端管理器的安全子集。
 * 参考 browser-host 范式（MEOWCODE_BROWSER_HOST）：agent server 通过 env 拿到
 * baseUrl/token 后直接调用；渲染层仍走 IPC（meow:term-*），两边共享同一 PTY。
 */
const http = require("node:http");
const crypto = require("node:crypto");

const MAX_BODY_BYTES = 256 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

/**
 * @param {{
 *   terminals: ReturnType<import("./terminals.cjs").registerTerminalIpc>,
 *   notify?: (event: { type: string; id?: string; command?: string; [key: string]: unknown }) => void,
 *   token?: string,
 * }} options
 */
function createJobHost({ terminals, notify = () => {}, token = crypto.randomBytes(24).toString("hex") }) {
  let server = null;
  let baseUrl = "";

  const send = (response, status, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  };

  const handle = async (request, response) => {
    if (request.headers["x-meow-job-token"] !== token) {
      send(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/job/start" && request.method === "POST") {
        const body = await readBody(request);
        const command = typeof body.command === "string" ? body.command.trim() : "";
        if (!command) {
          send(response, 400, { error: "command is required" });
          return;
        }
        const started = terminals.createSession({
          command,
          ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
          ...(body.cols !== undefined ? { cols: body.cols } : {}),
          ...(body.rows !== undefined ? { rows: body.rows } : {}),
        });
        notify({ type: "start", id: started.id, command });
        send(response, 200, started);
        return;
      }
      if (url.pathname === "/job/read" && request.method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        const offset = url.searchParams.get("offset");
        const result = terminals.readSession(id, offset === null ? undefined : Number(offset));
        if (!result) {
          send(response, 404, { error: "job not found" });
          return;
        }
        send(response, 200, result);
        return;
      }
      if (url.pathname === "/job/attach" && request.method === "GET") {
        const result = terminals.attachSession(url.searchParams.get("id") ?? "");
        if (!result) {
          send(response, 404, { error: "job not found" });
          return;
        }
        send(response, 200, result);
        return;
      }
      if (url.pathname === "/job/input" && request.method === "POST") {
        const body = await readBody(request);
        if (typeof body.id !== "string" || typeof body.data !== "string") {
          send(response, 400, { error: "id and data are required" });
          return;
        }
        terminals.writeSession(body.id, body.data);
        send(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/job/resize" && request.method === "POST") {
        const body = await readBody(request);
        if (typeof body.id !== "string") {
          send(response, 400, { error: "id is required" });
          return;
        }
        terminals.resizeSession(body.id, body.cols, body.rows);
        send(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/job/kill" && request.method === "POST") {
        const body = await readBody(request);
        if (typeof body.id !== "string") {
          send(response, 400, { error: "id is required" });
          return;
        }
        terminals.killSession(body.id);
        notify({ type: "kill", id: body.id });
        send(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/job/list" && request.method === "GET") {
        send(response, 200, { jobs: terminals.listSessions() });
        return;
      }
      send(response, 404, { error: "not found" });
    } catch (error) {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  return {
    token,
    get baseUrl() {
      return baseUrl;
    },
    async start() {
      if (server) return baseUrl;
      server = http.createServer((request, response) => {
        void handle(request, response);
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(undefined));
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      return baseUrl;
    },
    close() {
      const current = server;
      server = null;
      baseUrl = "";
      if (current) current.close(() => undefined);
    },
  };
}

module.exports = { createJobHost };
