/**
 * 自定义视频壁纸在消息流里有一份 fixed 全屏副本（蒙版根里的毛玻璃只能采样子树像素）。
 * 两个 <video> 各播各的：侧边聊天、子 Agent 等晚挂载的副本会从 0 秒开始，与真正的
 * 背景视频完全对不上。这里把主视频登记下来，让副本跟随它的时间、循环、暂停与倍速。
 */

/** 小于两帧的漂移不动副本：一次 seek 的代价比一帧级别的误差更明显。 */
const SYNC_TOLERANCE_SEC = 1 / 30;
/** requestVideoFrameCallback 在暂停时不会回调，用它兜底主视频换片 / 副本晚挂载。 */
const SYNC_POLL_MS = 1000;
const HAVE_CURRENT_DATA = 2;

let activeVideo: HTMLVideoElement | null = null;
const activeVideoListeners = new Set<() => void>();

function notifyActiveVideoListeners() {
  for (const listener of activeVideoListeners) listener();
}

/** 背景层当前正在展示的视频；调用返回的函数注销。 */
export function registerActiveWallpaperVideoElement(video: HTMLVideoElement): () => void {
  activeVideo = video;
  notifyActiveVideoListeners();
  return () => {
    if (activeVideo !== video) return;
    activeVideo = null;
    notifyActiveVideoListeners();
  };
}

/**
 * 主视频与副本的时间差。循环视频跨过结尾时（主视频已回到 0、副本还在末尾），
 * 直接相减会得到一整圈；折算到 [-duration/2, duration/2] 才是真实漂移。
 */
export function wallpaperVideoDrift(
  primaryTime: number,
  replicaTime: number,
  duration: number,
): number {
  const drift = primaryTime - replicaTime;
  if (!Number.isFinite(duration) || duration <= 0) return drift;
  if (drift > duration / 2) return drift - duration;
  if (drift < -duration / 2) return drift + duration;
  return drift;
}

export function wallpaperVideoNeedsSync(
  primaryTime: number,
  replicaTime: number,
  duration: number,
  tolerance = SYNC_TOLERANCE_SEC,
): boolean {
  if (!Number.isFinite(primaryTime) || !Number.isFinite(replicaTime)) return false;
  return Math.abs(wallpaperVideoDrift(primaryTime, replicaTime, duration)) > tolerance;
}

/** 循环接缝淡化的时长：按时长 8%，限制在 120–600ms。 */
export function wallpaperLoopFadeSeconds(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(0.6, Math.max(0.12, duration * 0.08));
}

/** 上一次还在结尾、这一次已经回到开头：原生 loop 刚跨过接缝。 */
export function wallpaperVideoLooped(
  previousTime: number,
  currentTime: number,
  duration: number,
): boolean {
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) return false;
  if (currentTime + 0.2 < previousTime) return true;
  return (
    Number.isFinite(duration) &&
    duration > 0 &&
    previousTime > duration * 0.5 &&
    currentTime < 0.2
  );
}

/** 从视频当前画面抓一张静图（JPEG data URL），跨接缝淡出时垫在视频下面。 */
export function captureVideoFirstFrame(video: HTMLVideoElement, maxWidth = 1600): string | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  try {
    const scale = Math.min(1, maxWidth / width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    // 跨域 / 解码失败：返回 null，保留原生硬切
    return null;
  }
}

/**
 * 单视频循环淡化：结尾前把视频淡出到下面垫着的首帧静图，原生 loop 回绕后立即恢复。
 * 只有视频自身的 opacity 在变（CSS transition 走合成器），不额外开第二条视频解码；
 * 静图本身就是第一帧，所以淡出和回绕都不会露出底色黑场。
 */
export function attachWallpaperLoopFade(video: HTMLVideoElement): () => void {
  let frame: number | null = null;
  let disposed = false;
  let fading = false;
  let lastTime = 0;

  const restore = () => {
    if (!fading) return;
    fading = false;
    video.style.transition = "none";
    video.style.opacity = "1";
    window.requestAnimationFrame(() => {
      if (!disposed) video.style.transition = "";
    });
  };

  const startFade = (remaining: number) => {
    fading = true;
    lastTime = video.currentTime;
    video.style.transition = `opacity ${Math.max(0.06, remaining)}s linear`;
    // 过渡需要先落上 transition 再改 opacity，隔一帧改才开始动
    window.requestAnimationFrame(() => {
      if (!disposed && fading) video.style.opacity = "0";
    });
  };

  function schedule() {
    if (disposed || frame !== null) return;
    if (video.paused || video.ended) return;
    frame = window.requestAnimationFrame(tick);
  }

  function tick() {
    frame = null;
    if (disposed || video.paused || video.ended) return;
    const duration = video.duration;
    const time = video.currentTime;
    if (fading) {
      if (wallpaperVideoLooped(lastTime, time, duration)) restore();
      else lastTime = time;
    } else if (Number.isFinite(duration) && duration > 0) {
      const remaining = duration - time;
      if (remaining <= wallpaperLoopFadeSeconds(duration) && remaining > 0.01) {
        startFade(remaining);
      }
    }
    schedule();
  }

  const onPlay = () => schedule();
  const onPause = () => {
    if (frame === null) return;
    window.cancelAnimationFrame(frame);
    frame = null;
  };
  const onEnded = () => {
    // loop 属性在，正常不会走到这里；兜底恢复并重播
    restore();
    void video.play().catch(() => undefined);
  };

  video.style.opacity = "1";
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("ended", onEnded);
  schedule();

  return () => {
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("ended", onEnded);
    video.style.removeProperty("transition");
    video.style.removeProperty("opacity");
  };
}

