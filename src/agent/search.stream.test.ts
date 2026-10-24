import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { searchGrep } = await import("./search.js");

type FakeRg = {
  child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
  feed: (chunk: Buffer | string) => void;
  close: (code?: number | null) => void;
};

/** rg 的 stdout 分块由测试决定：用于复现「一条 JSON 事件被切在两个 chunk 边界」 */
function fakeRipgrep(): FakeRg {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
  });
  spawnMock.mockReturnValue(child);
  return {
    child,
    feed: (chunk) => child.stdout.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    close: (code = 0) => child.emit("close", code),
  };
}

function matchEvent(file: string, line: number, text: string): string {
  return JSON.stringify({ type: "match", data: { path: { text: file }, line_number: line, lines: { text } } });
}

describe("searchGrep stream framing", () => {
  let workspace: string;

  beforeEach(async () => {
    spawnMock.mockReset();
    workspace = await mkdtemp(path.join(tmpdir(), "meowcode-search-stream-"));
    await writeFile(path.join(workspace, "a.txt"), "hello\n");
  });

  const search = (options: Parameters<typeof searchGrep>[3] = {}) =>
    searchGrep(workspace, ".", "hello", options, undefined, false);

  /** spawn 是异步发生的：先等监听器挂上，再喂数据 */
  async function start(options: Parameters<typeof searchGrep>[3] = {}) {
    const rg = fakeRipgrep();
    const pending = search(options);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    return { rg, pending };
  }

  it("keeps a match event that straddles two chunks", async () => {
    const { rg, pending } = await start();
    const first = matchEvent("a.txt", 1, "hello\n");
    const second = matchEvent("b.txt", 2, "hello there\n");
    rg.feed(first.slice(0, 24));
    rg.feed(`${first.slice(24)}\n${second}\n`);
    rg.close(0);

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.output).toContain("a.txt:1: hello");
    expect(result.output).toContain("b.txt:2: hello there");
  });

  it("terminates rg once the result limit is reached", async () => {
    const { rg, pending } = await start({ maxResults: 2 });
    for (let index = 1; index <= 50; index += 1) {
      rg.feed(`${matchEvent("a.txt", index, `hit ${index}\n`)}\n`);
    }
    rg.close(0);

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hit 2");
    expect(result.output).not.toContain("hit 3");
    expect(result.output).toContain("showing first 2 matches");
    expect(rg.child.kill).toHaveBeenCalled();
  });

  it("does not report a failure when the early stop changes the exit code", async () => {
    const { rg, pending } = await start({ maxResults: 1 });
    rg.feed(`${matchEvent("a.txt", 1, "hello\n")}\n`);
    rg.close(null);

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.output).toContain("a.txt:1: hello");
  });

  it("decodes a multibyte character split across chunks", async () => {
    const { rg, pending } = await start();
    const event = matchEvent("中文.txt", 1, "包含中文的一行\n");
    const bytes = Buffer.from(`${event}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("中", "utf8")) + 1;
    rg.feed(bytes.subarray(0, cut));
    rg.feed(bytes.subarray(cut));
    rg.close(0);

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.output).toContain("中文.txt:1: 包含中文的一行");
    expect(result.output).not.toContain(String.fromCharCode(0xfffd));
  });
});
