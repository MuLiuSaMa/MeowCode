#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANVAS_CAPABILITY_POLICY,
  assertAllowedCanvasCommand
} from "./canvas-capabilities.mjs";

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]"
]);
const DEFAULT_CONTROL_SERVER = "http://127.0.0.1:3000";
const DEFAULT_WORKBENCH_SERVER = "http://127.0.0.1:4174";
const PINNED_CANVAS_CLI = "mcp-excalidraw-server@1.1.0";

export function sanitizeCanvasCliLine(line) {
  if (line.startsWith("Canvas server running at ")) {
    return "Whiteboard control service is ready for the reduced workbench.\n";
  }
  return line;
}

function forwardSanitizedOutput(readable, writable) {
  let pending = "";
  readable.setEncoding("utf8");
  readable.on("data", (chunk) => {
    pending += chunk;
    let newlineIndex = pending.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex + 1);
      pending = pending.slice(newlineIndex + 1);
      writable.write(sanitizeCanvasCliLine(line));
      newlineIndex = pending.indexOf("\n");
    }
  });
  readable.on("end", () => {
    if (pending) {
      writable.write(sanitizeCanvasCliLine(pending));
    }
  });
}

export function assertLoopbackControlUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`无效的画板控制服务地址：${value}`);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("画板控制服务必须使用本机回环地址");
  }
  return url.origin;
}

function parseBrowserExportArgs(args) {
  let out;
  let browser = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--browser") {
      browser = true;
      continue;
    }
    if (argument === "--out") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--out 缺少参数值");
      }
      out = value;
      continue;
    }
    if (argument.startsWith("--out=")) {
      out = argument.slice("--out=".length);
      if (!out) {
        throw new Error("--out 缺少参数值");
      }
      continue;
    }
    throw new Error(`export --browser 不支持参数：${argument}`);
  }
  return { browser, out };
}

function isExcalidrawScene(value) {
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

async function writeSceneAtomically(outputPath, scene) {
  const resolved = path.resolve(outputPath);
  const temporaryPath = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(scene, null, 2)}\n`);
    await rename(temporaryPath, resolved);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return resolved;
}

async function runBrowserExport(args, options, environment) {
  const { out } = parseBrowserExportArgs(args);
  const workbenchOrigin = assertLoopbackControlUrl(
    environment.CANVAS_WORKBENCH_URL || DEFAULT_WORKBENCH_SERVER
  );
  const fetchImplementation = options.fetch || globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("当前 Node.js Runtime 不支持浏览器场景导出");
  }

  const response = await fetchImplementation(
    `${workbenchOrigin}/api/scene-export`,
    { method: "POST" }
  );
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      result?.error || `Workbench 场景导出失败：${response.status}`
    );
    error.exitCode = result?.code === "BROWSER_REQUIRED" ? 4 : 1;
    throw error;
  }
  if (!isExcalidrawScene(result)) {
    const error = new Error("Workbench 返回的 Excalidraw 场景无效");
    error.exitCode = 1;
    throw error;
  }

  const stdout = options.stdout || process.stdout;
  if (!out) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const file = await writeSceneAtomically(out, result);
  stdout.write(
    `${JSON.stringify(
      {
        success: true,
        file,
        elements: result.elements.length,
        source: "browser"
      },
      null,
      2
    )}\n`
  );
  return 0;
}

export function resolveControlEnvironment(args, inputEnvironment) {
  const environment = { ...inputEnvironment };
  const configuredUrl =
    environment.EXPRESS_SERVER_URL || DEFAULT_CONTROL_SERVER;
  environment.EXPRESS_SERVER_URL = assertLoopbackControlUrl(configuredUrl);
  environment.npm_config_cache ||= path.join(
    tmpdir(),
    "canvas-cli-npm-cache"
  );

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--url") {
      assertLoopbackControlUrl(args[index + 1]);
    } else if (argument.startsWith("--url=")) {
      assertLoopbackControlUrl(argument.slice("--url=".length));
    }
  }

  return environment;
}

function printUsage() {
  console.log(`Usage:
  node scripts/canvas-cli.mjs <command> [...args]

Allowed commands:
  ${CANVAS_CAPABILITY_POLICY.agentCommands.join(", ")}

Portable scene export:
  node scripts/canvas-cli.mjs export --browser --out diagram.excalidraw

The wrapper intentionally rejects clear, share, mermaid, and install-skill.`);
}

export async function runCanvasCli(argv, options = {}) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    if (!command) {
      throw new Error("缺少画板命令");
    }
    return 0;
  }

  assertAllowedCanvasCommand(command);
  const executable = options.executable || "npx";
  const prefixArgs = options.prefixArgs || [
    "-y",
    PINNED_CANVAS_CLI
  ];
  const environment = resolveControlEnvironment(
    args,
    options.env || process.env
  );

  if (command === "export" && args.includes("--browser")) {
    return runBrowserExport(args, options, environment);
  }

  return new Promise((resolve, reject) => {
    const useSanitizedOutput = options.stdio === undefined;
    const child = spawn(executable, [...prefixArgs, command, ...args], {
      cwd: options.cwd || process.cwd(),
      env: environment,
      stdio: options.stdio || ["inherit", "pipe", "pipe"]
    });

    if (useSanitizedOutput) {
      forwardSanitizedOutput(
        child.stdout,
        options.stdout || process.stdout
      );
      forwardSanitizedOutput(
        child.stderr,
        options.stderr || process.stderr
      );
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Whiteboard CLI 被信号 ${signal} 终止`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  try {
    const code = await runCanvasCli(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 2;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  void main();
}
