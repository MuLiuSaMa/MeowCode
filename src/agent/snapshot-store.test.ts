import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BLOB_BYTES,
  SnapshotStore,
  buildTarget,
  hashFileBytes,
  sha256Bytes,
  type RewindJournalData,
} from "./snapshot-store.js";
import { SNAPSHOT_SKIPPED, type SnapshotFiles } from "./types.js";

const createdDirs: string[] = [];

async function makeWorkspaceFile(rel: string, content: string): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "meowcode-snap-ws-"));
  createdDirs.push(root);
  const file = path.join(root, rel);
  await writeFile(file, content, "utf8");
  return { root, file };
}

function makeStore(root: string, options: { maxBlobBytes?: number } = {}): SnapshotStore {
  const dir = path.join(root, "snapshots", "owner-1");
  createdDirs.push(dir);
  return new SnapshotStore({ dir, cwd: root, ...options });
}

afterEach(async () => {
  // Windows 上目录句柄释放有延迟：清理失败不致命（系统临时目录会兜底回收）
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe("sha256Bytes / hashFileBytes", () => {
  it("hashes content deterministically", async () => {
    expect(sha256Bytes(Buffer.from("abc"))).toBe(sha256Bytes(Buffer.from("abc")));
    expect(sha256Bytes(Buffer.from("abc"))).not.toBe(sha256Bytes(Buffer.from("abd")));
  });

  it("returns null sha for missing files and null observation for unreadable paths", async () => {
    const { root, file } = await makeWorkspaceFile("a.txt", "hello");
    expect(await hashFileBytes(file)).toEqual({ sha: sha256Bytes(Buffer.from("hello")), bytes: Buffer.from("hello") });
    expect(await hashFileBytes(path.join(root, "missing.txt"))).toEqual({ sha: null, bytes: null });
  });
});

describe("buildTarget", () => {
  it("prefers index values and falls back to base for paths first touched after the checkpoint", () => {
    const index: SnapshotFiles = { "a.ts": "sha-a", "b.ts": null };
    const base: SnapshotFiles = { "a.ts": "sha-base", "b.ts": "sha-b-base", "c.ts": "sha-c" };
    expect(buildTarget(index, base)).toEqual({
      "a.ts": "sha-a",
      "b.ts": null,
      "c.ts": "sha-c",
    });
  });

  it("omits paths known to neither index nor base", () => {
    expect(buildTarget({ "a.ts": "sha-a" }, { "b.ts": "sha-b" })).toEqual({ "a.ts": "sha-a", "b.ts": "sha-b" });
    expect(buildTarget({}, {})).toEqual({});
  });
});

describe("SnapshotStore blobs", () => {
  it("dedupes identical content into a single blob and stores different content separately", async () => {
    const { root, file } = await makeWorkspaceFile("a.txt", "v1");
    const store = makeStore(root);
    await store.noteBefore([{ path: "a.txt", file }]);
    await writeFile(file, "v2", "utf8");
    await store.noteAfter([{ path: "a.txt", file }]);

    const blobsDir = path.join(store.dir, "blobs");
    const shards = await readdir(blobsDir);
    const blobCount = (
      await Promise.all(shards.map((shard) => readdir(path.join(blobsDir, shard))))
    ).reduce((sum, names) => sum + names.length, 0);
    expect(blobCount).toBe(2); // v1 + v2，同内容重复写也只留一份
  });

  it("treats concurrent ensureBlob of the same sha as success", async () => {
    const { root } = await makeWorkspaceFile("a.txt", "same");
    const store = makeStore(root);
    const bytes = Buffer.from("same");
    await Promise.all([store.ensureBlob(bytes), store.ensureBlob(bytes), store.ensureBlob(bytes)]);
    const blob = await store.readBlob(sha256Bytes(bytes));
    expect(blob?.toString("utf8")).toBe("same");
  });

  it("rejects reading blobs with non-hash names", async () => {
    const { root } = await makeWorkspaceFile("a.txt", "x");
    const store = makeStore(root);
    expect(await store.readBlob("../../etc/passwd")).toBeNull();
  });
});

describe("SnapshotStore base/state semantics", () => {
  it("seeds base only once and advances state on every observation", async () => {
    const { root, file } = await makeWorkspaceFile("a.txt", "v1");
    const store = makeStore(root);
    await store.noteBefore([{ path: "a.txt", file }]);
    expect(store.stateSnapshot()["a.txt"]).toBe(sha256Bytes(Buffer.from("v1")));

    await writeFile(file, "v2", "utf8");
    await store.noteAfter([{ path: "a.txt", file }]);
    expect(store.stateSnapshot()["a.txt"]).toBe(sha256Bytes(Buffer.from("v2")));

    // 第二次 noteBefore：state 推进，base 保持首次观测
    await writeFile(file, "v3", "utf8");
    await store.noteBefore([{ path: "a.txt", file }]);
    expect(store.stateSnapshot()["a.txt"]).toBe(sha256Bytes(Buffer.from("v3")));

    const base = (await readFile(path.join(store.dir, "base.json"), "utf8")) as unknown;
    const parsed = JSON.parse(base as string) as SnapshotFiles;
    expect(parsed["a.txt"]).toBe(sha256Bytes(Buffer.from("v1")));
  });

  it("keeps state at the before value when the write fails (noteAfter never called)", async () => {
    const { root, file } = await makeWorkspaceFile("a.txt", "before-value");
    const store = makeStore(root);
    await store.noteBefore([{ path: "a.txt", file }]);
    // 模拟写失败：磁盘没变，也没有 noteAfter
    expect(store.stateSnapshot()["a.txt"]).toBe(sha256Bytes(Buffer.from("before-value")));
  });

  it("records missing files as null and large files as the skipped sentinel", async () => {
    const { root } = await makeWorkspaceFile("keep.txt", "x");
    const store = makeStore(root);
    const missing = path.join(root, "ghost.txt");
    await store.noteBefore([{ path: "ghost.txt", file: missing }]);
    expect(store.stateSnapshot()["ghost.txt"]).toBeNull();

    const big = path.join(root, "big.bin");
    await writeFile(big, Buffer.alloc(DEFAULT_MAX_BLOB_BYTES + 1, 7));
    await store.noteBefore([{ path: "big.bin", file: big }]);
    expect(store.stateSnapshot()["big.bin"]).toBe(SNAPSHOT_SKIPPED);

    // 哨兵不进 base
    const parsed = JSON.parse(await readFile(path.join(store.dir, "base.json"), "utf8")) as SnapshotFiles;
    expect(parsed["big.bin"]).toBeUndefined();
    expect(parsed["ghost.txt"]).toBeNull();
  });
});

describe("SnapshotStore checkpoints", () => {
  it("clones state at the checkpoint moment: later writes do not affect an earlier index", async () => {
    const { root, file } = await makeWorkspaceFile("a.ts", "v1");
    const store = makeStore(root);
    await store.noteBefore([{ path: "a.ts", file }]);
    const c1 = await store.checkpoint("cp-1");

    await writeFile(file, "v2", "utf8");
    await store.noteAfter([{ path: "a.ts", file }]);
    const c2 = await store.checkpoint("cp-2");

    expect(c1).toMatchObject({ ownerId: "owner-1", file: "index/cp-1.json", count: 1, cwd: root });
    expect(c1.bytes).toBe(2);
    const index1 = await store.readIndexFile(c1.file);
    const index2 = await store.readIndexFile(c2.file);
    expect(index1?.["a.ts"]).toBe(sha256Bytes(Buffer.from("v1")));
    expect(index2?.["a.ts"]).toBe(sha256Bytes(Buffer.from("v2")));
  });

  it("persists the index across store instances and returns null for expired indexes", async () => {
    const { root, file } = await makeWorkspaceFile("a.ts", "v1");
    const dir = path.join(root, "snapshots", "owner-1");
    const store = new SnapshotStore({ dir, cwd: root });
    await store.noteBefore([{ path: "a.ts", file }]);
    const ref = await store.checkpoint("cp-1");

    const reloaded = new SnapshotStore({ dir, cwd: root });
    expect(await reloaded.readIndexFile(ref.file)).toEqual({ "a.ts": sha256Bytes(Buffer.from("v1")) });
    expect(await reloaded.readIndexFile("index/missing.json")).toBeNull();
    expect(await reloaded.readIndexFile("../base.json")).toBeNull();
  });

  it("rebuilds state via assignState after a rewind", async () => {
    const { root } = await makeWorkspaceFile("a.ts", "v1");
    const store = makeStore(root);
    store.assignState({ "a.ts": sha256Bytes(Buffer.from("restored")), "new.ts": null });
    const ref = await store.checkpoint("cp-after-rewind");
    expect(await store.readIndexFile(ref.file)).toEqual({
      "a.ts": sha256Bytes(Buffer.from("restored")),
      "new.ts": null,
    });
  });
});

describe("SnapshotStore gc", () => {
  it("keeps the newest N indexes, drops expired journals, and reclaims unreferenced blobs", async () => {
    const { root, file } = await makeWorkspaceFile("a.ts", "v0");
    const keep = 3;
    const dir = path.join(root, "snapshots", "gc-owner");
    const gcStore = new SnapshotStore({ dir, cwd: root, gcInterval: 0, keepCheckpoints: keep });

    // base 引用的 v0 先观测（首次 noteBefore 种 base）
    await gcStore.noteBefore([{ path: "a.ts", file }]);
    for (let i = 1; i <= 5; i += 1) {
      await writeFile(file, `content-${i}`, "utf8");
      await gcStore.noteAfter([{ path: "a.ts", file }]);
      await gcStore.checkpoint(`cp-${i}`);
    }

    await mkdir(path.join(dir, "journal"), { recursive: true });
    // 一个会被保留的 journal
    const journal: RewindJournalData = {
      version: 1,
      rewindId: "rw-keep",
      createdAt: new Date().toISOString(),
      mode: "both",
      checkpointId: "cp-5",
      sourceSessionId: "s1",
      sourceFilePath: "s1.jsonl",
      files: [{ path: "a.ts", before: sha256Bytes(Buffer.from("content-5")), after: "a".repeat(64) }],
    };
    await writeFile(path.join(dir, "journal", "rw-keep.json"), JSON.stringify(journal), "utf8");
    // 一个过期 journal（mtime 拨到 8 天前）
    const oldPath = path.join(dir, "journal", "rw-old.json");
    await writeFile(oldPath, JSON.stringify({ ...journal, rewindId: "rw-old" }), "utf8");
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, stale, stale);

    await gcStore.gc({ keepCheckpoints: keep });

    const indexDir = path.join(dir, "index");
    const remaining = (await readdir(indexDir)).sort();
    expect(remaining).toHaveLength(keep);
    // 滑窗保留最新的（mtime 序，cp-4/cp-5 一定在；第三个取決于 mtime 精度，断言数量即可）

    const blobShards = await readdir(path.join(dir, "blobs"));
    const liveBlobs = (
      await Promise.all(blobShards.map((shard) => readdir(path.join(dir, "blobs", shard))))
    ).flat().sort();
    // content-1/2 的 blob 被回收（不再被任何保留索引引用，也不在 base/journal 里）
    // 滑窗保留 cp-3/4/5 → content-3/4/5 存活；v0 被 base 引用；journal 引用的 after 哨兵 sha 无对应 blob
    expect(liveBlobs).toHaveLength(4);
    expect(liveBlobs).toContain(sha256Bytes(Buffer.from("content-3")));
    expect(liveBlobs).toContain(sha256Bytes(Buffer.from("content-4")));
    expect(liveBlobs).toContain(sha256Bytes(Buffer.from("content-5")));
    expect(liveBlobs).toContain(sha256Bytes(Buffer.from("v0")));

    const journalFiles = (await readdir(path.join(dir, "journal"))).sort();
    expect(journalFiles).toEqual(["rw-keep.json"]);
  });
});
