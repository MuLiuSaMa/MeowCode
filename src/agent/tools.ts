import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  LEVEL_LABEL,
  MAX_TEXT_BYTES,
  applyTextEdit,
  lineOfOffset,
  readTextFile,
  shapeForWrite,
  withBom,
  type EditLevel,
  type TextFileFailure,
} from "./edit-content.js";
import { DEFAULT_AGENT_TYPES } from "./agent-definition.js";
import { estimateTokens, estimateToolDefinitionsTokens } from "./context.js";
import { truncateToTokens } from "./tool-budget.js";
import { renderChangeSnippet } from "./diff.js";
import { readMultiEditGroups } from "./multi-edit.js";
import { readPdfBase64, readPdfText } from "./pdf.js";
import { grabFrames, grabStoryboard, probeVideo, type VideoToolResult } from "./video.js";
import { resolveToolPath, IGNORED_ENTRY_NAMES } from "./paths.js";
import { runDiagnosticsTool } from "../lsp/tool.js";
import { runCodeInSandbox, type HostToolBridge } from "./code-mode.js";
import { sliceLinesForModel } from "./read-slice.js";
import { changedSinceRead, recordRead, recordWrite } from "./read-state.js";
import { searchGlob, searchGrep } from "./search.js";
import { persistToolOutput, TOOL_OUTPUT_DIR } from "./tool-output.js";
import {
  deleteMemory,
  isValidMemoryName,
  memoryDirFor,
  readMemory,
  saveMemory,
  type MemoryScope,
} from "./memory.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import {
  MAX_QUERY_CHARS,
  searchSessions,
  type SessionSearchHit,
} from "./session-search.js";
import { formatWebSearchResult, type WebSearchResult } from "./web-search.js";
import type { WebFetchOutcome } from "./web-fetch.js";
import { classifySandboxDenial } from "./sandbox/denial.js";
import { getSandboxSettings } from "./sandbox/policy.js";
import { runShellCommand } from "./exec/shell.js";
import { MAX_COMMAND_OUTPUT_BYTES, DEFAULT_COMMAND_TIMEOUT_MS } from "./exec/types.js";
import {
  builtinToolContract,
  isParallelSafeContract,
  READ_MANY_MAX_PATHS,
  type ToolContract,
} from "./tool-contract.js";
import { executeJobTool, jobToolDefinition, startBackgroundCommand } from "./job-tools.js";
import type { JobManager } from "./jobs.js";
import { executeGitTool, gitToolDefinition } from "./git-tools.js";
import { applyPatch, PatchError } from "./patch.js";

// 执行面已抽到 ./exec；这里保留旧导出，git 服务与既有单测的导入路径不变。
export { commandEnv } from "./exec/env.js";
export { decodeCommandOutput } from "./exec/encoding.js";
export { killProcessTree } from "./exec/process-tree.js";

// 工具输出按 token 预算，而不是字符：中文 1 字 ≈ 1 token，按字符会让中文仓库
// 的单次输出膨胀约 4 倍（Codex 默认也是 10KB bytes + 头尾截断）。
const MAX_OUTPUT_TOKENS = 3_000;
/** 结构化搜索结果（grep/glob）超过这个预算就先落盘再降级，模型按需续读。 */
const STRUCTURED_OUTPUT_TOKENS = 2_000;
const MAX_COMMAND_TOKENS = 3_000;
const MAX_READ_LINES = 400;
/**
 * read_file 超长文件落盘阈值：文件超过这个预算且一屏读不完时，
 * 只内联头尾预览、全文落盘，避免模型靠 offset 一页页翻大文件
 * （每翻一页都是一次全上下文重发）。
 */
const READ_SAVE_THRESHOLD_TOKENS = 2_000;
const READ_HEAD_PREVIEW_LINES = 100;
const READ_TAIL_PREVIEW_LINES = 40;
const READ_TAIL_PREVIEW_TOKENS = 800;
const MAX_LIST_ENTRIES = 500;
const MAX_LIST_DIR_TOKENS = 1_000;
const MAX_READ_TOKENS = 4_000;
const MAX_READ_MANY_TOKENS = 4_000;
const SESSION_SEARCH_DEFAULT_LIMIT = 3;
const SESSION_SEARCH_MAX_LIMIT = 10;
const SESSION_SEARCH_MAX_CHARS = 4_000;
const SESSION_SEARCH_HYDRATE = 3;

export function truncateOutput(
  text: string,
  maxTokens = MAX_OUTPUT_TOKENS,
): { output: string; truncated: boolean } {
  const truncated = truncateToTokens(text, maxTokens);
  return { output: truncated.text, truncated: truncated.truncated };
}

/**
 * 命令输出保留头 + 尾：开头常有运行环境/首个错误，结尾常有汇总诊断。
 * 中段省略，完整内容由调用方落盘。
 */
export function truncateMiddle(
  text: string,
  maxTokens = MAX_COMMAND_TOKENS,
): { output: string; truncated: boolean; omitted: number; lines: number } {
  const lines = text.split(/\r?\n/).length;
  const truncated = truncateToTokens(text, maxTokens, {
    headRatio: 1 / 3,
    note: (omitted, total) =>
      `... [truncated ${omitted} of ${total} tokens in the middle; ${lines} lines total]`,
  });
  return {
    output: truncated.text,
    truncated: truncated.truncated,
    omitted: truncated.omittedTokens,
    lines,
  };
}

function toolResult(output: string, ok = true): ToolResult {
  const truncated = truncateOutput(output);
  return { output: truncated.output, ok };
}

/** tool_search 的实现：按关键词检索全部在册动态工具，命中的延迟工具提升回可见区。 */
function searchDynamicTools(args: Record<string, unknown>): ToolResult {
  const query = String(args.query ?? "").trim();
  if (!query) return toolResult("tool_search requires a non-empty `query`.", false);
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  if (!tokens.length) return toolResult("tool_search requires a non-empty `query`.", false);

  const scored: { name: string; score: number; description: string; deferred: boolean }[] = [];
  for (const [name, tool] of dynamicTools) {
    const description = tool.definition.function.description ?? "";
    const haystackName = name.toLowerCase();
    const haystackDesc = description.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystackName.includes(token)) score += 3;
      else if (haystackDesc.includes(token)) score += 1;
    }
    if (score > 0) {
      scored.push({ name, score, description, deferred: deferredDynamicTools.has(name) });
    }
  }
  if (!scored.length) {
    const all = [...dynamicTools.keys()].sort();
    return toolResult(
      `No registered tool matches "${query}". Registered tools: ${
        all.join(", ") || "(none)"
      }. Deferred tools are also listed above — try tool_search again with a keyword from their names.`,
    );
  }
  // deferred 优先展示（那是模型看不到的），同级再按分数、名字排序
  scored.sort(
    (a, b) =>
      Number(b.deferred) - Number(a.deferred) || b.score - a.score || a.name.localeCompare(b.name, "en"),
  );
  const lines: string[] = [];
  const promoted: string[] = [];
  for (const hit of scored.slice(0, limit)) {
    if (hit.deferred && promoteDynamicTool(hit.name)) promoted.push(hit.name);
    lines.push(`- ${hit.name}: ${hit.description}`);
  }
  const header = promoted.length
    ? `Promoted for your next turn (schema will be in your tools list; call them from the next request): ${promoted.join(", ")}`
    : "Top matches (already visible — call them directly):";
  return toolResult(`${header}\n${lines.join("\n")}`);
}

/** memory_* 工具的 scope 参数：其余值（含缺省）都拒绝，不猜测默认层。 */
function parseMemoryScope(value: unknown): MemoryScope | null {
  if (value === "user" || value === "project") return value;
  return null;
}

/**
 * 结构化搜索结果降级：超过 token 预算时头尾保留，完整结果落盘并给分页提示。
 *
 * 模型拿到落盘路径后可以用 read_file + offset 续读，不必重跑同一次搜索 ——
 * 重跑一次的成本（整个上下文重发）远高于读落盘文件。
 * 只用于 grep / glob：run_command 的输出是诊断信息，绝不能这样降级。
 */
