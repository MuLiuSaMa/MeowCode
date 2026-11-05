/**
 * 终端 PTY 管理（主进程）：node-pty 懒加载，按 id 管理会话。
 * 借鉴 ZCode 的 terminalService，但简化为 main 进程内直管 + IPC：
 *  - invoke：meow:term-create / meow:term-write / meow:term-resize / meow:term-kill
 *  - 推送：meow:term-data {id, data}（约 16ms 批量），meow:term-exit {id, code}
 * node-pty 1.1.0 自带 win32-x64 N-API prebuild，无需 electron-rebuild。
 */
const fs = require("node:fs");
const path = require("node:path");

/** id → { proc, pending: string[], timer, lastCols, lastRows } */
const terminals = new Map();
let seq = 0;

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

function resolveShell(env = process.env) {
  if (process.platform !== "win32") return env.SHELL || "bash";
  return shellCandidates(env).find(isSpawnableCandidate) ?? "cmd.exe";
}

function registerTerminalIpc(ipcMain, getWindow) {
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  /** 输出按 ~16ms 批量合并推送，降低 IPC 频率 */
  const pushData = (id, data) => {
    const entry = terminals.get(id);
    if (!entry) return;
    entry.pending.push(data);
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const chunk = entry.pending.join("");
      entry.pending = [];
      if (chunk) send("meow:term-data", { id, data: chunk });
    }, 16);
  };

  ipcMain.handle("meow:term-create", (_event, options) => {
    const pty = loadPty();
    const requestedCwd = typeof options?.cwd === "string" ? options.cwd : "";
    const cwd =
      requestedCwd && fs.existsSync(requestedCwd)
        ? requestedCwd
        : process.env.USERPROFILE || process.cwd();
    const cols = Math.max(20, Math.floor(Number(options?.cols) || 80));
    const rows = Math.max(5, Math.floor(Number(options?.rows) || 24));

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
        proc = pty.spawn(candidate, shellArgs(candidate), spawnOptions);
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
    const id = `term-${seq}-${Date.now().toString(36)}`;

    const entry = { proc, pending: [], timer: null, lastCols: cols, lastRows: rows };
    terminals.set(id, entry);

    proc.onData((data) => pushData(id, data));
    proc.onExit(({ exitCode }) => {
      const current = terminals.get(id);
      if (current?.timer) clearTimeout(current.timer);
      terminals.delete(id);
      send("meow:term-exit", { id, code: exitCode });
    });

    return { id, shell };
  });

  ipcMain.handle("meow:term-write", (_event, id, data) => {
    if (typeof id !== "string" || typeof data !== "string") return;
    const entry = terminals.get(id);
    if (!entry) return;
    try {
      entry.proc.write(data);
    } catch {
      // 进程已退出
    }
  });

  ipcMain.handle("meow:term-resize", (_event, id, cols, rows) => {
    const entry = terminals.get(id);
    if (!entry) return;
    const nextCols = Math.max(2, Math.floor(Number(cols) || 0));
    const nextRows = Math.max(2, Math.floor(Number(rows) || 0));
    if (!nextCols || !nextRows) return;
    if (entry.lastCols === nextCols && entry.lastRows === nextRows) return; // 尺寸没变不打扰 pty
    entry.lastCols = nextCols;
    entry.lastRows = nextRows;
    try {
      entry.proc.resize(nextCols, nextRows);
    } catch {
      // 进程已退出
    }
  });

  ipcMain.handle("meow:term-kill", (_event, id) => {
    const entry = terminals.get(id);
    if (!entry) return;
    terminals.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.proc.kill();
    } catch {
      // 已退出
    }
  });

  /** 窗口关闭 / 应用退出前杀掉全部 pty，避免 conpty 残留阻塞退出 */
  const disposeAll = () => {
    for (const entry of terminals.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      try {
        entry.proc.kill();
      } catch {
        // 已退出
      }
    }
    terminals.clear();
  };

  return { disposeAll };
}

module.exports = { registerTerminalIpc, resolveShell, shellArgs, shellCandidates };
