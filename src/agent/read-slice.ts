/**
 * read_file 与 @文件注入共用的切片器。
 *
 * 两条通道必须给模型同一套格式：`N: ` 行号前缀 + `use offset=M` 续读提示。
 * 否则模型会怀疑 @ 注入的内容不完整，再 read_file 读一遍 —— 一次往返的代价
 * 远高于多注入几百 token。
 */

export interface SliceOptions {
  /** 预算；单位由 cost 决定（默认按字符计）。 */
  budget: number;
  /** 单行成本；默认按字符计，@注入传 estimateTokens 按 token 计。 */
  cost?: (text: string) => number;
  /** 1-based 起始行。 */
  start?: number;
  /** 最多取多少行。 */
  maxLines?: number;
  /** 不追加续读提示行（read_file 落盘形态自己拼头尾之间的提示）。 */
  omitNotes?: boolean;
}

export interface SliceResult {
  /** 带 `N: ` 行号前缀的正文 + 续读提示。 */
  text: string;
  /** 实际给出的行数。 */
  shown: number;
  /** 文件总行数。 */
  total: number;
  /** 最后给出的行号；小于 start 表示一行都没给出。 */
  lastLine: number;
}

const DEFAULT_MAX_LINES = 400;

export function sliceLinesForModel(content: string, options: SliceOptions): SliceResult {
  const cost = options.cost ?? ((text: string) => text.length);
  const start = Math.max(1, options.start ?? 1);
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  let used = 0;
  let lastLine = start - 1;
  let clippedFirstLine = false;

  for (let index = start - 1; index < lines.length && selected.length < maxLines; index += 1) {
    let line = `${index + 1}: ${lines[index]}`;
    const remaining = options.budget - used;
    if (remaining <= 0 && selected.length > 0) break;
    const lineCost = cost(line);
    if (lineCost > remaining && selected.length > 0) break;
    if (lineCost > remaining) {
      // 第一行就超预算：按比例硬切，至少给出开头一段，别把整行丢空
      const keep = Math.max(0, Math.floor((line.length * remaining) / lineCost) - 40);
      line = `${line.slice(0, keep)} ... [line truncated]`;
      clippedFirstLine = true;
    }
    selected.push(line);
    used += cost(line) + 1;
    lastLine = index + 1;
  }

  const notes: string[] = [];
  if (options.omitNotes) {
    // 调用方自己拼提示（落盘形态的提示要放在头尾之间，不能拼在头段末尾）
  } else if (lastLine < lines.length) {
    notes.push(`... [${lines.length - lastLine} more lines; use offset=${lastLine + 1}]`);
  } else if (clippedFirstLine) {
    // 单行就超预算（压缩过的 js/css/json）：offset 续读没有意义，只能靠搜索定位
    notes.push("... [the first line alone exceeds the budget; use grep to locate a section]");
  }

  return {
    text: [selected.join("\n"), ...notes].filter(Boolean).join("\n"),
    shown: selected.length,
    total: lines.length,
    lastLine,
  };
}
