import { randomUUID } from "node:crypto";

/**
 * 轻量 trace 记录：一次顶层会话一个 traceId，turn/llm/tool 三层 span。
 * 只在回合与工具粒度打点（不为流式 delta 建 span），环形缓冲上限 500 条。
 */
export type TraceSpanKind = "turn" | "llm" | "tool" | "subagent" | "approval";
export type TraceSpanStatus = "ok" | "error" | "aborted";

export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: TraceSpanKind;
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: TraceSpanStatus;
  attributes?: Record<string, unknown>;
  error?: string;
};

export type ActiveTraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: TraceSpanKind;
  name: string;
  startedAt: number;
  attributes?: Record<string, unknown>;
};

export type TraceSummary = {
  total: number;
  errors: number;
  aborted: number;
  averageMs: number;
  maxMs: number;
  byKind: Partial<Record<TraceSpanKind, number>>;
};

const TRACE_SPAN_CAPACITY = 500;
const ERROR_MESSAGE_MAX = 300;

export function newTraceId(): string {
  return randomUUID();
}

export class TraceRecorder {
  private readonly spans: TraceSpan[] = [];
  private readonly sink?: (span: TraceSpan) => void;

  constructor(options: { sink?: (span: TraceSpan) => void } = {}) {
    this.sink = options.sink;
  }

  startSpan(input: {
    traceId: string;
    kind: TraceSpanKind;
    name: string;
    parentSpanId?: string;
    attributes?: Record<string, unknown>;
  }): ActiveTraceSpan {
    return {
      traceId: input.traceId,
      spanId: randomUUID().slice(0, 12),
      ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
      kind: input.kind,
      name: input.name,
      startedAt: Date.now(),
      ...(input.attributes ? { attributes: input.attributes } : {}),
    };
  }

  endSpan(
    active: ActiveTraceSpan,
    result: {
      status?: TraceSpanStatus;
      error?: unknown;
      attributes?: Record<string, unknown>;
    } = {},
  ): TraceSpan {
    const endedAt = Date.now();
    const errorText =
      result.error === undefined || result.error === null
        ? undefined
        : (result.error instanceof Error ? result.error.message : String(result.error)).slice(
            0,
            ERROR_MESSAGE_MAX,
          );
    const span: TraceSpan = {
      traceId: active.traceId,
      spanId: active.spanId,
      ...(active.parentSpanId ? { parentSpanId: active.parentSpanId } : {}),
      kind: active.kind,
      name: active.name,
      startedAt: active.startedAt,
      endedAt,
      durationMs: endedAt - active.startedAt,
      status: result.status ?? (errorText ? "error" : "ok"),
      ...(active.attributes || result.attributes
        ? { attributes: { ...active.attributes, ...result.attributes } }
        : {}),
      ...(errorText ? { error: errorText } : {}),
    };
    this.spans.push(span);
    if (this.spans.length > TRACE_SPAN_CAPACITY) this.spans.shift();
    try {
      this.sink?.(span);
    } catch {
      // 诊断落盘失败不能影响回合
    }
    return span;
  }

  /** 最近 limit 条，按发生顺序（旧 → 新）。 */
  list(limit = 100): TraceSpan[] {
    return this.spans.slice(Math.max(0, this.spans.length - limit));
  }

  summary(): TraceSummary {
    const byKind: Partial<Record<TraceSpanKind, number>> = {};
    let errors = 0;
    let aborted = 0;
    let maxMs = 0;
    let totalMs = 0;
    for (const span of this.spans) {
      byKind[span.kind] = (byKind[span.kind] ?? 0) + 1;
      if (span.status === "error") errors += 1;
      if (span.status === "aborted") aborted += 1;
      maxMs = Math.max(maxMs, span.durationMs);
      totalMs += span.durationMs;
    }
    return {
      total: this.spans.length,
      errors,
      aborted,
      averageMs: this.spans.length ? Math.round(totalMs / this.spans.length) : 0,
      maxMs,
      byKind,
    };
  }

  clear(): void {
    this.spans.length = 0;
  }
}
