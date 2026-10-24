import type { ToolCall } from "./types.js";

/** 流式生成工具调用参数时的轻量进度；不落盘，仅用于 UI 提示。 */
export type ToolCallProgress = {
  count: number;
  tool?: string;
  names?: string[];
  /** 已经能完整读出的目标文件路径（写/改文件时用于提前显示文件名） */
  path?: string;
  chars: number;
};

/**
 * 从**可能还没流完**的 JSON 参数里读出目标路径。
 * 只接受已经闭合的字符串值（避免显示半截文件名）；多文件 multi_edit 取第一个。
 */
function readPartialPath(argumentsText: string): string | undefined {
  const match = /"(?:path|file_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(argumentsText);
  if (!match) return undefined;
  try {
    const value = JSON.parse(`"${match[1]}"`) as unknown;
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

export function summarizeToolCalls(calls: Iterable<ToolCall>): ToolCallProgress {
  const values = [...calls];
  const names = values.map((call) => call.function.name).filter(Boolean);
  const path = values
    .map((call) => readPartialPath(call.function.arguments))
    .find((value) => value !== undefined);
  return {
    count: values.length,
    ...(names.at(-1) ? { tool: names.at(-1) } : {}),
    ...(names.length ? { names } : {}),
    ...(path ? { path } : {}),
    chars: values.reduce((total, call) => total + call.function.arguments.length, 0),
  };
}

/**
 * 流式累积中的工具调用参数是否已经完整闭合。
 * 三重校验：名字与 id 都到了、参数 JSON 可整体 parse（parse 成功已隐含括号/字符串配平）。
 * parse 失败 = 还在流式传输或被截断，绝不能提前执行。
 */
export function isToolCallComplete(call: ToolCall): boolean {
  if (!call.id || !call.function.name) return false;
  const raw = call.function.arguments;
  // 空参数说明参数流还没开始，不算完整
  if (!raw.trim()) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}
