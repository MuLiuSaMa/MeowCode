import { describe, expect, it } from "vitest";
import { TraceRecorder } from "./trace.js";

describe("TraceRecorder", () => {
  it("记录 span 嵌套与汇总", () => {
    const recorder = new TraceRecorder();
    const turn = recorder.startSpan({ traceId: "t1", kind: "turn", name: "prompt" });
    const tool = recorder.startSpan({
      traceId: "t1",
      kind: "tool",
      name: "read_file",
      parentSpanId: turn.spanId,
    });
    recorder.endSpan(tool, { attributes: { bytes: 12 } });
    recorder.endSpan(turn, { status: "ok", attributes: { files: 0 } });

    const spans = recorder.list();
    expect(spans).toHaveLength(2);
    // list 按结束时间排序：工具先结束
    expect(spans[0].parentSpanId).toBe(turn.spanId);
    expect(spans[0].attributes).toEqual({ bytes: 12 });
    expect(spans[1].attributes).toEqual({ files: 0 });
    const summary = recorder.summary();
    expect(summary.total).toBe(2);
    expect(summary.byKind).toEqual({ turn: 1, tool: 1 });
    expect(summary.errors).toBe(0);
  });

  it("错误与中止分别计数，错误文案截断", () => {
    const recorder = new TraceRecorder();
    const failed = recorder.startSpan({ traceId: "t", kind: "llm", name: "m" });
    recorder.endSpan(failed, { error: new Error("boom") });
    const aborted = recorder.startSpan({ traceId: "t", kind: "tool", name: "grep" });
    recorder.endSpan(aborted, { status: "aborted" });

    const summary = recorder.summary();
    expect(summary.errors).toBe(1);
    expect(summary.aborted).toBe(1);
    expect(recorder.list()[0].status).toBe("error");
    expect(recorder.list()[0].error).toBe("boom");
  });

  it("环形缓冲有上限，先丢最旧", () => {
    const recorder = new TraceRecorder();
    for (let index = 0; index < 540; index += 1) {
      const span = recorder.startSpan({ traceId: "t", kind: "tool", name: `t${index}` });
      recorder.endSpan(span);
    }
    const spans = recorder.list(1000);
    expect(spans).toHaveLength(500);
    expect(spans[0].name).toBe("t40");
  });

  it("sink 收到落盘副本，抛错不影响记录", () => {
    const seen: string[] = [];
    const recorder = new TraceRecorder({
      sink: (span) => {
        seen.push(span.name);
        throw new Error("disk full");
      },
    });
    const span = recorder.startSpan({ traceId: "t", kind: "tool", name: "write_file" });
    expect(() => recorder.endSpan(span)).not.toThrow();
    expect(seen).toEqual(["write_file"]);
    expect(recorder.list()).toHaveLength(1);
  });
});
