/**
 * 系统声音律动：Windows 回环采集 + Web Audio 频谱分析的共享单例。
 *
 * 主进程为渲染层的 getDisplayMedia 注册了 loopback 音频自动放行（仅 Windows），
 * 这里拿到回环流后用 AnalyserNode 读频谱，按 24 个对数频段算出各自的电平，
 * rAF 逐帧回调给订阅者；跳转条把每根刻度映射到一个频段，像迷你均衡器一样
 * 一根一根变长变短跳动。多处实例共享同一路采集，开关关闭或没有订阅者时
 * 不启动任何采集，全部退订即停。
 */

/** 频段数：每根刻度按序取一个频段 */
export const BAND_COUNT = 24;

/** 对数分布的频段 bin 边界 [lo, hi)：低频段窄、高频段宽（能量集中低频，对数分布每段才均匀跳动） */
export function bandEdges(binCount: number, bands: number): Array<[number, number]> {
  const maxBin = Math.max(bands, Math.floor(binCount * 0.8));
  const edges: Array<[number, number]> = [];
  let prev = 1;
  for (let i = 0; i < bands; i++) {
    // 低频段理想边界会塌缩到同一个 bin：强制 +1 去重，保证每段至少占一个 bin
    const hi = Math.max(prev + 1, Math.min(maxBin, Math.floor(Math.pow(maxBin, (i + 1) / bands))));
    edges.push([prev, hi]);
    prev = hi;
  }
  return edges;
}

/**
 * 频段原始电平：段内平均归一化 + 轻度高频补偿（高频能量天然偏低），
 * 结果钳到 0..1 写入 out。只保真不放大：动态范围交给下面的滚动峰值 AGC 处理。
 */
export function bandLevels(
  data: Uint8Array,
  edges: Array<[number, number]>,
  out: Float32Array,
): void {
  const last = out.length - 1;
  for (let i = 0; i < out.length; i++) {
    const [lo, hi] = edges[i] ?? [0, 0];
    let sum = 0;
    for (let bin = lo; bin < hi; bin++) sum += data[bin] ?? 0;
    const avg = sum / Math.max(1, hi - lo);
    const tilt = 1 + (last > 0 ? 1.2 * (i / last) : 0);
    out[i] = Math.min(1, (avg / 255) * tilt);
  }
}

/** AGC 峰值地板：静音时不去放大底噪 */
const PEAK_FLOOR = 0.15;

/**
 * 滚动峰值 AGC：各频段除以滚动峰值再过幂曲线（顶部留余量，只有真峰值才顶满），
 * 音量大小不再决定跳动幅度——安静的歌照样跳满全程，吵的歌不会钉死在最长。
 * 峰值上行立即跟随、下行每帧 ×0.995（60fps 下约 2 秒半衰），返回新峰值。
 */
export function normalizeBands(
  raw: Float32Array,
  prevPeak: number,
  out: Float32Array,
): number {
  let frameMax = 0;
  for (const value of raw) frameMax = Math.max(frameMax, value);
  const peak = frameMax > prevPeak ? frameMax : Math.max(PEAK_FLOOR, prevPeak * 0.995);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.pow(Math.min(1, raw[i] / peak), 1.3);
  }
  return peak;
}

/** 单频段平滑：起音快（跳动干脆）、收音稍慢（不闪烁），60fps 下的经验值 */
export function smoothBand(prev: number, next: number): number {
  return prev + (next - prev) * (next > prev ? 0.6 : 0.18);
}

type BandsListener = (bands: Float32Array) => void;
type ActiveListener = (active: boolean) => void;

let enabled = false;
/** 采集已启动并逐帧回调 */
let running = false;
/** 启停中（getDisplayMedia 是异步放行，避免重复发起） */
let starting = false;
/** 采集不可用（非 Windows / 无设备 / 被拒）：静默降级，重开开关才重试 */
let unavailable = false;
let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let rafId = 0;

