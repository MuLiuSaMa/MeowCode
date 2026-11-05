/**
 * 会话导出：把 JSONL entries 组织成「按轮次分组」的中间结构。
 *
 * 纯函数、零 IO —— 渲染层（markdown / html / json）只消费这里产出的 ExportDoc，
 * 因此格式调整不需要碰会话存储，测试也只需要字面量 entries。
 *
 * 为什么不用 messagesForClient：它丢了 turn 边界、审批决定、逐轮用量与检查点，
 * 做不出「工具折叠 + 元信息」这种结构。要无损真源只能用 entries。
 */
import type {
  ImageRef,
  SessionEntry,
  SessionWorktree,
  ToolImage,
  TurnStatus,
} from "./types.js";

export type ExportImage = {
  mimeType: string;
  /** base64（不含 data: 前缀）；导出为「外链资产」模式时缺省 */
  data?: string;
  name?: string;
  /** 参考图在 assets 目录里的相对路径，如 `<sessionId>/<entryId>-0.png` */
  file?: string;
};

export type ExportToolCall = {
  callId: string;
  tool: string;
  /** 已解析的参数（解析失败时保留原始字符串） */
  input: unknown;
  /** 送进模型的原始输出 */
  output?: string;
  ok?: boolean;
  error?: string;
};

export type ExportItem =
  | { kind: "user"; at?: string; text: string; images: ExportImage[]; documents: ExportImage[] }
  | { kind: "assistant"; at?: string; text: string; thinking?: string; toolCalls: ExportToolCall[] }
  | { kind: "tool"; at?: string; call: ExportToolCall }
  | { kind: "approval"; at?: string; callId: string; tool: string; approved: boolean; reason?: string };

export type ExportTurn = {
  index: number;
  turnId?: string;
  startedAt?: string;
  endedAt?: string;
  status?: TurnStatus;
  error?: string;
  items: ExportItem[];
  usage?: ExportUsage;
};

export type ExportUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ExportCompaction = {
  /** 压缩发生时已经消费了多少条消息（用于渲染分隔线位置） */
  messageIndex: number;
  summary: string;
  status?: "completed" | "failed" | "interrupted";
};

export type ExportCheckpoint = {
  id: string;
  label?: string;
  auto: boolean;
  timestamp: string;
  fileChanges: string[];
};

export type ExportSession = {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  messageCount: number;
  parentSessionId?: string;
  rootSessionId?: string;
  worktree?: SessionWorktree | null;
  providerId?: string;
  model?: string;
};

export type ExportDoc = {
  session: ExportSession;
  turns: ExportTurn[];
  compactions: ExportCompaction[];
  checkpoints: ExportCheckpoint[];
  usage: ExportUsage;
  /** 顶层游离条目（没有 turn_start 包裹的旧会话）单独成轮 */
  loose: ExportTurn | null;
};

export type BuildExportOptions = {
  /** 是否带上模型思考过程（默认 true，渲染时按折叠处理） */
  includeThinking?: boolean;
  /** 是否带上工具调用（默认 true） */
  includeTools?: boolean;
};

