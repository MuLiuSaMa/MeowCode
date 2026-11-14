/**
 * 工具入参统一门禁：解析、校验、观察副本。
 *
 * 三件事放在一个模块，是因为它们必须对同一份入参按同一个顺序发生：
 *   1. 解析 JSON（坏 JSON 与「对象但缺字段」是两种病，报错必须能区分）；
 *   2. 按 `tool-contract.ts` 的 `args` 声明校验（声明与执行同源，加工具只改一处）；
 *   3. 给观察者发副本（事件监听器 in-place 改字段不能改到即将执行的对象上）。
 *
 * 历史上这段逻辑长在 runtime.ts 内部，只服务串行路径；只读并行路径自己写了
 * 一段 `JSON.parse` + catch 吞成 `{}`，于是 `read_file` 会带着 `path=undefined`
 * 真的执行，回给模型的是一句无从纠正的 "undefined not found."。抽成模块的目的
 * 就是让两条路径没有第二份实现可写。
 */
import { readMultiEditGroups } from "./multi-edit.js";
import { builtinToolArgs, READ_MANY_MAX_PATHS } from "./tool-contract.js";

export type ToolInputValidation =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * 校验一次工具调用的入参。错误文案直接进模型上下文，所以每条都要写明
 * 「哪个字段、期望什么」，不要只说 invalid。
 */
export function validateToolInput(tool: string, raw: string | undefined): ToolInputValidation {
  const text = (raw ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `tool arguments are not valid JSON (${detail}).` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "tool arguments must be a JSON object." };
  }
  const args = parsed as Record<string, unknown>;
  // multi_edit 支持跨文件：path 可以在顶层，也可以挂在每条 edit 上
  if (tool === "multi_edit") {
    const groups = readMultiEditGroups(args);
    if (typeof groups === "string") return { ok: false, error: groups };
    return { ok: true, input: args };
  }
  // read_many 的 paths 是字符串数组：不是「一层字符串字段」，单独校验
  if (tool === "read_many") {
    const paths = args.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, error: 'argument "paths" must be a non-empty array of file paths.' };
    }
    if (paths.length > READ_MANY_MAX_PATHS) {
      return {
        ok: false,
        error: `argument "paths" accepts at most ${READ_MANY_MAX_PATHS} files; split into batches.`,
      };
    }
    if (paths.some((item) => typeof item !== "string" || !item.trim())) {
      return { ok: false, error: 'every entry in "paths" must be a non-empty string.' };
    }
    return { ok: true, input: args };
  }
  const spec = builtinToolArgs(tool);
  if (spec) {
    for (const field of spec.required ?? []) {
      const value = args[field];
      if (typeof value !== "string") {
        return {
          ok: false,
          error: `missing required string argument "${field}" (required: ${(
            spec.required ?? []
          ).join(", ")}).`,
        };
      }
      if (spec.nonEmpty?.includes(field) && !value.trim()) {
        return { ok: false, error: `argument "${field}" must not be empty.` };
      }
    }
  }
  return { ok: true, input: args };
}

/**
 * 观察者副本：事件监听器、trace、hook 拿到的入参不能和真正执行的对象共享引用。
 *
 * 共享引用时，一个 in-place 修改（埋点补字段、日志脱敏、插件顺手补个默认值）
 * 就会改掉即将执行的参数，而且 UI 上的审批预览、落盘的工具记录、下一次请求的
 * tool 消息会各说各话。hook 想改参数必须走返回值 `{ input }`，那条通道有重校验。
 *
 * 入参来自 JSON.parse，必然可结构化克隆；退化路径只是防御。
 */
export function observerCopy<T>(input: T): T {
  if (input === null || typeof input !== "object") return input;
  try {
    return structuredClone(input);
  } catch {
    try {
      return JSON.parse(JSON.stringify(input)) as T;
    } catch {
      return { ...(input as unknown as Record<string, unknown>) } as T;
    }
  }
}
