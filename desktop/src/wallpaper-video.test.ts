import { describe, expect, it } from "vitest";
import {
  wallpaperLoopFadeSeconds,
  wallpaperVideoDrift,
  wallpaperVideoLooped,
  wallpaperVideoNeedsSync,
} from "./wallpaper-video";

describe("wallpaperVideoDrift", () => {
  it("普通漂移保留正负方向", () => {
    expect(wallpaperVideoDrift(3, 2.9, 10)).toBeCloseTo(0.1);
    expect(wallpaperVideoDrift(2.9, 3, 10)).toBeCloseTo(-0.1);
  });

  it("循环视频跨过结尾时折算到最短时间差", () => {
    expect(wallpaperVideoDrift(0.02, 4.99, 5)).toBeCloseTo(0.03);
    expect(wallpaperVideoDrift(4.99, 0.02, 5)).toBeCloseTo(-0.03);
  });

  it("时长未知时不折算", () => {
    expect(wallpaperVideoDrift(0.02, 4.99, Number.NaN)).toBeCloseTo(-4.97);
  });
});

describe("wallpaperVideoNeedsSync", () => {
  it("超过容差才需要重新对齐", () => {
    expect(wallpaperVideoNeedsSync(0.04, 0, 30, 0.05)).toBe(false);
    expect(wallpaperVideoNeedsSync(0.06, 0, 30, 0.05)).toBe(true);
  });

  it("跨循环边界的漂移按最短路径判断", () => {
    expect(wallpaperVideoNeedsSync(0.02, 4.99, 5, 0.05)).toBe(false);
    expect(wallpaperVideoNeedsSync(0.02, 4.9, 5, 0.05)).toBe(true);
  });
});

describe("wallpaperLoopFadeSeconds", () => {
  it("按时长 8% 取，限制在 120–600ms", () => {
    expect(wallpaperLoopFadeSeconds(10)).toBeCloseTo(0.6);
    expect(wallpaperLoopFadeSeconds(3)).toBeCloseTo(0.24);
    expect(wallpaperLoopFadeSeconds(0.5)).toBeCloseTo(0.12);
  });

  it("时长未知时不淡化", () => {
    expect(wallpaperLoopFadeSeconds(Number.NaN)).toBe(0);
    expect(wallpaperLoopFadeSeconds(0)).toBe(0);
  });
});

describe("wallpaperVideoLooped", () => {
  it("回到开头算跨过接缝", () => {
    expect(wallpaperVideoLooped(9.95, 0.02, 10)).toBe(true);
    expect(wallpaperVideoLooped(0.5, 0.05, 10)).toBe(true);
  });

  it("正常前进不算回绕", () => {
    expect(wallpaperVideoLooped(5, 5.1, 10)).toBe(false);
    expect(wallpaperVideoLooped(9.9, 9.95, 10)).toBe(false);
  });

  it("时间未知时不算回绕", () => {
    expect(wallpaperVideoLooped(Number.NaN, 0, 10)).toBe(false);
    expect(wallpaperVideoLooped(1, Number.NaN, 10)).toBe(false);
  });
});
