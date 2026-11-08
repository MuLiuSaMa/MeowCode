/**
 * 图标重采样：resources/icon.png → 指定尺寸 PNG。
 *
 * Lanczos3 + RGBA 预乘后重采样：完整 Logo 不做裁切/镜像/改绘，小尺寸也不会
 * 出现透明边发黑。ICO（exe/任务栏）与 MSIX 商店资源图共用同一套实现。
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PNG = (() => {
  // pnpm 下 png-to-ico 是软链，按其真实路径解析兄弟依赖 pngjs。
  const pngToIcoPath = require.resolve("png-to-ico");
  return createRequire(fs.realpathSync(pngToIcoPath))("pngjs").PNG;
})();

export function readPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

export function createPng(width, height) {
  return new PNG({ width, height });
}

export function encodePng(png) {
  return PNG.sync.write(png);
}

export function writePng(filePath, png) {
  fs.writeFileSync(filePath, encodePng(png));
}

function lanczos(x) {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

/** 方形重采样（源图必须是正方形）。 */
export function resample(src, size) {
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
