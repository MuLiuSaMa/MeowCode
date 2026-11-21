import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { wallpaperUrl, type WallpaperItem, type WallpaperSettings } from "../api";
import {
  attachWallpaperLoopFade,
  captureVideoFirstFrame,
  registerActiveWallpaperVideoElement,
} from "../wallpaper-video";
import "./AppBackground.css";

/** 交叉淡入淡出的时长，必须和 AppBackground.css 里的 transition 一致 */
const FADE_MS = 700;

/*
 * 当前展示的壁纸视频（轮播跟随）。消息流挂了底部文字淡出的蒙版后，蒙版根里的玻璃
 * 只能糊到子树内部，视频壁纸需要在流里放一份真正的 <video> 副本才有东西可糊 ——
 * 副本由 MessageList 渲染，从这里订阅当前文件。null = 没在放视频（图片壁纸 / 关闭）。
 */
export type ActiveWallpaperVideo = { fileName: string } | null;
let activeWallpaperVideo: ActiveWallpaperVideo = null;
const wallpaperVideoListeners = new Set<() => void>();
/** 已尝试保存首帧缩略图的视频：同一会话里轮播/重挂载不重复走 IPC */
const savedWallpaperThumbs = new Set<string>();

export function useActiveWallpaperVideo(): ActiveWallpaperVideo {
  return useSyncExternalStore(
    (onStoreChange) => {
      wallpaperVideoListeners.add(onStoreChange);
      return () => wallpaperVideoListeners.delete(onStoreChange);
    },
    () => activeWallpaperVideo,
  );
}

/**
 * 自定义背景层：铺在整个窗口最底下的图片 / 视频。
 *
 * 它自己不参与布局，靠 position: fixed + z-index: -1 待在 body 底色之上、所有面板之下；
 * 面板的不透明度由 :root[data-wallpaper="true"] 的规则读取 --wallpaper-ui，
 * 三个参数（透明度 / 亮度 / 模糊）写在 :root 的 CSS 变量上，滑杆一拖立刻生效，不需要重渲染整棵树。
 *
 * 轮播：从「当前选中」那张开始，只在同一类型内循环（图片只轮图片、视频只轮视频），
 * 切换时新旧两层叠在一起做交叉淡化；轮播位置只放在组件内部，不回写 settings，免得每轮写盘。
 */
export function AppBackground({ wallpaper }: { wallpaper: WallpaperSettings | null }) {
  const items = useMemo(() => wallpaper?.items ?? [], [wallpaper]);
  const activeItem = useMemo(
    () => items.find((item) => item.fileName === wallpaper?.active) ?? items[0] ?? null,
    [items, wallpaper?.active],
  );
  const pool = useMemo(
    () => (activeItem ? items.filter((item) => item.kind === activeItem.kind) : []),
    [items, activeItem],
  );
  const activeIndex = useMemo(() => {
    const index = pool.findIndex((item) => item.fileName === wallpaper?.active);
    return index < 0 ? 0 : index;
  }, [pool, wallpaper?.active]);

  const [offset, setOffset] = useState(0);
  // 换库 / 换当前项：从选中那张重新开始数
  useEffect(() => {
    setOffset(0);
  }, [activeIndex, pool.length]);

  const visible = Boolean(wallpaper?.enabled) && items.length > 0;
  const carouselEnabled = visible && wallpaper?.carousel.enabled === true && pool.length > 1;
  const intervalSec = wallpaper?.carousel.intervalSec ?? 60;
  useEffect(() => {
    if (!carouselEnabled) return;
    const timer = window.setInterval(
      () => setOffset((value) => value + 1),
      Math.max(5, intervalSec) * 1000,
    );
    return () => window.clearInterval(timer);
  }, [carouselEnabled, intervalSec]);

  useEffect(() => {
    const root = document.documentElement;
    if (!wallpaper || !visible) {
      delete root.dataset.wallpaper;
      for (const key of [
        "--wallpaper-opacity",
        "--wallpaper-ui",
        "--wallpaper-image",
        "--wallpaper-filter",
        "--wallpaper-transform",
        "--wallpaper-dim",
      ]) {
        root.style.removeProperty(key);
      }
      delete root.dataset.wallpaperVideo;
      return;
    }
    root.dataset.wallpaper = "true";
    root.style.setProperty("--wallpaper-opacity", String(wallpaper.opacity));
    root.style.setProperty("--wallpaper-ui", String(wallpaper.uiOpacity));
    /*
     * 亮度 <1 用一层纯色叠层压暗，避免整幅视频每帧走 filter；>1 只能保留 brightness()。
     * 模糊为 0 时不挂 filter / 放大，视频才有机会走不经滤镜与缩放的直接合成。
     */
    const filter = [
      wallpaper.blur > 0 ? `blur(${wallpaper.blur}px)` : "",
      wallpaper.brightness > 1 ? `brightness(${wallpaper.brightness})` : "",
    ]
      .filter(Boolean)
      .join(" ");
    root.style.setProperty("--wallpaper-filter", filter || "none");
    root.style.setProperty(
      "--wallpaper-transform",
      wallpaper.blur > 0 ? "scale(1.04)" : "none",
    );
    root.style.setProperty(
      "--wallpaper-dim",
      String(wallpaper.brightness < 1 ? 1 - wallpaper.brightness : 0),
    );
    return () => {
      delete root.dataset.wallpaper;
    };
  }, [wallpaper, visible]);

  const item = !visible || !activeItem || !pool.length
    ? null
    : pool[(activeIndex + offset) % pool.length];

  /** 正在展示的两层：新的一张淡入，旧的一张垫在下面等淡出结束再卸载 */
  const [layers, setLayers] = useState<{ current: WallpaperItem | null; previous: WallpaperItem | null }>(
    { current: null, previous: null },
  );
  useEffect(() => {
    if (!item) {
      setLayers({ current: null, previous: null });
      return;
    }
    setLayers((last) =>
      last.current?.fileName === item.fileName
        ? last
        : { current: item, previous: last.current },
    );
  }, [item]);

  useEffect(() => {
    if (!layers.previous) return;
    const timer = window.setTimeout(() => {
      setLayers((last) => ({ current: last.current, previous: null }));
    }, FADE_MS);
    return () => window.clearTimeout(timer);
  }, [layers.previous]);

  /*
   * 图片壁纸的地址交给 CSS：消息流挂蒙版做文字淡出后，流内的毛玻璃只能糊到流子树内部，
   * 全靠 .mc-streamwrap::before 复刻的壁纸副本才有东西可糊。视频副本走上面的
   * activeWallpaperVideo（DOM <video>，位图放不了）。跟的是当前展示层（轮播会换图）。
   */
  useEffect(() => {
    const root = document.documentElement;
    if (visible && item && item.kind === "image") {
      root.style.setProperty("--wallpaper-image", `url("${wallpaperUrl(item.fileName)}")`);
    } else {
      root.style.removeProperty("--wallpaper-image");
    }
    if (visible && item?.kind === "video") {
      root.dataset.wallpaperVideo = "true";
    } else {
      delete root.dataset.wallpaperVideo;
    }
    const nextVideo: ActiveWallpaperVideo =
      visible && item?.kind === "video" ? { fileName: item.fileName } : null;
    if (nextVideo?.fileName !== activeWallpaperVideo?.fileName) {
      activeWallpaperVideo = nextVideo;
      for (const listener of wallpaperVideoListeners) listener();
    }
  }, [visible, item]);

  if (!wallpaper || !visible) return null;

  const soundOn = wallpaper.videoSound === true;
  const renderLayer = (entry: WallpaperItem, state: "in" | "out") => (
    <div key={entry.fileName} className="mc-appbg__layer" data-state={state}>
      {entry.kind === "video" ? (
        <BackgroundVideo fileName={entry.fileName} sound={soundOn} primary={state === "in"} />
      ) : (
        <div className="mc-appbg__media">
          <img
            className="mc-appbg__still"
            src={wallpaperUrl(entry.fileName)}
            alt=""
            draggable={false}
          />
          <span className="mc-appbg__dim" aria-hidden="true" />
        </div>
      )}
    </div>
  );

  return (
    <div className="mc-appbg" aria-hidden="true">
      {layers.previous ? renderLayer(layers.previous, "out") : null}
      {layers.current ? renderLayer(layers.current, "in") : null}
    </div>
  );
}

