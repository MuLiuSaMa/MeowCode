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

/** shell 探测：PowerShell 7 → Windows PowerShell → ComSpec → cmd.exe */
function resolveShell() {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const candidates = [
    path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    process.env.ComSpec,
    path.join(systemRoot, "System32", "cmd.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "cmd.exe" : process.env.SHELL || "bash";
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
    const shell = resolveShell();
    const requestedCwd = typeof options?.cwd === "string" ? options.cwd : "";
    const cwd =
      requestedCwd && fs.existsSync(requestedCwd)
        ? requestedCwd
        : process.env.USERPROFILE || process.cwd();
    const cols = Math.max(20, Math.floor(Number(options?.cols) || 80));
    const rows = Math.max(5, Math.floor(Number(options?.rows) || 24));

    seq += 1;
    const id = `term-${seq}-${Date.now().toString(36)}`;
    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      ...(process.platform === "win32" ? { useConpty: true } : {}),
      env: { ...process.env, TERM: "xterm-256color" },
    });

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

module.exports = { registerTerminalIpc };
