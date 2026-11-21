/**
 * 状态行 Logo 粒子：思考球与猫头点阵之间的定时形变。
 *
 * 参考 ZCode 的 ChatLoadingOrbs：同一批点在 Fibonacci 球与目标点阵之间插值，
 * 逐点错峰 + 沿法线弧线侧移 + opacity 交叉，不做重采样，也不引入第三方粒子库。
 * 这里的猫头目标点来自 logo-cat.webp 的 alpha 轮廓（见 sampleCatMask）。
 */

export type Dot = {
  x: number;
  y: number;
  opacity: number;
};

export type CatMask = {
  /** 归一化到 0..20 viewBox 的猫头点 */
  points: ReadonlyArray<readonly [number, number]>;
  grid: number;
};

export type CatMaskOptions = {
  grid?: number;
  alphaThreshold?: number;
  coverageThreshold?: number;
  maxPoints?: number;
  padding?: number;
};

export const VIEWBOX_SIZE = 20;
export const PARTICLE_COUNT = 96;
export const ORB_RADIUS = 8.5;
export const DOT_RADIUS = 0.5;

export const CYCLE_MS = 8_240;
export const SPHERE_HOLD_MS = 5_000;
export const MORPH_MS = 1_296;
export const LOGO_HOLD_MS = 864;
export const BACK_MS = 792;

export const CAT_GRID = 20;
export const CAT_ALPHA_THRESHOLD = 24;
export const CAT_COVERAGE_THRESHOLD = 0.32;
export const CAT_MAX_POINTS = PARTICLE_COUNT;
export const CAT_PADDING = 2;

