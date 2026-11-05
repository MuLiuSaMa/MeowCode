import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import { commandEnv } from "./env.js";

/** chcp 码页 → WHATWG TextDecoder 标签；437 等无标签的码页宁可不回退也不猜。 */
const LEGACY_OUTPUT_LABELS: Record<number, string> = {
  936: "gb18030",
  54936: "gb18030",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  866: "ibm866",
};

let legacyOutputLabelPromise: Promise<string | undefined> | undefined;

/** 原生工具在管道里按系统 OEM 码页写字节；探测一次，失败就维持 UTF-8 现状。 */
function probeLegacyOutputLabel(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "chcp"], {
      windowsHide: true,
      env: commandEnv(),
    });
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (label: string | undefined) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill();
      resolve(label);
    };
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => finish(undefined));
    child.on("close", () => {
      // chcp 文案随系统语言变化（Active code page / 活动代码页），只取第一段数字
      const codePage = Buffer.concat(chunks).toString("latin1").match(/\d{3,5}/)?.[0];
      finish(codePage ? LEGACY_OUTPUT_LABELS[Number(codePage)] : undefined);
    });
    timer = setTimeout(() => finish(undefined), 1_000);
  });
}

export function getLegacyOutputLabel(): Promise<string | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  legacyOutputLabelPromise ??= probeLegacyOutputLabel();
  return legacyOutputLabelPromise;
}

/** 采集上限/超时可能把最后一个多字节字符截半；先剪掉残尾，避免整段被误判成旧码页。 */
function trimIncompleteUtf8Tail(buffer: Buffer): Buffer {
  for (let back = 1; back <= Math.min(3, buffer.length); back += 1) {
    const byte = buffer[buffer.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    if (byte >= 0xc2 && byte <= 0xf4) {
      const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
      if (back < need) return buffer.subarray(0, buffer.length - back);
    }
    break;
  }
  return buffer;
}

function decodeOutputSegment(segment: Buffer, legacy: TextDecoder | undefined): string {
  if (!segment.length) return "";
  let ascii = true;
  for (const byte of segment) {
    if (byte > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) return segment.toString("latin1");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(segment);
  } catch {
    return legacy ? legacy.decode(segment) : segment.toString("utf8");
  }
}

/**
 * 命令输出先按 UTF-8 解；整体解不通才逐段（\n / \r）按系统 OEM 码页回退。
 * Python（UTF-8 模式关闭）、Java 等原生工具仍会按 ANSI/GBK 写管道，
 * 而 PowerShell 5.1 的 cmdlet 输出已由 preamble 固定成 UTF-8——两者可能混在同一次输出里。
 */
export function decodeCommandOutput(buffer: Buffer, legacyLabel?: string): string {
  if (!buffer.length) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    // 采集上限/超时可能停在多字节字符中间：整体失败后才尝试剪掉残尾重试，
    // 不能先剪——GBK 的末字节也可能落在 UTF-8 前导字节区间（0xC2–0xF4）。
    const trimmed = trimIncompleteUtf8Tail(buffer);
    if (trimmed.length !== buffer.length) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(trimmed);
      } catch {
        // 不是截断的 UTF-8，继续走逐段回退
      }
    }
  }
  const legacy = legacyLabel ? new TextDecoder(legacyLabel) : undefined;
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    const byte = index === buffer.length ? -1 : buffer[index];
    if (byte !== -1 && byte !== 0x0a && byte !== 0x0d) continue;
    parts.push(decodeOutputSegment(buffer.subarray(start, index), legacy));
    if (byte !== -1) parts.push(byte === 0x0a ? "\n" : "\r");
    start = index + 1;
  }
  return parts.join("");
}

/**
 * 命令输出先按字节累积、结束时一次性解码。
 * 逐 chunk toString("utf8") 会把跨 chunk 边界的多字节字符（中文 Windows 上很常见）切成乱码；
 * 无上限累积则刷屏命令会先把内存吃满，truncateMiddle 根本没机会生效。
 */
export function createOutputSink(limit: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let decoded: string | undefined;
  return {
    push(chunk: Buffer): void {
      if (bytes >= limit) return;
      const room = limit - bytes;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      bytes += Math.min(chunk.length, room);
    },
    get capped(): boolean {
      return bytes >= limit;
    },
    buffer(): Buffer {
      return Buffer.concat(chunks);
    },
    text(legacyLabel?: string): string {
      decoded ??= decodeCommandOutput(Buffer.concat(chunks), legacyLabel);
      return decoded;
    },
  };
}
