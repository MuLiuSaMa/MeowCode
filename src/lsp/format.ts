import path from "node:path";
import type { LspDiagnostic, LspDiagnosticsResult } from "./types.js";

function displayPath(workspace: string, file: string): string {
  const relative = path.relative(workspace, file);
  return (relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : file
  ).split(path.sep).join("/");
}

export type FormattedDiagnostics = {
  lines: string[];
  kept: LspDiagnostic[];
  total: number;
  errors: number;
  warnings: number;
  files: number;
  omitted: number;
};

export function formatDiagnosticLines(
  diagnostics: LspDiagnostic[],
  workspace: string,
  options: { maxTotal: number; maxPerFile: number; maxMessageChars?: number },
): FormattedDiagnostics {
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const perFile = new Map<string, number>();
  const kept: LspDiagnostic[] = [];
  for (const item of diagnostics) {
    if (kept.length >= options.maxTotal) break;
    const count = perFile.get(item.file) ?? 0;
    if (count >= options.maxPerFile) continue;
    perFile.set(item.file, count + 1);
    kept.push(item);
  }
  const maxChars = options.maxMessageChars ?? 240;
  const lines = kept.map((item) => {
    const code = item.code ? ` ${item.code}` : "";
    const message = item.message.replace(/\s+/g, " ").slice(0, maxChars);
    return `${displayPath(workspace, item.file)}(${item.line},${item.column}): ${item.severity}${code}: ${message}`;
  });
  return {
    lines,
    kept,
    total: diagnostics.length,
    errors,
    warnings,
    files: new Set(diagnostics.map((item) => item.file)).size,
    omitted: diagnostics.length - kept.length,
  };
}

function serverLabel(result: LspDiagnosticsResult): string {
  return result.serverNames.length ? ` (${result.serverNames.join(", ")})` : "";
}

export function formatToolDiagnostics(
  result: LspDiagnosticsResult,
  workspace: string,
  maxResults: number,
): string {
  if (!result.diagnostics.length) {
    if (result.unavailable) return `[diagnostics] Unavailable: ${result.unavailable}`;
    return `[diagnostics] No errors or warnings${serverLabel(result)}.`;
  }
  const formatted = formatDiagnosticLines(result.diagnostics, workspace, {
    maxTotal: maxResults,
    maxPerFile: Math.max(5, Math.ceil(maxResults / 2)),
  });
  const header = `[diagnostics] ${formatted.errors} error${formatted.errors === 1 ? "" : "s"}, ${
    formatted.warnings
  } warning${formatted.warnings === 1 ? "" : "s"} in ${formatted.files} file${
    formatted.files === 1 ? "" : "s"
  }${serverLabel(result)}`;
  const lines = [header, ...formatted.lines];
  if (formatted.omitted > 0) {
    lines.push(`... [${formatted.omitted} more omitted]`);
  }
  if (result.unavailable) {
    lines.push(`[diagnostics] Partially unavailable: ${result.unavailable}`);
  }
  return lines.join("\n");
}

/** 写后验证用：只保留 error/warning，按文件/全局限流；无内容返回 null。 */
export function formatLspFeedback(
  result: LspDiagnosticsResult,
  workspace: string,
  include?: (diagnostic: LspDiagnostic) => boolean,
): string | null {
  const diagnostics = include ? result.diagnostics.filter(include) : result.diagnostics;
  if (!diagnostics.length) return null;
  const formatted = formatDiagnosticLines(diagnostics, workspace, {
    maxTotal: 20,
    maxPerFile: 5,
  });
  if (!formatted.lines.length) return null;
  const lines = [
    `--- lsp diagnostics: ${formatted.errors} error${
      formatted.errors === 1 ? "" : "s"
    }, ${formatted.warnings} warning${formatted.warnings === 1 ? "" : "s"} in ${
      formatted.files
    } file${formatted.files === 1 ? "" : "s"}${serverLabel(result)} ---`,
    ...formatted.lines,
  ];
  if (formatted.omitted > 0) {
    lines.push(`... [${formatted.omitted} more omitted]`);
  }
  return lines.join("\n");
}
