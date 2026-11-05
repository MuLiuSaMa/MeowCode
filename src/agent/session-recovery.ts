import { randomUUID } from "node:crypto";
import type { SessionStore } from "./session-store.js";
import { normalizeAgentProfile } from "./agent-profiles.js";
import {
  normalizeApprovalMode,
  normalizeSessionMode,
  type AgentProfileId,
  type ApprovalMode,
  type ChatMessage,
  type SessionEntry,
  type SessionMode,
} from "./types.js";

export type RecoveryResult = {
  recovered: boolean;
  interrupted: boolean;
  actions: string[];
  approvalMode: ApprovalMode;
  mode: SessionMode;
  /** 主 Agent 档位（旧会话无记录时回落 standard） */
  agentProfile: AgentProfileId;
  /** 会话当前使用的架构图 id（custom-* 自定义架构）；缺省 = 跟随档位 */
  harnessArchitecture: string | null;
  lastUsageInputTokens: number | null;
  /** 真实用量锚点（inputTokens + 覆盖到的有效消息数）；压缩过的会话为 null */
  lastUsageAnchor: { inputTokens: number; messageCount: number } | null;
  lastError: string | null;
};

type CompactionStartedEntry = Extract<SessionEntry, { type: "compaction_started" }>;

function entriesBetween(
  entries: SessionEntry[],
  startIndex: number,
): SessionEntry[] {
  const result: SessionEntry[] = [];
  for (let index = startIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === "turn_start" || entry.type === "turn_end") break;
    result.push(entry);
  }
  return result;
}

function findTurnStartIndex(entries: SessionEntry[], turnId: string): number {
  return entries.findIndex((entry) => entry.type === "turn_start" && entry.turnId === turnId);
}

/**
 * 关闭进程退出时没有收尾的回合：
 * - 补齐悬挂的 user 消息、未决审批、孤儿 tool 结果和半截回答；
 * - 关闭未完成的压缩；
 * - 写入 turn_end(interrupted) 与 recovery 标记。
 *
 * 幂等：恢复完成后 turn 已闭合、partial 已删除，再次加载不会重复写入。
 */
