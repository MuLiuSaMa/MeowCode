import { promises as fs } from "node:fs";
import path from "node:path";
import { RpcConnection } from "./client.js";
import type { LspDiagnostic } from "./types.js";

type TsDiagnostic = {
  start?: { line?: number; offset?: number };
  text?: string;
  code?: number | string;
  /** 同步接口返回数字（1/0），部分版本/字段返回 "error"/"warning" */
  category?: number | string;
  source?: string;
  fileName?: string;
};

function severityOf(category: TsDiagnostic["category"]): "error" | "warning" | null {
  if (category === 1 || category === "error") return "error";
  if (category === 0 || category === "warning") return "warning";
  return null;
}

function mapTsDiagnostics(raw: unknown, fallbackFile: string): LspDiagnostic[] {
  const body =
    raw && typeof raw === "object" && Array.isArray((raw as { response?: unknown }).response)
      ? (raw as { response: TsDiagnostic[] }).response
      : Array.isArray(raw)
        ? (raw as TsDiagnostic[])
        : [];
  const result: LspDiagnostic[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const line = item.start?.line;
    const column = item.start?.offset;
    if (typeof line !== "number" || typeof column !== "number") continue;
    const severity = severityOf(item.category);
    if (!severity) continue;
    result.push({
      file: item.fileName || fallbackFile,
      line,
      column,
      severity,
      ...(item.code !== undefined ? { code: `TS${item.code}` } : {}),
      message: String(item.text ?? "").trim(),
      ...(item.source ? { source: item.source } : {}),
    });
  }
  return result;
}

/** 一个 workspace 一个 tsserver；请求串行由 manager 保证。 */
export class TypeScriptServer {
  private connection: RpcConnection | null = null;
  private readonly opened = new Set<string>();
  private readonly projectRoots = new Map<string, string>();

  constructor(
    private readonly options: {
      workspace: string;
      serverPath: string;
      timeoutMs: number;
    },
  ) {}

  get serverName(): string {
    return "typescript";
  }

  async diagnose(files: string[], signal?: AbortSignal): Promise<LspDiagnostic[]> {
    if (!files.length) return [];
    const connection = this.ensureConnection();
    const diagnostics: LspDiagnostic[] = [];
    let succeeded = false;
    let firstError: unknown;
    for (const file of files) {
      if (signal?.aborted) break;
      let content: string;
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      if (content.length > 2_000_000) continue;
      const projectRootPath = await this.projectRootFor(file);
      try {
        if (!this.opened.has(file)) {
          await connection.request(
            "open",
            { file, fileContent: content, projectRootPath },
            { timeoutMs: this.options.timeoutMs, signal },
          );
          this.opened.add(file);
        } else {
          await connection.request(
            "reload",
            { file },
            { timeoutMs: this.options.timeoutMs, signal },
          );
        }
        const semantic = await connection.request(
          "semanticDiagnosticsSync",
          { file },
          { timeoutMs: this.options.timeoutMs, signal },
        );
        const syntactic = await connection.request(
          "syntacticDiagnosticsSync",
          { file },
          { timeoutMs: this.options.timeoutMs, signal },
        );
        diagnostics.push(
          ...mapTsDiagnostics(semantic, file),
          ...mapTsDiagnostics(syntactic, file),
        );
        succeeded = true;
      } catch (error) {
        if (signal?.aborted) break;
        firstError ??= error;
      }
    }
    if (!succeeded && firstError) throw firstError;
    return diagnostics;
  }

  dispose(): void {
    this.connection?.dispose();
    this.connection = null;
    this.opened.clear();
    this.projectRoots.clear();
  }

  private ensureConnection(): RpcConnection {
    if (this.connection) return this.connection;
    this.connection = new RpcConnection({
      command: process.execPath,
      args: [
        this.options.serverPath,
        "--logVerbosity",
        "off",
        "--disableAutomaticTypingAcquisition",
        "--useInferredProjectPerProjectRoot",
      ],
      cwd: this.options.workspace,
      protocol: "tsserver",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    return this.connection;
  }

  private async projectRootFor(file: string): Promise<string> {
    const cached = this.projectRoots.get(file);
    if (cached) return cached;
    const workspace = path.resolve(this.options.workspace);
    let current = path.dirname(path.resolve(file));
    for (;;) {
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        try {
          await fs.access(path.join(current, name));
          this.projectRoots.set(file, current);
          return current;
        } catch {
          // 继续向上
        }
      }
      if (current === workspace) break;
      const relative = path.relative(workspace, current);
      if (relative.startsWith("..") || path.isAbsolute(relative)) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    this.projectRoots.set(file, workspace);
    return workspace;
  }
}