const edges = bandEdges(512, BAND_COUNT); // fftSize 1024 → 512 个 bin
const raw = new Float32Array(BAND_COUNT);
const agc = new Float32Array(BAND_COUNT);
const smooth = new Float32Array(BAND_COUNT);
let peak = PEAK_FLOOR;

const bandsListeners = new Set<BandsListener>();
const activeListeners = new Set<ActiveListener>();

function notifyActive(active: boolean): void {
  for (const listener of activeListeners) listener(active);
}

function tick(node: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): void {
  node.getByteFrequencyData(buffer);
  bandLevels(buffer, edges, raw);
  peak = normalizeBands(raw, peak, agc);
  for (let i = 0; i < BAND_COUNT; i++) smooth[i] = smoothBand(smooth[i], agc[i]);
  for (const listener of bandsListeners) listener(smooth);
  rafId = requestAnimationFrame(() => tick(node, buffer));
}

async function start(): Promise<void> {
  try {
    const media = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    // 视频轨是 getDisplayMedia 的强制要求，拿到就停掉，只留回环音频
    for (const track of media.getVideoTracks()) track.stop();
    const audioTrack = media.getAudioTracks()[0];
    if (!audioTrack) {
      for (const track of media.getTracks()) track.stop();
      throw new Error("no loopback audio track");
    }
    if (!enabled || bandsListeners.size === 0) {
      // 等待采集放行期间开关/订阅者已撤：直接丢弃，不算「不可用」
      audioTrack.stop();
      return;
    }
    stream = new MediaStream([audioTrack]);
    const audioCtx = new AudioContext();
    ctx = audioCtx;
    if (audioCtx.state === "suspended") {
      // 冷启动自动开启时可能还没有用户手势：监听首次交互补一次恢复
      const resume = () => void audioCtx.resume().catch(() => {});
      window.addEventListener("pointerdown", resume, { once: true });
      window.addEventListener("keydown", resume, { once: true });
      void audioCtx.resume().catch(() => {});
    }
    const node = audioCtx.createAnalyser();
    node.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(node);
    // 回环音频绝不连 destination：分析后再播回去会双重出声
    tick(node, new Uint8Array(node.frequencyBinCount));
    running = true;
    notifyActive(true);
  } catch {
    unavailable = true;
    stopCapture();
  } finally {
    starting = false;
  }
}

function stopCapture(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (running) {
    running = false;
    notifyActive(false);
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (ctx) {
    void ctx.close().catch(() => {});
    ctx = null;
  }
  smooth.fill(0);
  peak = PEAK_FLOOR;
}

/** 有开关且有订阅者才真正采集；否则确保已停 */
function sync(): void {
  const shouldRun = enabled && bandsListeners.size > 0;
  if (shouldRun && !running && !starting && !unavailable) {
    starting = true;
    void start();
  }
  if (!shouldRun && starting) {
    // 异步放行尚未回来：start() 里会在拿到流后自行丢弃
    stopCapture();
  }
  if (!shouldRun && running) {
    stopCapture();
  }
}

/** App 按偏好调用；开启时清除「不可用」标记（重试一次采集），随后重算启停 */
export function setAudioPulseEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  if (next) unavailable = false;
  sync();
}

/**
 * 跳转条挂载时订阅 24 个频段电平（0..1，每帧回调同一个 Float32Array，只读）；
 * 退订时调用返回的函数。onActiveChange 在采集开始/停止时触发（用于挂/摘 data-pulse），
 * 订阅时先同步一次当前态。
 */
export function subscribeAudioLevel(
  onBands: BandsListener,
  onActiveChange?: ActiveListener,
): () => void {
  bandsListeners.add(onBands);
  if (onActiveChange) {
    activeListeners.add(onActiveChange);
    onActiveChange(running);
  }
  sync();
  return () => {
    bandsListeners.delete(onBands);
    if (onActiveChange) activeListeners.delete(onActiveChange);
    sync();
  };
}
