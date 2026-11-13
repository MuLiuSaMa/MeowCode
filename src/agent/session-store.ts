import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildMessageUnits, estimateMessagesTokens, repairToolPairs } from "./context.js";
import { retainedThinkingBoundary, stripThinkingBefore } from "./request-projection.js";
import { countDiffStats } from "./diff.js";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import type {
  ApprovalMode,
  ChatMessage,
  ChatMessageWithRefs,
  CheckpointSnapshotRef,
  CompactionPoint,
  DocumentRef,
  FileChangeEntry,
  ImageRef,
  NativeCompactionEntry,
  NativeCompactionPayload,
  PlanStep,
  RewindEntry,
  SessionEntry,
  AgentRole,
  SessionCheckpoint,
  SessionHeader,
  SessionSettings,
  SessionWorktree,
  SubagentStatus,
  SubagentSummary,
  SubagentType,
  ToolDocument,
  TurnDurationGroup,
  TurnFileChangeGroup,
  TurnFileChangeStat,
  ToolImage,
  TurnStatus,
  UsageSource,
  UsageSummary,
} from "./types.js";

export function newEntryId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

type TurnStartEntry = Extract<SessionEntry, { type: "turn_start" }>;
type TurnEndEntry = Extract<SessionEntry, { type: "turn_end" }>;
type ApprovalRequestedEntry = Extract<SessionEntry, { type: "approval_requested" }>;
type UsageEntry = Extract<SessionEntry, { type: "usage" }>;

type PartialCheckpoint = {
  turnId: string;
  round: number;
  content: string;
  reasoning?: string;
  updatedAt?: string;
};

const PARTIAL_MAX_CHARS = 64_000;
const TAIL_SCAN_CHUNK = 1_048_576;

/**
 * 落盘前剥掉内联资产（图片 / 文档）。没有资产时原样返回同一引用，
 * 调用方据此判断是否需要内存副本。
 */
function stripMessageAssets(message: ChatMessage): {
  message: ChatMessage;
  images: ToolImage[];
  documents: ToolDocument[];
} {
  const images = "images" in message ? (message.images ?? []) : [];
  const documents = "documents" in message ? (message.documents ?? []) : [];
  if (!images.length && !documents.length) return { message, images: [], documents: [] };
  return {
    message: { ...message, images: undefined, documents: undefined } as ChatMessage,
    images,
    documents,
  };
}

/** mimeType → 落盘扩展名；未知类型兜底 .bin，内容仍是原始字节。 */
const ASSET_EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

export class SessionStore {
  readonly filePath: string;
  readonly entries: SessionEntry[] = [];
  private currentId: string | null = null;
  private writer: FileHandle | null = null;
  private writerOpening: Promise<FileHandle> | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(filePath: string, entries: SessionEntry[]) {
    this.filePath = filePath;
    for (const entry of entries) {
      this.entries.push(entry);
      if (entry.type !== "session") {
        this.currentId = entry.id;
      }
    }
  }

  static async create(
    filePath: string,
    cwd: string,
    options: {
      id?: string;
      parentSessionId?: string;
      rootSessionId?: string;
      agentKind?: "subagent";
      agentType?: SubagentType;
      /** fork 模式：记录来源会话 */
      forkedFrom?: string;
      parentCallId?: string;
      description?: string;
      worktree?: SessionWorktree;
      /** 诊断链路 id：子 Agent / 分支会话继承父级 */
      traceId?: string;
      /** 导入场景：会话头用来源会话的原始时间，列表排序才符合时间线 */
      createdAt?: Date;
    } = {},
  ): Promise<SessionStore> {
    const header: SessionHeader = {
      type: "session",
      version: 2,
      id: options.id ?? randomUUID(),
      cwd: path.resolve(cwd),
      createdAt: (options.createdAt ?? new Date()).toISOString(),
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.rootSessionId
        ? { rootSessionId: options.rootSessionId }
        : options.parentSessionId
          ? { rootSessionId: options.parentSessionId }
          : {}),
      ...(options.agentKind ? { agentKind: options.agentKind } : {}),
      ...(options.agentType ? { agentType: options.agentType } : {}),
      ...(options.forkedFrom ? { forkedFrom: options.forkedFrom } : {}),
      ...(options.parentCallId ? { parentCallId: options.parentCallId } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.worktree ? { worktree: options.worktree } : {}),
      ...(options.traceId ? { traceId: options.traceId } : {}),
    };
    const store = new SessionStore(filePath, [header]);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // wx：两个窗口/双击同时新建时绝不覆盖已有会话
    await fs.writeFile(filePath, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
    return store;
  }

