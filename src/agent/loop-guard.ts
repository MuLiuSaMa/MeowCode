import path from "node:path";
import { resolveToolPath } from "./paths.js";
import { captureVersion } from "./read-state.js";
import type { ChatMessage, ToolCall } from "./types.js";

/**
 * 循环检测（P1-2）：同一回合内「参数完全相同 且 输出逐字节相同」的连续工具调用。
 * 双条件缺一不可 —— edit 之后用相同参数重读同一文件是合法流程（文件变了输出就变，
 * 不会计数）；只有确定性工具返回相同输出时，重复调用才是零信息浪费。
 * 阈值参考 dsh repeat-tool-reminder 的 3/5/8 分级。
 */
export const LOOP_REMIND_AT = 3;
export const LOOP_WARN_AT = 5;
export const LOOP_BLOCK_AT = 8;

/** 每个文件最多保留多少段已读区间（相邻区间会合并）。 */
export const MAX_READ_RANGES_PER_FILE = 8;
/** 已读区间表最多跟踪多少个文件（LRU 淘汰）。 */
export const MAX_COVERAGE_FILES = 64;
/** 部分覆盖时，覆盖率达到这个比例才值得只回未覆盖段。 */
export const MIN_PARTIAL_COVERAGE = 0.5;
/** 跨回合结果去重的有效期（回合数）。 */
export const RESULT_DEDUPE_TURNS = 6;
/** 跨回合结果索引上限（LRU）。 */
const MAX_RESULT_INDEX = 128;
/**
 * 只有「确定性、纯只读、结果体积可观」的工具参与跨回合去重。
 * run_command / run_code 与时间相关，写类工具重跑本身有意义，动态工具副作用未知 ——
 * 一律不进这张表。
 */
const DEDUPE_TOOLS = new Set(["list_dir", "glob", "grep", "read_many"]);

const LOOP_REMINDER_3 =
  "[meowcode] Note: this exact call (same tool and arguments) has already returned an identical result 3 times in a row. The output is deterministic — repeating it adds nothing. Change the arguments or move on.";
const LOOP_REMINDER_5 =
  "[meowcode] Warning: 5th identical call in a row with identical output. You are in a loop. Use a different tool, different arguments, or summarize what you have and continue the task.";
const loopBlockedOutput = (tool: string, count: number): string =>
  `Blocked: ${tool} has been called with identical arguments and returned identical output ${count} times in a row. Repeating it is wasteful and it will not be executed again. Change the arguments (different offset/pattern/path) or take a different approach.`;

/** 稳定 JSON 序列化：键排序后拼接，避免模型换键序导致判重失效。 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([field, item]) => `${JSON.stringify(field)}:${stableJson(item)}`).join(",")}}`;
}

/** Windows 路径大小写不敏感；其余平台按原样比较。 */
function sameFilePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 已读区间表的键：解析后的真实路径（win32 小写）。 */
function fileKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** FNV-1a 指纹：循环状态里不存全文，只存 32 位哈希。 */
function outputFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function pathArg(input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const target = typeof args.path === "string" ? args.path.trim() : "";
  return target;
}

/**
 * 上下文里仍然「逐字可见」的工具结果 callId。
 * 被淘汰成占位符或被摘要替换的结果不能再作为「你之前读过」的依据。
 */
function visibleToolCallIds(messages: ChatMessage[]): Set<string> {
  const visible = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    if (!message.content) continue;
    if (message.content.includes("output elided:")) continue;
    if (message.content.startsWith("[summarized]")) continue;
    visible.add(message.tool_call_id);
  }
  return visible;
}

type ReadRange = { start: number; end: number; callIds: string[]; at: number };
type FileCoverage = { file: string; version: string; total: number; ranges: ReadRange[] };
type ResultEntry = { hash: string; turn: number; callId: string; length: number };

/** 可落盘的已读区间快照：只保留恢复所需的字段（callId/回合号是进程内概念）。 */
export type ReadCoverageSnapshot = Array<{
  file: string;
  version: string;
  total: number;
  ranges: Array<{ start: number; end: number }>;
}>;

/** 合并重叠或相邻区间；保留每段的贡献 callId（用于可见性校验）。 */
function mergeRanges(ranges: ReadRange[]): ReadRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: ReadRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      last.at = Math.max(last.at, range.at);
      for (const callId of range.callIds) {
        if (!last.callIds.includes(callId)) last.callIds.push(callId);
      }
      continue;
    }
    merged.push({ ...range, callIds: [...range.callIds] });
  }
  return merged;
}