/** 目标是否已经落在工具输出的落盘目录里：读产物不该再生成新产物（会无限增殖）。 */
function isInsideToolOutput(workspace: string, file: string): boolean {
  const relative = path.relative(path.resolve(workspace), path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const normalized = relative.split(path.sep).join("/");
  const dir = TOOL_OUTPUT_DIR.split(path.sep).join("/");
  return normalized === dir || normalized.startsWith(`${dir}/`);
}

/**
 * 通用截断收口：超预算就把完整文本落盘，并在头尾之间留一条可续读指针。
 *
 * 与 `degradeStructuredOutput` 是同一套约定（落盘 + `read_file (offset/limit)`），
 * 区别只在于不要求结果是结构化搜索结果。动态工具（MCP / 插件）与 `task` 子 Agent
 * 的报告都走这里 —— 它们的输出一旦被裸截断，模型就再也拿不回全文了。
 */
export async function truncateWithSpill(
  workspace: string,
  tool: string,
  text: string,
  maxTokens = MAX_OUTPUT_TOKENS,
): Promise<{ output: string; truncated: boolean; spilled?: string }> {
  if (estimateTokens(text) <= maxTokens) return { output: text, truncated: false };
  const saved = await persistToolOutput(workspace, tool, text).catch(() => null);
  const truncated = truncateToTokens(text, maxTokens, {
    note: (omitted, original) =>
      saved
        ? `... [${omitted} of ${original} tokens omitted; full output saved to ${saved} — read that path with read_file (offset/limit)]`
        : `... [${omitted} of ${original} tokens omitted; narrow the result or re-run with a smaller scope]`,
  });
  return {
    output: truncated.text,
    truncated: truncated.truncated,
    ...(saved ? { spilled: saved } : {}),
  };
}

export async function degradeStructuredOutput(
  workspace: string,
  tool: string,
  output: string,
  spillText?: string,
): Promise<{ output: string; truncated: boolean; spilled?: string }> {
  const alreadyCapped = spillText !== undefined && spillText !== output;
  if (estimateTokens(output) <= STRUCTURED_OUTPUT_TOKENS && !alreadyCapped) {
    return { output, truncated: false };
  }
  // 尾部 "... [truncated ...]" / "... [no matches]" 之类的提示行要保留，否则模型不知道结果被截过
  const noticeMatch = output.match(/(\n\.\.\. \[[^\n]*\])+$/);
  const body = noticeMatch ? output.slice(0, noticeMatch.index) : output;
  const notice = noticeMatch ? noticeMatch[1] : "";
  // 落盘写完整结果：搜索层的内联裁剪不该影响 artifact 的完整性
  const full = spillText ?? output;
  const saved = await persistToolOutput(workspace, tool, full).catch(() => null);
  const over = estimateTokens(body) > STRUCTURED_OUTPUT_TOKENS;
  const bounded = over
    ? truncateToTokens(body, STRUCTURED_OUTPUT_TOKENS, {
        note: (omitted, total) =>
          saved
            ? `... [${omitted} of ${total} tokens omitted; full result saved to ${saved} — page it with read_file (offset/limit) instead of re-running this search]`
            : `... [${omitted} of ${total} tokens omitted; narrow the pattern to see more]`,
      }).text
    : body;
  // 搜索层已经裁过、但正文仍在预算内：保留截断回执，不能因为“够短”丢掉落盘路径
  const spillHint =
    !over && saved && alreadyCapped
      ? `\n... [full result saved to ${saved} — page it with read_file (offset/limit) instead of re-running this search]`
      : "";
  return {
    output: bounded + spillHint + notice,
    truncated: true,
    ...(saved ? { spilled: saved } : {}),
  };
}

/** 文本安全读取失败时的模型可读提示；read / write / edit 共用同一套判定。 */
function textFileProblem(name: string, failure: TextFileFailure): ToolResult {
  switch (failure.reason) {
    case "directory":
      return { output: `${name} is a directory, not a file.`, ok: false };
    case "binary":
      return {
        output: `${name} looks like a binary file (NUL byte in the first 4096 bytes); these tools only handle UTF-8 text.`,
        ok: false,
      };
    case "not-utf8":
      return {
        output: `${name} is not valid UTF-8 (possibly GBK/ANSI). Reading it would produce mojibake and writing it back would destroy the original bytes. Convert the file to UTF-8 first.`,
        ok: false,
      };
    case "too-large":
      return {
        output: `${name} is ${failure.size} bytes, above the ${MAX_TEXT_BYTES}-byte limit these tools will rewrite in full. Read the part you need with read_file offset/limit.`,
        ok: false,
      };
    default:
      return { output: `${name} not found.`, ok: false };
  }
}

export const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories; build/dependency folders are skipped; large listings spill to .meowcode/tool-output/.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path (full-access mode allows absolute)." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file (default 400 lines; result reports the next offset). Images (png/jpg/webp/gif, max 4 MB) are attached when the model accepts them. PDFs: text layer, 20 pages per call — page with pages=\"1-5\". Oversized files and truncated tool output are saved to .meowcode/tool-output/ and can be re-read by path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path (full-access mode allows absolute)." },
          offset: { type: "integer", description: "1-based start line." },
          limit: { type: "integer", description: "Max lines to read." },
          pages: { type: "string", description: "PDF only: page range, e.g. \"1-5\" or \"1-3,7\"." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_many",
      description:
        "Read several text files in one call. Budget is shared fairly across files, each returned in read_file's \"N: \" format; files that do not fit are marked skipped. Images/binaries: use read_file.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            description: "Workspace-relative file paths, in reading priority order (max 12).",
            items: { type: "string" },
          },
          limit: {
            type: "integer",
            description: "Optional max lines per file (default is a fair share of the total budget).",
          },
        },
        required: ["paths"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_video",
      description:
        "Inspect a video via ffmpeg. meta: duration/resolution/fps/audio, 0 images. storyboard: 9 evenly spaced frames as one 3x3 sheet (~1.5k tokens) — start here. frames: up to 4 exact timestamps at 2048px. Needs ffmpeg (or MEOWCODE_FFMPEG).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative video path." },
          mode: {
            type: "string",
            enum: ["meta", "storyboard", "frames"],
            description: "meta (default) / storyboard / frames.",
          },
          start: { type: "string", description: "Range start (e.g. \"00:01:30\"). Default 0." },
          end: { type: "string", description: "Range end. Default: duration." },
          timestamps: {
            type: "array",
            description: "frames only: <=4 timestamps, e.g. [\"00:03\", \"1:20.5\"].",
            items: { type: "string" },
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob pattern without reading contents.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern relative to the workspace." },
          path: { type: "string", description: "Workspace-relative path (full-access mode allows absolute)." },
          maxResults: { type: "integer", description: "Max paths to return (default 100, max 500)." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with ripgrep; returns path, line number, and matching text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex, or a literal string when fixed=true." },
          path: { type: "string", description: "Workspace-relative path (full-access mode allows absolute)." },
          fixed: { type: "boolean", description: "Literal string match." },
          caseSensitive: { type: "boolean", description: "Case-sensitive (default true)." },
          contextLines: { type: "integer", description: "Context lines around each match (0-10)." },
          maxResults: { type: "integer", description: "Max matches (default 100, max 500)." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web for current information. Use when the answer depends on recent events, releases, prices, or facts past your knowledge cutoff. Returns titles, URLs, and summaries; cite the URLs you use. Available only when the current model provider offers search.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search query." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a public web page and return its readable text as Markdown. Use after web_search when snippets are not enough. HTML/text only; binary files and localhost/private hosts are rejected.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_code",
      description:
        "Sandboxed JS for batched reads/searches/edits; only the return value is billed. `meow`: read/readMany/grep/glob/listDir (grep→[{path,line,text}], glob→[paths]); write(path,content)/edit(path,old,new)/multiEdit(edits)/run(command) use host tools and their approvals (denial→{ok:false,output}). No require/process/fetch; 30s/200 calls. Return a short excerpt.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Async body; `return` the value." },
        },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or fully rewrite a file. Prefer edit_file/multi_edit for existing files (much cheaper). Preserves line endings and BOM. Requires approval. Put \"path\" first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path (full-access mode allows absolute)." },
          content: { type: "string", description: "Complete file content." },
          force: {
            type: "boolean",
            description: "Overwrite even when the rewrite keeps most old lines (refused by default).",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace oldString in a text file. Tolerates CRLF/LF, line-number prefixes, whitespace and smart-quote drift. Ambiguous matches fail (add context or set replaceAll). Result shows changed lines — do not re-read. Requires approval. Put \"path\" first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path (full-access mode allows absolute)." },
          oldString: { type: "string", description: "Text to replace, without read_file line-number prefixes." },
          newString: { type: "string", description: "Replacement text." },
          replaceAll: { type: "boolean", description: "Replace every occurrence (default false)." },
        },
        required: ["path", "oldString", "newString"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "multi_edit",
      description:
        "Apply several edits in one call, optionally across files: one approval and one round trip. Same-file edits apply in order; if any fails nothing is written. Result lists changed files — do not re-read. Requires approval. Put each edit's \"path\" first.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Default path for edits without their own.",
          },
          edits: {
            type: "array",
            description: "Edits in application order.",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Target file; defaults to top-level path." },
                oldString: { type: "string", description: "Text to replace, without line-number prefixes." },
                newString: { type: "string", description: "Replacement text." },
                replaceAll: { type: "boolean", description: "Replace every occurrence (default false)." },
              },
              required: ["oldString", "newString"],
              additionalProperties: false,
            },
          },
        },
        required: ["edits"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a PowerShell command in the workspace. Routine commands run automatically; only destructive ones (disk, registry, shutdown) ask first. Long output keeps head and tail; full log is saved under .meowcode/tool-output/. When the command sandbox is enabled, writes outside the workspace and configured extra roots are blocked; a blocked command may ask once to retry outside the sandbox. background=true starts a long-running job (dev server, watcher) in a terminal and returns immediately; read it with the job tool (job wait blocks for output). " +
        // 这段是给模型看的写法约束：系统提示词按 token 预算只留了「怎么搜/怎么读」，
        // 只在真要下命令时才需要读到的东西放这里。
        "This is PowerShell, not bash: no rm -rf / export / cat / grep -r — use Remove-Item -Recurse -Force, $env:NAME='value', Get-Content, Select-String. Windows PowerShell 5.1 has no && or ||: chain with ';'. There is no stdin, so interactive prompts (Read-Host, pause, git commit without -m) hang until the timeout. " +
        // 改文件走专用工具：这是实测过的毁文件路径，一句话指路，细节在主提示词里
        "Edit files with edit_file/multi_edit, never by piping through PowerShell (Get-Content | Set-Content, Out-File and '>' rewrite every byte and can truncate the target). For many files at once use run_code or the project's own formatter. The shell is for build/test/run and for projecting large output (Select-Object, Select-String).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "PowerShell command." },
          background: {
            type: "boolean",
            description:
              "Start as a background job in a terminal and return immediately (default false). Use job wait to block for output. The user can take over in the terminal tab.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task",
      description:
        "Spawn a subagent for one self-contained task; only its report returns. Use for broad independent work; handle quick searches and coupled edits yourself. It sees the current request and plan — give a short description and scope; pick the role via agent_type. background=true returns immediately and notifies later. mode=resume continues an earlier subagent by agent_id (its history is kept); mode=fork copies this conversation prefix for prompt-cache reuse. Concurrent agents are capped; finished slots can be reused this turn.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Short label shown in the UI.",
          },
          prompt: {
            type: "string",
            description:
              "Initial instruction (spawn) or follow-up (resume). Omit on spawn to derive it from the current request and plan.",
          },
          mode: {
            type: "string",
            enum: ["spawn", "resume", "fork"],
            description:
              "spawn = new fresh subagent (default); resume = continue agent_id; fork = copy this conversation prefix into a general subagent.",
          },
          agent_id: {
            type: "string",
            description: "Existing subagent id for mode=resume.",
          },
          agent_type: {
            type: "string",
            enum: [...DEFAULT_AGENT_TYPES],
            description:
              "general = full tools (default); explore = read-only cheapest; planner = plan; implementer = write+verify; reviewer = findings; verifier = run checks; custom = user-defined (architecture graph).",
          },
          lane_id: {
            type: "string",
            description: "Lane id for gate roles in T2 governed runs.",
          },
          background: {
            type: "boolean",
            description: "Return immediately; notify on completion. Default false.",
          },
          provider: {
            type: "string",
            description: "Provider id; omit to inherit current.",
          },
          reasoning_effort: {
            type: "string",
            description: "Reasoning effort; omit to inherit.",
          },
        },
        required: ["description"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Set the checklist to short, current steps. Create it early when the work needs 3+ steps or touches " +
        "several files; skip quick fixes. Keep it live: when you start a step set it in_progress; once done mark " +
        "it completed and start the next step in the same update. Never leave finished work open or batch " +
        "updates — the checklist is the user's only progress view.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
              },
              required: ["title", "status"],
              additionalProperties: false,
            },
            description: "At most 12 short steps in execution order.",
          },
          explanation: { type: "string", description: "Optional one-sentence status note." },
        },
        required: ["steps"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "context_status",
      description:
        "Context-window usage: tokens used, window size, headroom, compaction advice. Call before large explorations or near the limit.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "diagnostics",
      description:
        "Get language-server type errors/warnings for a file or directory. Read-only.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File or directory (default '.').",
          },
          maxResults: {
            type: "integer",
            description: "Max results (1-100).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user and wait. Ask only when the answer would change the outcome. Batch ALL questions into ONE call (up to 4); each has 2-4 exclusive short options, plus free text.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "1-4 questions",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "Specific question in the user's language" },
                options: {
                  type: "array",
                  items: { type: "string" },
                  description: "2-4 mutually exclusive short options",
                },
              },
              required: ["question", "options"],
              additionalProperties: false,
            },
          },
        },
        required: ["questions"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_read",
      description: "Read one long-term memory file in full; the Memory index lists saved entries.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["user", "project"],
            description: '"user" = cross-project, "project" = workspace.',
          },
          name: {
            type: "string",
            description: "Entry name from the index (kebab-case slug).",
          },
        },
        required: ["scope", "name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_write",
      description:
        "Save or update a long-term memory across sessions. Use proactively for reusable facts (preferences, conventions, decisions): one fact per file, check the index first, never store secrets or what code/git shows.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["user", "project"],
            description: '"user" = cross-project, "project" = workspace.',
          },
          name: {
            type: "string",
            description: "Kebab-case slug, e.g. docker-cli.",
          },
          description: {
            type: "string",
            description: "One-line summary for the index.",
          },
          content: {
            type: "string",
            description: "Full body with the context needed later.",
          },
        },
        required: ["scope", "name", "description", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_delete",
      description: "Delete an outdated or wrong memory and remove it from the index.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["user", "project"],
            description: '"user" = cross-project, "project" = workspace.',
          },
          name: {
            type: "string",
            description: "Entry name from the index (kebab-case slug).",
          },
        },
        required: ["scope", "name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "session_search",
      description:
        "Search this workspace's earlier sessions for past decisions, fixes, and reasons. Use when the user refers to earlier work (\"last time\", \"before\", \"remember\") or before asking again. Indexes user/assistant text only.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keywords or a short phrase (1-200 chars).",
          },
          limit: {
            type: "integer",
            description: "Max sessions to return (1-10, default 3).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tool_search",
      description:
        "Search registered MCP/plugin tools by keyword. A match surfaces deferred tools so they become callable next turn; use it before assuming a capability is missing.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, e.g. \"browser screenshot\" or \"figma\"." },
          limit: { type: "integer", description: "Max matches to surface (1-10, default 5)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  jobToolDefinition,
  gitToolDefinition,
  {
    type: "function",
    function: {
      name: "delete_file",
      description:
        "Delete one file (or a symbolic link itself). Directories are not supported. The file is snapshotted before deletion so session rewind can restore it.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path." } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description:
        "Move or rename a file, preserving bytes, BOM and line endings. Refuses to overwrite an existing target unless overwrite=true.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Source path." },
          to: { type: "string", description: "Destination path." },
          overwrite: { type: "boolean", description: "Replace an existing destination (default false)." },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Apply a Codex-style patch with *** Begin Patch / *** Update File / *** Add File / *** Delete File and @@ hunks. All hunks must match or nothing is written.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "The patch text." },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * 治理准入工具：仅 governance != "off" 的根 runtime 动态注册（不进静态
 * toolDefinitions——只读会话/子 Agent 不为此付常驻 schema 预算）。
 * 门禁语义：admit 之前变更类工具一律被拦（见 workflow-runtime）。
 */
