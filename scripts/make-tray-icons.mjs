#!/usr/bin/env node
/**
 * 托盘图标：从 resources/icon.ico 原样复制完整 Logo 帧（16–64px）打包成
 * resources/tray/tray.ico。不做裁切、镜像、阈值或任何改绘。
 * 换 Logo 后先更新 resources/icon.ico，再运行本脚本。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appIcoPath = path.join(repoRoot, "resources", "icon.ico");
const outIcoPath = path.join(repoRoot, "resources", "tray", "tray.ico");
// Windows 托盘会用到的 100%–400% 小图标尺寸。
const SIZES = [16, 20, 24, 28, 32, 36, 40, 48, 56, 64];

function readEntries(file) {
  const data = fs.readFileSync(file);
  if (data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) {
    throw new Error(`${path.relative(repoRoot, file)} 不是 ICO`);
  }
  const count = data.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const width = data[at] || 256;
    const length = data.readUInt32LE(at + 8);
    const offset = data.readUInt32LE(at + 12);
    entries.push({
      width,
      directory: Buffer.from(data.subarray(at, at + 16)),
      data: Buffer.from(data.subarray(offset, offset + length)),
    });
  }
  return entries;
}

function pack(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;
    entry.directory.copy(header, at);
    header.writeUInt32LE(entry.data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([header, ...entries.map((entry) => entry.data)]);
}

function main() {
  const available = new Map(readEntries(appIcoPath).map((entry) => [entry.width, entry]));
  const entries = SIZES.map((size) => {
    const entry = available.get(size);
    if (!entry) throw new Error(`resources/icon.ico 缺少 ${size}px 帧`);
    return entry;
  });
  fs.mkdirSync(path.dirname(outIcoPath), { recursive: true });
  fs.writeFileSync(outIcoPath, pack(entries));
  console.log(`[make-tray-icons] resources/tray/tray.ico <- ${SIZES.join(", ")} px（原样复制自 icon.ico）`);
}

try {
  main();
} catch (error) {
  console.error("[make-tray-icons]", error);
  process.exitCode = 1;
}
