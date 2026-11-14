/**
 * 生成 Inno Setup 向导品牌图（resources/）。
 *
 * 输入：resources/installer-wizard-src.png（桌面版猫头图，用户提供）
 * 输出：
 *   resources/installer-wizard.bmp       164×314 24bpp（Inno 向导左侧竖图）
 *   resources/installer-wizard-small.bmp 55×58  24bpp（向导右上小图）
 *
 * installer.iss 通过 WizardImageFile / WizardSmallImageFile 引用；
 * 改了源图后跑 `node scripts/make-installer-assets.mjs` 重新生成。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPng, readPng, writePng } from "./lib/icon-png.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readPng(path.join(root, "resources", "installer-wizard-src.png"));

/** 双线性缩放（预乘 alpha），保持比例不失真。 */
function resize(src, width, height) {
  const out = createPng(width, height);
  for (let y = 0; y < height; y += 1) {
    const sy = ((y + 0.5) * src.height) / height - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < width; x += 1) {
      const sx = ((x + 0.5) * src.width) / width - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = Math.max(0, Math.min(1, sx - x0));
      const at = (px, py) => (py * src.width + px) * 4;
      const sample = (channel) => {
        const a = at(x0, y0) + channel;
        const b = at(x1, y0) + channel;
        const c = at(x0, y1) + channel;
        const d = at(x1, y1) + channel;
        const top = src.data[a] * (1 - wx) + src.data[b] * wx;
        const bottom = src.data[c] * (1 - wx) + src.data[d] * wx;
        return top * (1 - wy) + bottom * wy;
      };
      const index = (y * width + x) * 4;
      out.data[index] = Math.round(sample(0));
      out.data[index + 1] = Math.round(sample(1));
      out.data[index + 2] = Math.round(sample(2));
      out.data[index + 3] = Math.round(sample(3));
    }
  }
  return out;
}

/** 24bpp BMP 编码（自底向上、行按 4 字节对齐），不透明图直接 BGR 排列。 */
function encodeBmp(png) {
  const rowSize = Math.ceil((png.width * 3) / 4) * 4;
  const pixelBytes = rowSize * png.height;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(54 + pixelBytes, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(png.width, 18);
  buffer.writeInt32LE(png.height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeInt32LE(2835, 38);
  buffer.writeInt32LE(2835, 42);
  for (let y = 0; y < png.height; y += 1) {
    const rowStart = 54 + (png.height - 1 - y) * rowSize;
    for (let x = 0; x < png.width; x += 1) {
      const s = (y * png.width + x) * 4;
      const offset = rowStart + x * 3;
      buffer[offset] = png.data[s + 2];
      buffer[offset + 1] = png.data[s + 1];
      buffer[offset + 2] = png.data[s];
    }
  }
  return buffer;
}

const outputs = [
  ["installer-wizard.bmp", resize(source, 164, 314)],
  ["installer-wizard-small.bmp", resize(source, 55, 58)],
];

for (const [name, png] of outputs) {
  fs.writeFileSync(path.join(root, "resources", name), encodeBmp(png));
  console.log(`${name} ${png.width}x${png.height}`);
}
