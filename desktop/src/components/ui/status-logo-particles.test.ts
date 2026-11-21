import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusLogoParticles } from "./StatusLogoParticles";
import {
  CYCLE_MS,
  PARTICLE_COUNT,
  cycleMorphAt,
  mapMaskToTargets,
  morphDots,
  sampleCatMask,
  sphereDots,
  type CatMask,
} from "./status-logo-particles";

function rgba(
  width: number,
  height: number,
  alphaAt: (x: number, y: number) => number,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = alphaAt(x, y);
    }
  }
  return data;
}

function maskOf(points: Array<readonly [number, number]>): CatMask {
  return { points, grid: 20 };
}

describe("sampleCatMask", () => {
  it("全透明返回空点集", () => {
    const mask = sampleCatMask(rgba(24, 24, () => 0), 24, 24);
    expect(mask.points).toHaveLength(0);
  });

  it("实心方块最多输出 maxPoints 个点，且都落在 viewBox 留白内", () => {
    const mask = sampleCatMask(rgba(40, 40, () => 255), 40, 40);
    expect(mask.points.length).toBeGreaterThan(0);
    expect(mask.points.length).toBeLessThanOrEqual(96);
    for (const [x, y] of mask.points) {
      expect(x).toBeGreaterThanOrEqual(2);
      expect(x).toBeLessThanOrEqual(18);
      expect(y).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThanOrEqual(18);
    }
  });

  it("轮廓优先：点数只够轮廓时不会选内部格", () => {
    // 20x20 全填充，轮廓正好 76 格
    const mask = sampleCatMask(rgba(40, 40, () => 255), 40, 40, { maxPoints: 76 });
    expect(mask.points).toHaveLength(76);
    for (const [x, y] of mask.points) {
      const onBorder = x < 2.6 || x > 17.4 || y < 2.6 || y > 17.4;
      expect(onBorder).toBe(true);
    }
  });

  it("按 bbox 等比居中，不因原图偏移而贴边", () => {
    // 右半部分不透明：归一化后应落在 viewBox 中间
    const mask = sampleCatMask(rgba(40, 40, (x) => (x >= 20 ? 255 : 0)), 40, 40);
    expect(mask.points.length).toBeGreaterThan(0);
    const xs = mask.points.map(([x]) => x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    expect(minX).toBeGreaterThan(5);
    expect(maxX).toBeLessThan(15);
    expect((minX + maxX) / 2).toBeCloseTo(10, 0);
  });

  it("非整除尺寸不崩溃", () => {
    const mask = sampleCatMask(rgba(37, 41, () => 255), 37, 41);
    expect(mask.points.length).toBeGreaterThan(0);
    for (const [x, y] of mask.points) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});

describe("mapMaskToTargets", () => {
  it("把点均摊到粒子上，其余位置为 null", () => {
    const targets = mapMaskToTargets(maskOf([[1, 1], [2, 2], [3, 3], [4, 4]]), 8);
    expect(targets).toHaveLength(8);
    expect(targets.filter(Boolean)).toHaveLength(4);
    expect(targets[0]).toEqual([1, 1]);
    expect(targets[2]).toEqual([2, 2]);
    expect(targets[4]).toEqual([3, 3]);
    expect(targets[6]).toEqual([4, 4]);
  });

  it("空点集全部为 null", () => {
    expect(mapMaskToTargets(maskOf([]), 4)).toEqual([null, null, null, null]);
  });
});

describe("sphereDots / morphDots", () => {
  it("球体只显示每 3 个点中的 1 个，坐标在球半径内", () => {
    const dots = sphereDots(PARTICLE_COUNT, 0.7);
    expect(dots).toHaveLength(PARTICLE_COUNT);
    dots.forEach((dot, index) => {
      expect(dot.x).toBeGreaterThanOrEqual(1.5);
      expect(dot.x).toBeLessThanOrEqual(18.5);
      expect(dot.y).toBeGreaterThanOrEqual(1.5);
      expect(dot.y).toBeLessThanOrEqual(18.5);
      if (index % 3 !== 0) expect(dot.opacity).toBe(0);
    });
  });

  it("progress=1 时有目标的粒子落在猫头点、其余透明", () => {
    const sphere = sphereDots(PARTICLE_COUNT, 0);
    const targets = mapMaskToTargets(maskOf([[10, 4]]), PARTICLE_COUNT);
    const frame = morphDots(sphere, targets, 1);
    expect(frame[0]?.x).toBeCloseTo(10, 5);
    expect(frame[0]?.y).toBeCloseTo(4, 5);
    expect(frame[0]?.opacity).toBeCloseTo(1, 5);
    expect(frame[1]?.opacity).toBe(0);
  });

  it("中间帧有限且不越界", () => {
    const sphere = sphereDots(PARTICLE_COUNT, 0.4);
    const targets = mapMaskToTargets(maskOf([[4, 4], [16, 16]]), PARTICLE_COUNT);
    const frame = morphDots(sphere, targets, 0.5);
    expect(frame).toHaveLength(PARTICLE_COUNT);
    for (const dot of frame) {
      expect(Number.isFinite(dot.x)).toBe(true);
      expect(Number.isFinite(dot.y)).toBe(true);
      expect(dot.opacity).toBeGreaterThanOrEqual(0);
      expect(dot.opacity).toBeLessThanOrEqual(1);
    }
  });
});

describe("cycleMorphAt", () => {
  it("按 ZCode 的 8.24 秒节奏切换", () => {
    expect(cycleMorphAt(0)).toBe(0);
    expect(cycleMorphAt(4_999)).toBe(0);
    expect(cycleMorphAt(5_000)).toBe(0);
    expect(cycleMorphAt(6_296)).toBeCloseTo(1, 5);
    expect(cycleMorphAt(7_160)).toBeCloseTo(1, 5);
    expect(cycleMorphAt(7_952)).toBeCloseTo(0, 5);
    expect(cycleMorphAt(8_240)).toBe(0);
    expect(cycleMorphAt(CYCLE_MS * 2 + 6_296)).toBeCloseTo(1, 5);
  });
});

describe("StatusLogoParticles", () => {
  it("静态渲染 96 个圆点并隐藏无障碍信息", () => {
    const html = renderToStaticMarkup(createElement(StatusLogoParticles));
    expect(html.match(/<circle/g)).toHaveLength(PARTICLE_COUNT);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('viewBox="0 0 20 20"');
  });
});
