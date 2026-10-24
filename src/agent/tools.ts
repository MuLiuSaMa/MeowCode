import { spawn, type ChildProcess } from "node:child_process";
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
import { renderChangeSnippet } from "./diff.js";
import { readMultiEditGroups } from "./multi-edit.js";
import { readPdfBase64, readPdfText } from "./pdf.js";
import { grabFrames, grabStoryboard, probeVideo, type VideoToolResult } from "./video.js";
import { resolveToolPath, IGNORED_ENTRY_NAMES } from "./paths.js";
import { runCodeInSandbox, type HostToolBridge } from "./code-mode.js";
import { sliceLinesForModel } from "./read-slice.js";
import { changedSinceRead, recordRead, recordWrite } from "./read-state.js";
import { searchGlob, searchGrep } from "./search.js";
import type { ToolDefinition, ToolResult } from "./types.js";

const MAX_OUTPUT_CHARS = 20000;
/** 结构化搜索结果（grep/glob）超过这个长度就先落盘再降级，模型按需续读。 */
const STRUCTURED_OUTPUT_CHARS = 8_000;
const STRUCTURED_HEAD_CHARS = 4_000;
const MAX_COMMAND_OUTPUT_CHARS = 12000;
const MAX_COMMAND_HEAD_CHARS = 4000;
/** 命令输出采集上限：只保护内存，超出部分明确告知模型被截断 */
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const MAX_READ_LINES = 400;
/**
 * read_file 超长文件落盘阈值：文件超过这个字符数且一屏读不完时，
 * 只内联头尾预览、全文落盘，避免模型靠 offset 一页页翻大文件
 * （每翻一页都是一次全上下文重发）。
 */
const READ_SAVE_THRESHOLD_CHARS = 8_000;
const READ_HEAD_PREVIEW_LINES = 100;
const READ_TAIL_PREVIEW_LINES = 40;
const READ_TAIL_PREVIEW_CHARS = 4_000;
const MAX_LIST_ENTRIES = 500;
const TOOL_OUTPUT_DIR = path.join(".meowcode", "tool-output");
const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function truncateOutput(text: string, max = MAX_OUTPUT_CHARS): { output: string; truncated: boolean } {
  if (text.length <= max) {
    return { output: text, truncated: false };
  }
  return {
    output: `${text.slice(0, max)}\n... [truncated ${text.length - max} characters]`,
    truncated: true,
  };
}

/**
 * 命令输出保留头 + 尾：开头常有运行环境/首个错误，结尾常有汇总诊断。
 * 中段省略，完整内容由调用方落盘。
 */
export function truncateMiddle(
  text: string,
  max = MAX_COMMAND_OUTPUT_CHARS,
): { output: string; truncated: boolean; omitted: number; lines: number } {
  const lines = text.split(/\r?\n/).length;
  if (text.length <= max) return { output: text, truncated: false, omitted: 0, lines };
  const head = Math.min(MAX_COMMAND_HEAD_CHARS, Math.floor(max / 3));
  const tail = max - head;
  const omitted = text.length - max;
  return {
    output: `${text.slice(0, head)}\n... [truncated ${omitted} characters in the middle; ${lines} lines total]\n${text.slice(-tail)}`,
    truncated: true,
    omitted,
    lines,
  };
}

