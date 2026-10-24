/**
 * 读状态跟踪：让 edit 知道"模型看到的这份内容是否还是最新的"。
 *
 * 只做**提示**，不做硬拦截：本地单会话单写者，硬拒（ZCode 的 FILE_NOT_READ）只会
 * 把一次编辑变成两次往返，反而更贵。真正的价值是在文件被外部改动过时告诉模型一句，
 * 避免它把改动打在旧内容上——那才是最贵的失败。
 *
 * 版本键 = inode:size:mtimeNs。只比 mtime 会被"改完又改回来"骗过；加上 inode
 * （原子替换会换 inode）和纳秒级 mtime，才能识别"同大小、同秒级时间"的替换。
 */

import { promises as fs } from "node:fs";

type FileState = { key: string; mtimeMs: number; size: number };

const states = new Map<string, FileState>();

async function statOf(file: string): Promise<FileState | null> {
  try {
    const info = await fs.stat(file, { bigint: true });
    return {
      key: `${info.ino}:${info.size}:${info.mtimeNs}`,
      mtimeMs: Number(info.mtimeNs / 1_000_000n),
      size: Number(info.size),
    };
  } catch {
    return null;
  }
}

/** 文件当前版本的稳定标识；不存在时返回 "absent"。 */
export async function captureVersion(file: string): Promise<string> {
  const state = await statOf(file);
  return state ? state.key : "absent";
}

/** read_file 成功后登记，作为"模型看过这一版"的基准。 */
export async function recordRead(file: string): Promise<void> {
  const state = await statOf(file);
  if (state) states.set(file, state);
}

/** 编辑/写入成功后刷新，模型无需再读一次就能继续编辑。 */
export async function recordWrite(file: string): Promise<void> {
  const state = await statOf(file);
  if (state) states.set(file, state);
  else states.delete(file);
}

/** 自上次读取后文件是否被外部改动（没读过则视为未改动，不打扰模型）。 */
export async function changedSinceRead(file: string): Promise<boolean> {
  const previous = states.get(file);
  if (!previous) return false;
  const current = await statOf(file);
  if (!current) return true;
  return current.key !== previous.key;
}

export function forget(file: string): void {
  states.delete(file);
}
