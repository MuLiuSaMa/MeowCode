import React from "react";
import type { PluginDescriptor } from "../api";
import type { PluginClientContext, PluginClientModule } from "./types";

/**
 * 被闭包参数遮蔽的浏览器全局：插件误用会立刻抛引导错误。
 * 这是防误用边界，不是安全沙箱（与 DeepSeek Harness 的 client 半同一姿态）。
 */
export const SHADOWED_GLOBALS = [
  "window",
  "document",
  "globalThis",
  "self",
  "top",
  "parent",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Worker",
  "require",
  "module",
  "exports",
  "process",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "Function",
] as const;

const REDIRECT =
  "browser globals are unavailable in plugin clients. Use ctx.actions / ctx.storage / ctx.rpc / ctx.timers / styles instead.";

/** 样式注入器：卸载时移除该插件插入的全部 <style>。 */
export class PluginStyles {
  private readonly tags = new Set<HTMLStyleElement>();

  constructor(private readonly pluginId: string) {}

  insert = (css: string): (() => void) => {
    if (typeof css !== "string") throw new Error("styles.insert(css) needs a string");
    const tag = document.createElement("style");
    tag.dataset.plugin = this.pluginId;
    tag.textContent = css;
    document.head.append(tag);
    this.tags.add(tag);
    return () => {
      this.tags.delete(tag);
      tag.remove();
    };
  };

  dispose(): void {
    for (const tag of this.tags) tag.remove();
    this.tags.clear();
  }
}

export type PluginHostBridge = {
  call: (method: string, args?: unknown) => Promise<unknown>;
};

/** 从 server 取 `ui/client.js`（与面板共用 `/plugin-ui` 资源通道，带 query token）。 */
export async function fetchPluginClientSource(descriptor: PluginDescriptor): Promise<string> {
  const entry = descriptor.ui?.client?.entry;
  if (!entry) throw new Error("plugin has no client entry");
  const url = await window.meow?.pluginClientUrl?.(descriptor.id, entry);
  if (!url) throw new Error("plugin client url is unavailable (server not ready)");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`plugin client fetch failed: HTTP ${response.status}`);
  return response.text();
}

/**
 * 把源码当 async 函数体执行，符号面固定；返回 `{ apply(ctx) }` 或函数。
 * `new Function` 只做语法预检与遮蔽，不提供强隔离。
 */
export async function evaluatePluginClient(
  source: string,
  symbols: {
    ctx: PluginClientContext;
    styles: PluginStyles;
    host: PluginHostBridge;
    pluginId: string;
  },
): Promise<PluginClientModule> {
  const traps = SHADOWED_GLOBALS.map((name) => (): never => {
    throw new Error(`${name} is not available in plugin clients — ${REDIRECT}`);
  });
  const factory = new Function(
    ...SHADOWED_GLOBALS,
    "React",
    "ctx",
    "styles",
    "host",
    "pluginId",
    `"use strict";\nreturn (async () => {\n${source}\n})();`,
  );
  return (await factory(
    ...traps,
    React,
    symbols.ctx,
    symbols.styles,
    symbols.host,
    symbols.pluginId,
  )) as PluginClientModule;
}

export type PluginClientDisposer = () => void;

/** apply 可以返回一个函数或函数数组；统一折叠成幂等 dispose。 */
export function disposeFromApplyResult(result: unknown): PluginClientDisposer {
  const disposers = Array.isArray(result)
    ? result
    : typeof result === "function"
      ? [result]
      : [];
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const item of disposers.reverse()) {
      if (typeof item !== "function") continue;
      try {
        (item as () => void)();
      } catch {
        /* 单个 disposer 失败不影响其余清理 */
      }
    }
  };
}

/** 执行 client 模块的 apply；返回它自己的 disposer（不含槽位清理）。 */
export async function applyPluginClient(
  module: PluginClientModule,
  ctx: PluginClientContext,
): Promise<PluginClientDisposer> {
  const apply = typeof module === "function" ? module : module.apply;
  if (typeof apply !== "function") {
    throw new Error("ui/client.js must return { apply(ctx) } or a function");
  }
  const result = await apply(ctx);
  return disposeFromApplyResult(result);
}
