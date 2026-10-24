/**
 * 视频输入（ffmpeg 封装）。
 *
 * 原生直传不可行：30MB 视频 ≈ 千万 token。所以只做三件事：
 *  - meta：ffprobe 读时长/分辨率/fps/音轨，**0 图**（先问结构再决定要不要看图）；
 *  - storyboard：区间内均匀取 9 帧拼成 3×3 联系表，一次 ~1.5k token；
 *  - frames：指定时间点取 ≤4 帧，长边 2048，用于看细节。
 *
 * 不引 ffmpeg-static（80MB），用系统 ffmpeg；缺失时返回安装提示而不是抛栈。
 * 临时文件一律落在 os.tmpdir()/meowcode-video-<uuid>，finally 递归删除。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** storyboard 固定 9 帧（3×3） */
export const STORYBOARD_FRAMES = 9;
/** frames 模式最多 4 帧：再多就不如用 storyboard */
export const MAX_FRAMES = 4;
/** 联系表单元格长边：512px × 3 = 1536px，约 1.5k token */
const TILE_CELL_EDGE = 512;
/** 单帧长边 */
const FRAME_EDGE = 2048;
/** 单次 ffmpeg/ffprobe 调用上限 */
const RUN_TIMEOUT_MS = 120_000;
/** 视频文件体积上限（只是防呆：真正限制是解码时间） */
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

export type RunResult = { status: number | null; stdout: string; stderr: string };
/** 可注入的进程执行器（测试用假实现，生产用 spawn）。 */
export type ProcessRunner = (command: string, args: string[]) => Promise<RunResult>;

export type VideoMeta = {
  durationSeconds: number;
  width: number;
  height: number;
  fps?: number;
  hasAudio: boolean;
  bytes: number;
  videoCodec?: string;
};

export type VideoToolResult =
  | { ok: true; output: string; images?: Array<{ data: string; mimeType: string }>; meta?: VideoMeta }
  | { ok: false; output: string };

/** ffmpeg 可执行文件：允许 MEOWCODE_FFMPEG 覆盖（便携版/非 PATH 安装）。 */
export function ffmpegPath(): string {
  return process.env.MEOWCODE_FFMPEG?.trim() || "ffmpeg";
}

/** ffprobe 默认为 ffmpeg 同目录的同名工具。 */
export function ffprobePath(): string {
  const explicit = process.env.MEOWCODE_FFPROBE?.trim();
  if (explicit) return explicit;
  const ffmpeg = ffmpegPath();
  if (ffmpeg === "ffmpeg") return "ffprobe";
  return path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
}

const defaultRunner: ProcessRunner = (command, args) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({
        status: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: null, stdout, stderr: `${stderr}\n[timeout after ${RUN_TIMEOUT_MS}ms]` });
    }, RUN_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      // 只留尾部：ffprobe 的 JSON 很小，ffmpeg 的进度输出没用
      stdout = (stdout + chunk.toString("utf8")).slice(-200_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-20_000);
    });
    child.on("error", (error: Error) => {
      finish({ status: null, stdout, stderr: error.message });
    });
    child.on("close", (code: number | null) => {
      finish({ status: code, stdout, stderr });
    });
  });

/** 解析 "00:03.2" / "1:20.5" / "00:01:30" / "90" / "90.5" 为秒。 */
export function parseTimestamp(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) return undefined;
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![seconds, minutes, hours].every((item) => Number.isFinite(item) && item >= 0)) {
    return undefined;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/** 秒 → "mm:ss.s"（帧时间戳展示用）。 */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const secText = secs.toFixed(1).padStart(4, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secText}`
    : `${String(minutes).padStart(2, "0")}:${secText}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * 确认 ffmpeg 可用。缺失时返回 false，调用方给安装提示（不抛栈）。
 * 用 `<bin> -version` 探测：比 `which` 可靠，Windows 上同样适用。
 */
export async function hasFfmpeg(runner: ProcessRunner = defaultRunner): Promise<boolean> {
  const result = await runner(ffmpegPath(), ["-version"]);
  return result.status === 0;
}

const INSTALL_HINT =
  "ffmpeg was not found. Install it (Windows: winget install Gyan.FFmpeg; macOS: brew install ffmpeg) and make sure `ffmpeg` is on PATH, or set MEOWCODE_FFMPEG to the full path of the executable.";

/** ffprobe JSON → 元信息。导出以便单测覆盖字段映射。 */
export function parseFfprobeJson(raw: string, bytes: number): VideoMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const payload = parsed as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
    }>;
    format?: { duration?: string };
  };
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  if (!video) return undefined;
  const duration = Number(payload.format?.duration ?? 0);
  const rate = video.avg_frame_rate ?? video.r_frame_rate ?? "";
  let fps: number | undefined;
  const [num, den] = rate.split("/").map((part) => Number(part));
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) fps = num / den;
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
    ...(fps && Number.isFinite(fps) ? { fps: Number(fps.toFixed(2)) } : {}),
    hasAudio: Boolean(payload.streams?.some((stream) => stream.codec_type === "audio")),
    bytes,
    ...(video.codec_name ? { videoCodec: video.codec_name } : {}),
  };
}