const EMPTY_USAGE: ExportUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function addUsage(target: ExportUsage, entry: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
  target.inputTokens += entry.inputTokens ?? 0;
  target.outputTokens += entry.outputTokens ?? 0;
  target.cacheReadTokens += entry.cacheReadTokens ?? 0;
  target.cacheWriteTokens += entry.cacheWriteTokens ?? 0;
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * entry.message.images 是 hydrate 回填的 base64；imageRefs 是落盘引用。
 * 两个都带上（按顺序对齐），渲染层再决定内联还是写相对路径。
 */
function toImages(images: ToolImage[] | undefined, refs: ImageRef[] | undefined): ExportImage[] {
  const dataList = images ?? [];
  const refList = refs ?? [];
  const out: ExportImage[] = [];
  for (let index = 0; index < Math.max(dataList.length, refList.length); index += 1) {
    const data = dataList[index];
    const ref = refList[index];
    const mimeType = data?.mimeType ?? ref?.mimeType;
    if (!mimeType) continue;
    out.push({
      mimeType,
      ...(data?.data ? { data: data.data } : {}),
      ...(ref?.file ? { file: ref.file } : {}),
    });
  }
  return out;
}

function toDocuments(
  documents: Array<{ data: string; mimeType: string; name: string }> | undefined,
  refs: Array<{ file: string; mimeType: string; name?: string }> | undefined,
): ExportImage[] {
  const out: ExportImage[] = [];
  for (const doc of documents ?? []) {
    out.push({ mimeType: doc.mimeType, data: doc.data, name: doc.name });
  }
  if (out.length === 0) {
    for (const ref of refs ?? []) {
      out.push({ mimeType: ref.mimeType, file: ref.file, ...(ref.name ? { name: ref.name } : {}) });
    }
  }
  return out;
}

/**
 * entries → ExportDoc。
 * 轮次切分：turn_start 开新轮，turn_end 收尾；没有 turn_start 的历史条目
 * （早期版本 / 导入的会话）统一收进 loose 轮，保证不丢内容。
 */
export function buildExportDoc(
  entries: SessionEntry[],
  options: BuildExportOptions = {},
): ExportDoc {
  const includeThinking = options.includeThinking !== false;
  const includeTools = options.includeTools !== false;

  const session: ExportSession = {
    id: "",
    title: "",
    cwd: "",
    createdAt: "",
    messageCount: 0,
  };
  const turns: ExportTurn[] = [];
  const compactions: ExportCompaction[] = [];
  const checkpoints: ExportCheckpoint[] = [];
  const usage: ExportUsage = { ...EMPTY_USAGE };
  let loose: ExportTurn | null = null;
  let current: ExportTurn | null = null;
  let messageIndex = 0;

  const openLoose = (): ExportTurn => {
    if (!loose) loose = { index: 0, items: [] };
    return loose;
  };
  const target = (): ExportTurn => current ?? openLoose();

  // tool 结果靠 callId 回填到 assistant 的 toolCalls 上
  const pendingCalls = new Map<string, ExportToolCall>();

  for (const entry of entries) {
    switch (entry.type) {
      case "session":
        session.id = entry.id;
        session.cwd = entry.cwd;
        session.createdAt = entry.createdAt;
        if (entry.parentSessionId) session.parentSessionId = entry.parentSessionId;
        if (entry.rootSessionId) session.rootSessionId = entry.rootSessionId;
        if (entry.worktree) session.worktree = entry.worktree;
        break;

      case "title":
        session.title = entry.title;
        break;

      case "turn_start": {
        current = {
          index: turns.length + 1,
          turnId: entry.turnId,
          startedAt: entry.timestamp,
          items: [],
        };
        if (entry.providerId) session.providerId = entry.providerId;
        if (entry.model) session.model = entry.model;
        turns.push(current);
        break;
      }

      case "turn_end":
        if (current) {
          current.status = entry.status;
          if (entry.error) current.error = entry.error;
          current.endedAt = entry.timestamp;
          current = null;
        }
        break;

      case "message": {
        const message = entry.message;
        messageIndex += 1;
        if (message.role === "user") {
          session.messageCount += 1;
          target().items.push({
            kind: "user",
            at: entry.timestamp,
            text: message.content,
            images: toImages(message.images, entry.imageRefs),
            documents: toDocuments(message.documents, entry.documentRefs),
          });
          break;
        }
        if (message.role === "assistant") {
          session.messageCount += 1;
          const calls: ExportToolCall[] = includeTools
            ? (message.tool_calls ?? []).map((call) => {
                const record: ExportToolCall = {
                  callId: call.id,
                  tool: call.function.name,
                  input: parseArguments(call.function.arguments),
                };
                pendingCalls.set(call.id, record);
                return record;
              })
            : [];
          const item: ExportItem = {
            kind: "assistant",
            at: entry.timestamp,
            text: message.content ?? "",
            toolCalls: calls,
            ...(includeThinking && message.reasoning ? { thinking: message.reasoning } : {}),
          };
          target().items.push(item);
          break;
        }
        if (message.role === "tool") {
          const known = pendingCalls.get(message.tool_call_id);
          const call: ExportToolCall = known ?? {
            callId: message.tool_call_id,
            tool: message.name ?? "tool",
            input: {},
          };
          call.output = message.content;
          call.ok = true;
          if (includeTools) {
            target().items.push({ kind: "tool", at: entry.timestamp, call });
          }
          break;
        }
        break;
      }

      case "approval":
        target().items.push({
          kind: "approval",
          at: entry.timestamp,
          callId: entry.callId,
          tool: entry.tool,
          approved: entry.approved,
          ...(entry.reason ? { reason: entry.reason } : {}),
        });
        break;

      case "compaction_summary":
        compactions.push({ messageIndex, summary: entry.summary });
        break;

      case "native_compaction":
        compactions.push({ messageIndex, summary: entry.summary });
        break;

      case "compaction_end":
        // 与 summary 分开记录：这里只补状态，摘要可能来自上面的条目
        if (compactions.length) compactions[compactions.length - 1]!.status = entry.status;
        break;

      case "checkpoint":
        checkpoints.push({
          id: entry.id,
          ...(entry.label ? { label: entry.label } : {}),
          auto: entry.auto,
          timestamp: entry.timestamp,
          fileChanges: entry.fileChanges,
        });
        break;

      case "usage":
        addUsage(usage, entry);
        if (current) {
          current.usage ??= { ...EMPTY_USAGE };
          addUsage(current.usage, entry);
        }
        break;

      default:
        break;
    }
  }

  // 末尾还没收尾的 turn（崩溃 / 正在运行）保留 status 缺省，渲染层按「未结束」处理
  return { session, turns, compactions, checkpoints, usage, loose };
}

/** JSON 导出：结构化、可再导入，字段名即上面这些类型。 */
export function renderJson(doc: ExportDoc, exportedAt = new Date().toISOString()): string {
  return `${JSON.stringify(
    {
      format: "meowcode.session.export",
      version: 1,
      exportedAt,
      session: doc.session,
      usage: doc.usage,
      turns: doc.turns,
      ...(doc.loose ? { loose: doc.loose } : {}),
      compactions: doc.compactions,
      checkpoints: doc.checkpoints,
    },
    null,
    2,
  )}\n`;
}