export const admitToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "admit",
    description:
      "Admit a governed task before mutating anything (required while gating is active). Declare the shape once; mutating tools unlock after it.",
    parameters: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: ["T0", "T1", "T2"],
          description: "T0 = trivial, no gates; T1 = single lane; T2 = parallel lanes.",
        },
        task_shape: {
          type: "string",
          description: "One sentence describing the deliverable.",
        },
        lanes: {
          type: "array",
          description: "T2 only: parallel lanes with their own scope.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable lane id used as lane_id in task calls." },
              objective: { type: "string" },
              owned_paths: {
                type: "array",
                items: { type: "string" },
                description: "Files this lane owns; parallel lanes must not overlap.",
              },
              verification_commands: {
                type: "array",
                items: { type: "string" },
                description: "Commands the verifier should run.",
              },
              depends_on: {
                type: "array",
                items: { type: "string" },
                description: "Lane ids that must finish first.",
              },
            },
            required: ["id", "objective"],
            additionalProperties: false,
          },
        },
      },
      required: ["tier", "task_shape"],
      additionalProperties: false,
    },
  },
};

// ---------------------------------------------------------------------------
// 动态工具表：插件 / MCP 注册的自定义工具。执行时先查这里，查不到再走内置 switch。
// 内置 toolDefinitions 数组与下方 switch 保持零改动。
// ---------------------------------------------------------------------------

export type DynamicTool = {
  definition: ToolDefinition;
  /** true 则每次调用先走审批流（runtime 的 requiresApproval 判定会追加本项） */
  requiresApproval?: boolean;
  /** 并发/只读/超时契约；缺省按「串行、有副作用」保守处理 */
  contract?: ToolContract;
  execute: (input: unknown, workspace: string, options: ToolRunOptions) => Promise<ToolResult>;
};

const dynamicTools = new Map<string, DynamicTool>();
/**
 * 已注销动态工具名（MCP 断线 / 卸载）。会话快照仍保留其 schema，
 * 模型再次调用时给明确原因，而不是含糊的 "Unknown tool"。
 */
const retiredDynamicNames = new Set<string>();
const RETIRED_NAME_CAP = 256;

function rememberRetired(name: string): void {
  retiredDynamicNames.add(name);
  if (retiredDynamicNames.size > RETIRED_NAME_CAP) {
    const oldest = retiredDynamicNames.values().next().value;
    if (oldest !== undefined) retiredDynamicNames.delete(oldest);
  }
}

/**
 * 动态工具 schema 的软预算：MCP / 插件工具每轮随请求全量发送，是唯一会随
 * 「装了几个 server」无限增长的部分。超预算只告警不再统一降档——统一重写会把
 * 已发送的工具描述换字节，整段缓存前缀失效；收缩下沉到注册时按单工具裁剪。
 */
const DYNAMIC_TOOL_BUDGET_TOKENS = 8_000;
/** 创作入口永远可见：被 MCP 工具挤出预算后模型会以为没有该能力，转而去翻源码。 */
const ALWAYS_VISIBLE_DYNAMIC_TOOLS = new Set([
  "plugin_authoring_guide",
  "create_plugin",
  "create_skill",
]);
/** 单工具注册即冻结的体积上限：超出按档裁剪自身，之后集合增长不改写它。 */
const DYNAMIC_TOOL_MAX_TOKENS = 400;
/** 逐档收缩：工具描述 / 字段描述（0 = 删掉字段描述）。按顺序降档直到落进预算。 */
const DYNAMIC_DESCRIPTION_LEVELS: ReadonlyArray<{ tool: number; property: number }> = [
  { tool: 240, property: 120 },
  { tool: 120, property: 60 },
  { tool: 80, property: 30 },
  { tool: 40, property: 0 },
];

let dynamicToolsRev = 0;
let dynamicDefinitionsCache: {
  version: number;
  tools: ToolDefinition[];
  trimmed: boolean;
} | null = null;

/** 词边界裁剪；max <= 0 表示直接丢弃。 */
function clipDescription(text: string, max: number): string {
  if (max <= 0) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const head = normalized.slice(0, Math.max(0, max - 2));
  const cut = head.lastIndexOf(" ");
  return `${(cut > max * 0.6 ? head.slice(0, cut) : head).trimEnd()} …`;
}

/** 递归重写一个字段节点的描述（保留 type/enum/required 等一切结构）。 */
function rewritePropertyDescriptions(node: unknown, propertyMax: number): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  if (typeof source.description === "string") {
    if (propertyMax <= 0) delete out.description;
    else out.description = clipDescription(source.description, propertyMax);
  }
  if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    const nested: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(source.properties as Record<string, unknown>)) {
      nested[name] = rewritePropertyDescriptions(child, propertyMax);
    }
    out.properties = nested;
  }
  if (source.items && typeof source.items === "object") {
    out.items = rewritePropertyDescriptions(source.items, propertyMax);
  }
  return out;
}

function rewriteDefinitionDescriptions(
  definition: ToolDefinition,
  toolMax: number,
  propertyMax: number,
): ToolDefinition {
  const parameters = definition.function.parameters as Record<string, unknown> | undefined;
  const properties = parameters?.properties;
  const nextProperties: Record<string, unknown> = {};
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
      nextProperties[name] = rewritePropertyDescriptions(value, propertyMax);
    }
  }
  return {
    ...definition,
    function: {
      ...definition.function,
      description: clipDescription(definition.function.description, toolMax),
      parameters: {
        type: "object",
        properties: properties ? nextProperties : definition.function.parameters.properties,
        ...(definition.function.parameters.required
          ? { required: definition.function.parameters.required }
          : {}),
        ...(definition.function.parameters.additionalProperties !== undefined
          ? { additionalProperties: definition.function.parameters.additionalProperties }
          : {}),
      },
    },
  };
}

/**
 * 注册即冻结：只按该工具自身体积裁剪（原始定义 ≤ 上限则逐字保留），
 * 集合后续增长不会再改写它的定义字节 —— 已发送的描述换字节 = 缓存前缀整段失效。
 */
function fitDynamicDefinition(definition: ToolDefinition, capTokens: number): ToolDefinition {
  let current = definition;
  for (const { tool, property } of DYNAMIC_DESCRIPTION_LEVELS) {
    if (estimateToolDefinitionsTokens([current]) <= capTokens) return current;
    current = rewriteDefinitionDescriptions(current, tool, property);
  }
  return current;
}

const RESERVED_DYNAMIC_TOOL_NAMES = new Set<string>([
  ...toolDefinitions.map((d) => d.function.name),
  "task",
  "update_plan",
  "admit",
]);

function isReservedDynamicToolName(name: string): boolean {
  return RESERVED_DYNAMIC_TOOL_NAMES.has(name) || name.startsWith("browser_");
}

/** 注册动态工具；重名或保留名返回 false。保留名 = 内置工具名 + browser_ 前缀 + task/update_plan。 */
export function registerDynamicTool(name: string, tool: DynamicTool): { ok: boolean; error?: string } {
  if (isReservedDynamicToolName(name)) {
    return { ok: false, error: `"${name}" is a reserved tool name` };
  }
  if (dynamicTools.has(name)) {
    return { ok: false, error: `tool "${name}" is already registered` };
  }
  dynamicTools.set(name, {
    ...tool,
    definition: fitDynamicDefinition(tool.definition, DYNAMIC_TOOL_MAX_TOKENS),
  });
  retiredDynamicNames.delete(name);
  dynamicToolsRev += 1;
  dynamicDefinitionsCache = null;
  return { ok: true };
}

export function unregisterDynamicTool(name: string): void {
  if (dynamicTools.delete(name)) {
    unpinDynamicTool(name);
    dynamicToolsRev += 1;
    dynamicDefinitionsCache = null;
    rememberRetired(name);
  }
}

/** 工具契约查询：动态工具优先（MCP 的 readOnlyHint 等），否则回落到内置表。 */
export function toolContractOf(name: string): ToolContract | undefined {
  return dynamicTools.get(name)?.contract ?? builtinToolContract(name);
}

/** 并发资格：只有 readOnly && parallelSafe 的契约才允许进 agent-loop 的并发批。 */
export function isToolParallelSafe(name: string): boolean {
  return isParallelSafeContract(toolContractOf(name));
}

/** 超预算被延迟展示的动态工具：注册在册、可按名调用，但 schema 不进 tools 段。 */
const deferredDynamicTools = new Set<string>();
/** tool_search 命中后被固定展示的工具（会话生命周期内保持可见，FIFO 淘汰最旧）。 */
const pinnedDynamicTools: string[] = [];
const PINNED_DYNAMIC_TOOL_MAX = 8;

/**
 * 把 tool_search 命中的延迟工具固定回可见区（下轮请求 schema 随目录追加，缓存安全）。
 * 返回 true 表示发生了实际提升。
 */
export function promoteDynamicTool(name: string): boolean {
  if (!dynamicTools.has(name)) return false;
  if (pinnedDynamicTools.includes(name)) return false;
  pinnedDynamicTools.push(name);
  if (pinnedDynamicTools.length > PINNED_DYNAMIC_TOOL_MAX) {
    const evicted = pinnedDynamicTools.shift();
    if (evicted !== undefined && !dynamicTools.has(evicted)) {
      // 被顶掉又已卸载的工具顺手清出固定表
    }
  }
  dynamicToolsRev += 1;
  dynamicDefinitionsCache = null;
  return true;
}

