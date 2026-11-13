import type { TFunction } from "i18next";
import type { TimelineTool } from "../../api";
import type { ToolStatus } from "./types";
import {
  asRecord,
  parseAskAnswers,
  parseDirectoryListing,
  parseGrepOutput,
  parseNumberedOutput,
  parsePathList,
  parseReadManyOutput,
  parseToolSearchOutput,
  parseWebFetchOutput,
  parseWebSearchOutput,
  textArg,
} from "./parse";

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

/**
 * 工具行右侧的一行摘要（不展开也能看到关键信息）。
 *
 * 参数优先：命令/代码/路径；有结果后再补计数（行数、条目数、命中数）。
 * 失败行已经有红色失败标记，不再补摘要，避免和错误信息抢位置。
 */
export function toolSummary(
  item: TimelineTool,
  status: ToolStatus,
  t: TFunction,
): string | undefined {
  if (status === "failed") return undefined;
  const args = asRecord(item.input);
  const output = item.output ?? "";

  switch (item.tool) {
    case "read_file": {
      const parsed = parseNumberedOutput(output);
      return parsed.numbered ? t("tool.lineCount", { count: parsed.lines.length }) : undefined;
    }
    case "read_many": {
      const sections = parseReadManyOutput(output);
      const lines = parseNumberedOutput(output).lines.length;
      const parts = [
        sections.length ? t("tool.fileCount", { count: sections.length }) : "",
        lines ? t("tool.lineCount", { count: lines }) : "",
      ].filter(Boolean);
      return parts.length ? parts.join(" · ") : undefined;
    }
    case "read_video": {
      const path = textArg(args, "path").trim();
      if (!path) return undefined;
      const mode = textArg(args, "mode").trim();
      return `${baseName(path)}${mode && mode !== "meta" ? ` · ${mode}` : ""}`;
    }
    case "list_dir": {
      const entries = parseDirectoryListing(output).entries;
      return entries.length ? t("tool.entryCount", { count: entries.length }) : undefined;
    }
    case "glob": {
      const paths = parsePathList(output).paths;
      return paths.length ? t("tool.fileCount", { count: paths.length }) : undefined;
    }
    case "grep": {
      const parsed = parseGrepOutput(output);
      const hits = parsed.groups.reduce((sum, group) => sum + group.matches.length, 0);
      if (!hits) return undefined;
      return parsed.groups.length > 1
        ? `${t("tool.matchCount", { count: hits })} · ${t("tool.fileCount", { count: parsed.groups.length })}`
        : t("tool.matchCount", { count: hits });
    }
    case "run_code": {
      const line = firstLine(textArg(args, "code"));
      return line ? line.slice(0, 160) : undefined;
    }
    case "web_search": {
      const results = parseWebSearchOutput(output).results;
      return results.length ? t("tool.resultCount", { count: results.length }) : undefined;
    }
    case "web_fetch": {
      const status = parseWebFetchOutput(output).status;
      return status ? `HTTP ${status}` : undefined;
    }
    case "memory_read":
    case "memory_delete": {
      const name = textArg(args, "name").trim();
      return name || undefined;
    }
    case "memory_write": {
      // description 是给记忆索引看的一句话，比 kebab-case slug 更适合常驻显示
      const description = textArg(args, "description").trim();
      if (description) return description.slice(0, 160);
      const name = textArg(args, "name").trim();
      return name || undefined;
    }
    case "context_status": {
      const line = firstLine(output);
      return line ? line.slice(0, 160) : undefined;
    }
    case "tool_search": {
      const names = parseToolSearchOutput(output).items.map((tool) => tool.name);
      return names.length ? names.join(" · ").slice(0, 160) : undefined;
    }
    case "session_search": {
      const query = textArg(args, "query").replace(/\s+/g, " ").trim();
      return query ? query.slice(0, 160) : undefined;
    }
    case "ask_user": {
      const answer = parseAskAnswers(output).find((value) => value.trim());
      return answer ? answer.trim().slice(0, 160) : undefined;
    }
    case "browser_navigate": {
      const url = textArg(args, "url").trim();
      return url ? url.slice(0, 160) : undefined;
    }
    case "browser_click": {
      const ref = textArg(args, "ref").trim();
      return ref || undefined;
    }
    case "browser_type": {
      const text = textArg(args, "text").replace(/\s+/g, " ").trim();
      return text ? text.slice(0, 160) : undefined;
    }
    default:
      return undefined;
  }
}
