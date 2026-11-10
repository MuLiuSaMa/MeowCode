/**
 * 终端 PTY 管理（主进程）：node-pty 懒加载，按 id 管理会话。
 * 借鉴 ZCode 的 terminalService，但简化为 main 进程内直管 + IPC：
 *  - invoke：meow:term-create / meow:term-write / meow:term-resize / meow:term-kill
 *  - 推送：meow:term-data {id, data}（约 16ms 批量），meow:term-exit {id, code}
 * node-pty 1.1.0 自带 win32-x64 N-API prebuild，无需 electron-rebuild。
 *
 * 2026-11 起终端同时是 agent 后台任务的宿主（job-host.cjs）：
 *  - 会话带 256KB 环形缓冲，网页/agent 可按 offset 增量读；
 *  - 退出后条目保留 5 分钟，供读取退出码与最后输出；
 *  - 带 command 的会话是任务终端：命令作为 shell 的一次性脚本执行，
 *    命令结束（跑完或被 Ctrl+C 中断）即进程退出，不保留交互 shell，
 *    这样「运行中」完全等价于进程活着，概览里的条目随进程消失。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

/** id → { proc, pending: string[], timer, lastCols, lastRows, buffer, bufferStart, ... } */
const terminals = new Map();
let seq = 0;
/** 由 registerTerminalIpc 注入；未注册桌面窗口（测试/CLI）时静默丢弃 */
let emit = () => {};

const BUFFER_MAX_CHARS = 256 * 1024;
const EXIT_RETENTION_MS = 5 * 60 * 1000;

function loadPty() {
  try {
    return require("node-pty");
  } catch (error) {
    throw new Error(`终端不可用：node-pty 加载失败（${error?.message ?? error}）`);
  }
}

const winJoin = path.win32.join;

