import type { ChatMessage } from "../agent/types.js";
import type {
  PluginHookContext,
  PluginHookEventMap,
  PluginHookName,
  PluginHookResultMap,
} from "./types.js";
import type { PluginRegistry } from "./registry.js";

/**
 * 单个 handler 的默认超时。
 * hook 是串行 await 的，任何插件卡住都会拖住整个回合（高频事件尤其致命），
 * 所以超时一律视为「本次无结果」继续下一个 handler —— 观察类等于放行，
 * 可阻断类等于不阻断，两种语义都不会因为插件卡死而错误地拦下用户。
 */
const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/** 超时用独立错误类型区分，避免与 handler 自身异常混在一起。 */
class HookTimeoutError extends Error {}

function hookTimeoutMs(): number {
  const raw = Number(process.env.MEOWCODE_HOOK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOOK_TIMEOUT_MS;
}

/** 给 handler 的 Promise 套一层超时；到点 reject HookTimeoutError 并清掉定时器。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HookTimeoutError("hook timed out")), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * hook 分发：按注册顺序（project 插件先于 user 插件）依次执行 handler。
 *  - transform 链式：改写字段同时回写 event（后者看到前者改过的值）并累积进返回值；
 *  - block 短路：任一 handler 返回 block=true 立即返回，取其 reason；
 *  - permission 折叠：deny > ask > allow（allow 不预批准，由调用方决定忽略）；
 *  - 失败降级：handler 抛错 / 超时视为返回空结果，记日志、继续后续 handler。
 * registry 为空 / 无 handler 时直通返回 undefined，runtime 侧零开销。
 */
export async function runHook<N extends PluginHookName>(
  registry: PluginRegistry | null | undefined,
  name: N,
  event: PluginHookEventMap[N],
  context?: PluginHookContext,
  options?: { timeoutMs?: number },
): Promise<PluginHookResultMap[N] | undefined> {
  if (!registry) return undefined;
  const handlers = registry.getHookHandlers(name);
  if (handlers.length === 0) return undefined;

  const timeoutMs = options?.timeoutMs ?? hookTimeoutMs();
  const merged: Record<string, unknown> = {};

  for (const { pluginId, handler } of handlers) {
    let result: unknown;
    try {
      const pending = (handler as (event: PluginHookEventMap[N], ctx?: PluginHookContext) => unknown)(
        event,
        context,
      );
      result = await withTimeout(Promise.resolve(pending), timeoutMs);
    } catch (error) {
      if (error instanceof HookTimeoutError) {
        registry.reportHandlerError(
          pluginId,
          name,
          new Error(`hook timed out after ${timeoutMs}ms; treated as no result`),
        );
      } else {
        registry.reportHandlerError(pluginId, name, error);
      }
      continue;
    }
    if (!result || typeof result !== "object") continue;
    const r = result as Record<string, unknown>;

    if (r.block === true) {
      if (name === "permission_request") {
        const out: Record<string, unknown> = { permission: "deny" };
        if (typeof r.reason === "string") out.reason = r.reason;
        return out as PluginHookResultMap[N];
      }
      const out: Record<string, unknown> = { block: true };
      if (typeof r.reason === "string") out.reason = r.reason;
      return out as PluginHookResultMap[N];
    }

    if (name === "tool_call" && r.permission === "deny") {
      const out: Record<string, unknown> = { block: true };
      if (typeof r.reason === "string") out.reason = r.reason;
      return out as PluginHookResultMap[N];
    }
    if (name === "permission_request" && r.permission === "deny") {
      const out: Record<string, unknown> = { permission: "deny" };
      if (typeof r.reason === "string") out.reason = r.reason;
      return out as PluginHookResultMap[N];
    }
    if (
      (name === "tool_call" || name === "permission_request") &&
      (r.permission === "allow" || r.permission === "ask")
    ) {
      const current = merged.permission;
      if (r.permission === "ask" && current !== "ask") {
        merged.permission = "ask";
        if (typeof r.reason === "string" && typeof merged.reason !== "string") {
          merged.reason = r.reason;
        }
      } else if (r.permission === "allow" && current === undefined) {
        merged.permission = "allow";
      }
    }

    switch (name) {
      case "tool_call": {
        const e = event as PluginHookEventMap["tool_call"];
        if (r.input && typeof r.input === "object") {
          e.input = r.input as Record<string, unknown>;
          merged.input = r.input;
        }
        break;
      }
      case "tool_result": {
        const e = event as PluginHookEventMap["tool_result"];
        if (typeof r.output === "string") {
          e.output = r.output;
          merged.output = r.output;
        }
        if (typeof r.ok === "boolean") {
          e.ok = r.ok;
          merged.ok = r.ok;
        }
        break;
      }
      case "prompt_submit": {
        const e = event as PluginHookEventMap["prompt_submit"];
        if (typeof r.text === "string") {
          e.text = r.text;
          merged.text = r.text;
        }
        break;
      }
      case "context_inject": {
        // 多条 notes 累积（每个 handler 各加各的，不做覆盖）
        const notes = Array.isArray(r.notes)
          ? r.notes.filter((note): note is string => typeof note === "string" && note.trim().length > 0)
          : [];
        if (notes.length) {
          const current = Array.isArray(merged.notes) ? (merged.notes as string[]) : [];
          merged.notes = [...current, ...notes];
        }
        break;
      }
      case "before_provider_request": {
        // messages/tools 回写 event：后注册的 handler 看到前者改过的消息
        const e = event as PluginHookEventMap["before_provider_request"];
        if (Array.isArray(r.messages)) {
          e.messages = r.messages as ChatMessage[];
          merged.messages = r.messages;
        }
        if (Array.isArray(r.tools)) {
          merged.tools = r.tools;
        }
        if (r.extraBody && typeof r.extraBody === "object") {
          merged.extraBody = {
            ...(merged.extraBody && typeof merged.extraBody === "object"
              ? (merged.extraBody as Record<string, unknown>)
              : {}),
            ...(r.extraBody as Record<string, unknown>),
          };
        }
        break;
      }
      default:
        break; // 观察类 hook 无 Result
    }
  }

  if (Object.keys(merged).length === 0) return undefined;
  return merged as PluginHookResultMap[N];
}
