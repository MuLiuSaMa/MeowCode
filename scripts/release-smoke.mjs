import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(import.meta.url);
const release = path.resolve(process.argv[2] || path.join(path.dirname(file), "../desktop/release/win-unpacked"));
const executable = path.join(release, "MeowCode.exe");

// 与生产环境一样使用同一份 Electron Node 运行时，避免 V8 IPC 序列化版本不同。
if (!process.versions.electron) {
  const result = spawnSync(executable, [file, release], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", NODE_PATH: "" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.platform === "win32") {
  const groups = execFileSync(path.join(process.env.SystemRoot, "System32", "whoami.exe"), ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8" });
  if (/S-1-16-(?:0|4096)(?:"|,|\s)/.test(groups)) {
    throw new Error(`Release runs at Low integrity and cannot access normal user data. Restore Medium integrity for ${release} and build from a normal terminal.`);
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "meowcode-release-smoke-"));
let child;
try {
  const runtime = path.join(temp, "agent-server");
  await fs.cp(path.join(release, "resources", "agent-server"), runtime, { recursive: true, dereference: true });
  const pkg = JSON.parse(await fs.readFile(path.join(runtime, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
  const workspace = path.join(temp, "workspace");
  await fs.mkdir(workspace);
  const token = randomBytes(24).toString("hex");
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: process.env.PATH,
    TEMP: temp,
    TMP: temp,
    HOME: temp,
    USERPROFILE: temp,
    ELECTRON_RUN_AS_NODE: "1",
    MEOWCODE_SERVER_TOKEN: token,
    MEOWCODE_SERVER_PORT: "0",
    MEOWCODE_HOME_DIR: temp,
    MEOWCODE_WORKSPACE: workspace,
    MEOWCODE_SESSIONS_DIR: path.join(temp, "sessions"),
    MEOWCODE_LOG_DIR: path.join(temp, "logs"),
    MEOWCODE_MEMORY: "0",
    MEOWCODE_SELF_LEARNING: "0",
  };
  child = fork(path.join(runtime, "dist", "server", "server.js"), [], {
    execPath: executable,
    cwd: temp,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced",
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Agent startup timed out.\n${stderr}`)), 30_000);
    const failed = (error) => { clearTimeout(timer); reject(error); };
    child.once("error", failed);
    const exited = (code, signal) => failed(new Error(`Agent exited before ready: ${code ?? signal}\n${stderr}`));
    child.once("exit", exited);
    child.on("message", (message) => {
      if (message?.type !== "ready") return;
      clearTimeout(timer);
      child.removeListener("exit", exited);
      resolve(message);
    });
  });
  assert.equal(ready.version, pkg.version);
  const unauthorized = await fetch(`${ready.url}/global/health`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`${ready.url}/global/health`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { healthy: true, version: pkg.version });
  console.log(`Release ${pkg.version}: isolated Agent ready, health and authentication passed.`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close");
    const timer = setTimeout(() => child.kill(), 5_000);
    if (child.connected) child.send({ type: "shutdown" }, () => {});
    else child.kill();
    await closed;
    clearTimeout(timer);
  }
  await fs.rm(temp, { recursive: true, force: true });
}