/**
 * 循环守卫：循环判重（按会话）+ 已读区间短路 + 跨回合同结果去重。
 * 每 runtime 一个实例；跨回合由调用方 reset，进程重启后状态自然为空即自动失效。
 */
export class LoopGuard {
  private readonly states = new Map<string, LoopState>();
  private readonly coverage = new Map<string, FileCoverage>();
  private readonly results = new Map<string, ResultEntry>();
  /** 回合序号：由 reset 推进，用于「跨回合」判定的时间基准。 */
  private turnSeq = 0;

  /** 会话切换/进程内状态回收时清空读覆盖与结果索引。 */
  clearReadVersions(): void {
    this.coverage.clear();
    this.results.clear();
  }

  /**
   * 导出已读区间快照（落盘用）。
   *
   * 这张表原来只在进程内活着：重启后「这个文件我读过、内容是 X 版」全部丢失，
   * 模型只能整段重读，一次就是几千 token。落盘后重启/换窗口仍能命中
   * 「已读过且未变更」的短路。
   */
  exportCoverage(): ReadCoverageSnapshot {
    return [...this.coverage.values()].map((entry) => ({
      file: entry.file,
      version: entry.version,
      total: entry.total,
      ranges: entry.ranges.map((range) => ({ start: range.start, end: range.end })),
    }));
  }

  /**
   * 恢复已读区间。版本键（inode:size:mtimeNs）对不上的直接丢弃：
   * 文件在进程外改过，旧区间不再成立，宁可让模型重读也不要给出过期正文。
   */
  async restoreCoverage(snapshot: ReadCoverageSnapshot | null | undefined): Promise<void> {
    if (!snapshot?.length) return;
    for (const entry of snapshot) {
      if (!entry?.file || !entry.version || !entry.ranges?.length) continue;
      const version = await captureVersion(entry.file).catch(() => "absent");
      if (version !== entry.version) continue;
      const key = fileKey(entry.file);
      this.coverage.delete(key);
      this.coverage.set(key, {
        file: entry.file,
        version,
        total: Math.max(1, entry.total),
        ranges: entry.ranges.map((range) => ({
          start: range.start,
          end: range.end,
          callIds: [],
          at: this.turnSeq,
        })),
      });
      while (this.coverage.size > MAX_COVERAGE_FILES) {
        const oldest = this.coverage.keys().next().value;
        if (oldest === undefined) break;
        this.coverage.delete(oldest);
      }
    }
  }

  /** 每回合开始时清空循环检测状态：跨回合的相同调用不算循环。 */
  reset(sessionId: string): void {
    this.states.delete(sessionId);
    this.turnSeq += 1;
  }

  /** 执行前检查：连续 8 次零信息重复直接拒绝执行 —— 省掉执行本身与整轮上下文重发。 */
  blockFor(sessionId: string, tool: string, input: unknown): string | null {
    const state = this.states.get(sessionId);
    if (!state || state.count < LOOP_BLOCK_AT) return null;
    const key = `${tool}:${stableJson(input)}`;
    return state.key === key ? loopBlockedOutput(tool, state.count) : null;
  }

  /**
   * 执行后登记：参数键与输出指纹都相同才累计。返回要附加到工具结果的提醒
   * （未达阈值返回空串）。占位符/错误结果同样计数 —— 反复同参数失败也是循环。
   */
  noteResult(sessionId: string, tool: string, input: unknown, output: string): string {
    const key = `${tool}:${stableJson(input)}`;
    const fingerprint = outputFingerprint(output);
    const state = this.states.get(sessionId);
    if (state && state.key === key && state.outputHash === fingerprint) {
      state.count += 1;
      if (state.count >= LOOP_BLOCK_AT) return loopBlockedOutput(tool, state.count);
      if (state.count >= LOOP_WARN_AT) return LOOP_REMINDER_5;
      if (state.count >= LOOP_REMIND_AT) return LOOP_REMINDER_3;
      return "";
    }
    this.states.set(sessionId, { key, outputHash: fingerprint, count: 1 });
    return "";
  }