/** 动态工具卸载时同步清固定表。 */
function unpinDynamicTool(name: string): void {
  const index = pinnedDynamicTools.indexOf(name);
  if (index >= 0) pinnedDynamicTools.splice(index, 1);
}

/** 当前被延迟展示的动态工具名（诊断 / tool_search 兜底列表用）。 */
export function deferredDynamicToolNames(): string[] {
  return [...deferredDynamicTools].sort();
}

/**
 * 动态工具定义：**按名字升序**输出，并套用描述预算。
 *
 * 排序是为了缓存前缀稳定 —— MCP server 并发 connect 的完成顺序不稳定，
 * 按注册顺序输出会让 tools 断点（缓存断点）在每次重连后整段失效。
 *
 * 集合超过整体预算时不再全量发送：按名字序累计装到预算为止，其余转入
 * deferred（仍在册、可调用，schema 不发）。tool_search 命中的工具会被固定回
 * 可见区（promote），下轮请求经 reconcileToolCatalog 以「新增」追加到目录末尾，
 * 不破坏缓存前缀 —— claude-code isDeferred 同款语义。
 */
export function listDynamicToolDefinitions(): ToolDefinition[] {
  const cached = dynamicDefinitionsCache;
  if (cached && cached.version === dynamicToolsRev) return cached.tools;
  const sorted = [...dynamicTools.keys()].sort();
  const visible: ToolDefinition[] = [];
  let used = 0;
  for (const name of sorted) {
    const definition = dynamicTools.get(name)!.definition;
    const cost = estimateToolDefinitionsTokens([definition]);
    if (
      ALWAYS_VISIBLE_DYNAMIC_TOOLS.has(name) ||
      pinnedDynamicTools.includes(name) ||
      used + cost <= DYNAMIC_TOOL_BUDGET_TOKENS
    ) {
      visible.push(definition);
      used += cost;
    } else {
      deferredDynamicTools.add(name);
    }
  }
  for (const name of deferredDynamicTools) {
    if (!dynamicTools.has(name) || visible.some((def) => def.function.name === name)) {
      deferredDynamicTools.delete(name);
    }
  }
  dynamicDefinitionsCache = {
    version: dynamicToolsRev,
    tools: visible,
    trimmed: deferredDynamicTools.size > 0,
  };
  return visible;
}

/** 动态工具注册表版本：runtime 用它判断是否需要重建原始工具表。 */
export function dynamicToolsVersion(): number {
  return dynamicToolsRev;
}

/** 动态工具描述是否因预算被裁剪过（true 说明该关掉一些 MCP server）。 */
export function dynamicToolDefinitionsTrimmed(): boolean {
  listDynamicToolDefinitions();
  return dynamicDefinitionsCache?.trimmed === true;
}

export function hasDynamicTool(name: string): boolean {
  return dynamicTools.has(name);
}

export function isDynamicToolRequiringApproval(name: string): boolean {
  return dynamicTools.get(name)?.requiresApproval === true;
}

export type ToolRunOptions = {
  /** 完全访问：允许工作区外的绝对路径 */
  allowOutsideWorkspace?: boolean;
  signal?: AbortSignal;
  /** run_command 的单次沙箱覆盖：bypass 只用于「用户批准后沙箱外重试一次」 */
  sandbox?: "enforce" | "bypass";
  /**
   * run_code 的宿主写/命令桥（write/edit/multiEdit/run）。由 runtime 注入，
   * 每次调用都走与普通工具一致的路径守卫与审批；缺省时 run_code 保持只读语义。
   */
  hostToolBridge?: HostToolBridge;
  /**
   * 当前模型是否接受图片：为 true 时 read_file 读到图片文件会直接把图片附在结果里，
   * 而不是按二进制拒绝。由 runtime 按 provider 的输入模态决定。
   */
  vision?: boolean;
  /**
   * 超限图片的自动缩图器（桌面端经 nativeImage 实现）。
   * 提供时超限图片先试缩图；不可用或失败则「卸载」为文字说明，不再硬报错。
   */
  shrinkImage?: (request: {
    path: string;
    maxBytes?: number;
    maxEdge?: number;
  }, signal?: AbortSignal) => Promise<{
    ok: boolean;
    data?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
    originalWidth?: number;
    originalHeight?: number;
    error?: string;
  }>;
  /**
   * 模型是否接受 PDF 文档块：true 时扫描件（没有文本层）回退成原生 document；
   * false 时只返回可操作的文字提示（chat completions 没有可移植的 file 块）。
   */
  pdfDocuments?: boolean;
  /**
   * 批量读的「已读」查询（由 runtime 注入 LoopGuard）：
   * 返回 true 表示该文件本会话已完整读过且没变，正文可以只给一行占位。
   * 缺省（工具单测直调）时行为与之前完全一致。
   */
  readCoverage?: (target: string) => Promise<boolean>;
  /**
   * 当前模型可用的联网搜索（runtime 按 provider 解析）。
   * 缺省 = 该服务商没有自己的搜索能力，此时 web_search 应被撤下。
   */
  webSearch?: (query: string, signal?: AbortSignal) => Promise<WebSearchResult>;
  /** 网页抓取：DeepSeek 走官方 Fetch API，其余走本地 HTTP。 */
  webFetch?: (url: string, signal?: AbortSignal) => Promise<WebFetchOutcome>;
  /** 后台任务管理器（桌面端走 job-host，CLI/测试走本地子进程） */
  jobs?: JobManager;
  /** 跨会话检索：root 会话目录与要排除的当前会话 id（runtime 注入）。 */
  sessionSearch?: { sessionsDir: string; excludeSessionId?: string };
};

/**
 * 动态工具（MCP/插件）的宿主级超时：它们接收 AbortSignal，所以可以真中断。
 * 内置工具不经过这里——超时由各自实现负责，避免写操作被「假失败真写入」。
 */
async function executeDynamicTool(
  name: string,
  dynamic: DynamicTool,
  input: unknown,
  workspace: string,
  options: ToolRunOptions,
): Promise<ToolResult> {
  const timeoutMs = dynamic.contract?.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) return dynamic.execute(input, workspace, options);

  const controller = new AbortController();
  const parent = options.signal;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      dynamic.execute(input, workspace, { ...options, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new Error(`${name} timed out after ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    // abort 会先让工具自己的监听器抛错，这里统一归一到超时原因
    if (timedOut) throw new Error(`${name} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}

function sessionSearchLimit(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return SESSION_SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SESSION_SEARCH_MAX_LIMIT, Math.floor(numeric)));
}

function formatSessionSearchHit(hit: SessionSearchHit, index: number): string {
  const date = hit.createdAt ? hit.createdAt.slice(0, 10) : "unknown date";
  const title = hit.title?.trim() || "(untitled session)";
  const lines = [`${index}. ${date} | ${title} | ${hit.sessionId.slice(0, 8)}`];
  if (hit.context?.length) {
    for (const message of hit.context) {
      const suffix = message.matched ? " (matched)" : "";
      const ellipsis = message.truncated ? "…" : "";
      lines.push(`   [${message.role}] ${message.text}${ellipsis}${suffix}`);
    }
    return lines.join("\n");
  }
  if (hit.snippets.length) {
    for (const snippet of hit.snippets) {
      lines.push(`   [${snippet.role}] ${snippet.text}`);
    }
    return lines.join("\n");
  }
  lines.push("   (title match only)");
  return lines.join("\n");
}

async function runSessionSearchTool(
  args: Record<string, unknown>,
  workspace: string,
  options: ToolRunOptions["sessionSearch"],
): Promise<ToolResult> {
  if (!options) {
    return { ok: false, output: "Session search is not available in this runtime." };
  }
  if (!workspace.trim()) {
    return { ok: false, output: "Session search needs a workspace folder, but this session has none." };
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { ok: false, output: 'session_search requires a non-empty "query".' };
  }
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, output: `session_search query must be at most ${MAX_QUERY_CHARS} characters.` };
  }
  const result = await searchSessions(options.sessionsDir, query, {
    limit: sessionSearchLimit(args.limit),
    workspace,
    ...(options.excludeSessionId ? { excludeSessionId: options.excludeSessionId } : {}),
    hydrate: SESSION_SEARCH_HYDRATE,
  });
  const skippedNote =
    result.skipped > 0 ? ` ${result.skipped} unreadable session file(s) were skipped.` : "";
  if (!result.hits.length) {
    return {
      ok: true,
      output: `No past sessions in this workspace matched "${query}" (scanned ${result.scanned}). Try broader keywords; only user and assistant text is indexed.${skippedNote}`,
    };
  }
  const header = `Found ${result.hits.length} session(s) matching "${query}" (scanned ${result.scanned}).`;
  const lines = [header];
  let used = header.length;
  let capped = false;
  for (let index = 0; index < result.hits.length; index += 1) {
    const block = formatSessionSearchHit(result.hits[index], index + 1);
    const remaining = SESSION_SEARCH_MAX_CHARS - used - 1;
    if (block.length > remaining) {
      if (remaining > 200) lines.push(`${block.slice(0, remaining - 1)}…`);
      capped = true;
      break;
    }
    lines.push(block);
    used += block.length + 1;
  }
  if (capped) lines.push("... output capped; narrow the query or lower the limit.");
  if (result.skipped > 0) lines.push(`${result.skipped} unreadable session file(s) were skipped.`);
  let output = lines.join("\n");
  if (output.length > SESSION_SEARCH_MAX_CHARS) {
    output = `${output.slice(0, SESSION_SEARCH_MAX_CHARS - 20)}\n... [capped]`;
  }
  return { ok: true, output };
}

