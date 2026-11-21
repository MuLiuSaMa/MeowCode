import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type WallpaperItem = { kind: "image" | "video"; fileName: string };
type WallpaperValue = {
  items: WallpaperItem[];
  active: string;
  enabled: boolean;
  opacity: number;
  brightness: number;
  blur: number;
  uiOpacity: number;
  carousel: { enabled: boolean; intervalSec: number };
};

type WallpaperModule = {
  WALLPAPER_DEFAULT_TUNING: Record<string, number | boolean>;
  WALLPAPER_MAX_ITEMS: number;
  normalizeWallpaper: (raw: unknown) => WallpaperValue | null;
  wallpaperFile: (dir: string, name: string) => string;
  wallpaperResponse: (input: { dir: string; request: Request }) => Response;
};

const requireCjs = createRequire(import.meta.url);
const { WALLPAPER_MAX_ITEMS, normalizeWallpaper, wallpaperFile, wallpaperResponse } =
  requireCjs("./wallpaper.cjs") as WallpaperModule;

let dir = "";
const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "meow-wallpaper-"));
  writeFileSync(path.join(dir, "photo.png"), BYTES);
  writeFileSync(path.join(dir, "movie.mp4"), BYTES);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function request(url: string, range?: string) {
  return new Request(url, range ? { headers: { range } } : undefined);
}

describe("背景库归一化", () => {
  it("非对象 / 空库一律视为没有背景", () => {
    expect(normalizeWallpaper(null)).toBeNull();
    expect(normalizeWallpaper("nope")).toBeNull();
    expect(normalizeWallpaper({ items: [] })).toBeNull();
    expect(normalizeWallpaper({ items: [{ kind: "gif", fileName: "a.png" }] })).toBeNull();
  });

  it("旧版单张结构迁移成一项的库", () => {
    const value = normalizeWallpaper({
      kind: "video",
      fileName: "movie.mp4",
      opacity: 1,
      brightness: 1,
      blur: 0,
      uiOpacity: 0.7,
    });
    expect(value?.items).toEqual([{ kind: "video", fileName: "movie.mp4" }]);
    expect(value?.active).toBe("movie.mp4");
    expect(value?.enabled).toBe(true);
    expect(value?.uiOpacity).toBe(0.7);
  });

  it("保留多张、去重、丢掉未知类型，当前项失效时回落到第一张", () => {
    const value = normalizeWallpaper({
      items: [
        { kind: "image", fileName: "a.png" },
        { kind: "image", fileName: "a.png" },
        { kind: "gif", fileName: "b.gif" },
        { kind: "video", fileName: "c.mp4" },
      ],
      active: "missing.png",
    });
    expect(value?.items).toEqual([
      { kind: "image", fileName: "a.png" },
      { kind: "video", fileName: "c.mp4" },
    ]);
    expect(value?.active).toBe("a.png");
  });

  it("路径只保留文件名，越界会被 basename 掉", () => {
    const value = normalizeWallpaper({ items: [{ kind: "image", fileName: "../../secret.png" }] });
    expect(value?.items[0].fileName).toBe("secret.png");
  });

  it("库有条数上限", () => {
    const items = Array.from({ length: WALLPAPER_MAX_ITEMS + 5 }, (_, index) => ({
      kind: "image",
      fileName: `p${index}.png`,
    }));
    expect(normalizeWallpaper({ items })?.items).toHaveLength(WALLPAPER_MAX_ITEMS);
  });

  it("调节参数夹到安全区间，轮播间隔也有上下限", () => {
    const clamped = normalizeWallpaper({
      items: [{ kind: "image", fileName: "a.png" }],
      opacity: 5,
      brightness: -3,
      blur: 999,
      uiOpacity: 0,
      carousel: { enabled: true, intervalSec: 99999 },
    });
    expect(clamped).toMatchObject({ opacity: 1, brightness: 0.2, blur: 40, uiOpacity: 0.2 });
    expect(clamped?.carousel).toEqual({ enabled: true, intervalSec: 3600 });
    const small = normalizeWallpaper({
      items: [{ kind: "image", fileName: "a.png" }],
      carousel: { enabled: "yes", intervalSec: 1 },
    });
    expect(small?.carousel).toEqual({ enabled: false, intervalSec: 5 });
  });

  it("视频声音默认关闭，显式 true 才开", () => {
    const value = normalizeWallpaper({ items: [{ kind: "video", fileName: "a.mp4" }] });
    expect(value?.videoSound).toBe(false);
    expect(
      normalizeWallpaper({ items: [{ kind: "video", fileName: "a.mp4" }], videoSound: true })?.videoSound,
    ).toBe(true);
  });

  it("enabled=false 保留库但关闭显示", () => {
    const value = normalizeWallpaper({ items: [{ kind: "image", fileName: "a.png" }], enabled: false });
    expect(value?.enabled).toBe(false);
    expect(value?.items).toHaveLength(1);
  });
});

describe("背景媒体协议", () => {
  it("整文件请求返回 200 与完整字节", async () => {
    const response = wallpaperResponse({
      dir,
      request: request("meow-media://wallpaper/photo.png"),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(BYTES.length));
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("带 Range 时返回 206 与对应片段（视频拖动进度靠它）", async () => {
    const response = wallpaperResponse({
      dir,
      request: request("meow-media://wallpaper/movie.mp4", "bytes=2-5"),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe(`bytes 2-5/${BYTES.length}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(2, 6));
  });

  it("开放式 Range 一直取到文件末尾", async () => {
    const response = wallpaperResponse({
      dir,
      request: request("meow-media://wallpaper/movie.mp4", "bytes=6-"),
    });
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(6));
  });

  it("越界 Range 回 416，不越界读文件", async () => {
    const response = wallpaperResponse({
      dir,
      request: request("meow-media://wallpaper/movie.mp4", "bytes=99-120"),
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${BYTES.length}`);
  });

  it("只服务背景目录：别的 host / 不存在的文件 / 目录穿越都是 404", async () => {
    for (const url of [
      "meow-media://other/photo.png",
      "meow-media://wallpaper/missing.png",
      "meow-media://wallpaper/..%2F..%2Fetc%2Fpasswd",
      "meow-media://wallpaper/",
    ]) {
      const response = wallpaperResponse({ dir, request: request(url) });
      expect(response.status, url).toBe(404);
    }
  });

  it("文件名清洗后落在背景目录里", () => {
    expect(wallpaperFile(dir, "photo.png")).toBe(path.join(dir, "photo.png"));
    expect(wallpaperFile(dir, "../../x.png")).toBe(path.join(dir, "x.png"));
    expect(wallpaperFile(dir, "")).toBe("");
  });
});
