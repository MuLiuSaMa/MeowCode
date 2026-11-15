/**
 * 生成 Inno Setup 向导品牌图（resources/）。
 *
 * 输入：resources/installer-wizard-src.png（桌面版猫头图，用户提供，带透明通道）
 * 输出：
 *   resources/installer-wizard-{dpi}.png        按 DPI 档位的大图（164:314）
 *   resources/installer-wizard-small-{dpi}.png  按 DPI 档位右上角小图
 *
 * 为什么要按档位出图：Inno 会把单张图拉伸到当前 DPI 的图像区，100% 的
 * 164×314 在 150% 下放大后锯齿明显。WizardImageFile 支持逗号分隔多张，
 * Setup 会自动挑最接近的一档。
 *
 * 为什么用 PNG 而不是 BMP：源图带 alpha，24bpp BMP 编码会把透明像素写成
 * 黑色（向导左侧出现一块黑底）。PNG 大图在脚本里直接合成品牌米色底，
 * 小图保留透明，让向导页的白色页头透过来。
 *
 * installer.iss 通过 WizardImageFile / WizardSmallImageFile 引用；
 * 改了源图后跑 `node scripts/make-installer-assets.mjs` 重新生成。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPng, readPng, resampleRect, writePng } from "./lib/icon-png.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readPng(path.join(root, "resources", "installer-wizard-src.png"));

// 向导大图 164:314；尺寸表取自 Inno 7 帮助（6.6+ 默认布局），Setup 按 DPI 挑最接近的一张
const LARGE = [
  [100, 202, 386],
  [125, 269, 515],
  [150, 336, 643],
  [175, 403, 772],
  [200, 430, 824],
  [225, 498, 953],
  [250, 534, 1022],
];
// 右上角小图，同样按 DPI 档位
const SMALL = [
  [100, 55, 55],
  [125, 64, 68],
  [150, 83, 80],
  [175, 92, 97],
  [200, 110, 106],
  [225, 119, 123],
  [250, 138, 140],
];

// 与 README 头图底色一致，避免大图区和向导页之间出现色块边界
const BACKDROP = [250, 243, 228];

/** 裁掉透明留白，只保留猫头本体（alpha > 8）。 */
function cropToContent(png) {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (png.data[(y * png.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return png;
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(png.width - 1, maxX + pad);
  maxY = Math.min(png.height - 1, maxY + pad);
  const out = createPng(maxX - minX + 1, maxY - minY + 1);
  const rowBytes = (maxX - minX + 1) * 4;
  for (let y = minY; y <= maxY; y += 1) {
    const from = (y * png.width + minX) * 4;
    out.data.set(png.data.subarray(from, from + rowBytes), (y - minY) * rowBytes);
  }
  return out;
}

/**
 * 等比放进目标画布：宽占 88%、高占 62%，居中。
 * backdrop 为 null 时保留透明底（小图），否则预乘合成到底色（大图）。
 */
function compose(src, width, height, backdrop) {
  const scale = Math.min((width * 0.88) / src.width, (height * 0.62) / src.height);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const art = resampleRect(src, w, h);
  const out = createPng(width, height);
  const x0 = Math.floor((width - w) / 2);
  const y0 = Math.floor((height - h) / 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const di = (y * width + x) * 4;
      const inside = x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
      const si = inside ? ((y - y0) * w + (x - x0)) * 4 : -1;
      const alpha = si >= 0 ? art.data[si + 3] / 255 : 0;
      const base = backdrop ?? [0, 0, 0];
      const baseAlpha = backdrop ? 1 : 0;
      const outAlpha = alpha + baseAlpha * (1 - alpha);
      if (outAlpha <= 0) continue;
      for (let c = 0; c < 3; c += 1) {
        const fg = si >= 0 ? art.data[si + c] : 0;
        out.data[di + c] = Math.round(
          (fg * alpha + base[c] * baseAlpha * (1 - alpha)) / outAlpha,
        );
      }
      out.data[di + 3] = Math.round(outAlpha * 255);
    }
  }
  return out;
}

const art = cropToContent(source);
for (const [dpi, width, height] of LARGE) {
  const file = path.join(root, "resources", `installer-wizard-${dpi}.png`);
  writePng(file, compose(art, width, height, BACKDROP));
  console.log(`${path.basename(file)} ${width}x${height}`);
}
for (const [dpi, width, height] of SMALL) {
  const file = path.join(root, "resources", `installer-wizard-small-${dpi}.png`);
  writePng(file, compose(art, width, height, null));
  console.log(`${path.basename(file)} ${width}x${height}`);
}