/**
 * 背景视频：静音与否跟着设置走。
 * Electron 默认允许无手势自动播放，但真开了声音仍可能被策略挡住，所以再补一次 play()。
 */
function BackgroundVideo({
  fileName,
  sound,
  primary,
}: {
  fileName: string;
  sound: boolean;
  /** 正在淡入 / 展示的那一层才是主播放器，淡出的旧层不参与副本同步 */
  primary: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const thumbUrl = wallpaperUrl(`${fileName}.thumb.jpg`);
  /** 首帧静图：启动先用缓存的缩略图，结尾淡化也垫这张 */
  const [firstFrame, setFirstFrame] = useState<string | null>(thumbUrl);
  const startedRef = useRef(false);

  useEffect(() => {
    setFirstFrame(thumbUrl);
    startedRef.current = false;
    const video = ref.current;
    if (!video) return;
    video.pause();
    let cancelled = false;
    let captured = false;
    /** 先抓首帧再起播：抓帧必须停在 0 秒的第一帧上 */
    const start = () => {
      if (cancelled) return;
      if (!captured) {
        captured = true;
        const frame = captureVideoFirstFrame(video);
        if (frame) {
          setFirstFrame(frame);
          if (!savedWallpaperThumbs.has(fileName)) {
            savedWallpaperThumbs.add(fileName);
            void window.meow.saveWallpaperThumbnail?.(fileName, frame).catch(() => undefined);
          }
        }
      }
      startedRef.current = true;
      void video.play().catch(() => undefined);
    };
    if (video.readyState >= 2) start();
    else video.addEventListener("loadeddata", start, { once: true });
    return () => {
      cancelled = true;
      video.removeEventListener("loadeddata", start);
    };
  }, [fileName, thumbUrl]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !firstFrame) return;
    return attachWallpaperLoopFade(video);
  }, [fileName, firstFrame]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.muted = !sound;
    // 起播由抓帧那条链路负责；这里只在用户关掉声音时兜底恢复可能被浏览器拦下的播放
    if (!sound && startedRef.current) void video.play().catch(() => undefined);
  }, [sound]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !primary) return;
    return registerActiveWallpaperVideoElement(video);
  }, [primary, fileName]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    /** 窗口不可见就别继续解码视频：后台挂着只会白烧 GPU */
    const onVisibility = () => {
      if (document.hidden) video.pause();
      else if (startedRef.current) void video.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.hidden) video.pause();
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [fileName]);

  return (
    <div className="mc-appbg__media">
      {firstFrame ? (
        <img
          className="mc-appbg__still"
          src={firstFrame}
          alt=""
          draggable={false}
          onError={() => setFirstFrame((current) => (current === thumbUrl ? null : current))}
        />
      ) : null}
      <video
        ref={ref}
        className="mc-appbg__clip"
        src={wallpaperUrl(fileName)}
        poster={thumbUrl}
        crossOrigin="anonymous"
        muted={!sound}
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
      />
      <span className="mc-appbg__dim" aria-hidden="true" />
    </div>
  );
}