export async function executeTool(
  name: string,
  input: unknown,
  workspace: string,
  options: ToolRunOptions = {},
): Promise<ToolResult> {
  const { allowOutsideWorkspace = false, signal, vision = false } = options;
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    const dynamic = dynamicTools.get(name);
    if (dynamic) {
      const result = await executeDynamicTool(name, dynamic, input, workspace, options);
      const shaped = await truncateWithSpill(workspace, name, result.output);
      return {
        ...result,
        output: shaped.output,
        truncated: shaped.truncated,
        ...(shaped.spilled ? { spilled: shaped.spilled } : {}),
      };
    }
    if (retiredDynamicNames.has(name)) {
      return {
        output: `Tool "${name}" is temporarily unavailable (its MCP server disconnected or was removed). Retry later or use another tool.`,
        ok: false,
      };
    }
    switch (name) {
      case "tool_search":
        return searchDynamicTools(args);
      case "web_search": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return { ok: false, output: 'web_search requires a non-empty "query".' };
        if (!options.webSearch) {
          return { ok: false, output: "Web search is not available for the current model." };
        }
        const result = await options.webSearch(query, signal);
        const body = formatWebSearchResult(query, result);
        const degraded = await degradeStructuredOutput(workspace, "web_search", body, body);
        return {
          ok: true,
          output: degraded.output,
          ...(degraded.truncated ? { truncated: true } : {}),
          ...(degraded.spilled ? { spilled: degraded.spilled } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
        };
      }
      case "web_fetch": {
        const url = typeof args.url === "string" ? args.url.trim() : "";
        if (!url) return { ok: false, output: 'web_fetch requires a non-empty "url".' };
        if (!options.webFetch) {
          return { ok: false, output: "Web fetch is not available." };
        }
        const result = await options.webFetch(url, signal);
        const degraded = await degradeStructuredOutput(workspace, "web_fetch", result.output, result.output);
        return {
          ok: true,
          output: degraded.output,
          ...(degraded.truncated || result.truncated ? { truncated: true } : {}),
          ...(degraded.spilled ? { spilled: degraded.spilled } : {}),
        };
      }
      case "list_dir":
        return await listDir(workspace, typeof args.path === "string" ? args.path : ".", allowOutsideWorkspace);
      case "read_file":
        return await readFile({
          workspace,
          target: String(args.path),
          offset: args.offset,
          limit: args.limit,
          pages: args.pages,
          allowOutsideWorkspace,
          vision,
          pdfDocuments: options.pdfDocuments === true,
          shrinkImage: options.shrinkImage,
          signal,
        });
      case "read_many":
        return await readMany(
          workspace,
          Array.isArray(args.paths) ? (args.paths as string[]) : [],
          args.limit,
          allowOutsideWorkspace,
          options,
        );
      case "read_video": {
        const target = typeof args.path === "string" ? args.path.trim() : "";
        if (!target) return { ok: false, output: "read_video requires a \"path\"." };
        const file = await resolveToolPath(workspace, target, allowOutsideWorkspace);
        const name = path.basename(file);
        const mode = typeof args.mode === "string" ? args.mode : "meta";
        // 视频会给模型回图片：模型不吃图时 meta 仍然有用，另外两种模式明确拒绝，
        // 免得白白渲染 9 帧再被丢掉（token 已经花了）。
        const wantsImages = mode === "storyboard" || mode === "frames";
        if (wantsImages && !vision) {
          return {
            ok: false,
            output:
              'This model is configured as text-only, so video frames cannot be attached. Use mode="meta" for duration/resolution, or enable the "Image" input modality for this model.',
          };
        }
        let result: VideoToolResult;
        if (mode === "storyboard") {
          result = await grabStoryboard(file, name, {
            ...(typeof args.start === "string" ? { start: args.start } : {}),
            ...(typeof args.end === "string" ? { end: args.end } : {}),
          });
        } else if (mode === "frames") {
          result = await grabFrames(
            file,
            name,
            Array.isArray(args.timestamps) ? args.timestamps.map((item) => String(item)) : [],
          );
        } else {
          result = await probeVideo(file, name);
        }
        return result.ok
          ? {
              ok: true,
              output: result.output,
              ...(result.images?.length ? { images: result.images } : {}),
            }
          : { ok: false, output: result.output };
      }
      case "glob": {
        const result = await searchGlob(
          workspace,
          typeof args.path === "string" ? args.path : ".",
          String(args.pattern ?? ""),
          args.maxResults,
          signal,
          allowOutsideWorkspace,
        );
        if (!result.ok) return result;
        const degraded = await degradeStructuredOutput(
          workspace,
          "glob",
          result.output,
          result.spillText,
        );
        return {
          ...result,
          output: degraded.output,
          truncated: degraded.truncated,
          ...(degraded.spilled ? { spilled: degraded.spilled } : {}),
        };
      }
      case "grep": {
        const result = await searchGrep(
          workspace,
          typeof args.path === "string" ? args.path : ".",
          String(args.pattern ?? ""),
          {
            fixed: args.fixed,
            caseSensitive: args.caseSensitive,
            contextLines: args.contextLines,
            maxResults: args.maxResults,
          },
          signal,
          allowOutsideWorkspace,
        );
        if (!result.ok) return result;
        const degraded = await degradeStructuredOutput(
          workspace,
          "grep",
          result.output,
          result.spillText,
        );
        return {
          ...result,
          output: degraded.output,
          truncated: degraded.truncated,
          ...(degraded.spilled ? { spilled: degraded.spilled } : {}),
        };
      }
      case "run_code":
        // PTC 语义在沙箱内完成：中间工具输出留在沙箱与日志里，结果只回最终值。
        // hostToolBridge 存在时，meow.write/edit/multiEdit/run 会走宿主审批后执行。
        return await runCodeInSandbox({
          workspace,
          code: String(args.code ?? ""),
          allowOutsideWorkspace,
          signal,
          ...(options.hostToolBridge ? { hostToolBridge: options.hostToolBridge } : {}),
        });
      case "write_file":
        return await writeFile(
          workspace,
          String(args.path),
          String(args.content ?? ""),
          allowOutsideWorkspace,
          Boolean(args.force),
        );
      case "edit_file":
        return await editFile(
          workspace,
          String(args.path),
          String(args.oldString ?? ""),
          String(args.newString ?? ""),
          allowOutsideWorkspace,
          Boolean(args.replaceAll),
        );
      case "multi_edit":
        return await multiEdit(workspace, input, allowOutsideWorkspace);
      case "run_command":
        if (args.background === true) {
          if (!options.jobs) {
            return { ok: false, output: "Background jobs are not available in this environment." };
          }
          return await startBackgroundCommand(options.jobs, String(args.command ?? ""), workspace);
        }
        return await runCommand(workspace, String(args.command ?? ""), signal, options.sandbox);
      case "job":
        if (!options.jobs) {
          return { ok: false, output: "Background jobs are not available in this environment." };
        }
        return await executeJobTool(options.jobs, args);
      case "git":
        return await executeGitTool(args, workspace);
      case "delete_file": {
        const target = String(args.path ?? "").trim();
        if (!target) return { ok: false, output: "delete_file requires path." };
        const file = await resolveToolPath(workspace, target, allowOutsideWorkspace);
        const stat = await fs.lstat(file);
        if (stat.isDirectory()) {
          return {
            ok: false,
            output: "delete_file only deletes files; directories are not supported.",
          };
        }
        await fs.unlink(file);
        return { ok: true, output: `Deleted ${target}.` };
      }
      case "move_file": {
        const from = String(args.from ?? "").trim();
        const to = String(args.to ?? "").trim();
        if (!from || !to) return { ok: false, output: "move_file requires from and to." };
        const source = await resolveToolPath(workspace, from, allowOutsideWorkspace);
        const destination = await resolveToolPath(workspace, to, allowOutsideWorkspace);
        if (source === destination) {
          return { ok: false, output: "move_file source and destination are the same path." };
        }
        const stat = await fs.lstat(source);
        if (stat.isDirectory()) {
          return { ok: false, output: "move_file only moves files; directories are not supported." };
        }
        const existing = await fs.lstat(destination).catch(() => null);
        if (existing && args.overwrite !== true) {
          return {
            ok: false,
            output: `${to} already exists; pass overwrite=true to replace it.`,
          };
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (existing) await fs.unlink(destination);
        try {
          await fs.rename(source, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await fs.copyFile(source, destination);
          await fs.unlink(source);
        }
        return { ok: true, output: `Moved ${from} → ${to}.` };
      }
      case "apply_patch": {
        const patchText = String(args.patch ?? "");
        if (!patchText.trim()) return { ok: false, output: "apply_patch requires patch." };
        try {
          const result = await applyPatch(workspace, patchText, { allowOutsideWorkspace });
          const parts = [
            ...result.changed.map((file) => `updated ${file}`),
            ...result.added.map((file) => `added ${file}`),
            ...result.deleted.map((file) => `deleted ${file}`),
          ];
          return { ok: true, output: `Patch applied.\n${parts.join("\n")}` };
        } catch (error) {
          if (error instanceof PatchError) {
            return { ok: false, output: `Patch not applied: ${error.message}` };
          }
          throw error;
        }
      }
      case "diagnostics":
        return await runDiagnosticsTool({
          workspace,
          target: typeof args.path === "string" ? args.path : ".",
          maxResults: args.maxResults,
          allowOutsideWorkspace,
          signal,
        });
      case "update_plan":
        return { output: "Plan updates are handled by the agent runtime.", ok: true };
      case "memory_read": {
        const scope = parseMemoryScope(args.scope);
        const name = String(args.name ?? "").trim();
        if (!scope) {
          return { ok: false, output: 'memory_read requires scope "user" or "project".' };
        }
        if (!isValidMemoryName(name)) {
          return {
            ok: false,
            output: `Invalid memory name "${name}": use lowercase kebab-case (letters, digits, hyphens).`,
          };
        }
        const record = await readMemory(memoryDirFor(scope, workspace), name);
        if (!record) {
          return {
            ok: false,
            output: `Memory "${name}" not found in ${scope} scope. The Memory index in the system instructions lists the saved entries.`,
          };
        }
        return toolResult(record.raw);
      }
      case "memory_write": {
        const scope = parseMemoryScope(args.scope);
        const name = String(args.name ?? "").trim();
        if (!scope) {
          return { ok: false, output: 'memory_write requires scope "user" or "project".' };
        }
        if (!isValidMemoryName(name)) {
          return {
            ok: false,
            output: `Invalid memory name "${name}": use lowercase kebab-case (letters, digits, hyphens).`,
          };
        }
        const description = String(args.description ?? "").trim();
        const content = String(args.content ?? "");
        if (!description || !content.trim()) {
          return {
            ok: false,
            output: "memory_write requires a one-line description and the memory content.",
          };
        }
        const result = await saveMemory(memoryDirFor(scope, workspace), name, {
          description,
          content,
        });
        return toolResult(
          `${result.existed ? "Updated" : "Saved"} ${scope} memory "${name}" (index updated).`,
        );
      }
      case "memory_delete": {
        const scope = parseMemoryScope(args.scope);
        const name = String(args.name ?? "").trim();
        if (!scope) {
          return { ok: false, output: 'memory_delete requires scope "user" or "project".' };
        }
        if (!isValidMemoryName(name)) {
          return {
            ok: false,
            output: `Invalid memory name "${name}": use lowercase kebab-case (letters, digits, hyphens).`,
          };
        }
        const removed = await deleteMemory(memoryDirFor(scope, workspace), name);
        if (!removed) {
          return { ok: false, output: `Memory "${name}" not found in ${scope} scope.` };
        }
        return toolResult(`Deleted ${scope} memory "${name}".`);
      }
      case "session_search":
        return await runSessionSearchTool(args, workspace, options.sessionSearch);
      default:
        return { output: `Unknown tool: ${name}`, ok: false };
    }
  } catch (error) {
    return { output: error instanceof Error ? error.message : String(error), ok: false };
  }
}

async function listDir(workspace: string, target: string, allowOutsideWorkspace = false): Promise<ToolResult> {
  const dir = await resolveToolPath(workspace, target, allowOutsideWorkspace);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !IGNORED_ENTRY_NAMES.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const lines = visible.map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);
  if (!lines.length) {
    lines.push("(empty)");
  }
  const budget = MAX_LIST_DIR_TOKENS - 100;
  let shown = 0;
  let used = 0;
  for (const line of lines) {
    if (shown >= MAX_LIST_ENTRIES || used + estimateTokens(line) + 1 > budget) break;
    used += estimateTokens(line) + 1;
    shown += 1;
  }
  if (shown === lines.length) {
    return { output: lines.join("\n"), ok: true };
  }
  const full = lines.join("\n");
  const saved = await persistToolOutput(workspace, "list_dir", full).catch(() => null);
  const notice = saved
    ? `\n... [truncated: showing first ${shown} of ${lines.length} entries; full list saved to ${saved}]`
    : `\n... [truncated: ${lines.length - shown} more entries]`;
  return {
    output: lines.slice(0, shown).join("\n") + notice,
    ok: true,
    ...(saved ? { spilled: saved } : {}),
  };
}

/** read_file 能直接当图片交给模型的扩展名 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 单张图片上限：超过就自动缩图；缩不了则「卸载」并说明，避免一次请求把上下文和带宽打满。 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** 图片长边上限：Anthropic 推荐的 1568px；小图不重编码，大图按这个边长缩。 */
const MAX_IMAGE_EDGE = 1_568;

