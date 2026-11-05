import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { IGNORED_ENTRY_NAMES } from "./paths.js";

/**
 * 工作区文件监听：外部编辑器/终端改动后通知 UI 刷新。
 * 只做「有哪些路径变了」的合并（400ms 去抖、最多 200 条）；不读内容、不碰 git。
 * Windows/macOS 用 recursive watch；Linux 的 recursive 支持依内核，失败时退回
 * 只监听根目录（首次事件仍会通知，路径可能缺失）。
 */
export type WorkspaceChange = {
  root: string;
  paths: string[];
  /** .git 内部发生变化：调用方可额外刷新 git 面板 */
  git: boolean;
  /** watch 本身不可用（网络盘等）：UI 仍可依赖轮询 */
  degraded: boolean;
};

export type WorkspaceWatcher = {
  root: string;
  close(): void;
};

const DEFAULT_DEBOUNCE_MS = 400;
const MAX_PATHS = 200;

function isIgnored(relativePath: string): { ignored: boolean; git: boolean } {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (!segments.length) return { ignored: true, git: false };
  if (segments[0] === ".git") return { ignored: true, git: true };
  return {
    ignored: segments.some((segment) => IGNORED_ENTRY_NAMES.has(segment)),
    git: false,
  };
}

export function createWorkspaceWatcher(options: {
  root: string;
  onChange: (change: WorkspaceChange) => void;
  debounceMs?: number;
}): WorkspaceWatcher {
  const root = path.resolve(options.root);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pendingPaths = new Set<string>();
  let pendingGit = false;
  let degraded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  let closed = false;

  const flush = () => {
    timer = null;
    if (closed || (!pendingPaths.size && !pendingGit)) return;
    const change: WorkspaceChange = {
      root,
      paths: [...pendingPaths].slice(0, MAX_PATHS),
      git: pendingGit,
      degraded,
    };
    pendingPaths.clear();
    pendingGit = false;
    options.onChange(change);
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };

  const onEvent = (_event: string, filename: string | Buffer | null) => {
    if (!filename) {
      pendingGit = true;
      schedule();
      return;
    }
    const relative = String(filename);
    const { ignored, git } = isIgnored(relative);
    if (git) {
      pendingGit = true;
      schedule();
      return;
    }
    if (ignored) return;
    if (pendingPaths.size >= MAX_PATHS) {
      schedule();
      return;
    }
    pendingPaths.add(relative);
    schedule();
  };

  try {
    watcher = watch(root, { recursive: true }, onEvent);
    watcher.on("error", () => {
      degraded = true;
      watcher?.close();
      watcher = null;
      try {
        watcher = watch(root, { recursive: false }, onEvent);
        watcher.on("error", () => {
          degraded = true;
          watcher = null;
        });
      } catch {
        watcher = null;
      }
    });
  } catch {
    degraded = true;
    try {
      watcher = watch(root, { recursive: false }, onEvent);
    } catch {
      watcher = null;
    }
  }

  return {
    root,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
      watcher = null;
    },
  };
}
