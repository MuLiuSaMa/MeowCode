import type { PluginHookEventMap, PluginHookName, PluginHookResultMap } from "./types.js";
import type { PluginRegistry } from "./registry.js";

/**
 * hook 分发：按注册顺序（project 插件先于 user 插件）依次执行 handler。
 *  - transform 链式：改写字段同时回写 event（后者看到前者改过的值）并累积进返回值；
 *  - block 短路：任一 handler 返回 block=true 立即返回，取其 reason；
 *  - 失败降级：handler 抛错视为返回空结果，记日志、继续后续 handler。
 * registry 为空 / 无 handler 时直通返回 undefined，runtime 侧零开销。
 */
export async function runHook<N extends PluginHookName>(
  registry: PluginRegistry | null | undefined,
  name: N,
  event: PluginHookEventMap[N],
): Promise<PluginHookResultMap[N] | undefined> {
  if (!registry) return undefined;
  const handlers = registry.getHookHandlers(name);
  if (handlers.length === 0) return undefined;

  const merged: Record<string, unknown> = {};

  for (const { pluginId, handler } of handlers) {
    let result: unknown;
    try {
      result = await (handler as (event: PluginHookEventMap[N]) => unknown)(event);
    } catch (error) {
      registry.reportHandlerError(pluginId, name, error);
      continue;
    }
    if (!result || typeof result !== "object") continue;
    const r = result as Record<string, unknown>;

    if (r.block === true) {
      const out: Record<string, unknown> = { block: true };
      if (typeof r.reason === "string") out.reason = r.reason;
      return out as PluginHookResultMap[N];
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
      default:
        break; // 观察类 hook 无 Result
    }
  }

  if (Object.keys(merged).length === 0) return undefined;
  return merged as PluginHookResultMap[N];
}
