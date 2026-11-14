/**
 * 模型可见请求的稳定快照。
 *
 * 目的：提示词、工具描述、工具顺序、message 形态的任何漂移，都应当在 CI 里
 * 变成一条可 review 的 diff，而不是等线上缓存命中率掉了才发现。
 *
 * 设计取舍：
 *  - 不存全文：30 个工具的 schema + system 全文会让快照几百 KB，diff 不可读。
 *  - 存「长度 + sha1 + 短前缀」：任何字节变化都会变红，且能定位到第几个工具 /
 *    第几条 system；需要看原文时按索引回源码取。
 *  - `cache_control` 不入快照：它随画像与轮次移动，属于计划而非内容。
 *  - 临时路径、会话 id 由调用方用 replacements 归一化，避免环境噪声。
 */
import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

export type RequestSnapshot = {
  system: Array<{ index: number; length: number; sha1: string; head: string }>;
  tools: Array<{
    index: number;
    name: string;
    description: { length: number; sha1: string };
    parameters: { length: number; sha1: string };
  }>;
  messages: Array<{
    index: number;
    role: string;
    length: number;
    sha1: string;
    toolCalls: string[];
  }>;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function normalize(text: string, replacements: ReadonlyArray<readonly [string, string]>): string {
  let out = text;
  for (const [from, to] of replacements) {
    if (from) out = out.split(from).join(to);
  }
  return out;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const record = asRecord(block);
        if (!record) return "";
        if (typeof record.text === "string") return record.text;
        return JSON.stringify(record);
      })
      .join("\n");
  }
  return JSON.stringify(content) ?? "";
}

/** 工具调用只记名字：id 由模型生成，同一场景跨运行不稳定，不属于内容契约。 */
function toolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "tool_use" && typeof record.name === "string") names.push(record.name);
  }
  return names;
}

export function buildRequestSnapshot(input: {
  system: readonly unknown[];
  tools: readonly unknown[];
  messages: readonly unknown[];
  replacements?: ReadonlyArray<readonly [string, string]>;
}): RequestSnapshot {
  const replacements = input.replacements ?? [];

  const system = input.system.map((block, index) => {
    const record = asRecord(block);
    const raw =
      typeof block === "string"
        ? block
        : typeof record?.text === "string"
          ? record.text
          : (JSON.stringify(block ?? "") ?? "");
    const text = normalize(raw, replacements);
    return { index, length: text.length, sha1: sha1(text), head: text.slice(0, 80) };
  });

  const tools = input.tools.map((tool, index) => {
    const record = asRecord(tool) ?? {};
    const name = typeof record.name === "string" ? record.name : `<tool-${index}>`;
    const description = normalize(
      typeof record.description === "string" ? record.description : "",
      replacements,
    );
    const parameters = normalize(
      JSON.stringify(record.input_schema ?? record.parameters ?? {}),
      replacements,
    );
    return {
      index,
      name,
      description: { length: description.length, sha1: sha1(description) },
      parameters: { length: parameters.length, sha1: sha1(parameters) },
    };
  });

  const messages = input.messages.map((message, index) => {
    const record = asRecord(message) ?? {};
    const text = normalize(contentText(record.content), replacements);
    return {
      index,
      role: typeof record.role === "string" ? record.role : "unknown",
      length: text.length,
      sha1: sha1(text),
      toolCalls: toolNames(record.content),
    };
  });

  return { system, tools, messages };
}