/** PATH 可能带引号或空项（空项等于当前目录，扫描时跳过）。 */
function pathEntries(env) {
  return (env.PATH ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/**
 * 终端 shell 候选：pwsh 7（ProgramFiles / ProgramFiles(x86) / PATH）→ 5.1 → ComSpec → cmd.exe。
 * PATH 覆盖 Scoop / winget / Microsoft Store 的执行别名。
 */
function shellCandidates(env = process.env) {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"];
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const candidates = [
    winJoin(programFiles, "PowerShell", "7", "pwsh.exe"),
    programFilesX86 ? winJoin(programFilesX86, "PowerShell", "7", "pwsh.exe") : "",
    ...pathEntries(env).map((entry) => winJoin(entry, "pwsh.exe")),
    winJoin(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    env.ComSpec,
    winJoin(systemRoot, "System32", "cmd.exe"),
  ];
  return candidates.filter(Boolean).filter((candidate, index, all) => all.indexOf(candidate) === index);
}

/** Store 执行别名在 Node 里可能是符号链接；existsSync 会误判目标缺失的坏别名。 */
function isSpawnableCandidate(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** PowerShell 家族去掉版权 banner；不动 profile，用户终端应照常加载。 */
function shellArgs(shell) {
  const name = path.win32.basename(shell).toLowerCase().replace(/\.exe$/, "");
  return name === "pwsh" || name === "powershell" ? ["-NoLogo"] : [];
}

/**
 * 任务终端的启动参数：把命令当成 shell 的一次性脚本跑，跑完进程就退出。
 * 比「往交互式 shell 里输入命令」更准：任务结束（含 Ctrl+C）不再留下空转的 shell，
 * 上层只看进程存活与否就能判定任务是否还在跑。
 * PowerShell 走 -EncodedCommand（base64 UTF-16LE）：引号、换行、中文都不参与
 * Win32 命令行解析，多行命令也不会被逐行拆开执行。
 */
function jobShellArgv(shell, command) {
  const name = path.win32.basename(shell).toLowerCase().replace(/\.exe$/, "");
  if (name === "pwsh" || name === "powershell") {
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    return ["-NoLogo", "-EncodedCommand", encoded];
  }
  if (name === "cmd") return ["/d", "/s", "/c", command];
  // POSIX shell：-l 以便加载登录 profile，PATH 与用户终端一致
  return ["-lc", command];
}

function resolveShell(env = process.env) {
  if (process.platform !== "win32") return env.SHELL || "bash";
  return shellCandidates(env).find(isSpawnableCandidate) ?? "cmd.exe";
}

function appendBuffer(entry, data) {
  entry.buffer += data;
  if (entry.buffer.length > BUFFER_MAX_CHARS) {
    const drop = entry.buffer.length - BUFFER_MAX_CHARS;
    entry.buffer = entry.buffer.slice(drop);
    entry.bufferStart += drop;
  }
}

function flushPending(entry) {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  const chunk = entry.pending.join("");
  entry.pending = [];
  if (chunk) emit("meow:term-data", { id: entry.id, data: chunk });
}

/** 创建一个 PTY 会话；command 存在时以任务模式启动，命令结束进程即退出。 */
function createSession(options = {}) {
  const pty = loadPty();
  const requestedCwd = typeof options.cwd === "string" ? options.cwd : "";
  const cwd =
    requestedCwd && fs.existsSync(requestedCwd)
      ? requestedCwd
      : process.env.USERPROFILE || process.cwd();
  const cols = Math.max(20, Math.floor(Number(options.cols) || 80));
  const rows = Math.max(5, Math.floor(Number(options.rows) || 24));
  const command = typeof options.command === "string" ? options.command.trim() : "";

  const spawnOptions = {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    ...(process.platform === "win32" ? { useConpty: true } : {}),
    env: { ...process.env, TERM: "xterm-256color" },
  };
  // 逐个候选尝试 spawn：Store 坏别名能通过 lstat，却会在 CreateProcess 阶段失败。
  const candidates =
    process.platform === "win32" ? shellCandidates().filter(isSpawnableCandidate) : [resolveShell()];
  let proc;
  let shell;
  let lastError;
  for (const candidate of candidates) {
    try {
      proc = pty.spawn(
        candidate,
        command ? jobShellArgv(candidate, command) : shellArgs(candidate),
        spawnOptions,
      );
      shell = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!proc) {
    throw new Error(`终端不可用：找不到可启动的 shell（${lastError?.message ?? "无候选"}）`);
  }

  seq += 1;
  const id =
    typeof options.id === "string" && options.id
      ? options.id
      : `term-${seq}-${Date.now().toString(36)}`;

  const entry = {
    id,
    proc,
    pending: [],
    timer: null,
    lastCols: cols,
    lastRows: rows,
    buffer: "",
    bufferStart: 0,
    shell,
    cwd,
    command: command || null,
    startedAt: new Date().toISOString(),
    exited: null,
    cleanupTimer: null,
  };
  terminals.set(id, entry);

  proc.onData((data) => {
    appendBuffer(entry, data);
    if (entry.exited) return;
    entry.pending.push(data);
    if (entry.timer) return;
    entry.timer = setTimeout(() => flushPending(entry), 16);
    entry.timer.unref?.();
  });
  proc.onExit(({ exitCode }) => {
    flushPending(entry);
    entry.exited = { code: exitCode, at: Date.now() };
    emit("meow:term-exit", { id, code: exitCode });
    // 保留缓冲供 agent/job 读取退出码；过期再清理
    entry.cleanupTimer = setTimeout(() => {
      terminals.delete(id);
    }, EXIT_RETENTION_MS);
    entry.cleanupTimer.unref?.();
  });

  return { id, shell };
}

function writeSession(id, data) {
  if (typeof id !== "string" || typeof data !== "string") return;
  const entry = terminals.get(id);
  if (!entry || entry.exited) return;
  try {
    entry.proc.write(data);
  } catch {
    // 进程已退出
  }
}

function resizeSession(id, cols, rows) {
  const entry = terminals.get(id);
  if (!entry || entry.exited) return;
  const nextCols = Math.max(2, Math.floor(Number(cols) || 0));
  const nextRows = Math.max(2, Math.floor(Number(rows) || 0));
  if (!nextCols || !nextRows) return;
  if (entry.lastCols === nextCols && entry.lastRows === nextRows) return;
  entry.lastCols = nextCols;
  entry.lastRows = nextRows;
  try {
    entry.proc.resize(nextCols, nextRows);
  } catch {
    // 进程已退出
  }
}

/** ConPTY 下 proc.kill 未必带走子树：Windows 上再补一次 taskkill /T /F。 */
function killSession(id) {
  const entry = terminals.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  terminals.delete(id);
  const pid = entry.proc.pid;
  try {
    entry.proc.kill();
  } catch {
    // 已退出
  }
  if (process.platform === "win32" && pid) {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => undefined);
  }
}

/**
 * 增量读取：offset 是缓冲内绝对字符位置；缺省从当前头开始。
 * 返回的 offset 是下一次应传的值（已消费到缓冲末尾）。
 */
function readSession(id, offset) {
  const entry = terminals.get(id);
  if (!entry) return null;
  const requested = Number(offset);
  const absolute = Number.isFinite(requested)
    ? Math.max(0, Math.min(Math.floor(requested), entry.bufferStart + entry.buffer.length))
    : entry.bufferStart;
  const from = Math.max(absolute, entry.bufferStart);
  return {
    id,
    data: entry.buffer.slice(from - entry.bufferStart),
    offset: entry.bufferStart + entry.buffer.length,
    bufferStart: entry.bufferStart,
    truncated: absolute < entry.bufferStart,
    exited: Boolean(entry.exited),
    code: entry.exited ? entry.exited.code : null,
  };
}

function attachSession(id) {
  const entry = terminals.get(id);
  if (!entry) return null;
  return {
    id,
    shell: entry.shell,
    cwd: entry.cwd,
    command: entry.command,
    cols: entry.lastCols,
    rows: entry.lastRows,
    startedAt: entry.startedAt,
    data: entry.buffer,
    offset: entry.bufferStart + entry.buffer.length,
    bufferStart: entry.bufferStart,
    exited: Boolean(entry.exited),
    code: entry.exited ? entry.exited.code : null,
  };
}

function listSessions() {
  return [...terminals.values()].map((entry) => ({
    id: entry.id,
    shell: entry.shell,
    cwd: entry.cwd,
    command: entry.command,
    startedAt: entry.startedAt,
    exited: Boolean(entry.exited),
    code: entry.exited ? entry.exited.code : null,
  }));
}

function registerTerminalIpc(ipcMain, getWindow) {
  emit = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  ipcMain.handle("meow:term-create", (_event, options) => createSession(options ?? {}));
  ipcMain.handle("meow:term-write", (_event, id, data) => writeSession(id, data));
  ipcMain.handle("meow:term-resize", (_event, id, cols, rows) => resizeSession(id, cols, rows));
  ipcMain.handle("meow:term-kill", (_event, id) => killSession(id));
  ipcMain.handle("meow:term-attach", (_event, id) => attachSession(id));
  ipcMain.handle("meow:term-read", (_event, id, offset) => readSession(id, offset));
  ipcMain.handle("meow:term-list", () => listSessions());

  /** 窗口关闭 / 应用退出前杀掉全部 pty，避免 conpty 残留阻塞退出 */
  const disposeAll = () => {
    for (const entry of terminals.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      try {
        entry.proc.kill();
      } catch {
        // 已退出
      }
    }
    terminals.clear();
  };

  return {
    disposeAll,
    createSession,
    writeSession,
    resizeSession,
    killSession,
    readSession,
    attachSession,
    listSessions,
  };
}

module.exports = {
  registerTerminalIpc,
  resolveShell,
  shellArgs,
  jobShellArgv,
  shellCandidates,
  createSession,
  readSession,
  attachSession,
  listSessions,
  writeSession,
  resizeSession,
  killSession,
};
