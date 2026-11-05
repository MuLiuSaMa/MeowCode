import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));

const { AgentRuntime } = await import("./runtime.js");

const createdWorkspaces: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-checkpoint-ws-"));
  createdWorkspaces.push(workspace);
  // 显式禁用写后验证：测试只关心检查点，不让启发式探测去跑真实 tsc
  await mkdir(path.join(workspace, ".meowcode"), { recursive: true });
  await writeFile(
    path.join(workspace, ".meowcode", "verify.json"),
    JSON.stringify({ typecheck: false }),
    "utf8",
  );
  return workspace;
}

function makeRuntime(sessionsDir: string) {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
  });
}

function writeToolCall(id: string, filePath: string): {
  message: {
    role: "assistant";
    content: null;
    tool_calls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
} {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: filePath, content: "export const ok = 1;" }),
          },
        },
      ],
    },
  };
}

beforeEach(() => {
  streamMock.mockReset();
});

afterEach(async () => {
  while (createdWorkspaces.length) {
    const workspace = createdWorkspaces.pop()!;
    await rm(workspace, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("session checkpoints", () => {
  it("appends one automatic checkpoint at the start of every user turn, with a file snapshot", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-checkpoint-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock
      .mockResolvedValueOnce(writeToolCall("call-1", "a.ts"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("write a file");

    const points = runtime.current!.checkpoints;
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      auto: true,
      messageIndex: 0,
      hasSnapshot: true,
      fileCount: 0,
    });
    expect(points[0].snapshot?.cwd).toBeTruthy();
    // 快照索引已落盘
    const { readFile } = await import("node:fs/promises");
    const index = JSON.parse(
      await readFile(
        path.join(sessionsDir, "snapshots", runtime.current!.snapshotOwnerId, points[0].snapshot!.file),
        "utf8",
      ),
    ) as Record<string, string | null>;
    // 写工具还没执行（checkpoint 在回合开始），此时只有 empty state 或 index 存在
    expect(typeof index).toBe("object");
  });

  it("captures before/after snapshots when a write tool runs during the turn", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-checkpoint-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock
      .mockResolvedValueOnce(writeToolCall("call-1", "a.ts"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("write a file");

    // 第二个回合：打点时 state 里已有 a.ts（上一回合写成功）
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("next turn");
    const points = runtime.current!.checkpoints;
    expect(points).toHaveLength(2);
    const second = points[1];
    expect(second.auto).toBe(true);
    expect(second.fileCount).toBe(1);
    const { readFile } = await import("node:fs/promises");
    const index = JSON.parse(
      await readFile(
        path.join(sessionsDir, "snapshots", runtime.current!.snapshotOwnerId, second.snapshot!.file),
        "utf8",
      ),
    ) as Record<string, string | null>;
    expect(Object.keys(index)).toContain("a.ts");
    expect(index["a.ts"]).toBeTypeOf("string");
  });

  it("appends an automatic checkpoint on plain conversation turns too", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-checkpoint-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "plain" } });

    await runtime.prompt("just chatting");

    const points = runtime.current!.checkpoints;
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ auto: true, messageIndex: 0, hasSnapshot: true });
  });

  it("skips a duplicate automatic checkpoint right after a manual one", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-checkpoint-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);

    await runtime.createCheckpoint("手动点");
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("just chatting");

    // 手动点与自动点都在 messageIndex 0：去重后只有一条
    expect(runtime.current!.checkpoints).toHaveLength(1);
  });

  it("does not write snapshots when the snapshot store is disabled", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-checkpoint-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace();
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
      sessionsDir,
      snapshots: { enabled: false },
    });
    await runtime.newSession(workspace);
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "plain" } });

    await runtime.prompt("just chatting");

    const points = runtime.current!.checkpoints;
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ auto: true, hasSnapshot: false, fileCount: 0 });
  });

  it("supports manual checkpoints on the current session", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-checkpoint-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace();
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);

    const created = await runtime.createCheckpoint("阶段完成");
    expect(created).toMatchObject({
      label: "阶段完成",
      auto: false,
      messageIndex: 0,
      hasSnapshot: true,
    });
    expect(runtime.current!.checkpoints).toHaveLength(1);
  });
});
