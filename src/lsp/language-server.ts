import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LspServerConfig } from "./config.js";
import { findExecutable } from "./config.js";
import { RpcConnection } from "./client.js";
import { LspUnavailableError, type LspDiagnostic } from "./types.js";

type RawDiagnostic = {
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  code?: number | string;
  message?: string;
  source?: string;
};

type CachedDiagnostics = {
  version?: number;
  publishedAt: number;
  items: RawDiagnostic[];
};

function toDiagnostics(
  items: RawDiagnostic[],
  file: string,
): LspDiagnostic[] {
  const result: LspDiagnostic[] = [];
  for (const item of items) {
    const line = item.range?.start?.line;
    const character = item.range?.start?.character;
    if (typeof line !== "number" || typeof character !== "number") continue;
    const severity =
      item.severity === 1 ? "error" : item.severity === 2 ? "warning" : null;
    if (!severity) continue;
    result.push({
      file,
      line: line + 1,
      column: character + 1,
      severity,
      ...(item.code !== undefined ? { code: String(item.code) } : {}),
      message: String(item.message ?? "").trim(),
      ...(item.source ? { source: item.source } : {}),
    });
  }
  return result;
}

async function findProjectRoot(
  file: string,
  workspace: string,
  markers: string[] | undefined,
): Promise<string> {
  if (!markers?.length) return workspace;
  let current = path.dirname(path.resolve(file));
  const root = path.resolve(workspace);
  for (;;) {
    for (const marker of markers) {
      try {
        await fs.access(path.join(current, marker));
        return current;
      } catch {
        // 继续找下一个标记/上级目录
      }
    }
    if (current === root) break;
    const relative = path.relative(root, current);
    if (relative.startsWith("..") || path.isAbsolute(relative)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return root;
}

/** 通用 stdio LSP：didOpen/didChange 全文同步 + publishDiagnostics 等待。 */
export class LanguageServer {
  private connection: RpcConnection | null = null;
  private initialized = false;
  private root = "";
  private rootUri = "";
  private readonly opened = new Map<string, number>();
  private readonly cache = new Map<string, CachedDiagnostics>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly options: {
      name: string;
      config: LspServerConfig;
      workspace: string;
      timeoutMs: number;
    },
  ) {}

  get serverName(): string {
    return this.options.name;
  }

  async diagnose(files: string[], signal?: AbortSignal): Promise<LspDiagnostic[]> {
    if (!files.length) return [];
    await this.ensureStarted(files[0]);
    const diagnostics: LspDiagnostic[] = [];
    for (const file of files) {
      if (signal?.aborted) break;
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      if (text.length > 2_000_000) continue;
      const uri = pathToFileURL(file).href;
      const nextVersion = (this.opened.get(uri) ?? 0) + 1;
      const firstOpen = !this.opened.has(uri);
      this.opened.set(uri, nextVersion);
      const connection = this.connection;
      if (!connection) break;
      if (firstOpen) {
        connection.notify("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: this.options.config.languageId ?? "plaintext",
            version: nextVersion,
            text,
          },
        });
      } else {
        connection.notify("textDocument/didChange", {
          textDocument: { uri, version: nextVersion },
          contentChanges: [{ text }],
        });
      }
      await this.waitForPublish(uri, nextVersion, signal);
      if (!this.connection) break;
      const cached = this.cache.get(uri);
      if (cached) diagnostics.push(...toDiagnostics(cached.items, file));
    }
    return diagnostics;
  }

  dispose(): void {
    this.connection?.dispose();
    this.connection = null;
    this.initialized = false;
    this.opened.clear();
    this.cache.clear();
    this.resolveWaiters("*");
  }

  private async ensureStarted(file: string): Promise<void> {
    if (this.initialized && this.connection) return;
    const executable = await findExecutable(this.options.config.command);
    if (!executable) {
      throw new LspUnavailableError(
        `${this.options.name}: command not found (${this.options.config.command}).`,
      );
    }
    this.root = await findProjectRoot(
      file,
      this.options.workspace,
      this.options.config.rootMarkers,
    );
    this.rootUri = pathToFileURL(this.root).href;
    const connection = new RpcConnection({
      command: executable,
      args: this.options.config.args,
      cwd: this.root,
      protocol: "jsonrpc",
      ...(this.options.config.env ? { env: this.options.config.env } : {}),
      onRequest: (method, params) => this.handleRequest(method, params),
      onNotification: (method, params) => this.handleNotification(method, params),
      onExit: () => {
        this.initialized = false;
        this.resolveWaiters("*");
      },
    });
    this.connection = connection;
    try {
      await connection.request(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "MeowCode" },
          rootUri: this.rootUri,
          rootPath: this.root,
          capabilities: {
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
              synchronization: { didSave: false, dynamicRegistration: false },
              publishDiagnostics: { relatedInformation: false },
            },
          },
          workspaceFolders: [
            { uri: this.rootUri, name: path.basename(this.root) || "workspace" },
          ],
          ...(this.options.config.initializationOptions !== undefined
            ? { initializationOptions: this.options.config.initializationOptions }
            : {}),
        },
        { timeoutMs: Math.max(10_000, this.options.timeoutMs) },
      );
      connection.notify("initialized", {});
      this.initialized = true;
    } catch (error) {
      connection.dispose();
      this.connection = null;
      throw error instanceof LspUnavailableError
        ? error
        : new LspUnavailableError(
            `${this.options.name}: initialize failed (${
              error instanceof Error ? error.message : String(error)
            }).`,
          );
    }
  }

  private handleRequest(method: string, params: unknown): unknown {
    switch (method) {
      case "workspace/configuration": {
        const items = Array.isArray((params as { items?: unknown })?.items)
          ? ((params as { items: unknown[] }).items ?? [])
          : [];
        return items.map(() => null);
      }
      case "workspace/workspaceFolders":
        return [{ uri: this.rootUri, name: path.basename(this.root) || "workspace" }];
      case "workspace/applyEdit":
        return { applied: false };
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
      case "window/showDocument":
        return null;
      default:
        return null;
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics") return;
    const value = params as {
      uri?: unknown;
      version?: unknown;
      diagnostics?: unknown;
    } | null;
    if (!value || typeof value.uri !== "string") return;
    const items = Array.isArray(value.diagnostics)
      ? (value.diagnostics as RawDiagnostic[])
      : [];
    this.cache.set(value.uri, {
      ...(typeof value.version === "number" ? { version: value.version } : {}),
      publishedAt: Date.now(),
      items,
    });
    this.resolveWaiters(value.uri);
  }

  private resolveWaiters(uri: string): void {
    const targets =
      uri === "*"
        ? [...this.waiters.values()].flatMap((set) => [...set])
        : [...(this.waiters.get(uri) ?? [])];
    for (const resolve of targets) resolve();
  }

  private async waitForPublish(
    uri: string,
    minVersion: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 3_000;
    for (;;) {
      if (!this.connection || signal?.aborted) return;
      const cached = this.cache.get(uri);
      if (
        cached &&
        (cached.version === undefined || cached.version >= minVersion)
      ) {
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(uri) ?? new Set<() => void>();
        this.waiters.set(uri, set);
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          set.delete(done);
          if (!set.size) this.waiters.delete(uri);
          resolve();
        };
        const timer = setTimeout(done, Math.min(remaining, 500));
        signal?.addEventListener("abort", done, { once: true });
        set.add(done);
      });
    }
  }
}
