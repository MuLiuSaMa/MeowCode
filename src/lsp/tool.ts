import { promises as fs } from "node:fs";
import path from "node:path";
import { IGNORED_ENTRY_NAMES, resolveToolPath } from "../agent/paths.js";
import type { ToolResult } from "../agent/types.js";
import { loadLspConfig, supportedExtensions } from "./config.js";
import { formatToolDiagnostics } from "./format.js";
import { getLspManager } from "./manager.js";

const MAX_SCAN_FILES = 20;
const MAX_SCAN_DEPTH = 6;

async function collectSourceFiles(
  root: string,
  extensions: Set<string>,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= MAX_SCAN_FILES || depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) return;
      if (entry.name.startsWith(".") || IGNORED_ENTRY_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).replace(/^\./, "").toLowerCase();
      if (extensions.has(ext)) files.push(full);
    }
  };
  await visit(root, 0);
  return files;
}

function clampMaxResults(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 50;
  return Math.max(1, Math.min(100, Math.round(raw)));
}

export async function runDiagnosticsTool(input: {
  workspace: string;
  target: string;
  maxResults?: unknown;
  allowOutsideWorkspace: boolean;
  signal?: AbortSignal;
}): Promise<ToolResult> {
  try {
    const target = input.target?.trim() || ".";
    const resolved = await resolveToolPath(
      input.workspace,
      target,
      input.allowOutsideWorkspace,
    );
    const stat = await fs.stat(resolved);
    const config = await loadLspConfig(input.workspace);
    if (config.disabled) {
      return {
        ok: true,
        output: "[diagnostics] LSP diagnostics are disabled by .meowcode/lsp.json.",
      };
    }
    let files: string[];
    let scannedDirectory = false;
    if (stat.isDirectory()) {
      scannedDirectory = true;
      files = await collectSourceFiles(resolved, supportedExtensions(config));
      if (!files.length) {
        return {
          ok: true,
          output: "[diagnostics] No source files for a configured language server.",
        };
      }
    } else if (stat.isFile()) {
      files = [resolved];
    } else {
      return { ok: false, output: `Not a file or directory: ${target}` };
    }
    const result = await getLspManager().diagnose({
      cwd: input.workspace,
      files,
      signal: input.signal,
      timeoutMs: 6_000,
    });
    const capped =
      scannedDirectory && files.length >= MAX_SCAN_FILES
        ? "\n[diagnostics] Directory scan capped at 20 files; pass a specific file for full coverage."
        : "";
    return {
      ok: true,
      output:
        formatToolDiagnostics(
          result,
          input.workspace,
          clampMaxResults(input.maxResults),
        ) + capped,
    };
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
