import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWithinWorkspace } from "../agent/paths.js";

export type LspServerConfig = {
  command: string;
  args: string[];
  extensions: string[];
  languageId?: string;
  rootMarkers?: string[];
  env?: Record<string, string>;
  initializationOptions?: unknown;
};

export type LspConfig = {
  disabled: boolean;
  timeoutMs: number;
  typescript: { serverPath?: string; disabled: boolean };
  servers: Record<string, LspServerConfig>;
};

export type LspServerRef =
  | { kind: "typescript" }
  | { kind: "server"; name: string; config: LspServerConfig };

const CONFIG_RELATIVE = path.join(".meowcode", "lsp.json");
const DEFAULT_TIMEOUT_MS = 4_000;
const TYPESCRIPT_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];

/** 只在项目里已经装了对应语言服务时才会真正启动；命令不存在就静默跳过。 */
const BUILTIN_SERVERS: Record<string, LspServerConfig> = {
  pyright: {
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: ["py", "pyi"],
    languageId: "python",
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
  },
  gopls: {
    command: "gopls",
    args: [],
    extensions: ["go"],
    languageId: "go",
    rootMarkers: ["go.mod", "go.work"],
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    extensions: ["rs"],
    languageId: "rust",
    rootMarkers: ["Cargo.toml"],
  },
  clangd: {
    command: "clangd",
    args: [],
    extensions: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh"],
    languageId: "cpp",
    rootMarkers: ["compile_commands.json", "CMakeLists.txt"],
  },
};

function normalizeExtensions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
}

function normalizeServer(raw: unknown): LspServerConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (!command) return undefined;
  const args = Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === "string")
    : [];
  const extensions = normalizeExtensions(value.extensions);
  if (!extensions.length) return undefined;
  const env: Record<string, string> = {};
  if (value.env && typeof value.env === "object" && !Array.isArray(value.env)) {
    for (const [key, entry] of Object.entries(value.env)) {
      if (typeof entry === "string") env[key] = entry;
    }
  }
  return {
    command,
    args,
    extensions,
    ...(typeof value.languageId === "string" && value.languageId.trim()
      ? { languageId: value.languageId.trim() }
      : {}),
    ...(Array.isArray(value.rootMarkers)
      ? {
          rootMarkers: value.rootMarkers.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(value.initializationOptions !== undefined
      ? { initializationOptions: value.initializationOptions }
      : {}),
  };
}

/** 读 .meowcode/lsp.json；坏配置/缺文件都回退到内置探测，绝不 throw。 */
export async function loadLspConfig(workspace: string): Promise<LspConfig> {
  const config: LspConfig = {
    disabled: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    typescript: { disabled: false },
    servers: { ...BUILTIN_SERVERS },
  };
  let raw: Record<string, unknown> | undefined;
  try {
    const file = await resolveWithinWorkspace(workspace, CONFIG_RELATIVE);
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[lsp] ignored .meowcode/lsp.json: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (!raw) return config;

  config.disabled = raw.disabled === true;
  if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)) {
    config.timeoutMs = Math.max(1_000, Math.min(30_000, Math.round(raw.timeoutMs)));
  }
  if (raw.typescript && typeof raw.typescript === "object" && !Array.isArray(raw.typescript)) {
    const ts = raw.typescript as Record<string, unknown>;
    config.typescript.disabled = ts.disabled === true;
    if (typeof ts.serverPath === "string" && ts.serverPath.trim()) {
      config.typescript.serverPath = ts.serverPath.trim();
    }
  }
  if (raw.servers && typeof raw.servers === "object" && !Array.isArray(raw.servers)) {
    for (const [name, value] of Object.entries(raw.servers)) {
      if (value === false) {
        delete config.servers[name];
        continue;
      }
      const server = normalizeServer(value);
      if (server) config.servers[name] = server;
      else console.warn(`[lsp] ignored invalid server config: ${name}`);
    }
  }
  return config;
}

export function isTypeScriptFile(file: string): boolean {
  return TYPESCRIPT_EXTENSIONS.includes(
    path.extname(file).replace(/^\./, "").toLowerCase(),
  );
}

export function serverForFile(config: LspConfig, file: string): LspServerRef | undefined {
  if (isTypeScriptFile(file)) {
    return config.typescript.disabled ? undefined : { kind: "typescript" };
  }
  const ext = path.extname(file).replace(/^\./, "").toLowerCase();
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.extensions.includes(ext)) return { kind: "server", name, config: server };
  }
  return undefined;
}

/** 目录扫描用：TS/JS + 已配置语言的扩展名（不检查命令是否存在）。 */
export function supportedExtensions(config: LspConfig): Set<string> {
  const result = new Set<string>(config.typescript.disabled ? [] : TYPESCRIPT_EXTENSIONS);
  for (const server of Object.values(config.servers)) {
    for (const ext of server.extensions) result.add(ext);
  }
  return result;
}

/** 在 PATH/PATHEXT 中找可执行文件；找不到返回 undefined。 */
export async function findExecutable(command: string): Promise<string | undefined> {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    try {
      await fs.access(trimmed);
      return trimmed;
    } catch {
      return undefined;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  const hasExtension = path.extname(trimmed) !== "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidates = hasExtension ? [trimmed] : [trimmed, ...extensions.map((ext) => `${trimmed}${ext}`)];
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        await fs.access(full);
        return full;
      } catch {
        // 继续找
      }
    }
  }
  return undefined;
}

/** 从 workspace 向上找 <node_modules>/typescript/lib/tsserver.js；Linked worktree 回主仓库找。 */
export async function resolveTypeScriptServer(
  workspace: string,
  configuredPath?: string,
): Promise<string | undefined> {
  if (configuredPath) {
    try {
      if ((await fs.stat(configuredPath)).isFile()) return configuredPath;
    } catch {
      // 配置失效，继续自动探测
    }
  }
  const check = async (root: string): Promise<string | undefined> => {
    const candidate = path.join(root, "node_modules", "typescript", "lib", "tsserver.js");
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      return undefined;
    }
    return undefined;
  };

  const start = path.resolve(workspace);
  let current = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const found = await check(current);
    if (found) return found;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // worktree 的 .git 是文件：gitdir 指向主仓库 .git/worktrees/<name>
  let probe = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const dotGit = path.join(probe, ".git");
    try {
      const info = await fs.stat(dotGit);
      if (info.isFile()) {
        const text = (await fs.readFile(dotGit, "utf8")).trim();
        const match = /^gitdir:\s*(.+)$/i.exec(text);
        if (match) {
          const gitDir = path.resolve(probe, match[1].trim());
          const commonDir = path.resolve(gitDir, "..", "..");
          const repoRoot = path.dirname(commonDir);
          const found = await check(repoRoot);
          if (found) return found;
        }
        break;
      }
      if (info.isDirectory()) break;
    } catch {
      // 继续向上
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return undefined;
}
