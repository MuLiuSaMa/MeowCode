#!/usr/bin/env node
/**
 * 生成微软商店（MSIX）需要的图片资源：resources/appx/*.png
 *
 * 尺寸按 AppxManifest 的资源清单（正方形瓦片 + 商店 Logo），全部由
 * resources/icon.png 用同一套 Lanczos 重采样得到，不做裁切或改绘。
 * 换了 Logo 之后重跑一次即可：
 *   node scripts/make-msix-assets.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPng, readPng, resample, writePng } from "./lib/icon-png.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "resources", "icon.png");
const outDir = path.join(repoRoot, "resources", "appx");

/** 文件名与像素尺寸必须与 AppxManifest 的引用一致（electron-builder 按文件名映射）。 */
const ASSETS = {
  "Square44x44Logo.png": 44,
  "Square150x150Logo.png": 150,
  "StoreLogo.png": 50,
};

/** 宽瓦片 310x150：Logo 等比缩到 132px 居中，四周留透明安全区。 */
function wideTile(src) {
  const width = 310;
  const height = 150;
  const iconSize = 132;
  const canvas = createPng(width, height);
  const icon = resample(src, iconSize);
  const offsetX = Math.floor((width - iconSize) / 2);
  const offsetY = Math.floor((height - iconSize) / 2);
  for (let y = 0; y < iconSize; y++) {
    for (let x = 0; x < iconSize; x++) {
      const from = (y * iconSize + x) * 4;
      const to = ((offsetY + y) * width + offsetX + x) * 4;
      canvas.data[to] = icon.data[from];
      canvas.data[to + 1] = icon.data[from + 1];
      canvas.data[to + 2] = icon.data[from + 2];
      canvas.data[to + 3] = icon.data[from + 3];
    }
  }
  return canvas;
}

function main() {
  const src = readPng(sourcePath);
  if (src.width !== src.height) {
    throw new Error(`resources/icon.png 必须是正方形，当前 ${src.width}x${src.height}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, size] of Object.entries(ASSETS)) {
    writePng(path.join(outDir, name), resample(src, size));
    console.log(`[make-msix-assets] ${name} <- ${size}x${size}`);
  }
  writePng(path.join(outDir, "Wide310x150Logo.png"), wideTile(src));
  console.log("[make-msix-assets] Wide310x150Logo.png <- 310x150（132px 居中）");
}

try {
  main();
} catch (error) {
  console.error("[make-msix-assets]", error);
  process.exitCode = 1;
}
