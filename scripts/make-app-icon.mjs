#!/usr/bin/env node
/**
 * 应用图标（exe / 任务管理器 / 任务栏）：始终从 resources/icon.png 的完整 Logo
 * 按每个 DPI 尺寸单独渲染，不做裁切、镜像、阈值或任何改绘。
 * Windows 125% 缩放会请求 20px（原 icon.ico 缺这个尺寸，导致图标被放大发糊）。
 * 生成后运行 node scripts/make-tray-icons.mjs，再完全退出应用并运行
 * node scripts/brand-electron.mjs --force 重打 exe。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import { encodePng, readPng, resample } from "./lib/icon-png.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "resources", "icon.png");
const outPath = path.join(repoRoot, "resources", "icon.ico");

// Windows 会按显示缩放请求的小/大图标尺寸（100%–400%，含 125%/150% 等）。
const SIZES = [16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 128, 256];

async function main() {
  const src = readPng(sourcePath);
  if (src.width !== src.height) {
    throw new Error(`resources/icon.png 必须是正方形，当前 ${src.width}x${src.height}`);
  }
  const pngs = SIZES.map((size) => encodePng(resample(src, size)));
  fs.writeFileSync(outPath, await pngToIco(pngs));
  console.log(`[make-app-icon] resources/icon.ico <- ${SIZES.join(", ")} px（完整 Logo）`);
}

main().catch((error) => {
  console.error("[make-app-icon]", error);
  process.exitCode = 1;
});
