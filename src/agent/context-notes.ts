/**
 * 上下文注记的「只留最新」过滤。
 *
 * 模式 / 语色 / 计划快照 / 命令账本这些注记写成 in-history 追加（换一次只追加一条，
 * 前缀字节不动，见 runtime 的 ensureModeContext 与 ensureSpeechStyleContext）。
 * 代价是历史里会留下一条条「已被后续覆盖」的旧注记：它们对模型没有信息量，
 * 却每轮都随上下文重发。
 *
 * 这里在**请求组装时**按家族只保留最后一条：不改 journal、不改 UI 历史，
 * 因此不影响回放与审计；过滤是确定性的（同一份历史永远得到同一份结果），
 * 所以跨回合前缀仍然稳定——只有新注记到来的那一刻尾部变化一次，
 * 与「直接追加」的代价完全相同，但不会线性增长。
 *
 * 刻意不处理的：
 *  - fork 契约（只有一条，且是契约而非状态快照）；
 *  - job/file/plugin 通知（每条内容不同，不是状态覆盖关系）。
 */

/** 会被后续注记覆盖的家族前缀（长前缀在前，避免包含关系误判）。 */
const SUPERSEDED_PREFIXES = [
  "Runtime context: current task plan",
  "Runtime context: [speech style]",
  "Runtime context: [mode]",
  "Runtime context: commands already run before compaction",
] as const;

/** 命中返回家族前缀，否则 null。只看字符串内容的 user 消息。 */
export function supersededNoteFamily(message: {
  role: string;
  content: unknown;
}): string | null {
  if (message.role !== "user" || typeof message.content !== "string") return null;
  const text = message.content;
  for (const prefix of SUPERSEDED_PREFIXES) {
    if (text.startsWith(prefix)) return prefix;
  }
  return null;
}

/**
 * 每个家族只保留最后一条；其余顺序、对象引用不变（增量链靠引用恒等判断前缀）。
 * 没有任何注记时原样返回浅拷贝，避免调用方误以为可以改原数组。
 */
export function dropSupersededNotes<T extends { role: string; content: unknown }>(
  messages: readonly T[],
): T[] {
  const lastIndex = new Map<string, number>();
  messages.forEach((message, index) => {
    const family = supersededNoteFamily(message);
    if (family) lastIndex.set(family, index);
  });
  if (!lastIndex.size) return [...messages];
  return messages.filter((message, index) => {
    const family = supersededNoteFamily(message);
    return family === null || lastIndex.get(family) === index;
  });
}