/** 超过预算的完整工具输出落到工作区，模型可用 read_file 继续读取。 */
async function persistToolOutput(workspace: string, tool: string, text: string): Promise<string> {
  // 输出目录也可能被替换成指向外部的 junction；与文件工具走同一套真实路径校验。
  const dir = await resolveToolPath(workspace, TOOL_OUTPUT_DIR);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${tool}-${stamp}-${randomUUID().slice(0, 8)}.log`);
  await fs.writeFile(file, text, "utf8");
  await cleanupToolOutput(dir);
  return path.relative(workspace, file).split(path.sep).join("/");
}

async function cleanupToolOutput(dir: string): Promise<void> {
  const cutoff = Date.now() - TOOL_OUTPUT_RETENTION_MS;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = path.join(dir, entry.name);
          try {
            const stat = await fs.stat(file);
            if (stat.mtimeMs < cutoff) await fs.unlink(file);
          } catch {
            // 并发清理或文件已消失不影响本次输出
          }
        }),
    );
  } catch {
    // 清理失败不应阻断工具结果
  }
}

function toolResult(output: string, ok = true): ToolResult {
  const truncated = truncateOutput(output);
  return { output: truncated.output, ok };
}

/**
 * 结构化搜索结果降级：超过预算时只留头部，完整结果落盘并给分页提示。
 *
 * 模型拿到落盘路径后可以用 read_file + offset 续读，不必重跑同一次搜索 ——
 * 重跑一次的成本（整个上下文重发）远高于读落盘文件。
 * 只用于 grep / glob：run_command 的输出是诊断信息，绝不能这样降级。
 */
export async function degradeStructuredOutput(
  workspace: string,
  tool: string,
  output: string,
): Promise<{ output: string; truncated: boolean }> {
  if (output.length <= STRUCTURED_OUTPUT_CHARS) {
    return { output, truncated: false };
  }
  // 尾部 "... [truncated ...]" / "... [no matches]" 之类的提示行要保留，否则模型不知道结果被截过
  const noticeMatch = output.match(/(\n\.\.\. \[[^\n]*\])+$/);
  const body = noticeMatch ? output.slice(0, noticeMatch.index) : output;
  const notice = noticeMatch ? noticeMatch[1] : "";
  const head = body.slice(0, STRUCTURED_HEAD_CHARS);
  const omitted = body.length - head.length;
  const saved = await persistToolOutput(workspace, tool, output).catch(() => null);
  const hint = saved
    ? `\n... [${omitted} more characters omitted; full result saved to ${saved} — page it with read_file (offset/limit) instead of re-running this search]`
    : `\n... [${omitted} more characters omitted; narrow the pattern to see more]`;
  return { output: head + hint + notice, truncated: true };
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

/** 这些变量即使命中敏感词也保留（系统运行必需） */
const SAFE_ENV_NAMES = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "OS",
]);

/** 凭据类环境变量：命令不应该能读到用户的 token/key/secret */
const SENSITIVE_ENV_PATTERN =
  /(^|_)(KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|COOKIE|SESSION)(_|$)/i;
// 只拦真正指向凭据的变量；AWS_REGION / NPM_CONFIG_* 这类普通配置继续继承
const SENSITIVE_ENV_PREFIXES = ["KUBECONFIG", "PGPASSFILE", "NETRC"];

/**
 * 子进程环境：剔除 MeowCode 自身与用户凭据，保留系统/路径等基础变量。
 * 与 codex 的 shell_environment_policy 同思路：命令默认不该继承 API key。
 */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^meowcode_/i.test(key)) continue;
    const upper = key.toUpperCase();
    if (SAFE_ENV_NAMES.has(upper)) {
      result[key] = value;
      continue;
    }
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    if (SENSITIVE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    result[key] = value;
  }
  return result;
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
        "Read a UTF-8 text file (default 400 lines; result reports the next offset). Images (png/jpg/webp/gif, max 4 MB) are attached when the model accepts them. PDFs: text layer, 20 pages per call — page with pages=\"1-5\".",
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
      description: "Run a PowerShell command in the workspace. Requires approval. Long output keeps head and tail; full log is saved under .meowcode/tool-output/.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "PowerShell command." },
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
        "Spawn a subagent for one self-contained task; only its report returns. Use proactively for multi-file exploration or independent implementation. It gets the current user request and plan itself — give a short description plus scope constraints; pick the role via agent_type. background=true returns immediately and notifies later. Max 3 per turn; batch related work. Writes follow the approval mode.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Short label shown in the UI.",
          },
          agent_type: {
            type: "string",
            enum: [...DEFAULT_AGENT_TYPES],
            description:
              "general = full tools (default); explore = read-only, cheapest; planner = plan; implementer = write+verify; reviewer = review findings; verifier = run checks; custom = user-defined (architecture graph).",
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
        "Replace the task checklist with short, current steps for multi-step work.",
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
        "Report context-window usage: tokens used, window size, remaining headroom, compaction recommendation. Zero side effects. Call it before large explorations or when a long session feels close to its limit.",
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
      name: "ask_user",
      description:
        "Ask the user clarifying questions and wait for the answers. Be PROACTIVE: if a decision would significantly change the outcome (audience, use case, style, tech choice, scope) and cannot be safely inferred, ASK instead of guessing. Batch ALL questions into ONE call (up to 4); never one call per question. Each question: 2-4 mutually exclusive short options; the user can also type a custom answer.",
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
  execute: (input: unknown, workspace: string, options: ToolRunOptions) => Promise<ToolResult>;
};

const dynamicTools = new Map<string, DynamicTool>();

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
  dynamicTools.set(name, tool);
  return { ok: true };
}

export function unregisterDynamicTool(name: string): void {
  dynamicTools.delete(name);
}

export function listDynamicToolDefinitions(): ToolDefinition[] {
  return [...dynamicTools.values()].map((t) => t.definition);
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
};

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
      const result = await dynamic.execute(input, workspace, options);
      const shaped = truncateOutput(result.output);
      return { ...result, output: shaped.output, truncated: shaped.truncated };
    }
    switch (name) {
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
        const degraded = await degradeStructuredOutput(workspace, "glob", result.output);
        return { ...result, output: degraded.output, truncated: degraded.truncated };
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
        const degraded = await degradeStructuredOutput(workspace, "grep", result.output);
        return { ...result, output: degraded.output, truncated: degraded.truncated };
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
        return await runCommand(workspace, String(args.command ?? ""), signal);
      case "update_plan":
        return { output: "Plan updates are handled by the agent runtime.", ok: true };
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
  const budget = MAX_OUTPUT_CHARS - 300;
  let shown = 0;
  let used = 0;
  for (const line of lines) {
    if (shown >= MAX_LIST_ENTRIES || used + line.length + 1 > budget) break;
    used += line.length + 1;
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
  return { output: lines.slice(0, shown).join("\n") + notice, ok: true };
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
    budget: MAX_OUTPUT_CHARS - 300,
    start,
    maxLines,
  });
  const oversizedNotice = read.file.oversized
    ? `\n... [file is ${read.file.size} bytes; only the first ${MAX_TEXT_BYTES} were read]`
    : "";

  // 超长文件且一屏读不完：头尾预览 + 全文落盘。模型拿到落盘路径后用
  // read_file (offset/limit) 续读，不必对原文件一页页 offset 翻。
  if (read.file.content.length > READ_SAVE_THRESHOLD_CHARS && slice.shown < slice.total) {
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
    // 尾部预览只保留最后若干字符：尾部也可能有超长行（压缩过的构建产物）
    const tail =
      tailText.length > READ_TAIL_PREVIEW_CHARS ? tailText.slice(-READ_TAIL_PREVIEW_CHARS) : tailText;
    // 头段预算 = 总预算 - 尾段实际占用，保证头尾加起来不超过单次工具输出上限
    const headBudget = Math.max(
      2_000,
      MAX_OUTPUT_CHARS - 300 - tail.length - 400,
    );
    const head = sliceLinesForModel(read.file.content, {
      budget: headBudget,
      start,
      // 尊重调用方显式给的 limit；默认情形才用 100 行预览
      maxLines: Math.min(maxLines, READ_HEAD_PREVIEW_LINES),
      omitNotes: true,
    });
    if (tailStart <= head.lastLine) {
      // 头段已经覆盖到文件末尾（例如模型明确从靠后位置开始读），不重复给尾段
      const suffix = saved ? `\n... [full content of ${name} saved to ${saved}]` : "";
      return { output: `${head.text}${oversizedNotice}${suffix}`, ok: true };
    }
    const omitted = tailStart - head.lastLine - 1;
    const hint = saved
      ? `\n... [${omitted} lines omitted; full content of ${name} saved to ${saved} — read that path with read_file (offset/limit) to page through]`
      : `\n... [${omitted} lines omitted; use offset=${head.lastLine + 1} to continue]`;
    return { output: `${head.text}${hint}\n${tail}${oversizedNotice}`, ok: true };
  }

  const output = read.file.oversized
    ? `${slice.text}${oversizedNotice}`
    : slice.text;
  return { output, ok: true };
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

/** read_many 单次最多读多少个文件：超过就要求模型分批，避免一次性灌爆输出预算。 */
export const READ_MANY_MAX_PATHS = 12;
/** read_many 单个文件的最低预算：低于这个数宁可跳过该文件（读了也是碎片）。 */
const READ_MANY_MIN_FILE_BUDGET = 1_500;

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

  const totalBudget = MAX_OUTPUT_CHARS - 300;
  // 公平分摊：每个文件预算 = 总预算 / 文件数；调用方显式 limit 会进一步收紧单文件行数
  const perFileBudget = Math.max(
    READ_MANY_MIN_FILE_BUDGET,
    Math.floor(totalBudget / paths.length),
  );
  const maxLines = Math.max(1, Number(limit ?? 0) || Number.MAX_SAFE_INTEGER);

  const sections: string[] = [];
  let used = 0;
  let skipped = 0;
  for (const target of paths) {
    // 剩余预算不够再读一个文件：剩余的全部标记 skipped（模型可用 read_file 单独续读）
    const remaining = totalBudget - used;
    if (sections.length && remaining < READ_MANY_MIN_FILE_BUDGET) {
      skipped += 1;
      sections.push(`=== ${target} ===\n[skipped: output budget exhausted — use read_file for this path]`);
      continue;
    }
    const file = await resolveToolPath(workspace, target, allowOutsideWorkspace).catch(
      () => null,
    );
    const name = path.basename(file ?? target);
    if (!file) {
      sections.push(`=== ${target} ===\nError: path is outside the workspace.`);
      continue;
    }
    // 图片/二进制不在批量通道里处理：read_file 才有图片附加与缩图逻辑
    if (IMAGE_MIME_BY_EXT[path.extname(file).toLowerCase()]) {
      sections.push(
        `=== ${target} ===\n[image file — use read_file to attach it as a picture]`,
      );
      continue;
    }
    // PDF 同理：批量通道按行切片会读出乱码，必须走 read_file 的文本层通道
    if (path.extname(file).toLowerCase() === ".pdf") {
      sections.push(
        `=== ${target} ===\n[PDF — use read_file with pages="1-20" to extract its text layer]`,
      );
      continue;
    }
    const read = await readTextFile(file, { headOnly: true });
    if (!read.ok) {
      sections.push(`=== ${target} ===\n${textFileProblem(name, read).output}`);
      continue;
    }
    // 登记逐文件读状态：之后 edit_file 才能判断"模型看到的版本是否最新"
    await recordRead(file);
    const fileBudget = Math.min(perFileBudget, remaining);
    const slice = sliceLinesForModel(read.file.content, {
      budget: fileBudget,
      maxLines,
    });
    const oversizedNotice = read.file.oversized
      ? `\n... [file is ${read.file.size} bytes; only the first ${MAX_TEXT_BYTES} were read]`
      : "";
    const continuation =
      slice.lastLine < slice.total && !read.file.oversized
        ? `\n... [${slice.total - slice.lastLine} more lines; use read_file ${target} offset=${slice.lastLine + 1}]`
        : "";
    sections.push(`=== ${target} ===\n${slice.text}${continuation}${oversizedNotice}`);
    used += Math.min(slice.text.length, fileBudget) + 40;
  }
  const header = paths.length > 1 ? `Read ${paths.length} files:\n` : "";
  return { ok: true, output: `${header}${sections.join("\n\n")}` };
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

/** Windows 上只 kill 直接子进程会留下孙进程占着管道；必须整棵树终止。 */
/** 杀掉整棵子进程树（Windows 走 taskkill /T）。git 服务复用同一份实现，不复制逻辑。 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      env: commandEnv(),
    });
    killer.on("error", () => {
      try {
        child.kill();
      } catch {
        // 进程可能已经退出
      }
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程可能已经退出
    }
  }
}

/**
 * 命令输出先按字节累积、结束时一次性解码。
 * 逐 chunk toString("utf8") 会把跨 chunk 边界的多字节字符（中文 Windows 上很常见）切成乱码；
 * 无上限累积则刷屏命令会先把内存吃满，truncateMiddle 根本没机会生效。
 */
function createOutputSink(limit: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    push(chunk: Buffer): void {
      if (bytes >= limit) return;
      const room = limit - bytes;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      bytes += Math.min(chunk.length, room);
    },
    get capped(): boolean {
      return bytes >= limit;
    },
    text(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

/** PowerShell 5.1 默认按系统 OEM 码页输出；显式切到 UTF-8 才能和上面的解码对上。 */
const UTF8_OUTPUT_PREAMBLE = "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { };\n";

async function runCommand(workspace: string, command: string, signal?: AbortSignal): Promise<ToolResult> {
  if (!command.trim()) {
    return { output: "command is empty.", ok: false };
  }
  if (signal?.aborted) {
    return { output: "Command aborted by the user.", ok: false };
  }
  const executable = await resolvePowerShell();
  if (signal?.aborted) {
    return { output: "Command aborted by the user.", ok: false };
  }

  return new Promise((resolve) => {
    let settled = false;
    const stdout = createOutputSink(MAX_COMMAND_OUTPUT_BYTES);
    const stderr = createOutputSink(MAX_COMMAND_OUTPUT_BYTES);
    let timer: NodeJS.Timeout | undefined;
    const combined = () =>
      [stdout.text(), stderr.text()].filter(Boolean).join("\n--- stderr ---\n") || "(no output)";
    const child = spawn(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", UTF8_OUTPUT_PREAMBLE + command],
      {
        cwd: workspace,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: { ...commandEnv(), POWERSHELL_TELEMETRY_OPTOUT: "1" },
      },
    );

    function cleanup(): void {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function finish(result: ToolResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    }
    function onAbort(): void {
      killProcessTree(child);
      finish({ output: "Command aborted by the user.", ok: false });
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      finish({ output: error.message, ok: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      const full = combined();
      const capped = stdout.capped || stderr.capped;
      const preview = truncateMiddle(full);
      if (!preview.truncated && !capped) {
        finish({ output: preview.output, ok: code === 0 });
        return;
      }
      void persistToolOutput(workspace, "run_command", full)
        .then((saved) =>
          finish({
            output: `${preview.output}\n... [${
              capped ? `capture stopped at ${MAX_COMMAND_OUTPUT_BYTES} bytes; ` : ""
            }full output saved to ${saved}; read it with read_file]`,
            ok: code === 0,
          }),
        )
        .catch(() => finish({ output: preview.output, ok: code === 0 }));
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      killProcessTree(child);
      const partial = truncateMiddle(combined());
      finish({
        output: `Command timed out after 120s and was terminated.${partial.output ? `\n${partial.output}` : ""}`,
        ok: false,
      });
    }, 120_000);
  });
}

let powershellProbe: Promise<string> | undefined;

/** 探测结果在一次进程生命周期内不会变，避免每条命令都付一次 spawn（最坏 5 秒）。 */
function resolvePowerShell(): Promise<string> {
  const override = process.env.MEOWCODE_POWERSHELL;
  if (override) return Promise.resolve(override);
  powershellProbe ??= findPowerShell();
  return powershellProbe;
}

async function findPowerShell(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("pwsh.exe", ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      windowsHide: true,
      // 探测进程同样不能继承完整环境（里面可能有服务商密钥）
      env: commandEnv(),
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (name: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill();
      resolve(name);
    };
    child.on("error", () => finish("powershell.exe"));
    child.on("close", (code) => finish(code === 0 ? "pwsh.exe" : "powershell.exe"));
    // pwsh 探测本身也不能无限等
    timer = setTimeout(() => finish("powershell.exe"), 5_000);
  });
}

