import { promises as fs } from "node:fs";
import path from "node:path";
import { renderDiff } from "../agent/diff.js";
import { readJsonFile, writeJsonAtomic } from "../agent/atomic-json.js";
import { SessionStore } from "../agent/session-store.js";
import {
  SnapshotStore,
  buildTarget,
  hashFileBytes,
  type RewindJournalData,
} from "../agent/snapshot-store.js";
import { SNAPSHOT_SKIPPED } from "../agent/types.js";

export type RewindMode = "both" | "conversation" | "code";

export class RewindError extends Error {
  constructor(
    /** 机器可读错误码（server 映射 HTTP 状态与前端文案） */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RewindError";
  }
}

export type RewindFileAction = {
  path: string;
  action: "restore" | "delete" | "unchanged";
  /** 目标相对磁盘的新增行数（二进制文件不计） */
  added?: number;
  /** 目标相对磁盘的删除行数（二进制文件不计） */
  removed?: number;
  /** 目标内容字节数（delete 时为磁盘现内容大小） */
  bytes?: number;
  /** 目标内容 sha（apply 用；delete 时为 null） */
  target?: string | null;
  /** 冲突：磁盘与「上次已知态」不一致（外部修改过） */
  conflict?: "modified_on_disk";
  /** 跳过原因 */
  skipped?: "too_large" | "outside_workspace" | "unreadable";
};

export type RewindPlan = {
  planId: string;
  mode: RewindMode;
  checkpoint: { id: string; label?: string; timestamp: string; messageIndex: number };
  cwd: string;
  /** 会被改动的文件（restore/delete），unchanged 一并返回供前端展示全貌 */
  files: RewindFileAction[];
  skipped: Array<{ path: string; reason: string }>;
  conversation: { dropMessages: number; totalMessages: number };
  warnings: string[];
  /** 有冲突文件（外部修改）或工作区外路径时需要 force 才能执行 */
  requiresForce: boolean;
};

export type PlanRewindOptions = {
  session: SessionStore;
  checkpointId: string;
  mode: RewindMode;
  /** 与打点共用的快照存储实例（内存 state 才一致） */
  store: SnapshotStore;
  keepNewFiles: boolean;
};

function isBinaryBuffer(bytes: Buffer): boolean {
  // git 同款启发式：前 8000 字节里出现 NUL 视为二进制
  const sample = bytes.subarray(0, 8000);
  return sample.includes(0);
}