export function describeVideoMeta(name: string, meta: VideoMeta): string {
  const bits = [
    formatTimestamp(meta.durationSeconds),
    `${meta.width}x${meta.height}`,
    meta.fps ? `${meta.fps}fps` : "",
    meta.hasAudio ? "audio: yes" : "audio: no",
    formatBytes(meta.bytes),
    meta.videoCodec ?? "",
  ].filter(Boolean);
  return `Video: ${name} (${bits.join(", ")})`;
}

async function probe(
  file: string,
  name: string,
  runner: ProcessRunner,
): Promise<{ ok: true; meta: VideoMeta } | { ok: false; output: string }> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return { ok: false, output: `File not found: ${name}` };
  if (stat.size > MAX_VIDEO_BYTES) {
    return { ok: false, output: `${name} is ${formatBytes(stat.size)}, above the 4GB limit.` };
  }
  if (!(await hasFfmpeg(runner))) return { ok: false, output: INSTALL_HINT };
  const result = await runner(ffprobePath(), [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const meta = result.status === 0 ? parseFfprobeJson(result.stdout, stat.size) : undefined;
  if (!meta) {
    return {
      ok: false,
      output: `Could not probe ${name} with ffprobe: ${(result.stderr || "no media stream found").trim().slice(0, 400)}`,
    };
  }
  return { ok: true, meta };
}

/** 临时工作目录：每次调用一个，finally 删掉。 */
async function withTempDir<T>(task: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(os.tmpdir(), `meowcode-video-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    return await task(dir);
  } finally {
    // 递归删除失败不能盖住真正的错误（Windows 上偶发文件占用）
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readImage(file: string): Promise<{ data: string; mimeType: string } | undefined> {
  try {
    const data = await fs.readFile(file);
    return { data: data.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return undefined;
  }
}

/**
 * 9 帧联系表：单次 ffmpeg 调用完成 fps 采样 + 缩放 + 3×3 拼接，
 * 不落 9 个中间文件（省 IO，也省掉 8 次进程启动）。
 */
export async function grabStoryboard(
  file: string,
  name: string,
  options: { start?: string; end?: string } = {},
  runner: ProcessRunner = defaultRunner,
): Promise<VideoToolResult> {
  const probed = await probe(file, name, runner);
  if (!probed.ok) return probed;
  const { meta } = probed;
  const start = options.start ? parseTimestamp(options.start) : 0;
  if (start === undefined) return { ok: false, output: `Invalid start timestamp: ${options.start}` };
  const end = options.end ? parseTimestamp(options.end) : meta.durationSeconds;
  if (end === undefined) return { ok: false, output: `Invalid end timestamp: ${options.end}` };
  if (!(end > start)) {
    return {
      ok: false,
      output: `Empty range: start ${formatTimestamp(start)} is not before end ${formatTimestamp(end)}.`,
    };
  }
  const span = Math.min(end, meta.durationSeconds || end) - start;
  const rate = Math.max(0.01, STORYBOARD_FRAMES / Math.max(0.1, span));
  const tileFilter = `fps=${rate.toFixed(6)},scale=${TILE_CELL_EDGE}:-1,tile=3x3`;

  return withTempDir(async (dir) => {
    const out = path.join(dir, "storyboard.jpg");
    const result = await runner(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-ss",
      String(start),
      "-t",
      String(span),
      "-i",
      file,
      "-an",
      "-vf",
      tileFilter,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      out,
    ]);
    const image = result.status === 0 ? await readImage(out) : undefined;
    if (!image) {
      return {
        ok: false as const,
        output: `ffmpeg could not render a storyboard: ${(result.stderr || "no output file").trim().slice(0, 400)}`,
      };
    }
    const lines = [
      `${describeVideoMeta(name, meta)} — 9 frames from ${formatTimestamp(start)} to ${formatTimestamp(
        start + span,
      )}, one 3x3 contact sheet (reading order left→right, top→bottom).`,
    ];
    for (let index = 0; index < STORYBOARD_FRAMES; index += 1) {
      // 采样点在每格中心：fps 采样落在 [start, start+span) 均匀分布
      const at = start + (span * (index + 0.5)) / STORYBOARD_FRAMES;
      lines.push(`frame ${index + 1} = ${formatTimestamp(at)}`);
    }
    return { ok: true as const, output: lines.join("\n"), images: [image], meta };
  });
}

/** 指定时间点取帧（≤4 帧，长边 2048）。 */
export async function grabFrames(
  file: string,
  name: string,
  timestamps: string[],
  runner: ProcessRunner = defaultRunner,
): Promise<VideoToolResult> {
  if (!timestamps.length) {
    return { ok: false, output: "frames mode requires a non-empty \"timestamps\" array." };
  }
  if (timestamps.length > MAX_FRAMES) {
    return {
      ok: false,
      output: `At most ${MAX_FRAMES} frames per call (got ${timestamps.length}). Use mode="storyboard" for a broad overview.`,
    };
  }
  const seconds: number[] = [];
  for (const raw of timestamps) {
    const value = parseTimestamp(raw);
    if (value === undefined) return { ok: false, output: `Invalid timestamp: ${raw}` };
    seconds.push(value);
  }
  const probed = await probe(file, name, runner);
  if (!probed.ok) return probed;
  const { meta } = probed;
  const beyond = seconds.find((value) => meta.durationSeconds > 0 && value > meta.durationSeconds);
  if (beyond !== undefined) {
    return {
      ok: false,
      output: `Timestamp ${formatTimestamp(beyond)} is past the end (${formatTimestamp(meta.durationSeconds)}).`,
    };
  }

  return withTempDir(async (dir) => {
    const images: Array<{ data: string; mimeType: string }> = [];
    const lines = [
      `${describeVideoMeta(name, meta)} — ${seconds.length} frame(s) at long edge ${FRAME_EDGE}px.`,
    ];
    for (let index = 0; index < seconds.length; index += 1) {
      const out = path.join(dir, `frame-${index + 1}.jpg`);
      const result = await runner(ffmpegPath(), [
        "-v",
        "error",
        "-y",
        "-ss",
        String(seconds[index]),
        "-i",
        file,
        "-an",
        "-vf",
        `scale=${FRAME_EDGE}:${FRAME_EDGE}:force_original_aspect_ratio=decrease`,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        out,
      ]);
      const image = result.status === 0 ? await readImage(out) : undefined;
      if (!image) {
        lines.push(
          `frame ${index + 1} = ${formatTimestamp(seconds[index])} — FAILED: ${(result.stderr || "no output")
            .trim()
            .slice(0, 200)}`,
        );
        continue;
      }
      images.push(image);
      lines.push(`frame ${index + 1} = ${formatTimestamp(seconds[index])}`);
    }
    if (!images.length) {
      return { ok: false as const, output: lines.join("\n") };
    }
    return { ok: true as const, output: lines.join("\n"), images, meta };
  });
}

/** meta 模式：只读结构，0 图。 */
export async function probeVideo(
  file: string,
  name: string,
  runner: ProcessRunner = defaultRunner,
): Promise<VideoToolResult> {
  const probed = await probe(file, name, runner);
  if (!probed.ok) return probed;
  const { meta } = probed;
  return {
    ok: true,
    output: `${describeVideoMeta(name, meta)}\nUse mode="storyboard" for 9 evenly spaced frames, or mode="frames" with up to 4 timestamps for detail.`,
    meta,
  };
}
