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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "resources", "icon.png");
const outPath = path.join(repoRoot, "resources", "icon.ico");

// Windows 会按显示缩放请求的小/大图标尺寸（100%–400%，含 125%/150% 等）。
const SIZES = [16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 128, 256];

const PNG = (() => {
  const require = createRequire(path.join(repoRoot, "node_modules", "png-to-ico", "index.js"));
  // pnpm 下 png-to-ico 是软链，按其真实路径解析兄弟依赖 pngjs。
  return createRequire(fs.realpathSync(require.resolve("png-to-ico")))("pngjs").PNG;
})();

function lanczos(x) {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

/** Lanczos3，RGBA 预乘后重采样，保留完整 Logo，透明圆角不会出现黑边。 */
function resample(src, size) {
  const sw = src.width;
  const sh = src.height;
  const scale = size / sw;
  const support = 3 / scale;
  const sr = new Float32Array(sw * sh);
  const sg = new Float32Array(sw * sh);
  const sb = new Float32Array(sw * sh);
  const sa = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    const a = src.data[i * 4 + 3] / 255;
    sa[i] = a;
    sr[i] = src.data[i * 4] * a;
    sg[i] = src.data[i * 4 + 1] * a;
    sb[i] = src.data[i * 4 + 2] * a;
  }

  const weights = (dest, sourceLength) => {
    const center = (dest + 0.5) / scale - 0.5;
    const start = Math.max(0, Math.floor(center - support));
    const end = Math.min(sourceLength - 1, Math.ceil(center + support));
    const list = [];
    let sum = 0;
    for (let i = start; i <= end; i++) {
      const w = lanczos((i - center) * scale);
      if (w !== 0) {
        list.push([i, w]);
        sum += w;
      }
    }
    for (const item of list) item[1] /= sum;
    return list;
  };

  const hr = new Float32Array(size * sh);
  const hg = new Float32Array(size * sh);
  const hb = new Float32Array(size * sh);
  const ha = new Float32Array(size * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sx, w] of weights(x, sw)) {
        const si = y * sw + sx;
        r += sr[si] * w;
        g += sg[si] * w;
        b += sb[si] * w;
        a += sa[si] * w;
      }
      const di = y * size + x;
      hr[di] = r;
      hg[di] = g;
      hb[di] = b;
      ha[di] = a;
    }
  }

  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sy, w] of weights(y, sh)) {
        const si = sy * size + x;
        r += hr[si] * w;
        g += hg[si] * w;
        b += hb[si] * w;
        a += ha[si] * w;
      }
      const di = (y * size + x) * 4;
      a = Math.max(0, Math.min(1, a));
      if (a <= 0.0001) {
        out.data[di] = 0;
        out.data[di + 1] = 0;
        out.data[di + 2] = 0;
        out.data[di + 3] = 0;
      } else {
        out.data[di] = Math.round(Math.max(0, Math.min(255, r / a)));
        out.data[di + 1] = Math.round(Math.max(0, Math.min(255, g / a)));
        out.data[di + 2] = Math.round(Math.max(0, Math.min(255, b / a)));
        out.data[di + 3] = Math.round(a * 255);
      }
    }
  }
  return out;
}

async function main() {
  const src = PNG.sync.read(fs.readFileSync(sourcePath));
  if (src.width !== src.height) {
    throw new Error(`resources/icon.png 必须是正方形，当前 ${src.width}x${src.height}`);
  }
  const pngs = SIZES.map((size) => PNG.sync.write(resample(src, size)));
  fs.writeFileSync(outPath, await pngToIco(pngs));
  console.log(`[make-app-icon] resources/icon.ico <- ${SIZES.join(", ")} px（完整 Logo）`);
}

main().catch((error) => {
  console.error("[make-app-icon]", error);
  process.exitCode = 1;
});