function sourceOf(video: HTMLVideoElement): string {
  return video.currentSrc || video.getAttribute("src") || "";
}

function usablePrimary(replica: HTMLVideoElement): HTMLVideoElement | null {
  const primary = activeVideo;
  if (!primary || primary === replica || !primary.isConnected) return null;
  const primarySrc = sourceOf(primary);
  return primarySrc !== "" && primarySrc === sourceOf(replica) ? primary : null;
}

/**
 * 让一份背景视频副本持续跟随主视频。返回清理函数。
 *
 * 只在同源视频之间同步：轮播换片时新副本可能比新主视频早挂载一帧，先等主视频
 * 重新注册，避免拿上一个文件的时间去 seek 新文件。
 */
export function bindWallpaperVideoReplica(replica: HTMLVideoElement): () => void {
  let disposed = false;
  let boundPrimary: HTMLVideoElement | null = null;
  let frameRequest: number | null = null;
  let frameVideo: HTMLVideoElement | null = null;
  let timer: number | null = null;

  const align = () => {
    if (disposed) return;
    const primary = usablePrimary(replica);
    if (
      !primary ||
      primary.readyState < HAVE_CURRENT_DATA ||
      replica.readyState < HAVE_CURRENT_DATA
    ) {
      return;
    }

    if (wallpaperVideoNeedsSync(primary.currentTime, replica.currentTime, primary.duration)) {
      replica.currentTime = primary.currentTime;
    }
    if (replica.playbackRate !== primary.playbackRate) {
      replica.playbackRate = primary.playbackRate;
    }
    if (primary.paused) {
      if (!replica.paused) replica.pause();
    } else if (replica.paused) {
      void replica.play().catch(() => undefined);
    }
  };

  const cancelFramePoll = () => {
    if (frameRequest === null || !frameVideo) return;
    if (typeof frameVideo.cancelVideoFrameCallback === "function") {
      frameVideo.cancelVideoFrameCallback(frameRequest);
    }
    frameRequest = null;
    frameVideo = null;
  };

  const pollFrames = () => {
    const primary = usablePrimary(replica);
    if (disposed || !primary) return;
    if (frameRequest !== null) {
      if (frameVideo === primary) return;
      cancelFramePoll();
    }
    if (typeof primary.requestVideoFrameCallback !== "function") return;
    frameVideo = primary;
    frameRequest = primary.requestVideoFrameCallback(() => {
      frameRequest = null;
      frameVideo = null;
      align();
      pollFrames();
    });
  };

  const primaryEvents = [
    "loadedmetadata",
    "canplay",
    "play",
    "pause",
    "seeked",
    "ratechange",
  ] as const;

  const onPrimaryChange = () => {
    align();
    pollFrames();
  };

  const bindPrimary = (primary: HTMLVideoElement | null) => {
    if (boundPrimary === primary) return;
    if (boundPrimary) {
      for (const event of primaryEvents) {
        boundPrimary.removeEventListener(event, onPrimaryChange);
      }
    }
    boundPrimary = primary;
    if (boundPrimary) {
      for (const event of primaryEvents) {
        boundPrimary.addEventListener(event, onPrimaryChange);
      }
    }
  };

  const sync = () => {
    if (disposed) return;
    bindPrimary(usablePrimary(replica));
    align();
    pollFrames();
  };

  const onReplicaReady = () => sync();
  replica.addEventListener("loadedmetadata", onReplicaReady);
  replica.addEventListener("canplay", onReplicaReady);
  replica.addEventListener("play", onReplicaReady);
  activeVideoListeners.add(sync);
  timer = window.setInterval(sync, SYNC_POLL_MS);
  sync();

  return () => {
    disposed = true;
    activeVideoListeners.delete(sync);
    replica.removeEventListener("loadedmetadata", onReplicaReady);
    replica.removeEventListener("canplay", onReplicaReady);
    replica.removeEventListener("play", onReplicaReady);
    if (timer !== null) window.clearInterval(timer);
    cancelFramePoll();
    bindPrimary(null);
  };
}