export async function recoverSession(session: SessionStore): Promise<RecoveryResult> {
  const actions: string[] = [];
  const openTurns = session.openTurns;
  let interrupted = false;

  for (const turn of openTurns) {
    const entries = session.entries;
    const startIndex = findTurnStartIndex(entries, turn.turnId);
    const turnEntries = startIndex >= 0 ? entriesBetween(entries, startIndex) : [];
    const hasUserMessage = turnEntries.some(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );

    // 只有「turn_start 之后一条消息都没有」时才补 user：如果 assistant/tool 已经写了，
    // append-only 无法把 user 插回它前面，硬追加会造成顺序错误（真实写入顺序不会出现这种状态）。
    const noMessagesInTurn = !turnEntries.some((entry) => entry.type === "message");
    if (!hasUserMessage && noMessagesInTurn) {
      const queuedText = turn.queueId
        ? entries.find(
            (entry): entry is Extract<SessionEntry, { type: "queued_prompt" }> =>
              entry.type === "queued_prompt" && entry.queueId === turn.queueId,
          )?.text
        : undefined;
      const text = turn.text ?? queuedText;
      if (text?.trim()) {
        await session.appendMessage({ role: "user", content: text });
        actions.push("restored user message");
      }
    }

    // 未决审批：先按拒绝结算，避免恢复后出现幽灵弹窗
    const openApprovals = session.openApprovalRequests.filter(
      (entry) => entry.turnId === turn.turnId,
    );
    for (const approval of openApprovals) {
      await session.appendApproval(approval.callId, approval.tool, approval.input, false, {
        turnId: turn.turnId,
        reason: "restored_denied",
      });
      actions.push(`denied pending approval for ${approval.tool}`);
    }

    // assistant 声明了 tool_calls 但没有对应 tool 结果：补配对消息，历史才合法
    const toolResults = new Set(
      turnEntries
        .filter(
          (entry): entry is Extract<SessionEntry, { type: "message" }> =>
            entry.type === "message" && entry.message.role === "tool",
        )
        .map((entry) => (entry.message as Extract<ChatMessage, { role: "tool" }>).tool_call_id),
    );
    const assistantMessages = turnEntries.filter(
      (entry): entry is Extract<SessionEntry, { type: "message" }> =>
        entry.type === "message" && entry.message.role === "assistant",
    );
    let repairedTools = 0;
    for (const entry of assistantMessages) {
      const message = entry.message as Extract<ChatMessage, { role: "assistant" }>;
      for (const call of message.tool_calls ?? []) {
        if (toolResults.has(call.id)) continue;
        await session.appendMessage({
          role: "tool",
          content: "Tool call not executed: the app was restarted before it completed.",
          tool_call_id: call.id,
          name: call.function.name,
        });
        toolResults.add(call.id);
        repairedTools += 1;
      }
    }
    if (repairedTools) actions.push(`repaired ${repairedTools} tool call(s)`);

    // 半截回答：只有与这个回合匹配且尚未落成 assistant 消息时才补
    const partial = await session.readPartial();
    if (partial?.turnId === turn.turnId && (partial.content.trim() || partial.reasoning?.trim())) {
      const alreadyPersisted = assistantMessages.some((entry) => {
        const message = entry.message as Extract<ChatMessage, { role: "assistant" }>;
        return (
          (message.content ?? "") === partial.content &&
          (message.reasoning ?? "") === (partial.reasoning ?? "")
        );
      });
      if (!alreadyPersisted) {
        await session.appendMessage({
          role: "assistant",
          content: partial.content,
          ...(partial.reasoning ? { reasoning: partial.reasoning } : {}),
        });
        actions.push("recovered partial assistant response");
      }
      await session.clearPartial().catch(() => undefined);
    }

    await session.appendTurnEnd({
      turnId: turn.turnId,
      status: "interrupted",
      error: "The app was restarted before this turn completed.",
    });
    interrupted = true;
    actions.push("closed interrupted turn");
  }

  // 旧写入顺序可能在 user 消息之后、turn_start 之前崩溃；没有 turn 标记也要收尾
  if (!openTurns.length) {
    const last = session.entries.at(-1);
    if (last?.type === "message" && last.message.role === "user") {
      const turnId = `recovered-${randomUUID().slice(0, 8)}`;
      await session.appendTurnEnd({
        turnId,
        status: "interrupted",
        error: "The app was restarted before this turn started.",
      });
      interrupted = true;
      actions.push("closed dangling user message");
    }
  }

  // 未闭合的压缩：有摘要则视为完成，否则标记中断
  const entries = session.entries;
  const endedCompactions = new Set(
    entries
      .filter(
        (entry): entry is Extract<SessionEntry, { type: "compaction_end" }> =>
          entry.type === "compaction_end",
      )
      .map((entry) => entry.compactionId),
  );
  const openCompactions: CompactionStartedEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction_started" && !endedCompactions.has(entry.compactionId)) {
      openCompactions.push(entry);
    }
  }
  for (const started of openCompactions) {
    const startIndex = entries.findIndex(
      (entry) => entry.type === "compaction_started" && entry.compactionId === started.compactionId,
    );
    const laterEntries = entries.slice(startIndex + 1);
    const nextStart = laterEntries.findIndex((entry) => entry.type === "compaction_started");
    const scope = nextStart >= 0 ? laterEntries.slice(0, nextStart) : laterEntries;
    const summary = scope.find(
      (entry): entry is Extract<SessionEntry, { type: "compaction_summary" }> =>
        entry.type === "compaction_summary",
    );
    await session.appendCompactionEnd({
      compactionId: started.compactionId,
      status: summary ? "completed" : "interrupted",
      ...(summary ? {} : { error: "Compaction was interrupted by the app restart." }),
    });
    actions.push(summary ? "closed compaction with summary" : "marked interrupted compaction");
  }

  if (actions.length) {
    await session.appendRecovery(actions);
    await session.flush();
  }

  const settings = session.sessionSettings;
  const lastTurnEnd = session.lastTurnEnd;
  return {
    recovered: actions.length > 0,
    interrupted,
    actions,
    approvalMode: normalizeApprovalMode(settings?.approvalMode),
    mode: normalizeSessionMode(settings?.mode),
    agentProfile: normalizeAgentProfile(settings?.agentProfile),
    // 空串 = 跟随档位（用空串而不是省略字段，才能覆盖掉更早的自定义架构选择）
    harnessArchitecture: settings?.harnessArchitecture || null,
    lastUsageInputTokens: session.lastChatUsage?.inputTokens ?? null,
    lastUsageAnchor: session.lastChatUsageAnchor,
    lastError: lastTurnEnd?.status === "error" ? (lastTurnEnd.error ?? null) : null,
  };
}