type Cell = { gx: number; gy: number };

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function cubicInOut(value: number): number {
  const t = clamp01(value);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 当前周期内的形变进度：0=球体，1=猫头。 */
export function cycleMorphAt(elapsedMs: number): number {
  const t = ((elapsedMs % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  if (t < SPHERE_HOLD_MS) return 0;
  if (t < SPHERE_HOLD_MS + MORPH_MS) {
    return cubicInOut((t - SPHERE_HOLD_MS) / MORPH_MS);
  }
  const logoStart = SPHERE_HOLD_MS + MORPH_MS;
  if (t < logoStart + LOGO_HOLD_MS) return 1;
  const backStart = logoStart + LOGO_HOLD_MS;
  if (t < backStart + BACK_MS) {
    return 1 - cubicInOut((t - backStart) / BACK_MS);
  }
  return 0;
}

/** Fibonacci 均匀球，绕 Y 轴旋转；只让每 3 个点里的 1 个可见，形成稀疏点云。 */
export function sphereDots(count: number, angleRad: number): Dot[] {
  const dots: Dot[] = [];
  const total = Math.max(1, count);
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  for (let index = 0; index < total; index += 1) {
    const y = 1 - (index / (total - 1 || 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = Math.PI * (3 - Math.sqrt(5)) * index;
    const sx = Math.cos(theta) * radius;
    const sz = Math.sin(theta) * radius;
    const depth = (-sx * sin + sz * cos + 1) / 2;
    dots.push({
      x: VIEWBOX_SIZE / 2 + ORB_RADIUS * (sx * cos + sz * sin),
      y: VIEWBOX_SIZE / 2 - ORB_RADIUS * y,
      opacity: index % 3 === 0 ? 0.35 + 0.6 * depth : 0,
    });
  }
  return dots;
}

/** 把猫头点均摊到粒子上；没有目标的粒子保持球体位置、透明度收敛到 0。 */
export function mapMaskToTargets(
  mask: CatMask,
  count = PARTICLE_COUNT,
): Array<readonly [number, number] | null> {
  const targets: Array<readonly [number, number] | null> = Array.from(
    { length: count },
    () => null,
  );
  const points = mask.points;
  if (!points.length || count <= 0) return targets;
  for (let index = 0; index < points.length; index += 1) {
    const slot = Math.floor((index * count) / points.length);
    if (slot < count) targets[slot] = points[index];
  }
  return targets;
}

/** 从当前球体帧形变到猫头目标；progress=1 时只有有目标的粒子可见。 */
export function morphDots(
  from: readonly Dot[],
  targets: ReadonlyArray<readonly [number, number] | null>,
  progress: number,
): Dot[] {
  const eased = cubicInOut(progress);
  const count = from.length;
  return from.map((dot, index) => {
    const target = targets[index] ?? null;
    const stagger =
      eased === 0 || eased === 1
        ? eased
        : Math.max(0, Math.min(1, eased + (index / count - 0.5) * 0.06));
    if (!target) {
      return { x: dot.x, y: dot.y, opacity: dot.opacity * (1 - stagger) };
    }
    const dx = target[0] - dot.x;
    const dy = target[1] - dot.y;
    const length = Math.hypot(dx, dy) || 1;
    const arc = Math.sin(Math.PI * stagger) * 0.45 * (index % 2 ? 1 : -1);
    return {
      x: dot.x + dx * stagger - (dy / length) * arc,
      y: dot.y + dy * stagger + (dx / length) * arc,
      opacity: dot.opacity + (1 - dot.opacity) * stagger,
    };
  });
}

/**
 * 从 RGBA 像素缓冲采样猫头轮廓点。
 *
 * 先按网格聚合 alpha 覆盖率，取不透明 bbox 并等比居中到 [padding, 20-padding]；
 * 轮廓格（四邻域存在空格）优先，不足 maxPoints 再按扫描顺序均匀补内部格，
 * 避免 16px 下变成一坨实心白块。
 */
export function sampleCatMask(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: CatMaskOptions = {},
): CatMask {
  const grid = Math.max(1, Math.min(64, Math.round(options.grid ?? CAT_GRID)));
  const alphaThreshold = Math.max(0, options.alphaThreshold ?? CAT_ALPHA_THRESHOLD);
  const coverageThreshold = clamp01(options.coverageThreshold ?? CAT_COVERAGE_THRESHOLD);
  const maxPoints = Math.max(1, Math.round(options.maxPoints ?? CAT_MAX_POINTS));
  const padding = Math.max(0, options.padding ?? CAT_PADDING);
  if (!width || !height || !rgba.length) return { points: [], grid };

  const filled: boolean[][] = Array.from({ length: grid }, () =>
    Array.from({ length: grid }, () => false),
  );
  const cells: Cell[] = [];
  for (let gy = 0; gy < grid; gy += 1) {
    const y0 = Math.floor((gy * height) / grid);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor(((gy + 1) * height) / grid)));
    for (let gx = 0; gx < grid; gx += 1) {
      const x0 = Math.floor((gx * width) / grid);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor(((gx + 1) * width) / grid)));
      let hits = 0;
      let total = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          total += 1;
          if ((rgba[(y * width + x) * 4 + 3] ?? 0) >= alphaThreshold) hits += 1;
        }
      }
      if (total > 0 && hits / total >= coverageThreshold) {
        filled[gy][gx] = true;
        cells.push({ gx, gy });
      }
    }
  }
  if (!cells.length) return { points: [], grid };

  let minX = grid;
  let minY = grid;
  let maxX = 0;
  let maxY = 0;
  for (const cell of cells) {
    minX = Math.min(minX, cell.gx);
    minY = Math.min(minY, cell.gy);
    maxX = Math.max(maxX, cell.gx);
    maxY = Math.max(maxY, cell.gy);
  }

  const isFilled = (gx: number, gy: number) =>
    gx >= 0 && gy >= 0 && gx < grid && gy < grid && filled[gy][gx];
  const outline = cells.filter(
    (cell) =>
      !isFilled(cell.gx - 1, cell.gy) ||
      !isFilled(cell.gx + 1, cell.gy) ||
      !isFilled(cell.gx, cell.gy - 1) ||
      !isFilled(cell.gx, cell.gy + 1),
  );
  let selected: Cell[];
  if (outline.length >= maxPoints) {
    selected = [];
    const step = outline.length / maxPoints;
    for (let index = 0; index < maxPoints; index += 1) {
      selected.push(outline[Math.floor(index * step)]);
    }
  } else {
    selected = [...outline];
    // 内部点按扫描顺序均匀抽取，避免伪随机哈希退化成线性、把点全堆在一侧
    const needed = maxPoints - selected.length;
    const interior = cells.filter((cell) => !outline.includes(cell));
    if (needed > 0 && interior.length > 0) {
      const step = interior.length / needed;
      for (let index = 0; index < needed; index += 1) {
        const cell = interior[Math.floor(index * step)];
        if (cell) selected.push(cell);
      }
    }
  }

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const inner = Math.max(1, VIEWBOX_SIZE - padding * 2);
  const scale = Math.min(inner / bboxW, inner / bboxH);
  const offsetX = (VIEWBOX_SIZE - bboxW * scale) / 2;
  const offsetY = (VIEWBOX_SIZE - bboxH * scale) / 2;
  const points = selected.map(
    (cell) =>
      [
        offsetX + (cell.gx - minX + 0.5) * scale,
        offsetY + (cell.gy - minY + 0.5) * scale,
      ] as const,
  );
  return { points, grid };
}
