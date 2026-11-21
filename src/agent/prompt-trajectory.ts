/**
 * 提示词轨迹：每次真正发往 provider 的请求留一份快照（system 分段 + 工具目录 + 版本指纹）。
 *
 * 与 `trace.ts` 的分工：trace 记「耗时与成败」（span），这里记「发出去的字节长什么样」。
 * 与 `cache-diagnostics.ts` 的分工：那边只留指纹用于缓存归因，这里要能给人看，
 * 所以保留文本（有单段上限），并按会话留最近 N 次以支持「与上一版对比」。
 *
 * 只驻留内存：重启即失。这够用于「这一轮到底发了什么」的排查，同时避免把
 * 工作区规则、可能的密钥片段意外持久化到磁盘。
 */
import { createHash, randomUUID } from "node:crypto";

/** 每个会话保留的请求数：够覆盖「上一轮 diff」与最近几次翻看。 */
export const MAX_TRAJECTORY_ENTRIES = 20;
/** 单段文本上限：超长 AGENTS.md 不该把内存与响应撑爆。 */
export const MAX_SEGMENT_CHARS = 32_000;

export type PromptSegmentRecord = {
  index: number;
  /** baseline / instructions / segment[i]；段本身没有名字，只能按装配顺序推断 */
  label: string;
  length: number;
  sha1: string;
  text: string;
  truncated?: boolean;
};

export type PromptToolRecord = {
  index: number;
  name: string;
  descriptionLength: number;
  schemaLength: number;
  sha1: string;
};

export type PromptTrajectoryDiff = {
  /** 内容变化的 system 下标（只在两次条数一致时逐条比对） */
  system: number[];
  tools: boolean;
  countChanged: boolean;
  toolChanges?: Array<{ index: number; name: string }>;
  addedTools: string[];
  removedTools: string[];
};

export type PromptTrajectoryEntry = {
  id: string;
  sessionId: string;
  turnId: string | null;
  roundId: string;
  providerId: string;
  model: string;
  protocol: string;
  createdAt: number;
  promptVersion: { baseline: string; instructions: string | null; segments: string[] };
  segments: PromptSegmentRecord[];
  tools: PromptToolRecord[];
  /** 与同一会话的上一条请求比较；第一条为 null */
  diff: PromptTrajectoryDiff | null;
};

export type PromptTrajectoryInput = {
  sessionId: string;
  turnId: string | null;
  roundId: string;
  providerId: string;
  model: string;
  protocol: string;
  promptVersion: { baseline: string; instructions: string | null; segments: string[] };
  messages: ReadonlyArray<{ role: string; content: unknown }>;
  tools: ReadonlyArray<{
    function: { name: string; description?: string; parameters?: unknown };
  }>;
};

const sha = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 16);

/** system 消息可能是纯字符串，也可能是 `[{ type: "text", text }]` 块数组。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part && typeof part === "object") {
      const value = (part as { text?: unknown }).text;
      if (typeof value === "string") text += value;
    }
  }
  return text;
}

export class PromptTrajectoryRecorder {
  private readonly bySession = new Map<string, PromptTrajectoryEntry[]>();

  /** 记录一次实际请求；返回落库条目（含与上一条的 diff）。 */
  record(input: PromptTrajectoryInput): PromptTrajectoryEntry {
    const systemTexts = input.messages
      .filter((message) => message.role === "system")
      .map((message) => textOf(message.content));

    const hasInstructions = input.promptVersion.instructions !== null;
    const segments: PromptSegmentRecord[] = systemTexts.map((text, index) => {
      const label =
        index === 0
          ? "baseline"
          : hasInstructions && index === 1
            ? "instructions"
            : `segment[${index - (hasInstructions ? 2 : 1)}]`;
      const clipped = text.length > MAX_SEGMENT_CHARS;
      return {
        index,
        label,
        length: text.length,
        sha1: sha(text),
        text: clipped ? text.slice(0, MAX_SEGMENT_CHARS) : text,
        ...(clipped ? { truncated: true } : {}),
      };
    });

    const tools: PromptToolRecord[] = input.tools.map((tool, index) => {
      const description = tool.function.description ?? "";
      const schema = JSON.stringify(tool.function.parameters ?? {});
      return {
        index,
        name: tool.function.name,
        descriptionLength: description.length,
        schemaLength: schema.length,
        sha1: sha(JSON.stringify(tool.function)),
      };
    });

    const previous = this.list(input.sessionId, 1).at(-1);
    const entry: PromptTrajectoryEntry = {
      id: randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      roundId: input.roundId,
      providerId: input.providerId,
      model: input.model,
      protocol: input.protocol,
      createdAt: Date.now(),
      promptVersion: input.promptVersion,
      segments,
      tools,
      diff: previous ? diffOf(previous, segments, tools) : null,
    };

    const bucket = this.bySession.get(input.sessionId) ?? [];
    bucket.push(entry);
    if (bucket.length > MAX_TRAJECTORY_ENTRIES) bucket.shift();
    this.bySession.set(input.sessionId, bucket);
    return entry;
  }

  /** 旧 → 新；limit 截的是尾部（最近 N 条）。 */
  list(sessionId: string, limit = MAX_TRAJECTORY_ENTRIES): PromptTrajectoryEntry[] {
    const bucket = this.bySession.get(sessionId) ?? [];
    return bucket.slice(Math.max(0, bucket.length - Math.max(1, limit)));
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

function diffOf(
  previous: PromptTrajectoryEntry,
  segments: PromptSegmentRecord[],
  tools: PromptToolRecord[],
): PromptTrajectoryDiff {
  const system: number[] = [];
  const shared = Math.min(previous.segments.length, segments.length);
  for (let index = 0; index < shared; index += 1) {
    if (previous.segments[index].sha1 !== segments[index].sha1) system.push(index);
  }

  const previousNames = new Set(previous.tools.map((tool) => tool.name));
  const nextNames = new Set(tools.map((tool) => tool.name));
  const addedTools = [...nextNames].filter((name) => !previousNames.has(name));
  const removedTools = [...previousNames].filter((name) => !nextNames.has(name));

  const toolChanges: Array<{ index: number; name: string }> = [];
  const sharedTools = Math.min(previous.tools.length, tools.length);
  for (let index = 0; index < sharedTools; index += 1) {
    if (previous.tools[index].sha1 !== tools[index].sha1) {
      toolChanges.push({ index, name: tools[index].name });
    }
  }

  return {
    system,
    tools: toolChanges.length > 0 || addedTools.length > 0 || removedTools.length > 0,
    countChanged: previous.segments.length !== segments.length,
    ...(toolChanges.length ? { toolChanges } : {}),
    addedTools,
    removedTools,
  };
}
