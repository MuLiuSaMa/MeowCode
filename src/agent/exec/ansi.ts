/**
 * 命令输出里的 ANSI 控制序列清理（流式、跨 chunk）。
 *
 * 为什么要在执行层做：`$PSStyle.OutputRendering='PlainText'` 只能管住 PowerShell
 * 自己的渲染；原生工具（git / npm / 各种 CLI）照样往管道里塞彩色码和光标控制。
 * 这些字节对模型是纯噪音 —— 既费 token，又会把结构化输出切得看不出结构。
 *
 * 为什么必须跨 chunk：一次读到的缓冲区经常正好切在 `ESC` 与 `[`、或 CSI 参数中间，
 * 逐 chunk 丢弃会漏掉半个序列、把后续正文吃掉。这里用状态机把未完成的序列留到下一块。
 */

const ESC = 0x1b;
const BEL = 0x07;
const EMPTY = Buffer.alloc(0);

type State = "ground" | "esc" | "csi" | "string" | "stringEsc";

export type AnsiStripper = {
  /** 喂一块字节，返回已清理的字节（可能是空） */
  push(chunk: Buffer): Buffer;
  /** 收尾：把悬空的不完整序列丢掉（不会补出内容） */
  flush(): Buffer;
};

export function createAnsiStripper(): AnsiStripper {
  let state: State = "ground";

  return {
    push(chunk: Buffer): Buffer {
      const out: number[] = [];
      for (const byte of chunk) {
        switch (state) {
          case "ground":
            // 只有 ESC 会开启序列；其余字节（含所有 >=0x80 的多字节内容）原样透传
            if (byte === ESC) {
              state = "esc";
              break;
            }
            out.push(byte);
            break;
          case "esc":
            if (byte === ESC) {
              // 连续 ESC：上一个序列作废，重新开始
              state = "esc";
            } else if (byte === 0x5b) {
              state = "csi"; // '['
            } else if (byte === 0x5d || byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f) {
              state = "string"; // OSC ']' / DCS 'P' / SOS 'X' / PM '^' / APC '_'
            } else {
              // 单字符 ESC 序列（如 ESC c 复位），扔掉这两个字节
              state = "ground";
            }
            break;
          case "csi":
            // CSI 的终止字节是 0x40–0x7E；中间的参数/中间字节全部吞掉
            if (byte >= 0x40 && byte <= 0x7e) state = "ground";
            break;
          case "string":
            if (byte === BEL) state = "ground";
            else if (byte === ESC) state = "stringEsc";
            break;
          case "stringEsc":
            // ST = ESC '\'；不是反斜杠就继续当字符串内容吞掉
            state = byte === 0x5c ? "ground" : "string";
            break;
        }
      }
      return out.length ? Buffer.from(out) : EMPTY;
    },
    flush(): Buffer {
      // 悬空序列（输出被截断在半个序列里）直接丢弃，不泄漏控制字节
      state = "ground";
      return EMPTY;
    },
  };
}

/** 一次性清理整段文本（测试与错误信息用；流式路径请用 createAnsiStripper）。 */
export function stripAnsi(text: string): string {
  const stripper = createAnsiStripper();
  return Buffer.concat([stripper.push(Buffer.from(text, "utf8")), stripper.flush()]).toString("utf8");
}

/** 这坨字节里是否含 ANSI 控制序列（含跨块残片）；用于决定要不要走清理路径的分支判断。 */
export function hasAnsi(value: Buffer | string): boolean {
  if (typeof value === "string") return value.includes("\u001b");
  return value.includes(ESC);
}
