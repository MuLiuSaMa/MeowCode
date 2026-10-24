import { promises as fs } from "node:fs";
import path from "node:path";
import { parseMarkdownFrontmatter } from "./frontmatter.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginCommandInfo } from "./types.js";

export type MarkdownCommand = {
  name: string;
  description?: string;
  source: "project" | "user";
  path: string;
  body: string;
};

/**
 * 发现 markdown 斜杠命令：`<root>/.meowcode/commands/*.md`，文件名即命令名。
 * project 同名覆盖 user；解析失败的文件跳过。
 */
export async function discoverMarkdownCommands(
  roots: Array<{ dir: string; source: "project" | "user" }>,
): Promise<MarkdownCommand[]> {
  const byName = new Map<string, MarkdownCommand>();
  for (const { dir, source } of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const fileName of entries) {
      if (!fileName.toLowerCase().endsWith(".md")) continue;
      const full = path.join(dir, fileName);
      try {
        const info = await fs.stat(full);
        if (!info.isFile()) continue;
        const raw = await fs.readFile(full, "utf8");
        const { meta, body } = parseMarkdownFrontmatter(raw);
        if (!body) continue;
        const name = fileName.slice(0, -3);
        if (byName.has(name)) continue; // project 先扫 → 先到先得
        byName.set(name, {
          name,
          ...(meta.description ? { description: meta.description } : {}),
          source,
          path: full,
          body,
        });
      } catch {
        continue;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 展开命令模板：$ARGUMENTS 替换为参数；模板无占位符时参数追加为第二段 */
export function expandCommandTemplate(command: MarkdownCommand | { body: string }, args: string): string {
  const trimmedArgs = args.trim();
  if (command.body.includes("$ARGUMENTS")) {
    return command.body.replaceAll("$ARGUMENTS", trimmedArgs);
  }
  return trimmedArgs ? `${command.body}\n\nArguments: ${trimmedArgs}` : command.body;
}

/**
 * 命令索引：markdown 声明式（project>user）+ 插件代码式（registry）。
 * resolve("/deploy foo") 返回展开后的 prompt 文本；未命中斜杠命令返回 null（原样透传）。
 */
export type CommandIndex = {
  commands(): PluginCommandInfo[];
  resolve(text: string): Promise<string | null>;
};

export async function loadCommandIndex(options: {
  workspace: string;
  homeDir: string;
  registry: PluginRegistry;
}): Promise<CommandIndex> {
  const markdown = await discoverMarkdownCommands([
    { dir: path.join(options.workspace, ".meowcode", "commands"), source: "project" },
    { dir: path.join(options.homeDir, ".meowcode", "commands"), source: "user" },
  ]);
  const byName = new Map(markdown.map((cmd) => [cmd.name, cmd]));

  return {
    commands(): PluginCommandInfo[] {
      const items: PluginCommandInfo[] = [...byName.values()].map((cmd) => ({
        name: cmd.name,
        ...(cmd.description !== undefined ? { description: cmd.description } : {}),
        source: cmd.source,
      }));
      items.push(...options.registry.listCommands());
      return items;
    },
    async resolve(text: string): Promise<string | null> {
      const trimmed = text.trimStart();
      if (!trimmed.startsWith("/")) return null;
      const spaceIndex = trimmed.indexOf(" ");
      const name = spaceIndex < 0 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
      if (!name) return null;
      const args = spaceIndex < 0 ? "" : trimmed.slice(spaceIndex + 1);

      const mdCommand = byName.get(name);
      if (mdCommand) return expandCommandTemplate(mdCommand, args);

      const codeCommand = options.registry.getCommand(name);
      if (codeCommand) {
        const result = await codeCommand.cmd.run(args);
        return result;
      }
      return null;
    },
  };
}
