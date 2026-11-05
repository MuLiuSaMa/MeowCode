#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveLiveCanvasConfig } from "./live-canvas-config.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  "../assets/canvas-editor-template.html"
);
const EXPORT_CLIENT_TTL_MS = 5_000;
const EXPORT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BODY_BYTES) {
      const error = new Error("请求体超过 25MB 限制");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求体不是有效 JSON");
    error.statusCode = 400;
    throw error;
  }
}

function isScene(value) {
  return (
    value &&
    typeof value === "object" &&
    value.type === "excalidraw" &&
    Array.isArray(value.elements) &&
    value.appState &&
    typeof value.appState === "object" &&
    value.files &&
    typeof value.files === "object"
  );
}

function resolveWorkbenchBackend(value) {
  const params = new URLSearchParams({
    mode: "workbench",
    backend: value
  });
  return resolveLiveCanvasConfig(`?${params.toString()}`).httpOrigin;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`无效的 Workbench 端口：${value}`);
  }
  return port;
}

export async function createWorkbenchServer({
  port = 4174,
  backend = "http://127.0.0.1:3000",
  templatePath = DEFAULT_TEMPLATE_PATH
} = {}) {
  const resolvedPort = parsePort(port);
  const resolvedBackend = resolveWorkbenchBackend(backend);
  const template = await readFile(templatePath);
  const exportClients = new Map();
  const pendingExports = new Map();

  const pruneExportClients = () => {
    const oldestAllowed = Date.now() - EXPORT_CLIENT_TTL_MS;
    for (const [clientId, lastSeen] of exportClients) {
      if (lastSeen < oldestAllowed) {
        exportClients.delete(clientId);
      }
    }
  };

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(
      request.url || "/",
      "http://127.0.0.1"
    );

    try {
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/scene-export/client"
      ) {
        const clientId = randomUUID();
        exportClients.set(clientId, Date.now());
        sendJson(response, 200, { clientId });
        return;
      }

      if (
        request.method === "DELETE" &&
        requestUrl.pathname === "/api/scene-export/client"
      ) {
        const clientId = requestUrl.searchParams.get("clientId");
        if (clientId) {
          exportClients.delete(clientId);
        }
        sendJson(response, 200, { success: true });
        return;
      }

      if (
        request.method === "GET" &&
        requestUrl.pathname === "/api/scene-export/request"
      ) {
        pruneExportClients();
        const clientId = requestUrl.searchParams.get("clientId");
        if (!clientId || !exportClients.has(clientId)) {
          sendJson(response, 404, {
            error: "Workbench browser client is not registered"
          });
          return;
        }
        exportClients.set(clientId, Date.now());
        const pending = [...pendingExports.values()].find(
          (entry) => entry.clientId === clientId
        );
        if (!pending) {
          response.writeHead(204, {
            "Cache-Control": "no-store"
          });
          response.end();
          return;
        }
        sendJson(response, 200, { requestId: pending.requestId });
        return;
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/scene-export/result"
      ) {
        const body = await readJsonBody(request);
        const pending = pendingExports.get(body.requestId);
        if (
          !pending ||
          pending.clientId !== body.clientId ||
          !exportClients.has(body.clientId)
        ) {
          sendJson(response, 404, {
            error: "Scene export request is no longer active"
          });
          return;
        }
        if (typeof body.error === "string" && body.error) {
          clearTimeout(pending.timeout);
          pendingExports.delete(pending.requestId);
          const error = new Error(body.error);
          error.statusCode = 500;
          pending.reject(error);
          sendJson(response, 200, { success: true });
          return;
        }
        if (!isScene(body.scene)) {
          sendJson(response, 400, {
            error: "Workbench returned an invalid Excalidraw scene"
          });
          return;
        }
        clearTimeout(pending.timeout);
        pendingExports.delete(pending.requestId);
        pending.resolve(body.scene);
        sendJson(response, 200, { success: true });
        return;
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/scene-export"
      ) {
        pruneExportClients();
        const clients = [...exportClients.keys()];
        if (clients.length === 0) {
          sendJson(response, 503, {
            code: "BROWSER_REQUIRED",
            error: "Open exactly one Whiteboard Workbench tab before browser export"
          });
          return;
        }
        if (clients.length > 1) {
          sendJson(response, 409, {
            code: "AMBIGUOUS_BROWSER_CLIENT",
            error: "Close extra Whiteboard Workbench tabs before browser export"
          });
          return;
        }
        const clientId = clients[0];
        if (
          [...pendingExports.values()].some(
            (entry) => entry.clientId === clientId
          )
        ) {
          sendJson(response, 409, {
            code: "EXPORT_IN_PROGRESS",
            error: "A Workbench scene export is already in progress"
          });
          return;
        }

        const requestId = randomUUID();
        const scenePromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingExports.delete(requestId);
            const error = new Error(
              "Workbench browser scene export timed out"
            );
            error.statusCode = 504;
            reject(error);
          }, EXPORT_REQUEST_TIMEOUT_MS);
          pendingExports.set(requestId, {
            clientId,
            requestId,
            resolve,
            reject,
            timeout
          });
        });
        const scene = await scenePromise;
        sendJson(response, 200, scene);
        return;
      }

      if (
        requestUrl.pathname.startsWith("/api/scene-export")
      ) {
        response.writeHead(405, {
          Allow: "GET, POST, DELETE"
        });
        response.end();
        return;
      }

    if (
      request.method !== "GET" &&
      request.method !== "HEAD"
    ) {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    if (requestUrl.pathname === "/favicon.ico") {
      response.writeHead(204, {
        "Cache-Control": "no-store"
      });
      response.end();
      return;
    }
    if (
      requestUrl.pathname !== "/" &&
      requestUrl.pathname !== "/canvas-editor-template.html"
    ) {
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : template);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, {
          error: error.message
        });
      } else {
        response.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(resolvedPort, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法确定 Workbench 地址");
  }
  const params = new URLSearchParams({
    mode: "workbench",
    backend: resolvedBackend
  });
  const url =
    `http://127.0.0.1:${address.port}/?${params.toString()}`;

  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        for (const pending of pendingExports.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("Whiteboard Workbench is closing"));
        }
        pendingExports.clear();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    if (argument === "--port") {
      options.port = argv[++index];
      continue;
    }
    if (argument === "--backend") {
      options.backend = argv[++index];
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage:
  node scripts/serve-canvas-workbench.mjs [--port 4174] [--backend http://127.0.0.1:3000]`);
    return;
  }

  const workbench = await createWorkbenchServer(options);
  console.log(`Whiteboard Workbench: ${workbench.url}`);

  const close = async () => {
    await workbench.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