  /**
   * 读取成功后登记「模型看过这一版、这一段」。
   * 区间来自 read_file 实际返回的行范围，不是请求参数 —— 文件比 limit 短时
   * 请求区间会高估覆盖，把没给过的行算成已读是这里唯一不能犯的错。
   */
  async rememberReadRange(
    cwd: string,
    callId: string,
    input: unknown,
    range: { start: number; end: number; total: number } | undefined,
    allowOutsideWorkspace: boolean,
  ): Promise<void> {
    const target = pathArg(input);
    if (!target) return;
    await this.rememberReadRangeAt(cwd, callId, target, range, allowOutsideWorkspace);
  }

  /** 同 rememberReadRange，但直接收路径（read_many 一次读多个文件时逐条登记）。 */
  async rememberReadRangeAt(
    cwd: string,
    callId: string,
    target: string,
    range: { start: number; end: number; total: number } | undefined,
    allowOutsideWorkspace: boolean,
  ): Promise<void> {
    if (!target || !range || range.end < range.start) return;
    try {
      const file = await resolveToolPath(cwd, target, allowOutsideWorkspace);
      const version = await captureVersion(file);
      if (version === "absent") return;
      const key = fileKey(file);
      const existing = this.coverage.get(key);
      // 文件变过：旧区间全部作废，从这一段重新开始记
      const sameVersion = existing && existing.version === version;
      const ranges = sameVersion ? [...existing.ranges] : [];
      ranges.push({ start: range.start, end: range.end, callIds: [callId], at: this.turnSeq });
      const merged = mergeRanges(ranges).slice(-MAX_READ_RANGES_PER_FILE);
      this.coverage.delete(key);
      this.coverage.set(key, {
        file,
        version,
        total: Math.max(1, range.total),
        ranges: merged,
      });
      while (this.coverage.size > MAX_COVERAGE_FILES) {
        const oldest = this.coverage.keys().next().value;
        if (oldest === undefined) break;
        this.coverage.delete(oldest);
      }
    } catch {
      // 路径解析失败不影响读取结果
    }
  }

  /**
   * 该文件是否已被本会话完整读过且没有变化（read_many 用它省掉整段正文）。
   * 比 repeatedReadStub 宽松：不看请求区间，只看「1..total 是否都在覆盖表里」。
   */
  async fullyCovered(
    cwd: string,
    messages: ChatMessage[],
    target: string,
    allowOutsideWorkspace: boolean,
  ): Promise<boolean> {
    const window = await this.readWindowFor(cwd, target, allowOutsideWorkspace);
    if (!window) return false;
    const visible = visibleToolCallIds(messages);
    return window.ranges.some(
      (range) =>
        range.start <= 1 &&
        range.end >= window.total &&
        range.callIds.every((callId) => visible.has(callId)),
    );
  }

  /**
   * 完全覆盖短路：请求区间已被之前的读取完整覆盖，且文件版本未变、
   * 贡献区间的结果仍在上下文里逐字可见 —— 直接给占位，不重发正文。
   */
  async repeatedReadStub(
    cwd: string,
    messages: ChatMessage[],
    call: ToolCall,
    input: unknown,
    allowOutsideWorkspace: boolean,
  ): Promise<string | null> {
    if (call.function.name !== "read_file") return null;
    const window = await this.readWindow(cwd, input, allowOutsideWorkspace);
    if (!window) return null;
    const { target, requested, ranges } = window;
    const visible = visibleToolCallIds(messages);
    const usable = ranges.filter((range) => range.callIds.every((id) => visible.has(id)));
    const hit = usable.find(
      (range) => range.start <= requested.start && range.end >= requested.end,
    );
    if (!hit) return null;
    return `Unchanged since your earlier read of ${target} (lines ${requested.start}-${requested.end}). Refer to that result instead; use a different offset/limit if you need another part.`;
  }

