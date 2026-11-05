import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { SNAPSHOT_SKIPPED, type CheckpointSnapshotRef, type SnapshotFiles } from "./types.js";

/** 单个文件快照的字节上限：超过不存 blob，索引里写哨兵（回滚时归入 skipped）。 */
export const DEFAULT_MAX_BLOB_BYTES = 4 * 1024 * 1024;

/** 每次 checkpoint 触发一次 gc 的间隔（次数）；0 = 从不。 */
export const DEFAULT_GC_INTERVAL = 20;

/** gc 保留的索引滑窗与 journal 保留策略。 */
export const DEFAULT_KEEP_CHECKPOINTS = 120;
export const KEEP_JOURNALS = 5;
export const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** runtime 写前/写后捕获的目标：path 为展示路径（key），file 为绝对路径（读盘用）。 */
export type SnapshotTarget = { path: string; file: string };

export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 读文件并算哈希；ENOENT → sha:null（文件此刻不存在）；其他读错误 → 整体 null（不更新已知态）。 */
export async function hashFileBytes(
  file: string,
): Promise<{ sha: string | null; bytes: Buffer | null } | null> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sha: null, bytes: null };
    return null;
  }
  return { sha: sha256Bytes(bytes), bytes };
}

/**
 * 回滚目标态：checkpoint 索引优先，base 兜底（该路径在打点之后才第一次被 Agent 碰过
 * → 回到碰之前的内容）。两边都不命中的路径不出现在结果里（从未被观测 → 不处理）。
 */
export function buildTarget(index: SnapshotFiles, base: SnapshotFiles): SnapshotFiles {
  const target: SnapshotFiles = { ...index };
  for (const [p, sha] of Object.entries(base)) {
    if (!(p in target)) target[p] = sha;
  }
  return target;
}

export type SnapshotStoreOptions = {
  /** <sessionsDir>/snapshots/<ownerId> */
  dir: string;
  /** 打点时的绝对工作区根（写入 CheckpointSnapshotRef.cwd，回滚前校验用） */
  cwd: string;
  maxBlobBytes?: number;
  gcInterval?: number;
  keepCheckpoints?: number;
};

/**
 * 会话级文件快照存储（前像快照，不依赖 git）：
 * - blobs/<aa>/<sha256>  内容寻址的原始字节（wx 写入，天然去重）
 * - base.json            路径 → 首次观测时的内容哈希（只种一次，回滚兜底）
 * - index/<id>.json      每个检查点的全量索引 = 那一刻 state 的克隆
 * - journal/<id>.json    回滚前磁盘态（撤销回滚的数据源，由回滚引擎写入）
 *
 * 内存三 map：base（持久化）/ state（最后已知磁盘态）/ sizes（blob 字节缓存）。
 * 重启后 state 为空在语义上仍正确：未追踪的路径保持磁盘现状 = 目标状态。
 */
export class SnapshotStore {
  readonly dir: string;
  readonly cwd: string;
  private readonly maxBlobBytes: number;
  private readonly gcInterval: number;
  private readonly keepCheckpoints: number;
  private base: SnapshotFiles | null = null;
  private readonly state = new Map<string, string | null>();
  private readonly sizes = new Map<string, number>();
  private checkpointCount = 0;
  private stateSeeded = false;

  constructor(options: SnapshotStoreOptions) {
    this.dir = options.dir;
    this.cwd = options.cwd;
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.gcInterval = options.gcInterval ?? DEFAULT_GC_INTERVAL;
    this.keepCheckpoints = options.keepCheckpoints ?? DEFAULT_KEEP_CHECKPOINTS;
  }

  /** 快照目录的会话归属 id（目录名）。 */
  get ownerId(): string {
    return path.basename(this.dir);
  }

  private async ensureBase(): Promise<SnapshotFiles> {
    if (!this.base) {
      this.base = (await readJsonFile<SnapshotFiles>(path.join(this.dir, "base.json"))) ?? {};
    }
    return this.base;
  }

  private blobPath(sha: string): string {
    return path.join(this.dir, "blobs", sha.slice(0, 2), sha);
  }

