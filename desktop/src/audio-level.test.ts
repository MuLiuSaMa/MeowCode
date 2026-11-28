import { describe, expect, it } from "vitest";
import { BAND_COUNT, bandEdges, bandLevels, normalizeBands, smoothBand } from "./audio-level";

describe("bandEdges", () => {
  const edges = bandEdges(512, BAND_COUNT);

  it("产出指定数量的频段，落在 1..maxBin 内且互不重叠", () => {
    expect(edges).toHaveLength(BAND_COUNT);
    let prevHi = 1;
    for (const [lo, hi] of edges) {
      expect(lo).toBeGreaterThanOrEqual(prevHi);
      expect(hi).toBeGreaterThan(lo);
      expect(hi).toBeLessThanOrEqual(Math.floor(512 * 0.8));
      prevHi = hi;
    }
  });

  it("低频段窄、高频段宽（对数分布）", () => {
    const first = edges[0][1] - edges[0][0];
    const last = edges[BAND_COUNT - 1][1] - edges[BAND_COUNT - 1][0];
    expect(last).toBeGreaterThan(first * 4);
  });
});

describe("bandLevels", () => {
  it("能量集中在低频时只有低频段有电平，高频段为 0", () => {
    const data = new Uint8Array(512);
    data[1] = 255; // bin 1 在第一个频段里
    const out = new Float32Array(BAND_COUNT);
    bandLevels(data, bandEdges(512, BAND_COUNT), out);
    expect(out[0]).toBeGreaterThan(0.9);
    expect(out[BAND_COUNT - 1]).toBe(0);
  });

  it("满幅信号钳到 1，高频补偿不会越界", () => {
    const data = new Uint8Array(512).fill(255);
    const out = new Float32Array(BAND_COUNT);
    bandLevels(data, bandEdges(512, BAND_COUNT), out);
    for (const value of out) expect(value).toBe(1);
  });
});

describe("normalizeBands", () => {
  it("峰值上行立即跟随：响的时候立刻按新峰归一化", () => {
    const raw = new Float32Array([0.8, 0.4, 0.2]);
    const out = new Float32Array(3);
    const peak = normalizeBands(raw, 0.15, out);
    expect(peak).toBeCloseTo(0.8, 6); // raw 是 Float32Array，0.8 有 1e-8 量级的存储误差
    expect(out[0]).toBeCloseTo(1, 10); // 顶满，只有真峰值才到 1
    expect(out[1]).toBeCloseTo(Math.pow(0.5, 1.3), 6);
  });

  it("峰值下行慢衰（每帧 ×0.995）：安静下来后刻度逐渐回落而不是瞬间归零", () => {
    const raw = new Float32Array([0.3, 0.1, 0.05]);
    const out = new Float32Array(3);
    const peak = normalizeBands(raw, 0.8, out);
    expect(peak).toBeCloseTo(0.8 * 0.995, 10);
    expect(out[0]).toBeCloseTo(Math.pow(Math.min(1, 0.3 / peak), 1.3), 6);
  });

  it("静音不放大底噪：峰值钳在地板上，电平为 0", () => {
    const raw = new Float32Array(3);
    const out = new Float32Array(3);
    const peak = normalizeBands(raw, 0.15, out);
    expect(peak).toBeCloseTo(0.15, 10);
    for (const value of out) expect(value).toBe(0);
  });
});

describe("smoothBand", () => {
  it("起音快（跳动干脆）", () => {
    expect(smoothBand(0, 1)).toBeCloseTo(0.6, 10);
  });

  it("收音稍慢（不闪烁）", () => {
    expect(smoothBand(1, 0)).toBeCloseTo(0.82, 10);
  });
});
