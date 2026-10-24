import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FRAMES,
  STORYBOARD_FRAMES,
  describeVideoMeta,
  formatTimestamp,
  grabFrames,
  grabStoryboard,
  parseFfprobeJson,
  parseTimestamp,
  probeVideo,
  type ProcessRunner,
} from "./video.js";

const FFPROBE_JSON = JSON.stringify({
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
    { codec_type: "audio", codec_name: "aac" },
  ],
  format: { duration: "133.5" },
});

type Call = { command: string; args: string[] };

/**
 * 假 ffmpeg/ffprobe：-version 成功、ffprobe 返回固定 JSON、ffmpeg 在最后
 * 一个参数（输出文件）写一个假 JPEG。记录每次调用的 argv 供断言。
 */
function fakeRunner(options?: { ffmpeg?: boolean; failRender?: boolean }): ProcessRunner & {
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner = (async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (args.includes("-version")) {
      return options?.ffmpeg === false
        ? { status: null, stdout: "", stderr: "spawn ffmpeg ENOENT" }
        : { status: 0, stdout: "ffmpeg version 7.0", stderr: "" };
    }
    if (command.includes("ffprobe") || args.includes("-print_format")) {
      return { status: 0, stdout: FFPROBE_JSON, stderr: "" };
    }
    if (options?.failRender) {
      return { status: 1, stdout: "", stderr: "Invalid data found when processing input" };
    }
    const out = args.at(-1) ?? "";
    await fs.writeFile(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return { status: 0, stdout: "", stderr: "" };
  }) as ProcessRunner & { calls: Call[] };
  runner.calls = calls;
  return runner;
}

const tempDirs: string[] = [];

async function makeVideo(): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meowcode-video-src-"));
  tempDirs.push(dir);
  const file = path.join(dir, "clip.mp4");
  await fs.writeFile(file, Buffer.alloc(2048, 1));
  return { dir, file };
}