  /** 写入内容寻址 blob；已存在（同内容）即跳过 —— 这就是去重。返回 sha。 */
  async ensureBlob(bytes: Buffer): Promise<string> {
    const sha = sha256Bytes(bytes);
    try {
      await fs.mkdir(path.dirname(this.blobPath(sha)), { recursive: true });
      await fs.writeFile(this.blobPath(sha), bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.sizes.set(sha, bytes.length);
    return sha;
  }

  async readBlob(sha: string): Promise<Buffer | null> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    try {
      return await fs.readFile(this.blobPath(sha));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async blobSize(sha: string): Promise<number> {
    const cached = this.sizes.get(sha);
    if (cached !== undefined) return cached;
    try {
      const stat = await fs.stat(this.blobPath(sha));
      this.sizes.set(sha, stat.size);
      return stat.size;
    } catch {
      return 0;
    }
  }

  /**
   * 观测一次磁盘内容。before/after 都在写工具执行前后的精确时刻调用：
   * 写失败时 noteAfter 不会被调用，state 保持 before —— 两个时刻都精确，无中间态。
   * 读不到文件（权限/被锁）时整体跳过，不污染已知态。
   */
  private async observe(target: SnapshotTarget, kind: "before" | "after"): Promise<void> {
    await this.ensureState();
    const observed = await hashFileBytes(target.file);
    if (!observed) return;
    let value: string | null = observed.sha;
    if (observed.bytes) {
      value =
        observed.bytes.length <= this.maxBlobBytes
          ? await this.ensureBlob(observed.bytes)
          : SNAPSHOT_SKIPPED;
    }
    if (kind === "before" && (value === null || value !== SNAPSHOT_SKIPPED)) {
      // base 只种真实哈希或 null（哨兵恢复不了内容，不进 base）
      const base = await this.ensureBase();
      if (!(target.path in base)) {
        base[target.path] = value;
        await writeJsonAtomic(path.join(this.dir, "base.json"), base);
      }
    }
    this.state.set(target.path, value);
    await this.persistState();
  }

  /**
   * 把当前已知态落盘（state.json）。
   *
   * 检查点索引只在打点那一刻写入，回合中途的改动（打点之后又改了文件）不会进索引；
   * 换一个 SnapshotStore 实例（server 侧回滚、进程重启）就只能从索引播种，于是把
   * 「Agent 自己刚改成的新内容」误判成「外部修改」，白要一次 force。
   * 每次观测后同步落一份真实磁盘态，冲突检测才有正确基线。
   */
  async persistState(): Promise<void> {
    try {
      await writeJsonAtomic(path.join(this.dir, "state.json"), this.stateSnapshot());
    } catch {
      // 落盘失败只让下一次回滚退化成「基线缺失」警告，不该影响写文件主流程
    }
  }

  async noteBefore(targets: SnapshotTarget[]): Promise<void> {
    for (const target of targets) await this.observe(target, "before");
  }

  async noteAfter(targets: SnapshotTarget[]): Promise<void> {
    for (const target of targets) await this.observe(target, "after");
  }

  /**
   * 落一个检查点索引（= 当前 state 的克隆），返回给 checkpoint entry 引用。
   * 先落索引、后 append entry（由调用方保证）：entry 写失败只留孤儿索引，GC 回收。
   */
  async checkpoint(checkpointId: string): Promise<CheckpointSnapshotRef> {
    await this.ensureState();
    const files = this.stateSnapshot();
    let bytes = 0;
    for (const sha of Object.values(files)) {
      if (!sha || sha === SNAPSHOT_SKIPPED) continue;
      bytes += await this.blobSize(sha);
    }
    const relFile = `index/${checkpointId}.json`;
    await fs.mkdir(path.dirname(path.join(this.dir, relFile)), { recursive: true });
    await writeJsonAtomic(path.join(this.dir, relFile), files);
    this.checkpointCount += 1;
    if (this.gcInterval > 0 && this.checkpointCount % this.gcInterval === 0) {
      await this.gc({ keepCheckpoints: this.keepCheckpoints }).catch(() => undefined);
    }
    return {
      ownerId: this.ownerId,
      file: relFile,
      count: Object.keys(files).length,
      bytes,
      cwd: this.cwd,
    };
  }

  /**
   * 重启后内存 state 为空（最后已知磁盘态是纯内存的）：从最新的检查点索引播种。
   * 索引本身就是「打点时刻的完整已知态」—— 播种后冲突检测恢复基线（重启前
   * agent 新建、之后没碰过的文件也能被正确判入回滚删除集合）。
   * 只播种一次；本进程已有观测（state 非空）时不覆盖。
   */
  async ensureState(): Promise<void> {
    if (this.stateSeeded) return;
    this.stateSeeded = true;
    if (this.state.size > 0) return;
    try {
      // 首选 state.json：它记的是最后一次观测到的真实磁盘态，含打点之后的改动
      const persisted = await readJsonFile<SnapshotFiles>(path.join(this.dir, "state.json"));
      if (persisted) {
        for (const [p, sha] of Object.entries(persisted)) this.state.set(p, sha);
        return;
      }
      const indexDir = path.join(this.dir, "index");
      const names = await fs.readdir(indexDir);
      let latest: { file: string; mtime: number } | null = null;
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const full = path.join(indexDir, name);
        const mtime = (await fs.stat(full).catch(() => null))?.mtimeMs ?? 0;
        if (!latest || mtime > latest.mtime) latest = { file: full, mtime };
      }
      if (!latest) return;
      const files = await readJsonFile<SnapshotFiles>(latest.file);
      if (files) {
        for (const [p, sha] of Object.entries(files)) this.state.set(p, sha);
      }
    } catch {
      // 无索引/读失败：state 保持为空，回滚时以「基线缺失」警告兜底
    }
  }

  /** 当前已知磁盘态（per path）。回滚引擎做冲突检测时读「上次已知态」用。 */
  stateSnapshot(): SnapshotFiles {
    return Object.fromEntries(this.state);
  }

  /** 派生/回滚后重建 state：target 的 sha 就是磁盘此刻的内容，无需重新哈希。 */
  assignState(files: SnapshotFiles): void {
    for (const [p, sha] of Object.entries(files)) this.state.set(p, sha);
  }

  /** 从已知态里移除一个路径（回滚删除该文件后调用，避免残留过期基线）。 */
  forget(p: string): void {
    this.state.delete(p);
  }

  /** 该路径是否曾被本会话观测过（冲突检测：未知基线只警告不阻断）。 */
  isTracked(p: string): boolean {
    return this.state.has(p);
  }

  /** 读回某个检查点索引；文件不存在（已过期）返回 null。 */
  async readIndexFile(relFile: string): Promise<SnapshotFiles | null> {
    if (!/^index\/[A-Za-z0-9_-]+\.json$/.test(relFile)) return null;
    return (await readJsonFile<SnapshotFiles>(path.join(this.dir, relFile))) ?? null;
  }

  journalFile(name: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid journal id.");
    return path.join(this.dir, "journal", `${name}.json`);
  }

  /**
   * 清理：索引滑窗（保留最新 keep 个）→ journal（最近 5 个且 ≤7 天）→ blob 引用回收。
   * 索引被清掉的检查点 entry 仍在 JSONL 里（append-only 改不了），回滚时会得到
   * 「快照已过期」错误 —— 用错误文案兜底，不做 JSONL 改写。
   */
  async gc(options: { keepCheckpoints?: number } = {}): Promise<void> {
    const keep = Math.max(1, options.keepCheckpoints ?? this.keepCheckpoints);
    await this.ensureBase();

    // 1) 索引滑窗（按 mtime 倒序保留）
    const indexDir = path.join(this.dir, "index");
    const stats: Array<{ full: string; mtime: number }> = [];
    try {
      for (const name of await fs.readdir(indexDir)) {
        if (!name.endsWith(".json")) continue;
        const full = path.join(indexDir, name);
        try {
          stats.push({ full, mtime: (await fs.stat(full)).mtimeMs });
        } catch {
          /* 并发删除竞态：跳过 */
        }
      }
    } catch {
      /* 目录不存在 → 无索引可清理 */
    }
    stats.sort((a, b) => b.mtime - a.mtime);
    const kept = stats.slice(0, keep);
    for (const item of stats.slice(keep)) await fs.rm(item.full, { force: true });

    // 2) journal：保留最近 KEEP_JOURNALS 个且未过期
    const journalDir = path.join(this.dir, "journal");
    const journals: Array<{ full: string; mtime: number }> = [];
    try {
      for (const name of await fs.readdir(journalDir)) {
        if (!name.endsWith(".json")) continue;
        const full = path.join(journalDir, name);
        try {
          const mtime = (await fs.stat(full)).mtimeMs;
          if (Date.now() - mtime > JOURNAL_MAX_AGE_MS) {
            await fs.rm(full, { force: true });
            continue;
          }
          journals.push({ full, mtime });
        } catch {
          /* 竞态：跳过 */
        }
      }
    } catch {
      /* 目录不存在 */
    }
    journals.sort((a, b) => b.mtime - a.mtime);
    const keptJournals = journals.slice(0, KEEP_JOURNALS);
    for (const item of journals.slice(KEEP_JOURNALS)) await fs.rm(item.full, { force: true });

    // 3) blob 引用回收：base + 保留的索引 + 保留的 journal 里引用的 sha 都是 live
    const live = new Set<string>();
    const collect = (files: SnapshotFiles) => {
      for (const sha of Object.values(files)) {
        if (sha && sha !== SNAPSHOT_SKIPPED && /^[0-9a-f]{64}$/.test(sha)) live.add(sha);
      }
    };
    collect(this.base ?? {});
    for (const item of kept) {
      const data = await readJsonFile<SnapshotFiles>(item.full);
      if (data) collect(data);
    }
    for (const item of keptJournals) {
      const data = await readJsonFile<RewindJournalData>(item.full);
      if (!data) continue;
      for (const entry of data.files ?? []) {
        if (entry.before && entry.before !== SNAPSHOT_SKIPPED) live.add(entry.before);
        if (entry.after && entry.after !== SNAPSHOT_SKIPPED) live.add(entry.after);
      }
    }
    const blobsDir = path.join(this.dir, "blobs");
    try {
      for (const shard of await fs.readdir(blobsDir)) {
        const shardDir = path.join(blobsDir, shard);
        let names: string[];
        try {
          names = await fs.readdir(shardDir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!live.has(name)) await fs.rm(path.join(shardDir, name), { force: true });
        }
      }
    } catch {
      /* blobs 目录不存在 */
    }
  }
}

/** journal/<rewindId>.json 的结构：回滚前磁盘态清单（撤销回滚的数据源）。 */
export type RewindJournalData = {
  version: 1;
  rewindId: string;
  createdAt: string;
  mode: "both" | "conversation" | "code";
  checkpointId: string;
  sourceSessionId: string;
  sourceFilePath: string;
  /** 逐文件：before = 回滚前内容（blob sha|null），after = 回滚目标（blob sha|null） */
  files: Array<{ path: string; before: string | null; after: string | null }>;
};
