/**
 * 会话级工具目录快照。
 *
 * 工具块排在 prompt 最前面，任何字节变化都会让后面所有缓存断点失效。
 * 因此这里把目录拆成两类变动：
 *  - 新增：立即追加到末尾（旧断点位置不动，旧工具段仍可命中）；
 *  - 删除 / 定义改写：保留旧 schema 不动，等缓存安全边界再整体重建。
 *
 * 纯函数，不持有会话状态；runtime 负责在 newSession / 压缩完成 / 切档 /
 * 插件重载时调用 createToolCatalog 重建。
 */
import { createHash } from "node:crypto";
import type { ToolDefinition } from "./types.js";

export type CatalogDelta = {
  /** 本次已追加到目录末尾的工具名 */
  added: string[];
  /** 已下线、但 schema 仍保留的工具名 */
  removed: string[];
  /** 定义变了、但仍沿用旧 schema 的工具名 */
  rewritten: string[];
};

export type ToolCatalog = {
  tools: ToolDefinition[];
  /** Anthropic tools 断点打在这个下标（快照末尾）；追加工具后保持不变 */
  anchorIndex: number;
  /** 工具块字节指纹（sha1），用于缓存诊断 */
  fingerprint: string;
  delta: CatalogDelta;
};

function definitionKey(definition: ToolDefinition): string {
  return JSON.stringify({
    description: definition.function.description,
    parameters: definition.function.parameters,
  });
}

function fingerprintTools(tools: ToolDefinition[]): string {
  const hash = createHash("sha1");
  for (const tool of tools) {
    hash.update(tool.function.name).update("\0").update(definitionKey(tool)).update("\0");
  }
  return hash.digest("hex");
}

/** 全新快照：目录整体重建（新会话 / 压缩 / 切档 / 手动重载）。 */
export function createToolCatalog(tools: ToolDefinition[]): ToolCatalog {
  const snapshot = [...tools];
  return {
    tools: snapshot,
    anchorIndex: snapshot.length - 1,
    fingerprint: fingerprintTools(snapshot),
    delta: { added: [], removed: [], rewritten: [] },
  };
}

/**
 * 增量对齐：只把真正新增的工具追加到末尾。
 * `delta` 每次都从「当前快照 vs 最新原始表」现算，不累积历史状态。
 */
export function reconcileToolCatalog(
  catalog: ToolCatalog,
  next: ToolDefinition[],
): { catalog: ToolCatalog; appliedAdditions: string[] } {
  const currentByName = new Map(catalog.tools.map((tool) => [tool.function.name, tool]));
  const nextByName = new Map(next.map((tool) => [tool.function.name, tool]));

  const additions: ToolDefinition[] = [];
  const rewritten: string[] = [];
  for (const [name, tool] of nextByName) {
    const previous = currentByName.get(name);
    if (!previous) additions.push(tool);
    else if (definitionKey(previous) !== definitionKey(tool)) rewritten.push(name);
  }
  const removed: string[] = [];
  for (const name of currentByName.keys()) {
    if (!nextByName.has(name)) removed.push(name);
  }

  // locale 钉死为 en：裸 localeCompare 跟随进程语言设置（如 da-DK 把 "aa" 排在 "z" 之后），
  // 换语言恢复会话时 additions 顺序变化会让 tools 段字节变化、缓存整段失效。
  additions.sort((a, b) => a.function.name.localeCompare(b.function.name, "en"));
  removed.sort();
  rewritten.sort();

  const appliedAdditions = additions.map((tool) => tool.function.name);
  const tools = appliedAdditions.length ? [...catalog.tools, ...additions] : catalog.tools;
  // 原目录为空时没有旧断点可保，直接把新末尾设为锚点。
  const anchorIndex =
    catalog.tools.length === 0 && tools.length > 0 ? tools.length - 1 : catalog.anchorIndex;

  return {
    catalog: {
      tools,
      anchorIndex,
      fingerprint: appliedAdditions.length ? fingerprintTools(tools) : catalog.fingerprint,
      delta: { added: appliedAdditions, removed, rewritten },
    },
    appliedAdditions,
  };
}