/**
 * 超限图片的降级路径：先试自动缩图（桌面端 nativeImage），成功就附缩图；
 * 不可用或失败则「卸载」——返回 ok 的文字说明而不是硬报错，
 * 模型可以改用别的手段（缩放/裁剪后再读）继续任务，而不是整个工具调用失败。
 */
async function attachOversizedImage(
  file: string,
  name: string,
  imageMime: string,
  size: number,
  shrink: ToolRunOptions["shrinkImage"],
  signal?: AbortSignal,
): Promise<ToolResult> {
  const limitMb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
  const originalMb = (size / (1024 * 1024)).toFixed(1);
  if (shrink) {
    const result: {
      ok: boolean;
      data?: string;
      mimeType?: string;
      width?: number;
      height?: number;
      bytes?: number;
      originalWidth?: number;
      originalHeight?: number;
      error?: string;
    } = await shrink({ path: file, maxBytes: MAX_IMAGE_BYTES, maxEdge: MAX_IMAGE_EDGE }, signal).catch(
      (error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    if (result.ok && result.data) {
      const from =
        result.originalWidth && result.originalHeight
          ? `${result.originalWidth}x${result.originalHeight} `
          : "";
      const to = result.width && result.height ? `${result.width}x${result.height} ` : "";
      const shrunkMb = result.bytes ? `${(result.bytes / (1024 * 1024)).toFixed(1)}MB ` : "";
      return {
        ok: true,
        output: `Image ${name} was ${originalMb}MB (over the ${limitMb}MB limit); auto-downscaled from ${from}to ${to}(${shrunkMb}${result.mimeType ?? imageMime}) and attached. Note it is a downscaled copy, not the original file.`,
        images: [{ data: result.data, mimeType: result.mimeType ?? "image/png" }],
      };
    }
    return {
      ok: true,
      output: `Image ${name} is ${originalMb}MB, over the ${limitMb}MB attach limit${
        result.error ? ` and could not be downscaled automatically (${result.error})` : ""
      }. It was NOT attached. Downscale or crop it first (e.g. via run_command) and read it again.`,
    };
  }
  return {
    ok: true,
    output: `Image ${name} is ${originalMb}MB, over the ${limitMb}MB attach limit, and no image resizer is available in this environment. It was NOT attached. Downscale or crop it first and read it again.`,
  };
}

async function readFile(options: {
  workspace: string;
  target: string;
  offset?: unknown;
  limit?: unknown;
  /** PDF 页范围表达式 */
  pages?: unknown;
  allowOutsideWorkspace?: boolean;
  vision?: boolean;
  /** 模型接受 PDF 文档块：扫描件回退成原生 document */
  pdfDocuments?: boolean;
  shrinkImage?: ToolRunOptions["shrinkImage"];
  signal?: AbortSignal;
}): Promise<ToolResult> {
  const {
    workspace,
    target,
    offset,
    limit,
    pages,
    allowOutsideWorkspace = false,
    vision = false,
    shrinkImage,
    signal,
  } = options;
  const file = await resolveToolPath(workspace, target, allowOutsideWorkspace);
  const name = path.basename(file);
  // PDF 走独立的文本层通道：不进"按行切片"的文本路径（二进制会被读成乱码）
  if (path.extname(file).toLowerCase() === ".pdf") {
    return readPdfFile({
      workspace,
      file,
      name,
      pages: typeof pages === "string" ? pages : undefined,
      pdfDocuments: options.pdfDocuments === true,
    });
  }
  const imageMime = IMAGE_MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (imageMime && vision) {
    const info = await fs.stat(file).catch(() => null);
    if (!info?.isFile()) return { ok: false, output: `File not found: ${name}` };
    if (info.size > MAX_IMAGE_BYTES) {
      return attachOversizedImage(file, name, imageMime, info.size, shrinkImage, signal);
    }
    // 体积没超限也可能边长很大（4K 截图压得很小）：按长边再问一次缩图器，
    // 只有原图边长确实超限才替换；小图继续用原字节，避免无谓重编码。
    if (shrinkImage) {
      const shrunk = await shrinkImage(
        { path: file, maxBytes: MAX_IMAGE_BYTES, maxEdge: MAX_IMAGE_EDGE },
        signal,
      ).catch(() => null);
      if (shrunk?.ok && shrunk.data) {
        const edgeExceeded =
          (shrunk.originalWidth ?? 0) > MAX_IMAGE_EDGE ||
          (shrunk.originalHeight ?? 0) > MAX_IMAGE_EDGE;
        if (edgeExceeded) {
          const from =
            shrunk.originalWidth && shrunk.originalHeight
              ? `from ${shrunk.originalWidth}x${shrunk.originalHeight} `
              : "";
          const to = shrunk.width && shrunk.height ? `to ${shrunk.width}x${shrunk.height} ` : "";
          const bytes = shrunk.bytes ? `${(shrunk.bytes / (1024 * 1024)).toFixed(1)}MB ` : "";
          return {
            ok: true,
            output: `Image ${name} was auto-downscaled ${from}${to}(${bytes}${shrunk.mimeType ?? imageMime}) by long-edge limit and attached. Note it is a downscaled copy, not the original file.`,
            images: [{ data: shrunk.data, mimeType: shrunk.mimeType ?? imageMime }],
          };
        }
      }
    }
    const bytes = await fs.readFile(file);
    return {
      ok: true,
      output: `Image ${name} (${imageMime}, ${info.size} bytes) is attached. Look at it directly.`,
      images: [{ data: bytes.toString("base64"), mimeType: imageMime }],
    };
  }
  const read = await readTextFile(file, { headOnly: true });
  if (!read.ok) return textFileProblem(name, read);
  // 登记"模型看过这一版"，后续编辑才能判断文件是否被外部改动
  await recordRead(file);
  const start = Math.max(1, Number(offset ?? 1) || 1);
  const maxLines = Math.max(1, Number(limit ?? MAX_READ_LINES) || MAX_READ_LINES);
  // 与 @文件注入共用切片器：两条通道给模型的格式必须一致
  const slice = sliceLinesForModel(read.file.content, {
    budget: MAX_READ_TOKENS - 300,
    cost: estimateTokens,
    start,
    maxLines,
  });
  const oversizedNotice = read.file.oversized
    ? `\n... [file is ${read.file.size} bytes; only the first ${MAX_TEXT_BYTES} were read]`
    : "";

  // 超长文件且一屏读不完：头尾预览 + 全文落盘。模型拿到落盘路径后用
  // read_file (offset/limit) 续读，不必对原文件一页页 offset 翻。
  // 读的本来就是落盘产物时不再落第二份：否则「读产物 → 生成新产物」会自我增殖
  if (
    !isInsideToolOutput(workspace, file) &&
    estimateTokens(read.file.content) > READ_SAVE_THRESHOLD_TOKENS &&
    slice.shown < slice.total
  ) {
    const saved = await persistToolOutput(workspace, "read_file", read.file.content).catch(
      () => null,
    );
    const lines = read.file.content.split(/\r?\n/);
    const total = slice.total;
    const tailStart = Math.max(1, total - READ_TAIL_PREVIEW_LINES + 1);
    const tailText = lines
      .slice(tailStart - 1)
      .map((line, index) => `${tailStart + index}: ${line}`)
      .join("\n");
    // 尾部预览只保留最后若干 token：尾部也可能有超长行（压缩过的构建产物）
    const tail = truncateToTokens(tailText, READ_TAIL_PREVIEW_TOKENS, { headRatio: 0 }).text;
    // 头段预算 = 总预算 - 尾段实际占用，保证头尾加起来不超过单次工具输出上限
    const headBudget = Math.max(500, MAX_READ_TOKENS - 300 - estimateTokens(tail) - 200);
    const head = sliceLinesForModel(read.file.content, {
      budget: headBudget,
      cost: estimateTokens,
      start,
      // 尊重调用方显式给的 limit；默认情形才用 100 行预览
      maxLines: Math.min(maxLines, READ_HEAD_PREVIEW_LINES),
      omitNotes: true,
    });
    if (tailStart <= head.lastLine) {
      // 头段已经覆盖到文件末尾（例如模型明确从靠后位置开始读），不重复给尾段
      const suffix = saved ? `\n... [full content of ${name} saved to ${saved}]` : "";
      return {
        output: `${head.text}${oversizedNotice}${suffix}`,
        ok: true,
        readRange: { start, end: head.lastLine, total },
        ...(saved ? { spilled: saved } : {}),
      };
    }
    const omitted = tailStart - head.lastLine - 1;
    const hint = saved
      ? `\n... [${omitted} lines omitted; full content of ${name} saved to ${saved} — read that path with read_file (offset/limit) to page through]`
      : `\n... [${omitted} lines omitted; use offset=${head.lastLine + 1} to continue]`;
    // 头尾预览不是连续区间，只登记头段：区间去重宁可少算，不能把没给过的行算成已读
    return {
      output: `${head.text}${hint}\n${tail}${oversizedNotice}`,
      ok: true,
      readRange: { start, end: head.lastLine, total },
      ...(saved ? { spilled: saved } : {}),
    };
  }

  const output = read.file.oversized
    ? `${slice.text}${oversizedNotice}`
    : slice.text;
  return { output, ok: true, readRange: { start, end: slice.lastLine, total: slice.total } };
}

/**
 * PDF 读取：先抽文本层（便宜），扫描件才回退成原生 document（贵但唯一可行）。
 * 模型没有 pdf 模态时给出可操作提示而不是硬报错 —— 用户可能只是没勾选模态。
 */
async function readPdfFile(options: {
  workspace: string;
  file: string;
  name: string;
  pages?: string;
  pdfDocuments: boolean;
}): Promise<ToolResult> {
  const result = await readPdfText({
    file: options.file,
    name: options.name,
    pages: options.pages,
    workspace: options.workspace,
  });
  if (!result.ok) return { ok: false, output: result.output };
  if (!result.scanned) return { ok: true, output: result.output };

  if (!options.pdfDocuments) {
    return {
      ok: true,
      output: `${result.output}\n[This looks like a scanned PDF with no usable text layer. To let the model read it directly, enable the "PDF" input modality for this model in Settings → Models (Anthropic / Responses endpoints only), or convert the pages to images and read those.]`,
    };
  }
  const data = await readPdfBase64(options.file);
  if (!data) {
    return { ok: true, output: `${result.output}\n[The original file could not be read for attachment.]` };
  }
  return {
    ok: true,
    output: `${result.output}\n[The original PDF is attached as a document — read it directly; the text above is only what the text layer yielded.]`,
    documents: [{ data, mimeType: "application/pdf", name: options.name }],
  };
}

/** read_many 单次最多读多少个文件：常量在 tool-contract（门禁与执行同源），这里只转出手。 */
export { READ_MANY_MAX_PATHS };
/** read_many 单个文件的最低预算（tokens）：低于这个数宁可跳过该文件（读了也是碎片）。 */
const READ_MANY_MIN_FILE_TOKENS = 600;

/**
 * 批量读的「预算已耗尽」分支：给头几行 + 全文落盘。
 *
 * 只回一句「自己用 read_file」会逼模型为了看开头再发一次调用 ——
 * 那是一次整轮上下文重发，比多给 800 字符贵得多。
 */
async function overflowSection(
  workspace: string,
  target: string,
  file: string,
  remaining: number,
): Promise<string> {
  const fallback = `=== ${target} ===\n[skipped: output budget exhausted — use read_file for this path]`;
  const previewBudget = Math.min(600, remaining - 100);
  if (previewBudget < 200) return fallback;
  const ext = path.extname(file).toLowerCase();
  // 图片/PDF 走 read_file 专用通道，批量切片会读成乱码
  if (IMAGE_MIME_BY_EXT[ext] || ext === ".pdf") return fallback;
  const read = await readTextFile(file, { headOnly: true });
  if (!read.ok) return `=== ${target} ===\n${textFileProblem(path.basename(file), read).output}`;
  await recordRead(file);
  const preview = sliceLinesForModel(read.file.content, {
    budget: previewBudget,
    cost: estimateTokens,
    maxLines: 20,
  });
  const saved = await persistToolOutput(workspace, "read_many", read.file.content).catch(() => null);
  const rest = Math.max(0, preview.total - preview.lastLine);
  const hint = saved
    ? `... [${rest} more lines; full content saved to ${saved} — read that path with read_file (offset/limit)]`
    : `... [${rest} more lines; use read_file for this path]`;
  return `=== ${target} ===\n${preview.text}\n${hint}`;
}

/**
 * 批量只读：一次调用读多个文本文件，替代同一批 N 次 read_file。
 * 收益不在"能并行"（模型本来就可以一条消息发多个调用），而在：
 *  1) 每个文件结果省掉一次 tool 消息包装（call id / role / 分隔）；
 *  2) 总预算公平分摊，防止单个超长文件吃光整批预算；
 *  3) 给模型一个明确的"批量读"入口，减少为省 token 逐个读的倾向 ——
 *     每省一次往返就省一次全上下文重发。
 */
async function readMany(
  workspace: string,
  rawPaths: string[],
  limit: unknown,
  allowOutsideWorkspace = false,
  options?: ToolRunOptions,
): Promise<ToolResult> {
  // 去重保序：重复路径只读一次，结果位置不变
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of rawPaths) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
    if (paths.length >= READ_MANY_MAX_PATHS) break;
  }
  if (!paths.length) {
    return { ok: false, output: "read_many requires a non-empty \"paths\" array." };
  }

  const totalBudget = MAX_READ_MANY_TOKENS - 200;
  // 公平分摊：每个文件预算 = 总预算 / 文件数；调用方显式 limit 会进一步收紧单文件行数
  const perFileBudget = Math.max(
    READ_MANY_MIN_FILE_TOKENS,
    Math.floor(totalBudget / paths.length),
  );
  const maxLines = Math.max(1, Number(limit ?? 0) || Number.MAX_SAFE_INTEGER);

  const sections: string[] = [];
  const readRanges: Array<{ path: string; start: number; end: number; total: number }> = [];
  let used = 0;
  // 归一化去重：./a.ts 与 a.ts 是同一个文件，不能读两遍
  const seenFiles = new Set<string>();
  for (const target of paths) {
    const remaining = totalBudget - used;
    const file = await resolveToolPath(workspace, target, allowOutsideWorkspace).catch(
      () => null,
    );
    const name = path.basename(file ?? target);
    if (!file) {
      const section = `=== ${target} ===\nError: path is outside the workspace.`;
      sections.push(section);
      used += estimateTokens(section);
      continue;
    }
    // 去重放在预算判断之前：重复路径不该在「预算耗尽」分支被预览 + 落盘两次
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    // 剩余预算不够再读一个文件：给头几行 + 全文落盘。
    // 只回一句「自己用 read_file」会逼模型为看开头再发一次调用，那是整轮上下文重发。
    if (sections.length && remaining < READ_MANY_MIN_FILE_TOKENS) {
      const section = await overflowSection(workspace, target, file, remaining);
      sections.push(section);
      used += estimateTokens(section);
      continue;
    }
    // 之前已完整读过且文件没变：正文不必再发一遍（省 token，不省 I/O）
    if (options?.readCoverage && (await options.readCoverage(target).catch(() => false))) {
      const section = `=== ${target} ===\n[already read in full earlier this session and unchanged — reuse that result]`;
      sections.push(section);
      used += estimateTokens(section);
      continue;
    }
    // 图片/二进制不在批量通道里处理：read_file 才有图片附加与缩图逻辑
    if (IMAGE_MIME_BY_EXT[path.extname(file).toLowerCase()]) {
      const section = `=== ${target} ===\n[image file — use read_file to attach it as a picture]`;
      sections.push(section);
      used += estimateTokens(section);
      continue;
    }
    // PDF 同理：批量通道按行切片会读出乱码，必须走 read_file 的文本层通道
    if (path.extname(file).toLowerCase() === ".pdf") {
      const section = `=== ${target} ===\n[PDF — use read_file with pages="1-20" to extract its text layer]`;
      sections.push(section);
      used += estimateTokens(section);
      continue;
    }
    const read = await readTextFile(file, { headOnly: true });
    if (!read.ok) {
      const section = `=== ${target} ===\n${textFileProblem(name, read).output}`;
      sections.push(section);
      used += estimateTokens(section);
      continue;
    }
    // 登记逐文件读状态：之后 edit_file 才能判断「模型看到的版本是否最新」
    await recordRead(file);
    const fileBudget = Math.min(perFileBudget, remaining);
    const slice = sliceLinesForModel(read.file.content, {
      budget: fileBudget,
      cost: estimateTokens,
      maxLines,
    });
    const oversizedNotice = read.file.oversized
      ? `\n... [file is ${read.file.size} bytes; only the first ${MAX_TEXT_BYTES} were read]`
      : "";
    const continuation =
      slice.lastLine < slice.total && !read.file.oversized
        ? `\n... [${slice.total - slice.lastLine} more lines; use read_file ${target} offset=${slice.lastLine + 1}]`
        : "";
    const section = `=== ${target} ===\n${slice.text}${continuation}${oversizedNotice}`;
    sections.push(section);
    // 预算按实际输出长度记账：估算值会让后续文件的可读空间漂移
    used += estimateTokens(section);
    if (slice.lastLine >= 1) {
      readRanges.push({ path: target, start: 1, end: slice.lastLine, total: slice.total });
    }
  }
  // 头部按实际段落数算：文件级去重后 paths.length 可能大于真正读到的文件数
  const header = sections.length > 1 ? `Read ${sections.length} files://n` : "";
  return {
    ok: true,
    output: `${header}${sections.join("\n\n")}`,
    ...(readRanges.length ? { readRanges } : {}),
  };
}

