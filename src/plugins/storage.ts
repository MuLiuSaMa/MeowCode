import { promises as fs } from "node:fs";
import path from "node:path";
import type { PluginStorage } from "./types.js";

/** 插件 id → 文件名：只保留安全字符，避免路径穿越 */
function sanitizeId(pluginId: string): string {
  const safe = pluginId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "_";
}

/**
 * 每插件一个 JSON 文件：~/.meowcode/plugin-data/<pluginId>.json。
 * 整文件读写 + tmp/rename 原子替换；进程内缓存读，简单够用（插件量级很小）。
 */
export function createPluginStorage(pluginId: string, homeDir: string): PluginStorage {
  const file = path.join(homeDir, ".meowcode", "plugin-data", `${sanitizeId(pluginId)}.json`);
  let cache: Record<string, unknown> | null = null;

  async function read(): Promise<Record<string, unknown>> {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      cache = {};
    }
    return cache;
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const data = await read();
      return data[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      const data = await read();
      data[key] = value;
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await fs.rename(tmp, file);
    },
  };
}