function countDiffLines(patch: string | undefined): { added: number; removed: number } {
  if (!patch) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

/**
 * 构建回滚计划（纯只读，不落盘）。
 * 目标态 = buildTarget(indexN, base)：索引优先、base 兜底（N 之后才首次被碰的路径
 * 回到碰之前）。删除集合只来自 state ∖ target —— 即 Agent 亲自写过的文件；
 * 用户手建、Agent 没碰过的路径永远不在 state 里，不会被删除。
 */
export async function planRewind(options: PlanRewindOptions): Promise<RewindPlan> {
  const { session, checkpointId, mode, store, keepNewFiles } = options;
  const cutIndex = session.entries.findIndex(
    (entry) => entry.type === "checkpoint" && entry.id === checkpointId,
  );
  if (cutIndex < 0) throw new RewindError("checkpoint_not_found", "Checkpoint not found in this session.");
  const cutEntry = session.entries[cutIndex];
  if (cutEntry.type !== "checkpoint") {
    throw new RewindError("checkpoint_not_found", "Checkpoint not found in this session.");
  }
  // conversation 模式不需要文件快照：无快照也能派生新会话（与旧 restore 同语义）
  const ref = cutEntry.snapshot;
  if (mode !== "conversation" && !ref) {
    throw new RewindError("no_snapshot", "该检查点没有文件快照，无法回滚代码（可仅回滚对话）。");
  }
  let target: Record<string, string | null> = {};
  if (ref) {
    if (path.resolve(ref.cwd) !== path.resolve(session.cwd)) {
      throw new RewindError("cwd_changed", "会话工作目录已变化，无法回滚代码（worktree 可能已切换）。");
    }
    const indexN = await store.readIndexFile(ref.file);
    if (!indexN) throw new RewindError("snapshot_expired", "该检查点的文件快照已过期，无法回滚代码。");
  const base = await readJsonFile<Record<string, string | null>>(path.join(store.dir, "base.json")) ?? {};
  target = buildTarget(indexN, base);
  }
  // 重启后内存已知态为空：从最新检查点索引播种，冲突检测才有基线
  await store.ensureState();
  const known = store.stateSnapshot();

  const files: RewindFileAction[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const warnings0: string[] = [];
  let requiresForce = false;

  const paths = new Set([...Object.keys(target), ...(mode === "conversation" ? [] : Object.keys(known))]);
  for (const p of paths) {
    const want = target[p];
    const was = known[p];
    // 展示路径可能是绝对路径（full 模式写的工作区外文件）：绝对路径原样解析
    const abs = path.isAbsolute(p) ? p : path.resolve(session.cwd, p);
    const disk = await hashFileBytes(abs);
    if (!disk) {
      if (want !== undefined) skipped.push({ path: p, reason: "unreadable" });
      continue;
    }
    if (want === undefined) {
      // N 时刻索引里没有、base 也没有 → N 之后才首次被 Agent 碰过 → 该点不存在 → 删除
      if (disk.sha === null) continue; // 磁盘上也没了
      if (keepNewFiles) {
        files.push({ path: p, action: "unchanged", bytes: disk.bytes?.length });
        continue;
      }
      files.push({ path: p, action: "delete", bytes: disk.bytes?.length, target: null });
      continue;
    }
    if (want === SNAPSHOT_SKIPPED) {
      files.push({ path: p, action: "unchanged", skipped: "too_large" });
      skipped.push({ path: p, reason: "too_large" });
      continue;
    }
    if (want === disk.sha) {
      files.push({ path: p, action: "unchanged" });
      continue;
    }
    // 冲突判定：磁盘内容 ≠ 上次已知态 → 被外部修改过（不丢内容的重建不算）
    let conflict: RewindFileAction["conflict"];
    if (was !== undefined && disk.sha !== null && disk.sha !== was) {
      conflict = "modified_on_disk";
    } else if (was === undefined) {
      warnings0.push(`无法确认 ${p} 是否被外部修改过（快照基线缺失）。`);
    }
    if (conflict || path.isAbsolute(p)) requiresForce = true;
    if (want === null) {
      // N 时刻该文件不存在 → 删除（Agent 在 N 之前创建/修改过它）；keepNewFiles 可保留
      if (disk.sha !== null && !keepNewFiles) {
        files.push({
          path: p,
          action: "delete",
          bytes: disk.bytes?.length,
          target: null,
          ...(conflict ? { conflict } : {}),
        });
      } else {
        files.push({ path: p, action: "unchanged", ...(conflict ? { conflict } : {}) });
      }
      continue;
    }
    const wantBytes = await store.readBlob(want);
    if (!wantBytes) {
      skipped.push({ path: p, reason: "unreadable" });
      continue;
    }
    const diskBytes = disk.bytes;
    let added: number | undefined;
    let removed: number | undefined;
    if (diskBytes && !isBinaryBuffer(diskBytes) && !isBinaryBuffer(wantBytes)) {
      const counts = countDiffLines(renderDiff(p, diskBytes.toString("utf8"), wantBytes.toString("utf8")));
      added = counts.added;
      removed = counts.removed;
    }
    files.push({
      path: p,
      action: "restore",
      target: want,
      bytes: wantBytes.length,
      ...(added !== undefined ? { added } : {}),
      ...(removed !== undefined ? { removed } : {}),
      ...(conflict ? { conflict } : {}),
    });
  }

  const totalMessages = session.messages.length;
  const dropMessages = Math.max(0, totalMessages - cutEntryMessageCount(session, cutIndex));
  return {
    planId: newPlanId(),
    mode,
    checkpoint: {
      id: cutEntry.id,
      ...(cutEntry.label ? { label: cutEntry.label } : {}),
      timestamp: cutEntry.timestamp,
      messageIndex: cutEntryMessageCount(session, cutIndex),
    },
    cwd: session.cwd,
    files,
    skipped,
    conversation: { dropMessages, totalMessages },
    warnings: warnings0,
    requiresForce,
  };
}

/** 检查点之前有多少条 message（与 checkpoints getter 的 messageIndex 同口径）。 */
function cutEntryMessageCount(session: SessionStore, cutIndex: number): number {
  let count = 0;
  for (let i = 1; i < cutIndex; i += 1) {
    if (session.entries[i]?.type === "message") count += 1;
  }
  return count;
}

// ---- planId 缓存：预览与执行之间复用同一份计划，防止预览后磁盘又变 ----

const PLAN_TTL_MS = 5 * 60 * 1000;
const PLAN_CACHE_MAX = 8;
const planCache = new Map<string, { plan: RewindPlan; at: number }>();

function newPlanId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function cachePlan(plan: RewindPlan): void {
  planCache.set(plan.planId, { plan, at: Date.now() });
  if (planCache.size > PLAN_CACHE_MAX) {
    const oldest = [...planCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) planCache.delete(oldest[0]);
  }
}

export function takePlan(planId: string): RewindPlan | null {
  const hit = planCache.get(planId);
  if (!hit) return null;
  planCache.delete(planId);
  if (Date.now() - hit.at > PLAN_TTL_MS) return null;
  return hit.plan;
}

// ---- 进程级互斥：防止两个窗口同时对同一工作区回滚 ----

let rewindLock: Promise<unknown> = Promise.resolve();

async function withRewindLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = rewindLock;
  let release: () => void = () => undefined;
  rewindLock = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

async function atomicWrite(abs: string, bytes: Buffer): Promise<void> {
  const tmp = `${abs}.rewind-${Math.random().toString(36).slice(2, 10)}.tmp`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, abs);
}

export type ApplyRewindOptions = {
  session: SessionStore;
  plan: RewindPlan;
  store: SnapshotStore;
  force: boolean;
  /** both/conversation 模式的会话派生回调（建文件 + 切 runtime）；失败时文件会被还原 */
  derive: (plan: RewindPlan) => Promise<{ id: string; filePath: string }>;
};

export type ApplyRewindResult = {
  rewindId: string;
  applied: number;
  deleted: number;
  /** 回滚后所在的会话（both/conversation = 派生会话；code = 当前会话）——rewind 留痕由调用方追加到它的 live store */
  entrySessionId?: string;
  derived?: { id: string; filePath: string };
};

/**
 * 执行回滚（plan/apply/rollback 三段式）：
 * 1) journal：把「回滚前磁盘态」全部落成 blob + 清单（撤销回滚的数据源）
 * 2) 逐文件应用；任一失败 → 按 journal 逆序写回已应用项
 * 3) 会话派生（both/conversation）在文件落定之后做；失败 → 文件再还原
 * 4) rewind entry 留痕 + state 对齐到目标态
 */
export async function applyRewind(options: ApplyRewindOptions): Promise<ApplyRewindResult> {
  const { session, plan, store, force, derive } = options;
  if (plan.requiresForce && !force) {
    throw new RewindError("needs_force", "存在被外部修改过的文件，需要确认覆盖后才能回滚。");
  }
  const changes = plan.files.filter((file) => file.action !== "unchanged");
  return withRewindLock(async () => {
    const rewindId = `rw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    // 1) journal：回滚前磁盘态
    const journalFiles: RewindJournalData["files"] = [];
    for (const file of changes) {
      const abs = path.isAbsolute(file.path) ? file.path : path.resolve(session.cwd, file.path);
      const disk = await hashFileBytes(abs);
      let before: string | null = null;
      if (disk?.bytes) before = await store.ensureBlob(disk.bytes);
      journalFiles.push({ path: file.path, before, after: file.target ?? null });
    }
    const journal: RewindJournalData = {
      version: 1,
      rewindId,
      createdAt: new Date().toISOString(),
      mode: plan.mode,
      checkpointId: plan.checkpoint.id,
      sourceSessionId: session.id,
      sourceFilePath: session.filePath,
      files: journalFiles,
    };
    const journalPath = store.journalFile(rewindId);
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    await writeJsonAtomic(journalPath, journal);

    // 2) 应用；失败按 journal 逆序还原已应用项
    const done: string[] = [];
    const revertDone = async (): Promise<void> => {
      for (const p of [...done].reverse()) {
        const abs = path.isAbsolute(p) ? p : path.resolve(session.cwd, p);
        const entry = journalFiles.find((item) => item.path === p);
        try {
          if (entry?.before) {
            const bytes = await store.readBlob(entry.before);
            if (bytes) await atomicWrite(abs, bytes);
          } else {
            await fs.rm(abs, { force: true });
          }
        } catch {
          /* 还原失败只能记录：journal 仍在，用户可手动恢复 */
        }
      }
    };
    try {
      for (const file of changes) {
        const abs = path.isAbsolute(file.path) ? file.path : path.resolve(session.cwd, file.path);
        if (file.action === "delete") {
          await fs.rm(abs, { force: true });
        } else if (file.action === "restore" && file.target) {
          const bytes = await store.readBlob(file.target);
          if (!bytes) throw new RewindError("blob_missing", `快照内容缺失：${file.path}`);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await atomicWrite(abs, bytes);
        } else {
          continue;
        }
        done.push(file.path);
      }
    } catch (error) {
      await revertDone();
      throw error instanceof RewindError
        ? error
        : new RewindError("apply_failed", error instanceof Error ? error.message : String(error));
    }

    // 3) 会话派生（文件已落定）；失败 → 文件还原
    let derived: { id: string; filePath: string } | undefined;
    if (plan.mode !== "code") {
      try {
        derived = await derive(plan);
      } catch (error) {
        await revertDone();
        throw error instanceof RewindError
          ? error
          : new RewindError("derive_failed", error instanceof Error ? error.message : String(error));
      }
    }

    // 5) state 对齐：磁盘现在就是 target；被删除的路径从已知态里移除
    const nextTarget: Record<string, string | null> = {};
    for (const file of changes) {
      nextTarget[file.path] = file.target ?? null;
    }
    store.assignState(nextTarget);
    for (const file of changes) {
      if (file.action === "delete") store.forget(file.path);
    }
    // 磁盘已改动：同步落盘已知态，避免下一次回滚把刚恢复的内容当成外部修改
    await store.persistState();

    // 留痕（rewind entry）不在这里追加：derive 回调已把 runtime 切到派生会话，
    // 该文件的 live store 是切换时 load 的实例 —— 在别的实例上 append 文件虽有，
    // live 内存态却没有这条 entry，undoable 查询（读 lastRewind）会拿不到。
    // 由调用方在切换完成后用 runtime.current.appendRewind 补上。
    return {
      rewindId,
      applied: changes.filter((f) => f.action === "restore").length,
      deleted: changes.filter((f) => f.action === "delete").length,
      entrySessionId: derived?.id ?? session.id,
      ...(derived ? { derived } : {}),
    };
  });
}

// ---- 撤销回滚 ----

export type UndoableRewind = {
  rewindId: string;
  checkpointId: string;
  mode: RewindMode;
  createdAt: string;
  fileCount: number;
  sourceSessionId: string;
  sourceFilePath: string;
};

/** 当前会话最近一次可撤销的回滚（journal 过期/丢失 → 不可撤销）。 */
export async function findUndoable(session: SessionStore, store: SnapshotStore): Promise<UndoableRewind | null> {
  const rewind = session.lastRewind;
  if (!rewind) return null;
  try {
    const journal = await readJsonFile<RewindJournalData>(store.journalFile(rewind.journal));
    if (!journal || journal.rewindId !== rewind.journal) return null;
    return {
      rewindId: rewind.journal,
      checkpointId: rewind.checkpointId,
      mode: rewind.mode,
      createdAt: rewind.timestamp,
      fileCount: rewind.fileCount,
      sourceSessionId: rewind.sourceSessionId ?? journal.sourceSessionId,
      sourceFilePath: journal.sourceFilePath,
    };
  } catch {
    return null;
  }
}

export type UndoPlan = {
  planId: string;
  files: RewindFileAction[];
  warnings: string[];
  requiresForce: boolean;
};

/** 撤销计划：把 journal.before 当目标态（撤销 = 把文件从 after 改回 before）。 */
export async function planUndo(
  session: SessionStore,
  store: SnapshotStore,
  rewindId?: string,
): Promise<{ plan: UndoPlan; journal: RewindJournalData }> {
  const rewind = session.lastRewind;
  if (!rewind || (rewindId && rewind.journal !== rewindId)) {
    throw new RewindError("nothing_to_undo", "没有可撤销的回滚。");
  }
  const journal = await readJsonFile<RewindJournalData>(store.journalFile(rewind.journal));
  if (!journal) throw new RewindError("undo_expired", "撤销窗口已过期（回滚前状态已清理）。");
  const files: RewindFileAction[] = [];
  const warnings: string[] = [];
  let requiresForce = false;
  // 逆序：journal 记录的是「回滚把 path 从 before 改成 after」，撤销即改回
  for (const entry of [...journal.files].reverse()) {
    const abs = path.isAbsolute(entry.path) ? entry.path : path.resolve(session.cwd, entry.path);
    const disk = await hashFileBytes(abs);
    if (!disk) {
      warnings.push(`无法读取 ${entry.path}，已跳过。`);
      continue;
    }
    if (entry.before === null) {
      if (disk.sha === null) continue;
      files.push({ path: entry.path, action: "delete", target: null, bytes: disk.bytes?.length });
      continue;
    }
    if (disk.sha === entry.before) continue;
    // 撤销目标 ≠ 磁盘现状；若磁盘也不等于 after（回滚后又被改过）→ 冲突
    let conflict: RewindFileAction["conflict"] | undefined;
    if (disk.sha !== null && disk.sha !== entry.after) conflict = "modified_on_disk";
    if (conflict) requiresForce = true;
    const bytes = await store.readBlob(entry.before);
    if (!bytes) {
      warnings.push(`快照内容缺失：${entry.path}，已跳过。`);
      continue;
    }
    let added: number | undefined;
    let removed: number | undefined;
    if (disk.bytes && !isBinaryBuffer(disk.bytes) && !isBinaryBuffer(bytes)) {
      const counts = countDiffLines(renderDiff(entry.path, disk.bytes.toString("utf8"), bytes.toString("utf8")));
      added = counts.added;
      removed = counts.removed;
    }
    files.push({
      path: entry.path,
      action: "restore",
      target: entry.before,
      bytes: bytes.length,
      ...(added !== undefined ? { added } : {}),
      ...(removed !== undefined ? { removed } : {}),
      ...(conflict ? { conflict } : {}),
    });
  }
  return { plan: { planId: newPlanId(), files, warnings, requiresForce }, journal };
}

export type ApplyUndoOptions = {
  session: SessionStore;
  plan: UndoPlan;
  journal: RewindJournalData;
  store: SnapshotStore;
  force: boolean;
};

/** 执行撤销：把文件改回 journal.before。state 同步回滚。 */
export async function applyUndo(options: ApplyUndoOptions): Promise<{ restored: number; deleted: number }> {
  const { session, plan, journal, store, force } = options;
  if (plan.requiresForce && !force) {
    throw new RewindError("needs_force", "回滚后文件又被修改过，需要确认覆盖后才能撤销。");
  }
  return withRewindLock(async () => {
    let restored = 0;
    let deleted = 0;
    const done: Array<{ path: string; after: string | null }> = [];
    try {
      for (const file of plan.files) {
        const abs = path.isAbsolute(file.path) ? file.path : path.resolve(session.cwd, file.path);
        if (file.action === "delete") {
          await fs.rm(abs, { force: true });
          deleted += 1;
        } else if (file.action === "restore" && file.target) {
          const bytes = await store.readBlob(file.target);
          if (!bytes) throw new RewindError("blob_missing", `快照内容缺失：${file.path}`);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await atomicWrite(abs, bytes);
          restored += 1;
        } else {
          continue;
        }
        done.push({ path: file.path, after: file.target ?? null });
      }
    } catch (error) {
      // 失败还原：把已应用项写回撤销前的状态（journal.after）
      for (const item of [...done].reverse()) {
        const abs = path.isAbsolute(item.path) ? item.path : path.resolve(session.cwd, item.path);
        try {
          if (item.after) {
            const bytes = await store.readBlob(item.after);
            if (bytes) await atomicWrite(abs, bytes);
          } else {
            await fs.rm(abs, { force: true });
          }
        } catch {
          /* 尽力而为 */
        }
      }
      throw error;
    }
    // state 对齐回撤销后的磁盘态
    const nextState: Record<string, string | null> = {};
    for (const item of done) nextState[item.path] = item.after;
    store.assignState(nextState);
    await store.persistState();
    void journal;
    return { restored, deleted };
  });
}