/** 原子写入：先写同目录临时文件再 rename，避免写一半崩进程把文件截断。 */
async function writeFileAtomic(file: string, data: string): Promise<void> {
  const temp = `${file}.meowcode-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, data, "utf8");
    await fs.rename(temp, file);
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    // rename 失败（目标被别的进程占用）时退回直接写：宁可非原子，也不能让编辑丢掉
    await fs.writeFile(file, data, "utf8");
  }
}

/**
 * 整文件重写护栏：新内容保留了大部分旧行时，edit_file 便宜一个数量级。
 * 只在文件足够大时生效，避免拦掉小文件或生成文件的正常覆盖。
 */
function rewriteGuard(name: string, before: string, content: string): string | undefined {
  const beforeLines = before.split(/\r?\n/);
  if (beforeLines.at(-1) === "") beforeLines.pop();
  if (beforeLines.length < 40) return undefined;
  const afterLines = content.replace(/\r\n/g, "\n").split("\n");
  if (afterLines.at(-1) === "") afterLines.pop();
  const pool = new Map<string, number>();
  for (const line of beforeLines) pool.set(line, (pool.get(line) ?? 0) + 1);
  let kept = 0;
  for (const line of afterLines) {
    const count = pool.get(line) ?? 0;
    if (count > 0) {
      kept += 1;
      pool.set(line, count - 1);
    }
  }
  const changed = afterLines.length - kept;
  const ratio = changed / Math.max(1, Math.max(beforeLines.length, afterLines.length));
  if (ratio >= 0.35) return undefined;
  return (
    `write_file refused: this rewrite only changes ${Math.round(ratio * 100)}% of ${beforeLines.length} lines. ` +
    "Use edit_file or multi_edit instead — they cost a fraction of the tokens. " +
    "If a full rewrite is really intended, call write_file again with force: true."
  );
}

/**
 * not-found 时给模型可行动的线索：最近似的行 + 行号，小文件直接附全文。
 * 这比"再读一次文件"便宜得多（一次 400 行读 ≈ 4k token + 一个往返）。
 */
function notFoundHint(content: string, oldString: string): string {
  const lines = content.split(/\r?\n/);
  const notes: string[] = [];
  if (/^\s*\d+:\s/m.test(oldString)) {
    notes.push(
      'Hint: oldString contains "123: " style line numbers. read_file adds those for display only — retry without them.',
    );
  }
  const firstLine = oldString.split(/\r?\n/).find((line) => line.trim());
  const needle = (firstLine ?? "").replace(/^\s*\d+:\s?/, "").trim();
  if (!needle) return notes.length ? `\n${notes.join("\n")}` : "";
  const candidates: string[] = [];
  const lower = needle.toLowerCase();
  for (let index = 0; index < lines.length && candidates.length < 3; index += 1) {
    if (lines[index].toLowerCase().includes(lower)) {
      candidates.push(`  L${index + 1}: ${lines[index].slice(0, 200)}`);
    }
  }
  if (candidates.length) {
    notes.push(`Closest lines in the file:\n${candidates.join("\n")}`);
  } else if (lines.length <= 80) {
    const body = lines.map((line, index) => `${index + 1}: ${line}`).join("\n").slice(0, 4000);
    notes.push(`The file has ${lines.length} lines. Current content:\n${body}`);
  } else {
    notes.push(
      `The file has ${lines.length} lines and no line contains "${needle.slice(0, 60)}". Re-read the region you meant to change.`,
    );
  }
  return `\n${notes.join("\n")}`;
}

/** not-unique 时列出全部命中行号，并给出两条出路（补上下文 / replaceAll）。 */
function notUniqueHint(content: string, positions: number[]): string {
  const shown = positions.slice(0, 8).map((offset) => `L${lineOfOffset(content, offset)}`);
  const more = positions.length > shown.length ? ` (+${positions.length - shown.length} more)` : "";
  return (
    `\nFound ${positions.length} matches at ${shown.join(", ")}${more}. ` +
    "Add surrounding lines to make it unique, or pass replaceAll: true to change every occurrence."
  );
}

/** 编辑回执：改动片段 + "不用再读"，直接掐掉模型复核读的那一次往返。 */
function editReceipt(
  name: string,
  before: string,
  after: string,
  count: number,
  level: EditLevel,
): string {
  const lines = [count > 1 ? `Edited ${name} (${count} replacements)` : `Edited ${name}`];
  if (level !== "exact") lines.push(`Note: ${LEVEL_LABEL[level]}.`);
  const snippet = renderChangeSnippet(name, before, after);
  if (snippet) lines.push(snippet);
  lines.push("File is up to date; no need to re-read.");
  return lines.join("\n");
}

async function writeFile(
  workspace: string,
  target: string,
  content: string,
  allowOutsideWorkspace = false,
  force = false,
): Promise<ToolResult> {
  const file = await resolveToolPath(workspace, target, allowOutsideWorkspace);
  const name = path.basename(file);
  // 覆盖已有文件时沿用它的行尾与 BOM：否则整文件重写会把 CRLF 仓库变成全文件 diff
  const existing = await readTextFile(file);
  if (!existing.ok && existing.reason !== "missing") return textFileProblem(name, existing);
  if (existing.ok && !force) {
    const guard = rewriteGuard(name, existing.file.content, content);
    if (guard) return { output: guard, ok: false };
  }
  const next = shapeForWrite(content, existing.ok ? existing.file : undefined);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, next);
  await recordWrite(file);
  const bytes = Buffer.byteLength(next, "utf8");
  const head = existing.ok ? `Wrote ${name} (${bytes} bytes)` : `Created ${name} (${bytes} bytes)`;
  return toolResult(`${head}\nFile is up to date; no need to re-read.`);
}

async function editFile(
  workspace: string,
  target: string,
  oldString: string,
  newString: string,
  allowOutsideWorkspace = false,
  replaceAll = false,
): Promise<ToolResult> {
  const file = await resolveToolPath(workspace, target, allowOutsideWorkspace);
  const name = path.basename(file);
  const read = await readTextFile(file);
  if (!read.ok) return textFileProblem(name, read);
  const stale = await changedSinceRead(file);
  const outcome = applyTextEdit(read.file.content, oldString, newString, { replaceAll });
  if (!outcome.ok) {
    const output =
      outcome.reason === "not-found"
        ? `oldString was not found in ${name}.${notFoundHint(read.file.content, oldString)}`
        : `oldString is not unique in ${name}.${notUniqueHint(read.file.content, outcome.positions)}`;
    return { output, ok: false };
  }
  await writeFileAtomic(file, withBom(outcome.content, read.file.bom));
  await recordWrite(file);
  const receipt = editReceipt(name, read.file.content, outcome.content, outcome.count, outcome.level);
  return toolResult(
    stale
      ? `${receipt}\nNote: the file had changed on disk since your last read; the edit applied to the current content.`
      : receipt,
  );
}

/** 一次调用改多处（可跨文件）：先在内存里全部算完，再逐文件原子写；写失败回滚已写的。 */
async function multiEdit(
  workspace: string,
  input: unknown,
  allowOutsideWorkspace = false,
): Promise<ToolResult> {
  const groups = readMultiEditGroups(input);
  if (typeof groups === "string") return { output: groups, ok: false };

  type Plan = {
    file: string;
    name: string;
    target: string;
    before: string;
    bom: boolean;
    after: string;
    count: number;
    level: EditLevel;
    stale: boolean;
  };
  const plans: Plan[] = [];
  // 第一阶段：所有文件的匹配与替换都在内存里完成。任一失败 → 一个字节都不写。
  for (const group of groups) {
    let file: string;
    try {
      file = await resolveToolPath(workspace, group.path, allowOutsideWorkspace);
    } catch (error) {
      return {
        output: `multi_edit aborted; nothing was written. ${error instanceof Error ? error.message : String(error)}`,
        ok: false,
      };
    }
    const name = path.basename(file);
    const read = await readTextFile(file);
    if (!read.ok) {
      return {
        output: `multi_edit aborted; nothing was written. ${textFileProblem(name, read).output}`,
        ok: false,
      };
    }
    let content = read.file.content;
    let count = 0;
    const levels = new Set<EditLevel>();
    for (let index = 0; index < group.edits.length; index += 1) {
      const edit = group.edits[index];
      const outcome = applyTextEdit(content, edit.oldString, edit.newString, {
        replaceAll: edit.replaceAll,
      });
      if (!outcome.ok) {
        const detail =
          outcome.reason === "not-found"
            ? `oldString was not found.${notFoundHint(content, edit.oldString)}`
            : `oldString is not unique.${notUniqueHint(content, outcome.positions)}`;
        const where = groups.length > 1 ? `${group.path} ` : "";
        return {
          output: `multi_edit aborted at ${where}edit #${index + 1} of ${group.edits.length}; nothing was written. ${detail}`,
          ok: false,
        };
      }
      content = outcome.content;
      count += outcome.count;
      levels.add(outcome.level);
    }
    if (content === read.file.content) continue;
    plans.push({
      file,
      name,
      target: group.path,
      before: read.file.content,
      bom: read.file.bom,
      after: content,
      count,
      level: [...levels].find((item) => item !== "exact") ?? "exact",
      stale: await changedSinceRead(file),
    });
  }
  if (!plans.length) return toolResult("multi_edit: the edits produced no changes.");

  // 第二阶段：逐文件原子写。中途失败就把已写的恢复原样，绝不留下"改了一半"的工作区。
  const written: Plan[] = [];
  for (const plan of plans) {
    try {
      await writeFileAtomic(plan.file, withBom(plan.after, plan.bom));
      await recordWrite(plan.file);
      written.push(plan);
    } catch (error) {
      const restored: string[] = [];
      const failedRestore: string[] = [];
      for (const done of [...written].reverse()) {
        try {
          await writeFileAtomic(done.file, withBom(done.before, done.bom));
          await recordWrite(done.file);
          restored.push(done.name);
        } catch {
          failedRestore.push(done.name);
        }
      }
      const rollback = failedRestore.length
        ? `Rollback FAILED for ${failedRestore.join(", ")}; restore those files manually.`
        : restored.length
          ? `Already-written files were restored (${restored.join(", ")}).`
          : "No files were written.";
      const message = error instanceof Error ? error.message : String(error);
      return {
        output: `multi_edit failed while writing ${plan.target}; nothing was left half-applied. ${rollback} ${message}`,
        ok: false,
      };
    }
  }

  const stale = plans.filter((plan) => plan.stale).map((plan) => plan.name);
  if (plans.length === 1) {
    const plan = plans[0];
    const receipt = editReceipt(plan.name, plan.before, plan.after, plan.count, plan.level);
    return toolResult(
      stale.length
        ? `${receipt}\nNote: the file had changed on disk since your last read; the edits applied to the current content.`
        : receipt,
    );
  }
  const lines = [`multi_edit: ${plans.length} files updated`];
  for (const plan of plans) {
    lines.push(`- ${plan.target} (${plan.count} replacement${plan.count === 1 ? "" : "s"})`);
  }
  if (stale.length) {
    lines.push(
      `Note: ${stale.join(", ")} had changed on disk since your last read; the edits applied to the current content.`,
    );
  }
  lines.push("Files are up to date; no need to re-read.");
  return toolResult(lines.join("\n"));
}