/** 列出 os.tmpdir() 下残留的本工具临时目录。 */
async function leftoverTempDirs(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((entry) => entry.startsWith("meowcode-video-"));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("timestamp parsing", () => {
  it("accepts seconds, mm:ss and hh:mm:ss", () => {
    expect(parseTimestamp("90")).toBe(90);
    expect(parseTimestamp("90.5")).toBe(90.5);
    expect(parseTimestamp("00:03.2")).toBeCloseTo(3.2);
    expect(parseTimestamp("1:20.5")).toBeCloseTo(80.5);
    expect(parseTimestamp("00:01:30")).toBe(90);
  });

  it("rejects nonsense", () => {
    expect(parseTimestamp("")).toBeUndefined();
    expect(parseTimestamp("abc")).toBeUndefined();
    expect(parseTimestamp("1:2:3:4")).toBeUndefined();
    expect(parseTimestamp("-5")).toBeUndefined();
  });

  it("formats back into mm:ss.s / h:mm:ss.s", () => {
    expect(formatTimestamp(3.2)).toBe("00:03.2");
    expect(formatTimestamp(80.5)).toBe("01:20.5");
    expect(formatTimestamp(3671)).toBe("1:01:11.0");
  });
});

describe("parseFfprobeJson", () => {
  it("maps streams and format duration", () => {
    const meta = parseFfprobeJson(FFPROBE_JSON, 1024);
    expect(meta).toEqual({
      durationSeconds: 133.5,
      width: 1920,
      height: 1080,
      fps: 29.97,
      hasAudio: true,
      bytes: 1024,
      videoCodec: "h264",
    });
  });

  it("returns undefined when there is no video stream", () => {
    expect(parseFfprobeJson(JSON.stringify({ streams: [{ codec_type: "audio" }] }), 1)).toBeUndefined();
    expect(parseFfprobeJson("not json", 1)).toBeUndefined();
  });

  it("renders a one-line description", () => {
    const meta = parseFfprobeJson(FFPROBE_JSON, 5 * 1024 * 1024);
    expect(describeVideoMeta("clip.mp4", meta!)).toContain("1920x1080");
    expect(describeVideoMeta("clip.mp4", meta!)).toContain("audio: yes");
  });
});

describe("probeVideo (meta)", () => {
  it("returns duration/resolution with zero images", async () => {
    const { file } = await makeVideo();
    const runner = fakeRunner();
    const result = await probeVideo(file, "clip.mp4", runner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toBeUndefined();
    expect(result.meta?.durationSeconds).toBe(133.5);
    expect(result.output).toContain("1920x1080");
    // 0 图：只调了 ffmpeg -version 与 ffprobe
    expect(runner.calls.some((call) => call.args.includes("tile=3x3"))).toBe(false);
  });

  it("explains how to install ffmpeg instead of throwing", async () => {
    const { file } = await makeVideo();
    const result = await probeVideo(file, "clip.mp4", fakeRunner({ ffmpeg: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.output).toContain("MEOWCODE_FFMPEG");
  });
});

describe("grabStoryboard", () => {
  it("renders exactly 9 frames in a single 3x3 tile call", async () => {
    const { file } = await makeVideo();
    const runner = fakeRunner();
    const result = await grabStoryboard(file, "clip.mp4", {}, runner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
    expect(result.output).toContain("3x3 contact sheet");
    for (let index = 1; index <= STORYBOARD_FRAMES; index += 1) {
      expect(result.output).toContain(`frame ${index} = `);
    }
    const renders = runner.calls.filter((call) => call.args.includes("-vf"));
    expect(renders).toHaveLength(1);
    const filter = renders[0].args[renders[0].args.indexOf("-vf") + 1];
    expect(filter).toMatch(/^fps=[\d.]+,scale=512:-1,tile=3x3$/);
    // 9 帧 / 133.5 秒 ≈ 0.0674 fps
    expect(Number(filter.slice(4).split(",")[0])).toBeCloseTo(STORYBOARD_FRAMES / 133.5, 4);
  });

  it("returns an actionable error when ffmpeg cannot render", async () => {
    const { file } = await makeVideo();
    const result = await grabStoryboard(file, "clip.mp4", {}, fakeRunner({ failRender: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.output).toContain("could not render a storyboard");
  });

  it("rejects an empty range", async () => {
    const { file } = await makeVideo();
    const result = await grabStoryboard(file, "clip.mp4", { start: "60", end: "60" }, fakeRunner());
    expect(result.ok).toBe(false);
  });
});

describe("grabFrames", () => {
  it("renders up to 4 requested timestamps", async () => {
    const { file } = await makeVideo();
    const runner = fakeRunner();
    const result = await grabFrames(file, "clip.mp4", ["00:03", "1:20.5", "10"], runner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(3);
    expect(result.output).toContain("frame 1 = 00:03.0");
    expect(result.output).toContain("frame 2 = 01:20.5");
  });

  it("rejects more than 4 frames without invoking ffmpeg", async () => {
    const { file } = await makeVideo();
    const runner = fakeRunner();
    const tooMany = Array.from({ length: MAX_FRAMES + 1 }, (_, index) => String(index + 1));
    const result = await grabFrames(file, "clip.mp4", tooMany, runner);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.output).toContain("At most 4 frames");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects an empty timestamp list", async () => {
    const { file } = await makeVideo();
    const result = await grabFrames(file, "clip.mp4", [], fakeRunner());
    expect(result.ok).toBe(false);
  });

  it("rejects a timestamp past the end", async () => {
    const { file } = await makeVideo();
    const result = await grabFrames(file, "clip.mp4", ["500"], fakeRunner());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.output).toContain("past the end");
  });
});

describe("temp directory hygiene", () => {
  it("removes the working directory after success and after failure", async () => {
    const { file } = await makeVideo();
    const before = await leftoverTempDirs();
    const dirs: string[] = [];

    const captureRunner: ProcessRunner = async (command, args) => {
      if (args.includes("-version")) return { status: 0, stdout: "", stderr: "" };
      if (args.includes("-print_format")) return { status: 0, stdout: FFPROBE_JSON, stderr: "" };
      const out = args.at(-1) ?? "";
      if (out) dirs.push(path.dirname(out));
      await fs.writeFile(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return { status: 0, stdout: "", stderr: "" };
    };

    const ok = await grabStoryboard(file, "clip.mp4", {}, captureRunner);
    expect(ok.ok).toBe(true);
    const failed = await grabStoryboard(file, "clip.mp4", {}, async (command, args) => {
      if (args.includes("-version")) return { status: 0, stdout: "", stderr: "" };
      if (args.includes("-print_format")) return { status: 0, stdout: FFPROBE_JSON, stderr: "" };
      const out = args.at(-1) ?? "";
      if (out) dirs.push(path.dirname(out));
      return { status: 1, stdout: "", stderr: "boom" };
    });
    expect(failed.ok).toBe(false);

    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      await expect(fs.stat(dir)).rejects.toThrow();
    }
    // 不残留新的 meowcode-video-* 目录
    const after = await leftoverTempDirs();
    expect(after.length).toBeLessThanOrEqual(before.length);
    vi.restoreAllMocks();
  });
});
