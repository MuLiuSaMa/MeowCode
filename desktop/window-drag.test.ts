import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { dragBounds } = require("./window-drag.cjs") as {
  dragBounds: (
    bounds: { x: number; y: number; width: number; height: number },
    startCursor: { x: number; y: number },
    cursor: { x: number; y: number },
  ) => { x: number; y: number; width: number; height: number };
};

const BOUNDS = { x: 200, y: 120, width: 1320, height: 880 };

describe("window drag bounds", () => {
  it("moves the window by the cursor delta", () => {
    expect(dragBounds(BOUNDS, { x: 500, y: 500 }, { x: 560, y: 530 })).toEqual({
      x: 260,
      y: 150,
      width: 1320,
      height: 880,
    });
  });

  it("never changes the window size", () => {
    // 历史 bug：只调 setPosition 时尺寸会按 DIP↔像素往返取整漂移，
    // 拖动过程中窗口一直变大。宽高必须取自起拖快照。
    for (const cursor of [
      { x: 0, y: 0 },
      { x: -400, y: 900 },
      { x: 4321, y: 7 },
      { x: 2001.5, y: 88.25 },
    ]) {
      const next = dragBounds(BOUNDS, { x: 500, y: 500 }, cursor);
      expect(next.width).toBe(BOUNDS.width);
      expect(next.height).toBe(BOUNDS.height);
    }
  });

  it("is a pure translation: same delta from any starting point", () => {
    const other = { x: -80, y: 900, width: 960, height: 640 };
    const a = dragBounds(BOUNDS, { x: 10, y: 10 }, { x: 130, y: 40 });
    const b = dragBounds(other, { x: 10, y: 10 }, { x: 130, y: 40 });
    expect(a.x - BOUNDS.x).toBe(b.x - other.x);
    expect(a.y - BOUNDS.y).toBe(b.y - other.y);
  });

  it("returns the same rectangle when the cursor has not moved", () => {
    expect(dragBounds(BOUNDS, { x: 500, y: 500 }, { x: 500, y: 500 })).toEqual(BOUNDS);
  });
});