  /**
   * 部分覆盖：请求区间的前半段已经读过时，只回未覆盖的尾部。
   * 先执行后裁剪 —— 执行很便宜，贵的是把重复正文塞进历史。
   * 返回 null 表示不需要裁剪（覆盖不足一半，或输出不是可识别的行号形态）。
   */
  async trimCoveredReadPrefix(
    cwd: string,
    messages: ChatMessage[],
    input: unknown,
    output: string,
    allowOutsideWorkspace: boolean,
  ): Promise<string | null> {
    const window = await this.readWindow(cwd, input, allowOutsideWorkspace);
    if (!window) return null;
    const { requested, ranges } = window;
    const visible = visibleToolCallIds(messages);
    const usable = ranges.filter((range) => range.callIds.every((id) => visible.has(id)));
    const covering = usable.find(
      (range) => range.start <= requested.start && range.end > requested.start,
    );
    if (!covering) return null;
    const coveredEnd = Math.min(covering.end, requested.end - 1);
    const covered = coveredEnd - requested.start + 1;
    const total = requested.end - requested.start + 1;
    if (covered <= 0 || covered / total < MIN_PARTIAL_COVERAGE) return null;

    const lines = output.split("\n");
    const kept: string[] = [];
    let dropped = 0;
    for (const line of lines) {
      const match = /^(\d+): /.exec(line);
      if (match) {
        const number = Number(match[1]);
        if (number >= requested.start && number <= coveredEnd) {
          dropped += 1;
          continue;
        }
      }
      kept.push(line);
    }
    if (dropped === 0) return null;
    return `[Lines ${requested.start}-${coveredEnd} unchanged since your earlier read — omitted here.]\n${kept.join("\n")}`;
  }

  /**
   * 跨回合结果去重：同工具、同参数、同输出指纹，且旧结果仍在上下文里可见时，
   * 用一行占位替代整段结果。命中后不刷新时间窗口，避免「一直命中一直续命」。
   */
  dedupeRepeatedResult(
    tool: string,
    input: unknown,
    output: string,
    callId: string,
    messages: ChatMessage[],
  ): string | null {
    if (!DEDUPE_TOOLS.has(tool)) return null;
    const key = `${tool}:${stableJson(input)}`;
    const hash = outputFingerprint(output);
    const entry = this.results.get(key);
    if (
      entry &&
      entry.hash === hash &&
      this.turnSeq - entry.turn <= RESULT_DEDUPE_TURNS &&
      visibleToolCallIds(messages).has(entry.callId)
    ) {
      return `Identical to your ${tool} result from an earlier turn (same arguments, ${entry.length} chars, byte-for-byte identical). Nothing changed — reuse that result instead of repeating the call.`;
    }
    this.results.delete(key);
    this.results.set(key, { hash, turn: this.turnSeq, callId, length: output.length });
    while (this.results.size > MAX_RESULT_INDEX) {
      const oldest = this.results.keys().next().value;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
    return null;
  }

  /** 解析路径、校验版本、算出请求区间；任一环节不成立就返回 null（退回正常读取）。 */
  private async readWindow(
    cwd: string,
    input: unknown,
    allowOutsideWorkspace: boolean,
  ): Promise<{
    target: string;
    requested: { start: number; end: number };
    ranges: ReadRange[];
    total: number;
  } | null> {
    const target = pathArg(input);
    if (!target) return null;
    const args = (input ?? {}) as Record<string, unknown>;
    const start = Math.max(1, Number(args.offset ?? 1) || 1);
    const limit = Math.max(1, Number(args.limit ?? 400) || 400);
    return this.readWindowFor(cwd, target, allowOutsideWorkspace, start, limit);
  }

  /**
   * readWindow 的路径版：read_many 没有 offset/limit，默认按整文件（1..total）请求。
   * 请求区间在文件末尾收敛 —— limit 超过剩余行数时多出来的部分不存在，
   * 不能因为「没覆盖到 400 行」就判定只读了一小段。
   */
  private async readWindowFor(
    cwd: string,
    target: string,
    allowOutsideWorkspace: boolean,
    start = 1,
    limit = Number.MAX_SAFE_INTEGER,
  ): Promise<{
    target: string;
    requested: { start: number; end: number };
    ranges: ReadRange[];
    total: number;
  } | null> {
    if (!target) return null;
    let file: string;
    try {
      file = await resolveToolPath(cwd, target, allowOutsideWorkspace);
    } catch {
      return null;
    }
    const entry = this.coverage.get(fileKey(file));
    if (!entry) return null;
    // 文件被改过（含 Agent 自己的编辑）：之前的读取不再代表当前内容
    const current = await captureVersion(file);
    if (current === "absent" || current !== entry.version) return null;
    if (!sameFilePath(file, entry.file)) return null;
    const end = Math.min(start + limit - 1, Math.max(entry.total, start));
    return { target, requested: { start, end }, ranges: entry.ranges, total: entry.total };
  }
}

type LoopState = { key: string; outputHash: string; count: number };