  static async load(filePath: string): Promise<SessionStore> {
    const content = await fs.readFile(filePath, "utf8");
    const entries: SessionEntry[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        // 撕裂的最后一行由 writer 在首次 append 时修复；加载阶段只忽略
      }
    }
    if (!entries[0] || entries[0].type !== "session") {
      throw new Error(`Invalid session file: ${filePath}`);
    }
    const store = new SessionStore(filePath, entries);
    // 按落盘引用把图片读回内存：旧会话没有 imageRefs 字段，天然跳过
    await store.hydrateImages();
    return store;
  }

  get id(): string {
    const header = this.entries[0];
    if (header?.type !== "session") throw new Error("Session header is missing.");
    return header.id;
  }

  get cwd(): string {
    const header = this.entries[0];
    if (header?.type !== "session") throw new Error("Session header is missing.");
    return header.cwd;
  }

  /** 诊断链路 id：旧会话没有 traceId 字段时用会话 id 派生，保证始终可用。 */
  get traceId(): string {
    const header = this.entries[0];
    if (header?.type !== "session") throw new Error("Session header is missing.");
    return header.traceId ?? header.id;
  }

  /**
   * 缓存血缘根：只有 fork（复制了父历史）才继承来源键。
   * spawn 子 Agent 不复制父历史、system[0] 也不同，共享键只会挤占父分片；
   * 普通会话与 spawn 子会话返回 undefined。
   */
  get affinityRootId(): string | undefined {
    const header = this.entries[0];
    if (header?.type !== "session") throw new Error("Session header is missing.");
    return header.forkedFrom;
  }

  get worktree(): SessionWorktree | undefined {
    const header = this.entries[0];
    if (header?.type !== "session") throw new Error("Session header is missing.");
    return header.worktree;
  }

  get createdAt(): string {
    const header = this.entries[0];
    if (header?.type !== "session") throw new Error("Session header is missing.");
    return header.createdAt;
  }

  get messages(): ChatMessage[] {
    return this.entries
      .filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
      // 图片/文档只给模型用：接口回放剥掉 base64，避免一次会话响应传几 MB
      .map((entry) => stripMessageAssets(entry.message).message);
  }

  /**
   * API 回放消息：剥掉 base64（轻快照），但保留 imageRefs / documentRefs 落盘引用——
   * 前端经 /session/asset 路由按需取文件，恢复后的历史附件仍然可见。
   */
  get messagesForClient(): ChatMessageWithRefs[] {
    return this.entries
      .filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
      .map((entry) => {
        const message = stripMessageAssets(entry.message).message;
        if (!entry.imageRefs?.length && !entry.documentRefs?.length) return message;
        return {
          ...message,
          ...(entry.imageRefs?.length ? { imageRefs: entry.imageRefs } : {}),
          ...(entry.documentRefs?.length ? { documentRefs: entry.documentRefs } : {}),
        };
      });
  }

  /** Agent 文件改动记录（审阅面板数据源，按写入顺序） */
  get fileChanges(): FileChangeEntry[] {
    return this.entries.filter(
      (entry): entry is FileChangeEntry => entry.type === "file_change",
    );
  }

  /**
   * 按回合聚合的文件改动（历史回放）：turn_start 开新组、file_change 累加、turn_end 定稿。
   * 没有 turn_end 的回合（进程崩溃）不出组 —— 那一轮的编辑没有「完成」语义。
   */
  get turnFileChangeGroups(): TurnFileChangeGroup[] {
    // 自动检查点和 turn_start 共用 turnId：预先索引，卡片「撤销」直接指向本回合起点
    const checkpointByTurn = new Map<string, { id: string; hasSnapshot: boolean }>();
    for (const entry of this.entries) {
      if (entry.type !== "checkpoint" || !entry.turnId) continue;
      checkpointByTurn.set(entry.turnId, {
        id: entry.id,
        hasSnapshot: Boolean(entry.snapshot),
      });
    }

    const groups: TurnFileChangeGroup[] = [];
    let messageCount = 0;
    let current: { turnId: string; stats: Map<string, TurnFileChangeStat> } | null = null;
    for (const entry of this.entries) {
      if (entry.type === "message") {
        messageCount += 1;
        continue;
      }
      if (entry.type === "turn_start") {
        current = { turnId: entry.turnId, stats: new Map() };
        continue;
      }
      if (entry.type === "file_change" && current) {
        const stats = countDiffStats(entry.diff);
        const existing = current.stats.get(entry.path);
        if (existing) {
          existing.added += stats.added;
          existing.removed += stats.removed;
        } else {
          current.stats.set(entry.path, {
            path: entry.path,
            added: stats.added,
            removed: stats.removed,
          });
        }
        continue;
      }
      if (entry.type === "turn_end") {
        if (!current || current.turnId !== entry.turnId) {
          current = null;
          continue;
        }
        if (current.stats.size) {
          const checkpoint = checkpointByTurn.get(current.turnId);
          groups.push({
            turnId: current.turnId,
            messageIndex: messageCount,
            ...(checkpoint ? { checkpointId: checkpoint.id } : {}),
            canRewind: Boolean(checkpoint?.hasSnapshot),
            files: [...current.stats.values()],
          });
        }
        current = null;
      }
    }
    return groups;
  }

  /**
   * 按回合的运行耗时（历史回放）：首个 turn_start → 末个 turn_end 的墙钟差。
   * messageIndex 与 turnFileChangeGroups 完全同口径（只数 message 条目）。
   * 续命循环复用同 turnId 但不重写 turn_start，首尾差天然覆盖多段；
   * 孤立 turn_start（崩溃未收尾）不出组，非法时间戳 / 负值一律丢弃。
   * interrupted 轮的 turn_end 是下次启动时补写的，直接取差值会把停机时间算进去，
   * 改用轮内最后一次活动时间作为终点。
   */
  get turnDurations(): TurnDurationGroup[] {
    const startAt = new Map<string, number>();
    const lastActivityAt = new Map<string, number>();
    /** turnId → 主对话（source=chat）Token 汇总：usage 条目天然带 turnId */
    const usageByTurn = new Map<
      string,
      { input: number; output: number; cacheRead: number; cacheWrite: number }
    >();
    const groups: TurnDurationGroup[] = [];
    let openTurnId: string | null = null;
    let messageCount = 0;
    const bumpActivity = (turnId: string, ts: number) => {
      if (!Number.isFinite(ts)) return;
      lastActivityAt.set(turnId, Math.max(lastActivityAt.get(turnId) ?? ts, ts));
    };
    for (const entry of this.entries) {
      // 会话头部没有 timestamp；其余条目都有
      const ts = "timestamp" in entry ? Date.parse(entry.timestamp) : Number.NaN;
      if (entry.type === "usage") {
        // 旧记录没有 source：视为主对话；标题/压缩/建议等不计入回合用量
        if (entry.turnId && (entry.source ?? "chat") === "chat") {
          const acc = usageByTurn.get(entry.turnId) ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          };
          acc.input += entry.inputTokens ?? 0;
          acc.output += entry.outputTokens ?? 0;
          acc.cacheRead += entry.cacheReadTokens ?? 0;
          acc.cacheWrite += entry.cacheWriteTokens ?? 0;
          usageByTurn.set(entry.turnId, acc);
        }
      }
      if (entry.type === "turn_end") {
        const start = startAt.get(entry.turnId);
        if (start === undefined) continue;
        // 崩溃恢复补写的 turn_end 在重启时才落盘：用轮内最后活动时间，别把停机时间算进去
        const end =
          entry.status === "interrupted" ? (lastActivityAt.get(entry.turnId) ?? Number.NaN) : ts;
        const durationMs = end - start;
        openTurnId = null;
        if (!Number.isFinite(durationMs) || durationMs < 0) continue;        // 同 turnId 可能有多段 turn_end：保留最后一段（首尾差），先移除旧的
        const existing = groups.findIndex((group) => group.turnId === entry.turnId);
        const acc = usageByTurn.get(entry.turnId);
        const group: TurnDurationGroup = {
          turnId: entry.turnId,
          messageIndex: messageCount,
          durationMs,
          status: entry.status,
          // 中断轮的结束时间同样取最后活动时刻（不是重启补写 turn_end 的时间）
          endedAt: new Date(end).toISOString(),
          ...(acc && (acc.input || acc.output || acc.cacheRead || acc.cacheWrite)
            ? {
                usage: {
                  inputTokens: acc.input,
                  outputTokens: acc.output,
                  cacheReadTokens: acc.cacheRead,
                  cacheWriteTokens: acc.cacheWrite,
                  totalTokens: acc.input + acc.output,
                },
              }
            : {}),
        };
        if (existing >= 0) groups[existing] = group;
        else groups.push(group);
        continue;
      }
      if (entry.type === "message") messageCount += 1;
      if (entry.type === "turn_start") {
        if (Number.isFinite(ts) && !startAt.has(entry.turnId)) startAt.set(entry.turnId, ts);
        openTurnId = entry.turnId;
        bumpActivity(entry.turnId, ts);
        continue;
      }
      if (openTurnId != null) bumpActivity(openTurnId, ts);
    }
    return groups;
  }

  /** 快照目录归属会话 id：派生会话沿用源会话 owner 共享 blob；缺省 = 自己的 id。 */
  get snapshotOwnerId(): string {
    const header = this.entries[0];
    if (header?.type !== "session") return this.id;
    return header.snapshotOwnerId ?? header.id;
  }

  /** 所有检查点，按时间线位置；messageIndex 与 messagesForClient 对齐（分隔线定位）。 */
  get checkpoints(): SessionCheckpoint[] {
    const points: SessionCheckpoint[] = [];
    let messageCount = 0;
    for (const entry of this.entries) {
      if (entry.type === "message") {
        messageCount += 1;
        continue;
      }
      if (entry.type !== "checkpoint") continue;
      points.push({
        id: entry.id,
        timestamp: entry.timestamp,
        ...(entry.label ? { label: entry.label } : {}),
        auto: entry.auto,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
        fileChanges: entry.fileChanges,
        messageIndex: messageCount,
        ...(entry.snapshot ? { snapshot: entry.snapshot } : {}),
        hasSnapshot: Boolean(entry.snapshot),
        fileCount: entry.snapshot?.count ?? 0,
      });
    }
    return points;
  }

  /** 最近一次回滚留痕（撤销回滚入口；每次回滚追加一条，取最后一条）。 */
  get lastRewind(): RewindEntry | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === "rewind") return entry;
    }
    return null;
  }

  // ---- 回合 / 队列 / 审批投影 ----

  /** 所有没有配对 turn_end 的 turn_start（正常只有一个）。 */
  get openTurns(): TurnStartEntry[] {
    const ended = new Set(
      this.entries
        .filter((entry): entry is TurnEndEntry => entry.type === "turn_end")
        .map((entry) => entry.turnId),
    );
    return this.entries.filter(
      (entry): entry is TurnStartEntry =>
        entry.type === "turn_start" && !ended.has(entry.turnId),
    );
  }

  get openTurn(): TurnStartEntry | null {
    return this.openTurns.at(-1) ?? null;
  }

  get lastTurnEnd(): TurnEndEntry | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === "turn_end") return entry;
    }
    return null;
  }

  get sessionSettings(): SessionSettings | null {
    const settings: SessionSettings = {};
    for (const entry of this.entries) {
      if (entry.type !== "session_settings") continue;
      if (entry.approvalMode !== undefined) settings.approvalMode = entry.approvalMode;
      if (entry.mode !== undefined) settings.mode = entry.mode;
      if (entry.agentProfile !== undefined) settings.agentProfile = entry.agentProfile;
      if (entry.harnessArchitecture !== undefined) {
        settings.harnessArchitecture = entry.harnessArchitecture;
      }
      if (entry.providerId !== undefined) settings.providerId = entry.providerId;
      if (entry.model !== undefined) settings.model = entry.model;
      if (entry.reasoningEffort !== undefined) settings.reasoningEffort = entry.reasoningEffort;
    }
    return Object.keys(settings).length ? settings : null;
  }

  /** 当前回合还没有结论的审批请求（恢复时补 denied）。 */
  get openApprovalRequests(): ApprovalRequestedEntry[] {
    const openTurnIds = new Set(this.openTurns.map((entry) => entry.turnId));
    if (!openTurnIds.size) return [];
    const answered = new Set(
      this.entries
        .filter((entry): entry is Extract<SessionEntry, { type: "approval" }> => entry.type === "approval")
        .map((entry) => entry.callId),
    );
    return this.entries.filter(
      (entry): entry is ApprovalRequestedEntry =>
        entry.type === "approval_requested" &&
        openTurnIds.has(entry.turnId) &&
        !answered.has(entry.callId),
    );
  }

  /** 未交付、未移除的排队消息（重启后作为“待发送”展示，不自动执行）。 */
  get recoveredQueue(): Array<{ id: string; text: string }> {
    const removed = new Set(
      this.entries
        .filter(
          (entry): entry is Extract<SessionEntry, { type: "queued_prompt_removed" }> =>
            entry.type === "queued_prompt_removed",
        )
        .map((entry) => entry.queueId),
    );
    const delivered = new Set(
      this.entries
        .filter((entry): entry is TurnStartEntry => entry.type === "turn_start")
        .map((entry) => entry.queueId)
        .filter((id): id is string => Boolean(id)),
    );
    const queue = new Map<string, string>();
    for (const entry of this.entries) {
      if (entry.type !== "queued_prompt") continue;
      if (removed.has(entry.queueId) || delivered.has(entry.queueId)) continue;
      queue.set(entry.queueId, entry.text);
    }
    return [...queue].map(([id, text]) => ({ id, text }));
  }

  /**
   * 最近一次主对话调用的真实输入 token，用于重启后恢复上下文占用。
   * 压缩前的用量不代表压缩后的上下文，必须从最后一个压缩点之后找。
   */
  get lastChatUsage(): UsageEntry | null {
    const lastSummaryIndex = this.findLastSummaryIndex();
    for (let index = this.entries.length - 1; index > lastSummaryIndex; index -= 1) {
      const entry = this.entries[index];
      if (entry.type !== "usage") continue;
      if (entry.source === undefined || entry.source === "chat") return entry;
    }
    return null;
  }

  get usageBySource(): Record<
    UsageSource,
    { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  > {
    const empty = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    const result: Record<UsageSource, ReturnType<typeof empty>> = {
      chat: empty(),
      title: empty(),
      compaction: empty(),
      memory: empty(),
      learning: empty(),
      web_search: empty(),
      suggestion: empty(),
    };
    for (const entry of this.entries) {
      if (entry.type !== "usage") continue;
      const bucket = result[entry.source ?? "chat"];
      bucket.calls += 1;
      if (typeof entry.inputTokens === "number") bucket.inputTokens += entry.inputTokens;
      if (typeof entry.outputTokens === "number") bucket.outputTokens += entry.outputTokens;
      if (typeof entry.cacheReadTokens === "number") bucket.cacheReadTokens += entry.cacheReadTokens;
    }
    return result;
  }

  // ---- Append API ----

  async appendMessage(message: ChatMessage): Promise<string> {
    const id = newEntryId();
    // 图片/文档写进 JSONL 会让会话文件膨胀几个数量级：剥掉 base64 落到 assets/ 目录，
    // JSONL 只留引用（imageRefs / documentRefs）。内存条目仍带原图（toMemory 回填），
    // 本轮与后续回合模型照常引用；落盘失败则退回旧行为（重启后丢失）。
    const { message: persisted, images, documents } = stripMessageAssets(message);
    const imageRefs = images.length ? await this.persistAssets(id, images, "img") : undefined;
    const documentRefs = documents.length
      ? await this.persistAssets(id, documents, "doc")
      : undefined;
    const hasAssets = images.length > 0 || documents.length > 0;
    await this.appendEntry(
      (parentId) => ({
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: persisted,
        ...(imageRefs ? { imageRefs } : {}),
        ...(documentRefs ? { documentRefs } : {}),
      }),
      hasAssets
        ? (entry) =>
            entry.type === "message"
              ? {
                  ...entry,
                  message: {
                    ...entry.message,
                    ...(images.length ? { images } : {}),
                    ...(documents.length ? { documents } : {}),
                  },
                }
              : entry
        : undefined,
    );
    return id;
  }

  /**
   * 把消息内联资产写到 sessions/assets/<sessionId>/，返回相对 assets 根的引用。
   * 失败返回 undefined：消息照常落盘（无引用），资产仅本轮内存可用。
   * kind 只影响文件名前缀（img-0 / doc-0），同一条消息的图片与文档不会互相覆盖。
   */
  private async persistAssets(
    entryId: string,
    assets: Array<{ data: string; mimeType: string }>,
    kind: "img" | "doc",
  ): Promise<Array<ImageRef & { name?: string }> | undefined> {
    try {
      const dir = path.join(path.dirname(this.filePath), "assets", this.id);
      await fs.mkdir(dir, { recursive: true });
      const refs: Array<ImageRef & { name?: string }> = [];
      for (let index = 0; index < assets.length; index += 1) {
        const asset = assets[index];
        const ext = ASSET_EXT_BY_MIME[asset.mimeType] ?? ".bin";
        // entryId 全局唯一 ⇒ 文件名不会撞；全小写规避 Windows 大小写歧义。
        // 图片沿用历史命名（-0 / -1），文档加 doc 前缀避免与同条消息的图片重名。
        const file =
          kind === "img" ? `${entryId.toLowerCase()}-${index}${ext}` : `${entryId.toLowerCase()}-doc${index}${ext}`;
        await fs.writeFile(path.join(dir, file), Buffer.from(asset.data, "base64"));
        const name = (asset as { name?: string }).name;
        refs.push({ file: `${this.id}/${file}`, mimeType: asset.mimeType, ...(name ? { name } : {}) });
      }
      return refs;
    } catch {
      return undefined;
    }
  }

  /**
   * 恢复会话时按 imageRefs / documentRefs 把落盘资产读回内存条目，
   * 模型与投影继续可用。旧会话没有这些字段，天然跳过（向前兼容）。
   */
  private async hydrateImages(): Promise<void> {
    const assetsDir = path.join(path.dirname(this.filePath), "assets");
    const readAssets = async (
      refs: Array<{ file: string; mimeType: string; name?: string }>,
    ): Promise<Array<{ data: string; mimeType: string; name?: string }>> => {
      const loaded: Array<{ data: string; mimeType: string; name?: string }> = [];
      for (const ref of refs) {
        // 引用里的 file 只允许 "<sessionId>/<name>" 两段，杜绝路径穿越
        const [dirName, fileName] = ref.file.split("/");
        if (!dirName || !fileName || ref.file.includes("..")) continue;
        if (dirName !== this.id) continue;
        try {
          const data = await fs.readFile(path.join(assetsDir, dirName, path.basename(fileName)));
          loaded.push({
            data: data.toString("base64"),
            mimeType: ref.mimeType,
            ...(ref.name ? { name: ref.name } : {}),
          });
        } catch {
          // 单个资产丢失不影响其余：旧会话/被清理的资产静默跳过
        }
      }
      return loaded;
    };

    for (const entry of this.entries) {
      if (entry.type !== "message") continue;
      if (!entry.imageRefs?.length && !entry.documentRefs?.length) continue;
      const existingImages = (entry.message as { images?: ToolImage[] }).images;
      const existingDocuments = (entry.message as { documents?: ToolDocument[] }).documents;
      const images =
        existingImages?.length || !entry.imageRefs?.length
          ? []
          : await readAssets(entry.imageRefs);
      const documents =
        existingDocuments?.length || !entry.documentRefs?.length
          ? []
          : await readAssets(entry.documentRefs as DocumentRef[]);
      if (!images.length && !documents.length) continue;
      entry.message = {
        ...entry.message,
        ...(images.length ? { images } : {}),
        ...(documents.length ? { documents } : {}),
      } as ChatMessage;
    }
  }

  async appendTurnStart(input: {
    turnId: string;
    queueId?: string;
    text?: string;
    providerId?: string;
    model?: string;
    approvalMode?: ApprovalMode;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "turn_start",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  async appendTurnEnd(input: {
    turnId: string;
    status: TurnStatus;
    error?: string;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "turn_end",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  async appendToolCallStarted(input: {
    turnId: string;
    callId: string;
    tool: string;
    input: unknown;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "tool_call_started",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  async appendApprovalRequested(input: {
    turnId: string;
    callId: string;
    tool: string;
    input: unknown;
    diff?: string;
    risk?: Extract<SessionEntry, { type: "approval_requested" }>["risk"];
    sandboxEscape?: { command: string; detail: string };
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "approval_requested",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  async appendApproval(
    callId: string,
    tool: string,
    input: unknown,
    approved: boolean,
    options: {
      turnId?: string;
      reason?: Extract<SessionEntry, { type: "approval" }>["reason"];
    } = {},
  ): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "approval",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      callId,
      tool,
      input,
      approved,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    }));
    return id;
  }

  async appendQueuedPrompt(queueId: string, text: string): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "queued_prompt",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      queueId,
      text,
    }));
    return id;
  }

  async appendQueuedPromptRemoved(
    queueId: string,
    reason: "user" | "aborted" | "steered" | "discarded",
  ): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "queued_prompt_removed",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      queueId,
      reason,
    }));
    return id;
  }

  async appendSessionSettings(settings: SessionSettings): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "session_settings",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...settings,
    }));
    return id;
  }

  async appendCompactionStarted(input: {
    compactionId: string;
    turnId?: string;
    reason: "manual" | "overflow";
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "compaction_started",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
      messageIndex: this.entries.filter((entry) => entry.type === "message").length,
    }));
    return id;
  }

  async appendCompactionEnd(input: {
    compactionId: string;
    status: "completed" | "failed" | "interrupted";
    error?: string;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "compaction_end",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  /**
   * 落一条压缩质量观测：压缩后窗口期内重复读了哪些「压缩前已读过」的文件。
   * 纯观测条目，不参与 effectiveMessages 回放。
   */
  async appendCompactionQuality(input: {
    compactionId: string;
    baselineCount: number;
    rereadPaths: string[];
    windowTurns: number;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "compaction_quality",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  /** 最近一条压缩质量观测；没有则返回 null。 */
  get lastCompactionQuality(): Extract<SessionEntry, { type: "compaction_quality" }> | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === "compaction_quality") return entry;
    }
    return null;
  }

  async appendRecovery(actions: string[]): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "recovery",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      actions,
    }));
    return id;
  }

  async appendTitle(title: string): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "title",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      title,
    }));
    return id;
  }

  /** 追加一条文件改动记录（审阅面板）；path 为工作区相对路径，diff 为统一 diff 文本。 */
  async appendFileChange(
    filePath: string,
    operation: "write_file" | "edit_file" | "delete_file" | "move_file",
    diff: string,
  ): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "file_change",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      path: filePath,
      operation,
      diff,
    }));
    return id;
  }

  /**
   * 落一条检查点（纯元数据 + 可选文件快照引用；restore 时才截断复制建新会话）。
   * 自动检查点在每个用户回合开始写入；手动检查点走 server 端点。
   * buildSnapshot 在拿到 checkpointId 后落快照索引，返回引用一并写进 entry ——
   * 顺序是先索引后 entry：entry 写失败只留孤儿索引（GC 回收），反序会留下指向
   * 不存在文件的引用。不传 buildSnapshot = 纯对话检查点（旧形态，不可回滚代码）。
   */
  async appendCheckpoint(
    input: {
      label?: string;
      auto: boolean;
      turnId?: string;
      fileChanges: string[];
    },
    buildSnapshot?: (checkpointId: string) => Promise<CheckpointSnapshotRef | null>,
  ): Promise<SessionCheckpoint> {
    const id = newEntryId();
    const timestamp = new Date().toISOString();
    const snapshot = buildSnapshot ? ((await buildSnapshot(id)) ?? undefined) : undefined;
    await this.appendEntry((parentId) => ({
      type: "checkpoint",
      id,
      parentId,
      timestamp,
      ...input,
      ...(snapshot ? { snapshot } : {}),
    }));
    // 检查点条目在末尾：此前全部 message 条目就是它的时间线位置（与 checkpoints getter 同口径）
    let messageIndex = 0;
    for (const entry of this.entries) {
      if (entry.type === "message") messageIndex += 1;
    }
    return {
      id,
      timestamp,
      ...(input.label ? { label: input.label } : {}),
      auto: input.auto,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      fileChanges: input.fileChanges,
      messageIndex,
      ...(snapshot ? { snapshot } : {}),
      hasSnapshot: Boolean(snapshot),
      fileCount: snapshot?.count ?? 0,
    };
  }

  /** 落一条回滚留痕（审计 + 撤销回滚入口；不参与消息重放与检查点计数）。 */
  async appendRewind(input: {
    checkpointId: string;
    mode: "both" | "conversation" | "code";
    journal: string;
    derivedSessionId?: string;
    sourceSessionId?: string;
    fileCount: number;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "rewind",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  async appendPlan(steps: PlanStep[], explanation?: string): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "plan",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      steps,
      ...(explanation ? { explanation } : {}),
    }));
    return id;
  }

  /** 落一条模型调用用量；用于切换会话/重启后恢复右侧 token 与缓存统计。 */
  async appendUsage(usage: {
    inputTokens?: number;
    uncachedInputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** 本轮生成速度（output token / 秒）；实时速度曲线回放用 */
    tokensPerSecond?: number;
    source?: UsageSource;
    /** 模型调用轮次 id：同一轮多次上报靠它去重 */
    roundId?: string;
    turnId?: string;
    providerId?: string;
    model?: string;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "usage",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...usage,
    }));
    return id;
  }

  /** 落一个已完成回合的耗时指标；切换会话时恢复右侧信息。 */
  async appendMetrics(metrics: {
    tokensPerSecond?: number;
    responseMs?: number;
    firstTokenMs?: number;
    turnId?: string;
    status?: TurnStatus;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "metrics",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...metrics,
    }));
    return id;
  }

  async appendCompactionSummary(summary: string, keepRecentMessages = 0): Promise<string> {
    const id = newEntryId();
    // 压缩边界是唯一可以安全改写历史的时刻：把保留段里「最后一个真实 user 之前」的
    // thinking 一次性剥掉（切点在此刻冻结，之后不再随回合前移，不然就成逐轮投影了）。
    const retained: ChatMessage[] = [];
    if (keepRecentMessages > 0) {
      for (const entry of this.entries) {
        if (entry.type === "message") retained.push(entry.message);
      }
      retained.splice(0, Math.max(0, retained.length - keepRecentMessages));
    }
    const thinkingKeepFromRetained = retainedThinkingBoundary(retained);
    await this.appendEntry((parentId) => ({
      type: "compaction_summary",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      summary,
      ...(keepRecentMessages > 0 ? { keepRecentMessages } : {}),
      ...(thinkingKeepFromRetained > 0 ? { thinkingKeepFromRetained } : {}),
    }));
    return id;
  }

  /**
   * 落一个服务端原生压缩点：加密 item 连同来源一起存档，重放时原样回传。
   * 与 compaction_summary 同位——更早的历史不再进入后续请求，但原始消息
   * 仍完整留在 JSONL 里，换端点/换模型时可以退回本地摘要。
   */
  async appendNativeCompaction(summary: string, native: NativeCompactionPayload): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "native_compaction",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      summary,
      native,
    }));
    return id;
  }

  /**
   * 记录「旧工具输出 → 模型纪要」的映射（轻量压缩档位）。
   * 只影响后续请求的重放（effectiveMessages），不改写在案的原始消息。
   */
  async appendToolDigests(digests: Array<{ callId: string; digest: string }>): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "tool_digest",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      digests: digests.filter((item) => item.callId && item.digest),
    }));
    return id;
  }

  /** 父会话里的子 Agent 索引；running → completed 追加第二条，由 getter 折叠。 */
  async appendSubagent(input: {
    agentId: string;
    callId: string;
    description: string;
    agentType?: SubagentType;
    background?: boolean;
    status: SubagentStatus;
    startedAt: string;
    endedAt?: string;
    durationMs?: number;
    error?: string;
    usage?: UsageSummary;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "subagent",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  /** 追加一条运行时上下文（如压缩后的计划快照 / @文件引用），按位置参与后续请求。 */
  async appendContextNote(
    content: string,
    source: "plan" | "file" | "subagent" | "workflow" | "plugin" | "style" = "plan",
  ): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "context_note",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      source,
      content,
    }));
    return id;
  }

  /** 治理 run 准入审计条目（admit 成功时）。 */
  async appendAdmission(input: {
    tier: "T0" | "T1" | "T2";
    taskShape: string;
    lanes: Array<{
      id: string;
      objective: string;
      ownedPaths: string[];
      verificationCommands: string[];
      dependsOn: string[];
    }>;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "admission",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  /** 治理 gate 判定审计条目（G4/G5/G6 pass/fail）。 */
  async appendGateReport(input: {
    laneId: string;
    gate: string;
    verdict: "pass" | "fail";
    agentId?: string;
    message: string;
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "gate_report",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  /** 契约角色 ChildResult 审计条目（implementer/reviewer/verifier 结算时）。 */
  async appendChildResult(input: {
    agentId: string;
    callId: string;
    role: AgentRole;
    payload: {
      status: string;
      valid: boolean;
      invalidReason?: string;
      summary: string;
      filesChanged: string[];
      commands: Array<{ argv: string; exitCode: number }>;
      findingsCount: number;
    };
  }): Promise<string> {
    const id = newEntryId();
    await this.appendEntry((parentId) => ({
      type: "child_result",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      ...input,
    }));
    return id;
  }

  // ---- Value getters ----

  /** 子 Agent 索引：同一 agentId 以最后一条状态为准，按首次出现顺序返回。 */
  get subagents(): SubagentSummary[] {
    const byAgent = new Map<string, SubagentSummary>();
    for (const entry of this.entries) {
      if (entry.type !== "subagent") continue;
      byAgent.set(entry.agentId, {
        agentId: entry.agentId,
        parentSessionId: this.id,
        callId: entry.callId,
        description: entry.description,
        ...(entry.agentType ? { agentType: entry.agentType } : {}),
        ...(entry.background ? { background: true } : {}),
        status: entry.status,
        startedAt: entry.startedAt,
        ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.usage ? { usage: entry.usage } : {}),
      });
    }
    return [...byAgent.values()];
  }

  /** 当前标题 = 最后一条 title 条目；没有则 null（还没生成过）。 */
  get title(): string | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === "title") return entry.title;
    }
    return null;
  }

  /** 是否已经生成过标题（自动生成只做一次）。 */
  get hasTitle(): boolean {
    return this.entries.some((entry) => entry.type === "title");
  }

  /** 最新任务计划；没有则 null。 */
  get currentPlan(): { steps: PlanStep[]; explanation?: string } | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === "plan") {
        return {
          steps: entry.steps,
          ...(entry.explanation ? { explanation: entry.explanation } : {}),
        };
      }
    }
    return null;
  }

  /** 最新上下文压缩摘要；没有则 null。原生压缩点用它的可读说明代替。 */
  get currentCompactionSummary(): string | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === "compaction_summary") return entry.summary;
      if (entry.type === "native_compaction") return entry.summary;
    }
    return null;
  }

  /** 最新一个服务端原生压缩点（含来源）；没有则 null。 */
  get lastNativeCompaction(): NativeCompactionEntry | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === "native_compaction") return entry;
    }
    return null;
  }

  /**
   * 所有压缩点（含未完成/中断的），按时间线位置排序。
   * 旧文件只有 compaction_summary，按摘要条目位置视为已完成。
   */
  get compactionPoints(): CompactionPoint[] {
    const points: Array<CompactionPoint & { id?: string }> = [];
    const started = new Map<string, number>();
    let messageCount = 0;
    for (const entry of this.entries) {
      if (entry.type === "message") {
        messageCount += 1;
        continue;
      }
      if (entry.type === "compaction_started") {
        started.set(entry.compactionId, points.length);
        points.push({
          id: entry.compactionId,
          messageIndex: entry.messageIndex ?? messageCount,
          status: "interrupted",
        });
        continue;
      }
      if (entry.type === "compaction_summary" || entry.type === "native_compaction") {
        let attached = false;
        for (let index = points.length - 1; index >= 0; index -= 1) {
          if (points[index].id && !points[index].summary) {
            points[index].summary = entry.summary;
            attached = true;
            break;
          }
          if (points[index].summary) break;
        }
        if (!attached) {
          points.push({ messageIndex: messageCount, summary: entry.summary, status: "completed" });
        }
        continue;
      }
      if (entry.type === "compaction_end") {
        const index = started.get(entry.compactionId);
        if (index !== undefined) points[index].status = entry.status;
      }
    }
    return points.map(({ id: _id, ...point }) => point);
  }

  /**
   * 最近一次带摘要的压缩点及其之前有多少条对话消息。
   * 前端据此把压缩分隔线插回时间线的原始位置，而不是固定贴在输入框上方。
   */
  get lastCompaction(): { messageIndex: number; summary: string } | null {
    const points = this.compactionPoints;
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const point = points[index];
      if (point.summary !== undefined) {
        return { messageIndex: point.messageIndex, summary: point.summary };
      }
    }
    return null;
  }

  /** 最后一个已完成回合的耗时指标；没有则 null。 */
  get lastTurnMetrics(): {
    tokensPerSecond?: number;
    responseMs?: number;
    firstTokenMs?: number;
  } | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === "metrics") {
        return {
          ...(entry.tokensPerSecond !== undefined
            ? { tokensPerSecond: entry.tokensPerSecond }
            : {}),
          ...(entry.responseMs !== undefined ? { responseMs: entry.responseMs } : {}),
          ...(entry.firstTokenMs !== undefined ? { firstTokenMs: entry.firstTokenMs } : {}),
        };
      }
    }
    return null;
  }

  /**
   * 会话累计用量。只统计主对话（source === "chat"）。
   *
   * 两个口径必须与前端实时链路一致，否则切会话/重载后数字会跳变：
   *  - 排除标题 / 压缩 / 记忆 / 学习 / 建议这些旁路调用（实时链路本来就不累计它们）；
   *  - 同一轮 `roundId` 有多条时后写覆盖先写（流中断记一笔、重试成功再记一笔）。
   * 旧记录没有 roundId，按「一次调用只落一条 final」的历史纪律逐条累加。
   */
  get usageTotals(): {
    inputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheInputTokens: number;
    cacheReported: boolean;
    hasUsage: boolean;
  } {
    const merged = new Map<string, Extract<SessionEntry, { type: "usage" }>>();
    let legacy = 0;
    for (const entry of this.entries) {
      if (entry.type !== "usage") continue;
      if ((entry.source ?? "chat") !== "chat") continue;
      merged.set(entry.roundId ?? `legacy:${legacy++}`, entry);
    }
    let inputTokens = 0;
    let uncachedInputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let cacheInputTokens = 0;
    let cacheReported = false;
    let hasUsage = false;
    for (const entry of merged.values()) {
      hasUsage = true;
      if (typeof entry.inputTokens === "number") inputTokens += entry.inputTokens;
      if (typeof entry.uncachedInputTokens === "number") {
        uncachedInputTokens += entry.uncachedInputTokens;
      }
      if (typeof entry.outputTokens === "number") outputTokens += entry.outputTokens;
      if (typeof entry.cacheReadTokens === "number") {
        cacheReported = true;
        cacheReadTokens += entry.cacheReadTokens;
        if (typeof entry.inputTokens === "number") cacheInputTokens += entry.inputTokens;
      }
      if (typeof entry.cacheWriteTokens === "number") {
        cacheWriteTokens += entry.cacheWriteTokens;
      }
    }
    return {
      inputTokens,
      uncachedInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheInputTokens,
      cacheReported,
      hasUsage,
    };
  }

  /**
   * 最近的主对话模型调用样本（时间正序）：右侧「实时命中率曲线」。
   * 每条 source=chat 的 usage 条目 = 一次模型调用；只收报告过缓存读取的样本，
   * 否则会在曲线上画出假的 0 命中。
   */
  get usageSamples(): Array<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    tokensPerSecond?: number;
  }> {
    const samples: Array<{
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      tokensPerSecond?: number;
    }> = [];
    for (const entry of this.entries) {
      if (entry.type !== "usage") continue;
      // 旧记录没有 source：视为主对话，与 turnDurations 同口径
      if ((entry.source ?? "chat") !== "chat") continue;
      if (typeof entry.cacheReadTokens !== "number") continue;
      if (typeof entry.inputTokens !== "number" || entry.inputTokens <= 0) continue;
      samples.push({
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens ?? 0,
        cacheReadTokens: entry.cacheReadTokens,
        ...(typeof entry.tokensPerSecond === "number"
          ? { tokensPerSecond: entry.tokensPerSecond }
          : {}),
      });
    }
    return samples.slice(-30);
  }

  /**
   * callId → 纪要：来自全部 tool_digest 条目，后写的覆盖先写的。
   * 纪要只替换请求里的工具输出正文，完整原文仍在 JSONL 与会话时间线里。
   */
  private toolDigestOverrides(): Map<string, string> {
    const overrides = new Map<string, string>();
    for (const entry of this.entries) {
      if (entry.type !== "tool_digest") continue;
      for (const item of entry.digests) overrides.set(item.callId, item.digest);
    }
    return overrides;
  }

  /** 用纪要替换对应 tool 消息（只换内容，不动配对 id 与时间线）。 */
  private applyToolDigests(messages: ChatMessage[]): ChatMessage[] {
    const overrides = this.toolDigestOverrides();
    if (!overrides.size) return messages;
    return messages.map((message) => {
      if (message.role !== "tool") return message;
      const digest = overrides.get(message.tool_call_id);
      if (!digest) return message;
      // 纪要内容没变就复用同一个对象：增量链靠引用相等判断前缀可续接。
      const cached = this.digestMessages.get(message);
      if (cached?.digest === digest) return cached.message;
      const next = { ...message, content: `[summarized] ${digest}`, images: undefined };
      this.digestMessages.set(message, { digest, message: next });
      return next;
    });
  }

  /** 合成消息按 entry 记忆化，避免每轮访问都新建字面量。 */
  private noteMessage(entry: SessionEntry, build: () => ChatMessage): ChatMessage {
    const cached = this.noteMessages.get(entry);
    if (cached) return cached;
    const message = build();
    this.noteMessages.set(entry, message);
    return message;
  }

  /**
   * 从当前有效历史的尾部按不可拆单元收集「压缩时逐字保留」的真实消息条目：
   * 保留预算从最新往回消耗，切段永远落在单元边界，保证工具配对完整。
   * 范围与 effectiveMessages 一致（含上一压缩点的保留段），多次压缩时预算连续累计。
   * 返回空数组表示整个有效历史都在保留预算内，没有可摘要的旧历史（退回全量摘要）。
   */
  recentKeptMessages(options: { tokens: number; contextWindow?: number }): ChatMessage[] {
    const lastSummaryIndex = this.findLastSummaryIndex();
    const summaryEntry = lastSummaryIndex >= 0 ? this.entries[lastSummaryIndex] : null;
    // 原生压缩点不可回放时与 effectiveMessages 口径一致：视同没有压缩点
    const blocked = summaryEntry?.type === "native_compaction" && !this.nativeCompactionReplayable;
    const startIndex = blocked ? -1 : lastSummaryIndex;
    const messages: ChatMessage[] = [];
    if (summaryEntry?.type === "compaction_summary") {
      const keep = summaryEntry.keepRecentMessages ?? 0;
      if (keep > 0) {
        const before: ChatMessage[] = [];
        for (const entry of this.entries.slice(0, lastSummaryIndex)) {
          if (entry.type === "message") before.push(entry.message);
        }
        // 切点在压缩时冻结：保留段本身不再变化，所以每轮算出的结果一致
        messages.push(
          ...stripThinkingBefore(
            before.slice(-keep),
            summaryEntry.thinkingKeepFromRetained ?? 0,
          ),
        );
      }
    }
    for (const entry of this.entries.slice(startIndex + 1)) {
      if (entry.type === "message") messages.push(entry.message);
    }
    if (!messages.length) return [];

    // 小窗口自适应：保留预算不超过窗口的 20%，至少 2000，避免小窗口被保留段占满
    const window = options.contextWindow && options.contextWindow > 0 ? options.contextWindow : null;
    const budget = window
      ? Math.max(2_000, Math.min(options.tokens, Math.floor(window * 0.2)))
      : options.tokens;
    const units = buildMessageUnits(messages);
    const keptUnits: ChatMessage[][] = [];
    let used = 0;
    for (let index = units.length - 1; index >= 0; index -= 1) {
      const cost = estimateMessagesTokens(units[index]);
      // 最新单元即使单独超预算也保留：最后一条 user 回合必须逐字在场
      if (used + cost > budget && keptUnits.length > 0) break;
      keptUnits.unshift(units[index]);
      used += cost;
    }
    if (keptUnits.length >= units.length) return [];
    return this.applyToolDigests(keptUnits.flat());
  }

  /**
   * 合成消息按 entry 记忆化：增量链（previous_response_id）用引用相等判断前缀，
   * 每轮重建字面量会让链断掉，之后每轮全量重发。
   */
  private noteMessages = new WeakMap<SessionEntry, ChatMessage>();
  /** 工具纪要替换结果按「原消息 + 纪要内容」记忆化，纪要变了才重建。 */
  private digestMessages = new WeakMap<ChatMessage, { digest: string; message: ChatMessage }>();
  /**
   * effectiveMessages 整体投影缓存。entries 只追加不截断（rewind 也是 append），
   * 所以 length 可当版本号；原生压缩点可回放性变化会整体改变投影，必须一起进键。
   */
  private effectiveCache: {
    size: number;
    replayable: boolean;
    messages: ChatMessage[];
  } | null = null;

  /**
   * 当前 provider 能否重放最新的服务端原生压缩点。加密 item 与端点/模型绑定，
   * runtime 在换模型/换服务商后置 false：此时退回原始历史（JSONL 里完整保留），
   * 由裁剪兜住窗口，而不是把上下文交给一个回放不了的 item。
   */
  nativeCompactionReplayable = true;

  /**
   * 压缩后继续对话时只使用摘要之后的消息；完整历史仍留在 JSONL 文件里。
   * 摘要以一条 user 消息的形式作为请求前缀，计划等上下文按记录位置穿插。
   * 摘要条目带有 keepRecentMessages 时，压缩点之前最近 N 条真实消息仍逐字参与请求。
   * 服务端原生压缩点则以 native_compaction 消息回放加密 item（不再保留旧消息）。
   *
   * 返回值按 entries 长度缓存，合成消息按 entry 记忆化：增量链用引用相等判断
   * 前缀可续接，每次重建都会让链断掉。调用方不得原地修改返回数组。
   */
  get effectiveMessages(): ChatMessage[] {
    const cached = this.effectiveCache;
    if (
      cached &&
      cached.size === this.entries.length &&
      cached.replayable === this.nativeCompactionReplayable
    ) {
      return cached.messages;
    }
    const messages = this.buildEffectiveMessages();
    this.effectiveCache = {
      size: this.entries.length,
      replayable: this.nativeCompactionReplayable,
      messages,
    };
    return messages;
  }

  private buildEffectiveMessages(): ChatMessage[] {
    const lastSummaryIndex = this.findLastSummaryIndex();
    const messages: ChatMessage[] = [];
    const summaryEntry = lastSummaryIndex >= 0 ? this.entries[lastSummaryIndex] : null;
    // 原生压缩点无法在当前端点上回放：视同没有压缩点，退回完整原始历史
    const blocked = summaryEntry?.type === "native_compaction" && !this.nativeCompactionReplayable;
    const startIndex = blocked ? -1 : lastSummaryIndex;
    if (summaryEntry?.type === "compaction_summary") {
      messages.push(
        this.noteMessage(summaryEntry, () => ({
          role: "user",
          content: `Earlier conversation summary:\n${summaryEntry.summary}`,
        })),
      );
      const keep = summaryEntry.keepRecentMessages ?? 0;
      if (keep > 0) {
        const before: ChatMessage[] = [];
        for (const entry of this.entries.slice(0, lastSummaryIndex)) {
          if (entry.type === "message") before.push(entry.message);
        }
        // 保留段里旧回合的 thinking 在压缩时已被判定可剥：重放时不再回传，
        // 切点冻结在压缩那一刻，所以这仍是「一次改写」而不是逐轮投影
        messages.push(
          ...stripThinkingBefore(
            before.slice(-keep),
            summaryEntry.thinkingKeepFromRetained ?? 0,
          ),
        );
      }
    } else if (summaryEntry?.type === "native_compaction" && !blocked) {
      messages.push(
        this.noteMessage(summaryEntry, () => ({
          role: "native_compaction",
          content:
            summaryEntry.summary ||
            "Earlier conversation history was compacted server-side by the provider.",
          native: summaryEntry.native,
        })),
      );
    }
    for (const entry of this.entries.slice(startIndex + 1)) {
      if (entry.type === "message") {
        messages.push(entry.message);
      } else if (entry.type === "context_note") {
        messages.push(this.noteMessage(entry, () => ({ role: "user", content: entry.content })));
      }
    }
    return repairToolPairs(this.applyToolDigests(messages));
  }

  /**
   * 最近一次主对话真实用量的锚点：inputTokens + 它覆盖到的有效消息条数。
   * 压缩过的会话不做跨进程推算（摘要前缀会让下标对不上），交给下一次请求重新锚定。
   */
  get lastChatUsageAnchor(): { inputTokens: number; messageCount: number } | null {
    const usage = this.lastChatUsage;
    if (!usage || typeof usage.inputTokens !== "number" || usage.inputTokens <= 0) return null;
    if (this.findLastSummaryIndex() >= 0) return null;
    const usageIndex = this.entries.lastIndexOf(usage);
    let trailing = 0;
    for (let index = usageIndex + 1; index < this.entries.length; index += 1) {
      if (this.entries[index].type === "message") trailing += 1;
    }
    return {
      inputTokens: usage.inputTokens,
      messageCount: Math.max(0, this.effectiveMessages.length - trailing),
    };
  }

  /** 压缩点之后是否还有新的对话消息（只有摘要本身不算）。 */
  get hasUncompactedMessages(): boolean {
    const lastSummaryIndex = this.findLastSummaryIndex();
    return this.entries
      .slice(lastSummaryIndex + 1)
      .some((entry) => entry.type === "message");
  }

  // ---- Partial checkpoint (in-flight assistant text) ----

  private get partialFile(): string {
    return path.join(path.dirname(this.filePath), ".partial", `${this.id}.json`);
  }

  /** 已读区间快照的落盘位置：与 .partial 同级，按会话 id 命名。 */
  private get readStateFile(): string {
    return path.join(path.dirname(this.filePath), ".readstate", `${this.id}.json`);
  }

  /**
   * 保存「模型读过哪些文件的哪几行」快照（best-effort，失败即忽略）。
   *
   * 不进 JSONL 日志：它的作用是加速（省掉整段重读），丢了的代价只是重读一次，
   * 不是事实性数据 —— 独立小文件最省事，也不会污染会话时间线。
   */
  async saveReadCoverage(snapshot: unknown): Promise<void> {
    if (!Array.isArray(snapshot) || !snapshot.length) return;
    try {
      await writeJsonAtomic(this.readStateFile, snapshot);
    } catch {
      // 写失败不影响对话
    }
  }

  /** 读取已读区间快照；没有/损坏都返回 null（按「没读过」处理）。 */
  async loadReadCoverage<T>(): Promise<T | null> {
    try {
      return (await readJsonFile<T>(this.readStateFile)) ?? null;
    } catch {
      return null;
    }
  }

  async writePartial(input: {
    turnId: string;
    round: number;
    content: string;
    reasoning?: string;
  }): Promise<void> {
    const payload: PartialCheckpoint = {
      turnId: input.turnId,
      round: input.round,
      content: input.content.slice(0, PARTIAL_MAX_CHARS),
      ...(input.reasoning ? { reasoning: input.reasoning.slice(0, PARTIAL_MAX_CHARS) } : {}),
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeJsonAtomic(this.partialFile, payload);
    } catch {
      // 半截文本是尽力而为的检查点，写失败不能打断回合
    }
  }

  async readPartial(): Promise<PartialCheckpoint | null> {
    try {
      const parsed = await readJsonFile<PartialCheckpoint>(this.partialFile);
      if (!parsed || typeof parsed.turnId !== "string" || typeof parsed.content !== "string") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async clearPartial(): Promise<void> {
    try {
      await fs.unlink(this.partialFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // ---- Writer / durability ----

  /** Flush pending appends and fsync the session file. */
  async flush(): Promise<void> {
    await this.writeChain;
    if (this.writer) await this.writer.datasync();
  }

  /** 幂等关闭：等写链清空、fsync 后释放句柄，并同步刷新会话索引。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeChain;
    await this.writerOpening?.catch(() => undefined);
    if (this.writer) {
      try {
        await this.writer.datasync();
      } finally {
        await this.writer.close().catch(() => undefined);
        this.writer = null;
      }
    }
    // 关闭前把防抖中的索引更新落盘，保证列表立刻反映最终状态
    await flushSessionIndex(path.dirname(this.filePath));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 追加一条记录。
   * `toMemory` 让内存副本与落盘副本不一致（例如图片只留内存）：磁盘写 `entry`，`entries` 里放映射后的版本。
   */
  private async appendEntry(
    build: (parentId: string | null) => SessionEntry,
    toMemory?: (entry: SessionEntry) => SessionEntry,
  ): Promise<SessionEntry> {
    if (this.closed) throw new Error("Session store is closed.");
    return this.enqueue(async () => {
      const entry = build(this.currentId);
      const handle = await this.ensureWriter();
      await handle.write(`${JSON.stringify(entry)}\n`, null, "utf8");
      this.entries.push(toMemory ? toMemory(entry) : entry);
      if (entry.type !== "session") this.currentId = entry.id;
      scheduleIndexUpdate(path.dirname(this.filePath));
      return entry;
    });
  }

  private async ensureWriter(): Promise<FileHandle> {
    if (this.writer) return this.writer;
    if (this.writerOpening) return this.writerOpening;
    this.writerOpening = (async () => {
      await this.repairTail();
      const handle = await fs.open(this.filePath, "a");
      this.writer = handle;
      return handle;
    })();
    try {
      return await this.writerOpening;
    } finally {
      this.writerOpening = null;
    }
  }

  /** 首次写入前修复崩溃留下的半行，避免新记录接在半行后面变成坏行。 */
  private async repairTail(): Promise<void> {
    let size: number;
    try {
      size = (await fs.stat(this.filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (size === 0) return;

    let tailStart = 0;
    let scanEnd = size;
    while (scanEnd > 0) {
      const start = Math.max(0, scanEnd - TAIL_SCAN_CHUNK);
      const chunk = await this.readRange(start, scanEnd);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) {
        tailStart = start + newline + 1;
        break;
      }
      scanEnd = start;
    }
    if (tailStart >= size) return; // 文件以换行结束

    // 尾段超过 8MB 时只检查最后一段：合法的单行记录不会这么大
    const readStart = Math.max(tailStart, size - 8 * 1024 * 1024);
    const tail = (await this.readRange(readStart, size)).toString("utf8");
    let valid = false;
    try {
      if (tail.trim()) {
        JSON.parse(tail.trim());
        valid = true;
      }
    } catch {
      valid = false;
    }

    if (valid) {
      const handle = await fs.open(this.filePath, "a");
      try {
        await handle.write("\n", null, "utf8");
      } finally {
        await handle.close();
      }
      return;
    }

    if (tail.trim()) await this.backupBrokenTail(tail);
    await fs.truncate(this.filePath, tailStart);
  }

  private async readRange(start: number, end: number): Promise<Buffer> {
    const handle = await fs.open(this.filePath, "r");
    try {
      const length = Math.max(0, end - start);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private async backupBrokenTail(tail: string): Promise<void> {
    try {
      const recoveryDir = path.join(path.dirname(this.filePath), ".recovery");
      await fs.mkdir(recoveryDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `${path.basename(this.filePath)}.${stamp}.partial`;
      await fs.writeFile(path.join(recoveryDir, name), tail, "utf8");
    } catch {
      // 备份失败不阻止修复
    }
  }

  private findLastSummaryIndex(): number {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const type = this.entries[index].type;
      if (type === "compaction_summary" || type === "native_compaction") return index;
    }
    return -1;
  }
}

export type SessionSummary = {
  id: string;
  filePath: string;
  cwd: string;
  createdAt: string;
  /** AI 生成或用户手动设置的会话标题；还没生成过则为 null */
  title: string | null;
  /** 会话里的消息条数；0 = 还没发过消息（新建后未使用的会话，列表里不显示） */
  messageCount: number;
  /** 独立 worktree 元数据；侧栏归组与分支标识用 */
  worktree?: SessionWorktree;
};

type IndexedSession = Omit<SessionSummary, "filePath"> & {
  size: number;
  mtimeMs: number;
};

type SessionIndexFile = {
  version: 1;
  files: Record<string, IndexedSession>;
};

async function readSessionIndex(indexPath: string): Promise<SessionIndexFile> {
  try {
    const parsed = await readJsonFile<SessionIndexFile>(indexPath);
    if (parsed?.version === 1 && parsed.files && typeof parsed.files === "object") {
      return parsed;
    }
  } catch {
    // 坏索引直接重建
  }
  return { version: 1, files: {} };
}

// ---- 会话索引防抖更新 ----

const pendingIndexTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 会话写入后调度索引更新：只保证一个 2s 防抖定时器存在，不做任何 IO。
 * appendEntry 每条消息/工具事件都会写盘，直接同步更新 index.json 会把
 * 原子写（tmp+fsync+rename）放大成每事件一次；防抖期间多次写入合并成
 * 一次全量对账。崩溃丢掉防抖窗口也安全——listSessions 按 size/mtime
 * 不匹配自动重建索引。
 */
function scheduleIndexUpdate(sessionsDir: string): void {
  if (pendingIndexTimers.has(sessionsDir)) return;
  const timer = setTimeout(() => {
    pendingIndexTimers.delete(sessionsDir);
    void listSessions(sessionsDir).catch(() => undefined);
  }, 2_000);
  // 不阻止进程退出：索引丢了可以重建，挂住退出得不偿失
  timer.unref?.();
  pendingIndexTimers.set(sessionsDir, timer);
}

/** 立即刷新某目录的会话索引（close / 优雅退出前调用），并取消未触发的防抖。 */
export async function flushSessionIndex(sessionsDir: string): Promise<void> {
  const timer = pendingIndexTimers.get(sessionsDir);
  if (timer) {
    clearTimeout(timer);
    pendingIndexTimers.delete(sessionsDir);
  }
  await listSessions(sessionsDir).catch(() => undefined);
}

async function parseSessionSummary(
  filePath: string,
): Promise<Omit<SessionSummary, "filePath"> | null> {
  const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
  const header = JSON.parse(lines[0] ?? "") as SessionHeader;
  if (header.type !== "session") return null;
  let title: string | null = null;
  let messageCount = 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      const entry = JSON.parse(lines[index]) as SessionEntry;
      if (entry.type === "title") title = entry.title;
      else if (entry.type === "message") messageCount += 1;
    } catch {
      // 忽略撕裂/坏行；writer 会在下次 append 时修复
    }
  }
  return {
    id: header.id,
    cwd: header.cwd,
    createdAt: header.createdAt,
    title,
    messageCount,
    ...(header.worktree ? { worktree: header.worktree } : {}),
  };
}

export async function listSessions(sessionsDir: string): Promise<SessionSummary[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(sessionsDir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const indexPath = path.join(sessionsDir, "index.json");
  const index = await readSessionIndex(indexPath);
  let changed = false;
  const files: Record<string, IndexedSession> = {};
  const sessions: SessionSummary[] = [];

  await Promise.all(
    names.map(async (name) => {
      const filePath = path.join(sessionsDir, name);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        changed = true;
        return;
      }
      const cached = index.files[name];
      let summary: Omit<SessionSummary, "filePath"> | null;
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        summary = {
          id: cached.id,
          cwd: cached.cwd,
          createdAt: cached.createdAt,
          title: cached.title,
          messageCount: cached.messageCount,
          ...(cached.worktree ? { worktree: cached.worktree } : {}),
        };
      } else {
        try {
          summary = await parseSessionSummary(filePath);
        } catch {
          summary = null;
        }
        changed = true;
      }
      if (!summary) return;
      files[name] = { ...summary, size: stat.size, mtimeMs: stat.mtimeMs };
      sessions.push({ ...summary, filePath });
    }),
  );

  if (Object.keys(index.files).length !== Object.keys(files).length) changed = true;
  if (!changed) {
    for (const name of Object.keys(files)) {
      if (!index.files[name]) {
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    await writeJsonAtomic(indexPath, { version: 1, files } satisfies SessionIndexFile).catch(
      () => undefined,
    );
  }

  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function sessionFileName(cwd: string, timestamp: Date): string {
  const safeCwd = cwd
    .replace(/^([a-zA-Z]):\\?/, "$1-")
    .replace(/[<>:"/\\|?*\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stamp = timestamp.toISOString().replace(/[:.]/g, "-");
  return `${stamp}_${safeCwd || "workspace"}.jsonl`;
}