/** ToolResult 适配层：执行面只回原始字节，这里保留原有的截断/落盘/文案语义。 */
/**
 * 命令语法写错时的定向纠错。
 *
 * 系统提示词里的 BASE 只剩 2 token 余量，塞不进 PowerShell 速查；工具描述能放一小段，
 * 但真正省 token 的做法是「只在写错的那一次付一行」—— 本仓已有这个范式
 * （write_file refused、use offset=N、Hint: oldString contains "123: "）。
 */
const SHELL_MISUSE_HINTS: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /is not recognized as the name of a cmdlet|The term '[^']*' is not recognized/i,
    hint: "PowerShell doesn't have that command: Get-ChildItem (ls/find), Get-Content (cat/head/tail), Select-String (grep), Remove-Item -Recurse -Force (rm -rf), Copy-Item/Move-Item (cp/mv).",
  },
  {
    pattern: /'&&' is not a valid separator|unexpected token '&&'|token '&&' is not a valid statement separator/i,
    hint: "Windows PowerShell 5.1 has no && / ||: chain the steps with ';' (or make separate run_command calls).",
  },
  {
    pattern: /(^|\n)\s*(export|sudo|chmod|chown|apt|apt-get|brew)\b/i,
    hint: "Bash built-ins don't exist here: set env vars with $env:NAME='value', and there is no sudo (the process already runs as you).",
  },
];

function shellMisuseHint(output: string): string | undefined {
  for (const { pattern, hint } of SHELL_MISUSE_HINTS) {
    if (pattern.test(output)) return hint;
  }
  return undefined;
}

/** 超时最常见的原因就是命令在等 stdin（而这条执行面没有 stdin 通道）。 */
const TIMEOUT_HINT =
  "If it was waiting for input (Read-Host, pause, a password prompt, git commit without -m), there is no stdin — pass the flags instead. If it is a dev server or watcher, use background=true.";

async function runCommand(
  workspace: string,
  command: string,
  signal?: AbortSignal,
  sandbox?: "enforce" | "bypass",
): Promise<ToolResult> {
  if (!command.trim()) {
    return { output: "command is empty.", ok: false };
  }
  if (signal?.aborted) {
    return { output: "Command aborted by the user.", ok: false };
  }
  const result = await runShellCommand({
    workspace,
    command,
    ...(signal ? { signal } : {}),
    ...(sandbox ? { sandbox } : {}),
  });
  if (result.sandboxUnavailable) {
    return {
      output: `Command was not run: the command sandbox is unavailable (${result.sandboxUnavailable.code}: ${result.sandboxUnavailable.detail}). Fix or disable it in Settings, or run a command without the sandbox after approval.`,
      ok: false,
    };
  }
  const denial = result.sandboxed
    ? classifySandboxDenial({
        exitCode: result.code,
        output: result.combined,
        command,
        timedOut: result.timedOut,
        aborted: result.aborted,
        ...(result.spawnError ? { spawnError: result.spawnError } : {}),
        writableRoots: getSandboxSettings().writableRoots,
      })
    : undefined;
  const denied = (output: string): string =>
    denial ? `${output}\n[sandbox] The command was blocked by the write sandbox.` : output;
  const sandboxField = denial ? { sandboxDenial: denial } : {};
  // 命中「bash 写法」特征时给一行定向改写建议 —— 只在这一趟付 token。
  // 刻意不看退出码：PowerShell 的「命令不存在」是**非终止错误**，进程仍退出 0，
  // 只按 code 判断会漏掉最常见的那类写法错误。
  const misuse =
    !result.timedOut && !result.aborted ? shellMisuseHint(result.combined) : undefined;
  const report = (output: string): string => {
    const base = denied(output);
    return misuse ? `${base}\n[hint] ${misuse}` : base;
  };
  if (result.aborted) {
    return { output: "Command aborted by the user.", ok: false, ...sandboxField };
  }
  if (result.timedOut) {
    const partial = truncateMiddle(result.combined);
    const seconds = Math.round((result.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS) / 1000);
    return {
      output: denied(
        `Command timed out after ${seconds}s and was terminated.${partial.output ? `\n${partial.output}` : ""}\n[hint] ${TIMEOUT_HINT}`,
      ),
      ok: false,
      ...sandboxField,
    };
  }
  if (result.spawnError) {
    return { output: result.spawnError, ok: false, ...sandboxField };
  }
  const full = result.combined;
  const capped = result.capped;
  const preview = truncateMiddle(full);
  if (!preview.truncated && !capped) {
    return { output: report(preview.output), ok: result.code === 0, ...sandboxField };
  }
  try {
    const saved = await persistToolOutput(workspace, "run_command", full);
    return {
      output: report(
        `${preview.output}\n... [${
          capped
            ? `output was capped at ${MAX_COMMAND_OUTPUT_BYTES} bytes (first and last part kept); `
            : ""
        }the log is saved to ${saved}; read it with read_file]`,
      ),
      ok: result.code === 0,
      spilled: saved,
      ...sandboxField,
    };
  } catch {
    return { output: report(preview.output), ok: result.code === 0, ...sandboxField };
  }
}

