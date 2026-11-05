import { promises as fs } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore, sessionFileName, newEntryId } from "../agent/session-store.js";
import type { SessionEntry } from "../agent/types.js";

/** 派生/恢复出的新会话摘要（切换 runtime 由调用方负责）。 */
export type DerivedSession = {
  id: string;
  filePath: string;
  cwd: string;
  createdAt: string;
  title: string | null;
};

export type DeriveSessionOptions = {
  /** 源会话文件（resolveSessionFile 校验过的路径） */
  sourceFilePath: string;
  /** 已加载的源会话；不传则按 sourceFilePath 读盘 */
  source?: SessionStore;
  checkpointId: string;
  sessionsDir: string;
  /** 新会话标题后缀，如 "（检查点：xxx）" / "（回滚）"；空串 = 不加后缀 */
  titleSuffix?: string;
};

/**
 * 从源会话的某个检查点派生新会话文件（截断语义：只保留检查点之前的条目）。
 * 原 server.ts 的 /session/checkpoints/restore 逻辑原样抽出，另外两件事：
 * 1) header 带上 snapshotOwnerId（派生会话共享源会话的快照 blob，不复制）；
 * 2) rewind 留痕条目同样不带入（那是源会话自己的审计）。
 * 返回前不切换 runtime —— 切换涉及 server 的 runtime 闭包，由调用方完成。
 */
export async function deriveSessionAtCheckpoint(
  options: DeriveSessionOptions,
): Promise<DerivedSession> {
  const source = options.source ?? (await SessionStore.load(options.sourceFilePath));
  const cutIndex = source.entries.findIndex(
    (entry: SessionEntry) => entry.type === "checkpoint" && entry.id === options.checkpointId,
  );
  if (cutIndex < 0) {
    throw new Error("Checkpoint not found in this session.");
  }
  const cutEntry = source.entries[cutIndex];
  const checkpointLabel = cutEntry.type === "checkpoint" ? cutEntry.label : undefined;
  const sourceHeader = source.entries[0];
  const rootSessionId =
    sourceHeader.type === "session"
      ? (sourceHeader.rootSessionId ?? sourceHeader.id)
      : source.id;
  const header = {
    type: "session",
    version: 2 as const,
    id: randomUUID(),
    cwd: source.cwd,
    createdAt: new Date().toISOString(),
    parentSessionId: source.id,
    rootSessionId,
    // 派生会话共享源会话的快照目录：blob 不复制，回滚/打点继续写同一 owner
    snapshotOwnerId: source.snapshotOwnerId,
    ...(sourceHeader.type === "session" && sourceHeader.worktree
      ? { worktree: sourceHeader.worktree }
      : {}),
  };
  // 与分支同款：assets 整目录拷贝 + 引用前缀改写，失败降级（引用照抄，缺图静默跳过）
  const derivedId = header.id;
  let refsRewritten = false;
  try {
    await cp(
      path.join(options.sessionsDir, "assets", source.id),
      path.join(options.sessionsDir, "assets", derivedId),
      { recursive: true, errorOnExist: true, force: false },
    );
    refsRewritten = true;
  } catch {
    // 源会话没有资产（ENOENT）属常态；其余错误同样降级
  }
  // 只复制检查点之前的条目；检查点/子 Agent/回滚留痕不带入（恢复出的会话是纯对话状态）
  const copied = source.entries
    .slice(1, cutIndex)
    .filter(
      (entry) =>
        entry.type !== "subagent" && entry.type !== "checkpoint" && entry.type !== "rewind",
    );
  // 尾部未配对的 turn_start 一律剔除：带进派生会话会被 switchSession 的崩溃恢复
  // 重放成假用户消息并报「上次生成被中断」——旧会话的检查点打在 turn_start 之后，
  // 回滚它们时 slice 边界天然会带上这个孤立条目，这里统一兜底。
  const seenTurnEnds = new Set<string>();
  const kept: SessionEntry[] = [];
  for (let index = copied.length - 1; index >= 0; index -= 1) {
    const entry = copied[index];
    if (entry.type === "turn_end") {
      seenTurnEnds.add(entry.turnId);
    } else if (entry.type === "turn_start" && !seenTurnEnds.has(entry.turnId)) {
      continue;
    }
    kept.unshift(entry);
  }
  const lines = [
    JSON.stringify(header),
    ...kept.map((entry) => {
      if (refsRewritten && entry.type === "message" && entry.imageRefs?.length) {
        return JSON.stringify({
          ...entry,
          imageRefs: entry.imageRefs.map((ref) => ({
            ...ref,
            file: `${derivedId}/${ref.file.split("/")[1] ?? ""}`,
          })),
        });
      }
      return JSON.stringify(entry);
    }),
  ];
  const suffix = options.titleSuffix ?? "";
  const sourceTitle = source.title;
  if (sourceTitle) {
    lines.push(
      JSON.stringify({
        type: "title",
        id: newEntryId(),
        parentId: null,
        timestamp: new Date().toISOString(),
        title: `${sourceTitle}${suffix || (checkpointLabel ? `（检查点：${checkpointLabel}）` : "（检查点）")}`.slice(
          0,
          100,
        ),
      }),
    );
  }
  const content = `${lines.join("\n")}\n`;
  let derivedPath = path.join(options.sessionsDir, sessionFileName(source.cwd, new Date()));
  let written = false;
  for (let attempt = 0; attempt < 4 && !written; attempt += 1) {
    try {
      await fs.writeFile(derivedPath, content, { encoding: "utf8", flag: "wx" });
      written = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 3) {
        throw error;
      }
      derivedPath = derivedPath.replace(/\.jsonl$/, `_${randomUUID().slice(0, 8)}.jsonl`);
    }
  }
  if (!written) throw new Error("Failed to create the derived session file.");
  return {
    id: derivedId,
    filePath: derivedPath,
    cwd: source.cwd,
    createdAt: header.createdAt,
    title: sourceTitle
      ? `${sourceTitle}${suffix || (checkpointLabel ? `（检查点：${checkpointLabel}）` : "（检查点）")}`.slice(0, 100)
      : null,
  };
}
