/** @文件补全面板的路径逻辑：目录作用域、token 拼接、条目组装。纯函数，便于测试。 */

export type MentionState = { query: string; start: number; end: number };

/** 目录的一条直接子项（服务端 /workspace/dir 的返回结构） */
export type MentionEntry = { name: string; path: string; dir: boolean };

/** 面板里的一行：`..` 返回上一层、目录（点进去）、文件（选中引用） */
export type MentionItem = { kind: "up" | "dir" | "file"; name: string; path: string };

/** 光标前的 @ 引用 token（只在词首触发，避免邮箱）。 */
export function detectMention(value: string, caret: number): MentionState | null {
  const match = value.slice(0, caret).match(/(?:^|[\s(（])@([^\s@]*)$/);
  if (!match) return null;
  const query = match[1];
  if (query.includes('"')) return null;
  return { query, start: caret - query.length - 1, end: caret };
}

/** 带空格的路径用引号包起来，服务端按 @"..." 解析。 */
export function mentionToken(file: string): string {
  return /\s/.test(file) ? `@"${file}"` : `@${file}`;
}

/** `src/a/b` → `src/a`；根目录返回空串。 */
export function parentDir(dir: string): string {
  const slash = dir.lastIndexOf("/");
  return slash > 0 ? dir.slice(0, slash) : "";
}

/** 目录导航用的 token：`@src/`，根目录是裸 `@`（后面直接接过滤词）。 */
export function mentionDirToken(dir: string): string {
  return dir ? `@${dir}/` : "@";
}

/**
 * 目录作用域直接从 query 推导：`@src/ap` 列 src/ 并用 "ap" 过滤。
 * 这样「手打路径」和「点目录项」走同一条路，不需要额外的导航状态，
 * 光标移进移出也能自然跟随。
 */
export function mentionScopeOf(query: string): { dir: string; filter: string } {
  const slash = query.lastIndexOf("/");
  return slash >= 0
    ? { dir: query.slice(0, slash), filter: query.slice(slash + 1) }
    : { dir: "", filter: query };
}

/**
 * 组装面板条目：`..` 排最前（键盘也能选到），其余保持服务端的目录优先 + 名字序。
 * 目录读取失败时 entries 是空数组，此时仍保留 `..`，否则用户没法退回去。
 */
export function buildMentionItems(
  entries: readonly MentionEntry[],
  dir: string,
  filter: string,
): MentionItem[] {
  const needle = filter.trim().toLowerCase();
  const items: MentionItem[] = dir ? [{ kind: "up", name: "..", path: parentDir(dir) }] : [];
  for (const entry of entries) {
    if (needle && !entry.name.toLowerCase().includes(needle)) continue;
    items.push({ kind: entry.dir ? "dir" : "file", name: entry.name, path: entry.path });
  }
  return items;
}
