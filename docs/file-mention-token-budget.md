# @文件引用注入的 Token 预算：MeowCode vs opencode / ZCode / deepseek-harness

> 视角：**@文件 mention 的上下文注入成本**。不讨论补全面板 UI，只讨论「一次 @ 要塞多少 token、超了怎么办、模型怎么知道该续读」。
> 调研对象：`src/agent/`（MeowCode 自身）、`opencode-2/`、`ZCode-main/`、`deepseek-harness-master/`。
> 所有现状断言均带 `文件:行号`。

---

## 1. 结论摘要

1. **最坏不是 45k token，是 180k。** `MAX_TOTAL_CHARS = 180_000`（`src/agent/file-mentions.ts:6`）配 `estimateTokens` 的 CJK 1:1 规则（`src/agent/context.ts:9-13`），代码类内容约 45k token，中文文档类内容直接 180k token —— 单轮吃掉 200k 窗口的 90%。按 45k 评估会低估风险 4 倍。

2. **比 token 更严重的是静默丢文件。** `if (total + clipped.length > MAX_TOTAL_CHARS) break;`（`file-mentions.ts:52`）用 `break` 而不是均分。8 个 60k 文件时，前 3 个占满 180k，**@4~@8 完全不进上下文且无任何提示**。用户以为注入了 8 个，模型只看到 3 个。

3. **@ 通道绕过了工具层预算。** `read_file` 的单次上限是 20k 字符 / 400 行（`tools.ts:22,27`），而 @ 的单文件上限是 60k 字符（`file-mentions.ts:5`）—— **@ 比工具读取还宽松 3 倍**，同一文件走两条通道拿到的内容量不一致。

4. **截断信息不可用。** `${content.slice(0, MAX_FILE_CHARS)}\n...[file truncated]`（`file-mentions.ts:50`）没有行号、没有总行数、没有续读方式。模型只知道"被截断了"，不知道从哪续读，于是要么忽略，要么再 `read_file` 读一遍全文 —— 等于两次浪费。

5. **三家开源项目的共识：@ 不该是独立的注入通道。** ZCode 把 @ 的内容**伪装成一次 `Read` 工具调用结果**（`prompt-attachment.ts:74-101`），复用工具的截断器和行号格式；opencode 传 `file://` URI 让后端读（`prompt.ts:114-123`）；deepseek-harness 溢出落盘并给 spill locator（`session-reference.md:210`）。**没有一家把文件全文拼成 `<file>` 标签塞进 user 消息。**

6. **最省事的改法不是加参数，是删代码。** MeowCode 已有 `readTextFile(..., { headOnly: true })` + 400 行 + 行号 + `use offset=M` 续读提示的完整实现（`tools.ts:526-564`），@ 只要复用它就能同时拿到预算、行号、续读指令三件事，净减代码。

7. **以上 1~4 已按档 B 全部修复**（实现见第 5 节，迁移点见第 6 节）。第 2 节保留改动前的账，作为风险依据。

---

## 2. 现状与实测账

### 2.1 常量表

| 常量 | 值 | 位置 | 作用 |
|---|---|---|---|
| `MAX_MENTION_FILES` | 8 | `file-mentions.ts:4` | 单轮最多处理 8 个 @ |
| `MAX_FILE_CHARS` | 60_000 | `file-mentions.ts:5` | 单文件字符上限 |
| `MAX_TOTAL_CHARS` | 180_000 | `file-mentions.ts:6` | 单轮总字符上限 |
| `MAX_FILE_BYTES` | 2_000_000 | `file-mentions.ts:7` | 超过直接跳过 |
| `BINARY_SNIFF_BYTES` | 4_096 | `file-mentions.ts:8` | 二进制嗅探窗口 |
| `MAX_OUTPUT_CHARS` | 20_000 | `tools.ts:22` | 工具输出上限 |
| `MAX_READ_LINES` | 400 | `tools.ts:27` | read_file 默认行数 |

### 2.2 三个算错的账

**账一：CJK 让预算放大 4 倍。**

```ts
// src/agent/context.ts:9-13
const CJK_CHAR_PATTERN = /[\u3000-\u30ff...]/g;
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK_CHAR_PATTERN)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);   // CJK 1 字符 = 1 token
}
```

180k 字符的纯中文 = **180k token**。@ 一个中文 Markdown 文档（比如本项目的 `docs/` 下任意一份 27KB 的 md），单轮就能把 32k 小窗口模型打爆，200k 窗口也用掉九成。

**账二：`break` 让文件消失。**

8 个文件各 60k 字符时的实际执行轨迹：

```
@1  total=0     +60k = 60k   ✓ 注入
@2  total=60k   +60k = 120k  ✓ 注入
@3  total=120k  +60k = 180k  ✓ 注入（180k > 180k 为假，刚好通过）
@4  total=180k  +60k = 240k  ✗ break → @4~@8 全部丢弃
```

`break` 而不是 `continue`，意味着**后面的小文件也拿不到**。就算 @5 是个 100 字节的配置，也一起没了。

**账三：读 2MB 再切 60k。**

`file-mentions.ts:44` 是 `await fs.readFile(target)` —— 整文件读进内存，然后 `:48-50` 才切到 60k 字符。`read_file` 工具走的是 `readTextFile(file, { headOnly: true })`（`tools.ts:535`），有 headOnly 优化。@ 一个 2MB 的日志文件，白读 33 倍数据，还多占一次堆。

### 2.3 累积驻留

`appendContextNote(fileContext, "file")`（`runtime.ts:1028`）写入的是普通 user 消息（`session-store.ts:583`），会一直留在 `effectiveMessages` 里直到被压缩或裁剪。

`MAX_TOTAL_CHARS` 是**每轮**的上限，不是会话上限。连续 3 轮各 @ 一个大文件：

| 轮次 | 新增 | 上下文累计（ASCII 估算） | 200k 窗口占用 |
|---|---|---|---|
| 1 | 45k token | 45k | 22% |
| 2 | 45k token | 90k | 45% |
| 3 | 45k token | 135k | 68% |
| 4 | 45k token | 180k | **90% → 触发压缩** |

压缩会把前 3 轮的真实对话挤成一段摘要。用户体感是"聊了几轮之后模型忘了前面说过什么"，但根因是 @ 文件把窗口吃光了。

### 2.4 与 read_file 的不一致

同一份 800 行的源码文件：

| 通道 | 拿到多少 | 行号 | 续读提示 |
|---|---|---|---|
| `read_file` | 400 行 / 20k 字符 | `N: ` 前缀 | `... [400 more lines; use offset=401]` |
| `@` 引用 | 全文件（≤60k 字符） | 无 | 无 |

模型在两条通道看到的同一文件格式完全不同，这是让它"@ 之后又 read_file 读一遍"的直接原因 —— 它不确定 @ 进来的东西是否完整。

---

## 3. 四家做法对比

| 维度 | MeowCode | opencode | ZCode（Claude Code 分支） | deepseek-harness |
|---|---|---|---|---|
| 注入形态 | 文本拼进 user 消息 | `file://` URI 附件 | 伪装成 `Read` 工具结果 | 引用 + 落盘定位符 |
| 预算单位 | 字符 | 字节 | **token** | 字节（64 KiB） |
| 单文件上限 | 60k 字符 | 20 MB | **25k token** | 64 KiB |
| 超限行为 | 硬切 + `break` 丢文件 | 不截断 | **按行二分取前缀 + 部分视图** | 截断预览 + 落盘 |
| 行号 | 无 | 无 | **`N\t` 前缀** | 无 |
| 续读引导 | 无 | 无 | **`use Read with offset=N`** | spill locator |
| 非文本文件 | 静默跳过 | 二进制附件 | **只给路径引用** | — |
| 重复 @ | 重复全量注入 | 去重（`used` Set） | — | — |

### 3.1 opencode：URI 引用 + 行范围

`packages/app/src/composer/request.ts:105-115` 把 @ 转成 `file://` URI，行选择编码在 query 里：

```ts
const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""
```

后端 `packages/core/src/session/prompt.ts:114-123` 按行范围切片：

```ts
const content = mime === "text/plain" && resolved.start !== undefined
  ? Buffer.from(Buffer.from(resolved.bytes).toString("utf8")
      .split("\n").slice(resolved.start - 1, resolved.end).join("\n"))
  : resolved.bytes
```

**优点**：用户在编辑器里选中 20 行再 @，就只注入 20 行，精度最高。
**缺点**：没有全局预算，上限 20MB（`prompt.ts:203`），模型一次性读 20MB 文本没有任何拦截。格式是 `Attached file: <name>\n<全文>`（`to-llm-message.ts:37-54`），同样无行号、无续读提示。

### 3.2 ZCode：复用工具读取器（最值得抄）

ZCode 的关键决策：**@ 不产生新格式，它产生一次"已经发生过的 Read 调用"**。

`system-reminder/prompt-attachment.ts:74-101`：

```ts
const blocks = [
  systemReminderBody(
    `Called the ${toolName} tool with the following input: ${JSON.stringify({ [inputKey]: inputValue })}`,
  ),
  systemReminderBody([
    `Result of calling the ${toolName} tool:`,
    formatReadTextResult({ content, partialViewNotice, startLine, totalLines }),
  ]),
];
```

模型看到的是：

```
<system-reminder>Called the Read tool with the following input: {"file_path":"src/a.ts"}</system-reminder>
<system-reminder>Result of calling the Read tool:
1	import { foo } from "./foo.js"
2	...
</system-reminder>
```

**三个收益，一个代价：**

1. 格式与真实工具结果**完全同构** → 模型不会重复调用 `read_file` 验证
2. 预算天然复用工具的 25k token 上限（`contracts/src/tools/read.ts:16`）→ 不需要第二套预算
3. 续读提示与工具一致 → `partialViewNotice` 里就是 `Use Read with offset 401 and limit 2000 to continue`（`read-text.ts:183-188`）
4. 代价：@ 的内容看起来像工具调用，前端要把 system-reminder 隐藏掉（ZCode 用 `wrapSystemReminderForSource("prompt_attachment", body)` 打标签，UI 按 source 过滤）

它的截断器是二分找最大前缀行（`read-text.ts:210-222`），**按行边界切，不会切坏一行代码**：

```ts
function findLargestPrefixWithinTokenBudget(lines: readonly string[]): number {
  let low = 0, high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(lines.slice(0, mid).join("\n")) <= READ_TOKEN_BUDGET_PARTIAL_TARGET) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}
```

`READ_TOKEN_BUDGET_PARTIAL_TARGET = floor(25_000 * 0.85)`（`read-text.ts:18`）—— 留 15% 给行号前缀和警告文本。

还有两个细节值得注意：

- **非文本扩展名只给路径引用**（`attachments.ts:273-282`），注入文本只有三行：
  ```
  Attached text/plain: <path>
  The file was sent by local path because the file is not a known text attachment.
  Use the available file reading tools if you need to inspect the file contents.
  ```
- **超过 256KB 的文件只读前 2000 行**（`attachments.ts:299-312`），走 `allowPartialFallback: true` 拿部分视图而不是报错。

### 3.3 deepseek-harness：预算 + 落盘 + 定位符

`docs/subsystems/session-reference.md:209-210`：

> Missing model capacity or adapter uses 64 KiB; ... Truncated previews include omission facts and a full-snapshot spill locator, or an explicit unavailable notice.

思路是"**截断必须留下三个事实**：截了什么、原文在哪、怎么拿回来"。MeowCode 的 `persistToolOutput`（`tools.ts:82-91`）已经有落盘能力，只是 @ 通道没用。

---

## 4. 建议方案

### 4.1 核心思路

> **@ 不要自己造预算和格式，去复用 `read_file` 的。**

理由：`read_file` 已经解决了"读多少、怎么切、怎么告诉模型续读"三件事，而且模型对它的输出格式已经形成了稳定预期。再造一套只会让模型困惑。

### 4.2 三档落地

> **最终落地的是档 B**（第 5 节），档 A 的 bug 修复被档 B 完整覆盖。

#### 档 A：修 bug（最小改动）

只做两件事，风险最低：

1. `break` → 均分。超预算时不再丢弃后续文件，改为按文件数均分预算。
2. 单文件上限 60k → 20k 字符，与 `read_file` 对齐（`tools.ts:22`）。

```ts
// file-mentions.ts
const MAX_FILE_CHARS = 20_000;      // 与 MAX_OUTPUT_CHARS 对齐
const MAX_TOTAL_CHARS = 60_000;     // 3 个满额文件

// 先按文件数均分，再逐文件截断，不再 break
const perFile = Math.max(4_000, Math.floor(MAX_TOTAL_CHARS / mentions.length));
for (const mention of mentions) {
  const limit = Math.min(MAX_FILE_CHARS, perFile);
  // ... 用 limit 截断，不再检查 total 后 break
}
```

收益：8 文件全部可见、单轮最坏 60k 字符（15k token ASCII）。但 CJK 仍是 60k token，截断仍无行号。

#### 档 B：对齐 read_file 语义（已落地）

在档 A 基础上，把截断器换成 `read_file` 的那一套：

1. **按行切 + 行号前缀**，复用 `tools.ts:546-557` 的循环逻辑（`${index + 1}: ${line}`）
2. **按 token 而非字符算预算**，复用 `estimateTokens`（`context.ts:9`）
3. **续读提示与 `read_file` 一字不差**：`... [N more lines; use offset=M]`（`tools.ts:559`）
4. **注入格式对齐 Read 结果**（学 ZCode），前缀文案保持不变以兼容 `isInjectedUserMessage`（`context.ts:119` 依赖 `"The user referenced these workspace files with @mentions."` 这串字面量）

预算值建议：

```ts
/** 单轮 @ 的总 token 预算：跟随窗口，夹在 [2k, 12k]。 */
export function mentionTokenBudget(contextWindow?: number | null): number {
  if (!contextWindow || contextWindow <= 0) return 8_000;
  return Math.min(12_000, Math.max(2_000, Math.round(contextWindow * 0.05)));
}
```

| 窗口 | 预算 | 占比 |
|---|---|---|
| 32k | 2_000 token | 6% |
| 128k | 6_400 token | 5% |
| 200k | 10_000 token | 5% |
| 1M | 12_000 token（封顶） | 1.2% |

单文件上限 = `min(5_000, 预算 / 文件数)`，但每个文件保底 800 token（约 30 行代码），保证 8 个文件都有可辨认的头部。

#### 档 C：非文本与溢出（进阶，可选）

1. 非文本文件只注入路径引用，不读内容（**已实现**，用二进制黑名单 + NUL 嗅探，见第 5 节）
2. 被截断且剩余内容很多的文件，用 `persistToolOutput` 落盘并在提示里给路径（**未实现**）
3. 已注入过的文件（同会话内）只给占位（**已实现**，见第 5 节）

---


## 5. 落地实现（已完成）

### 5.1 改动文件

| 文件 | 改动 |
|---|---|
| `src/agent/read-slice.ts` | **新增**。`sliceLinesForModel` —— `read_file` 与 @注入共用的切片器 |
| `src/agent/file-mentions.ts` | 重写。token 预算 + 均分 + ZCode 式注入 + 去重 + 二进制路径引用 |
| `src/agent/tools.ts` | `readFile` 改调共享切片器，删掉 30 行重复循环 |
| `src/agent/runtime.ts` | 调用点传入 `mentionTokenBudget(provider.contextWindow)` 与已注入路径集合 |
| `src/agent/file-mentions.test.ts` | 4 → 11 个用例 |

净效果：`file-mentions.ts` 从 66 行到约 200 行（多了预算与去重），但 `tools.ts` 少了一套重复的行切片逻辑，**两条通道从此只有一个真相源**。

### 5.2 核心机制

**① 把 @ 伪装成已经发生过的 `read_file` 调用**（照搬 ZCode）：

```
The user referenced these workspace files with @mentions. Their contents are pre-loaded
below as read_file results: continue from where a result stops instead of reading the
whole file again.

<system-reminder>
Called the read_file tool with the following input: {"path":"src/a.ts"}
</system-reminder>
<system-reminder>
Result of calling the read_file tool:
1: export function foo() {
2:   return 1;
...
... [800 more lines; use offset=201]
</system-reminder>
```

三个关键点：

- 工具名用 MeowCode 真实的 `read_file`（不是 ZCode 的 `Read`），参数名用 `path`（不是 `file_path`）—— 伪装的工具名必须与真实工具一致，否则模型照着调会失败
- 行号前缀 `N: ` 与 `read_file` 完全一致（`tools.ts` 原有格式）
- 续读提示 `... [N more lines; use offset=M]` 与 `read_file` 一字不差

**② 首行保留原字面量**，`isInjectedUserMessage`（`context.ts:119`）不需要改：

```ts
const INTRO =
  "The user referenced these workspace files with @mentions. " +
  "Their contents are pre-loaded below as read_file results: continue from where a result stops instead of reading the whole file again.";
```

**③ 预算按 token 且跟随窗口**：

```ts
export function mentionTokenBudget(contextWindow?: number | null): number {
  if (!contextWindow || contextWindow <= 0) return 8_000;
  return Math.min(12_000, Math.max(2_000, Math.round(contextWindow * 0.05)));
}
```

**④ 均分而不是 `break`**：`perFile = clamp(budget / 文件数, 800, 5000)`。超预算时每个文件少给一点，而不是让第 4 个之后静默消失。

**⑤ 只读头部**：`readHead` 按 `tokenLimit * 8` 字节读（CJK 3 字节/字符 × 余量），不再 `fs.readFile` 全量读 2MB 再切。切点落在多字节序列中间时丢掉无换行符的残尾，避免 `U+FFFD`。

**⑥ 二进制只给路径**：明确二进制的扩展名（`BINARY_FILE_PATTERN`）不读内容；扩展名看不出来的（`.dat` / 无后缀）读 4KB 嗅探 NUL 兜底。用黑名单而不是白名单 —— `.dat` / `.proto` 也可能是文本，漏判会让用户 @ 了却拿不到内容。

**⑦ 同会话去重**：`collectInjectedPaths` 从历史 user 消息里扫 `{"path":"..."}`，命中的只给 59 token 的占位：

```
<system-reminder>
Already read earlier in this conversation: {"path":"src/a.ts"}
Re-read it only if you need its current contents.
</system-reminder>
```

路径要 JSON 反转义后再归一（`\\` → `/`），否则 Windows 路径去重会失效。

### 5.3 共享切片器

`read-slice.ts` 是整个改动的支点 —— 它让「工具读」和「@注入」不可能再漂移：

```ts
export function sliceLinesForModel(content: string, options: SliceOptions): SliceResult {
  const cost = options.cost ?? ((text: string) => text.length);
  // ...
  for (let index = start - 1; index < lines.length && selected.length < maxLines; index += 1) {
    let line = `${index + 1}: ${lines[index]}`;
    const remaining = options.budget - used;
    if (remaining <= 0 && selected.length > 0) break;
    const lineCost = cost(line);
    if (lineCost > remaining && selected.length > 0) break;
    if (lineCost > remaining) {
      const keep = Math.max(0, Math.floor((line.length * remaining) / lineCost) - 40);
      line = `${line.slice(0, keep)} ... [line truncated]`;
      clippedFirstLine = true;
    }
    selected.push(line);
    used += cost(line) + 1;
    lastLine = index + 1;
  }
  // ...
}
```

`cost` 是唯一的分歧点：`read_file` 用默认的字符成本（保持既有 20k 字符预算不变），@注入传 `estimateTokens`（按 token 预算）。**格式、行号、续读提示完全共用。**

单行就超预算的情况（压缩过的 js/css/json）额外给一条提示 —— 此时 `offset` 续读没有意义：

```
... [the first line alone exceeds the budget; use grep to locate a section]
```

### 5.4 实测数据

200k 窗口（预算 10k token）下跑真实文件：

| 场景 | 改动前 | 改动后 |
|---|---|---|
| 8 个各 1200 行文件（56k 字符/个） | 只有前 3 个注入，**后 5 个消失**；约 45k token | **8/8 全部注入**，9280 token，8 条续读提示 |
| 1 个 54k 字符中文单行文件 | 全量注入 54k token，无提示 | 5077 token，带 `use grep` 提示 |
| 重复 @ 同一文件（第二轮） | 再注入一遍全量 | **85 token** 占位 |

测试基线：`339 passed`（原 327 + 12），`tsc --noEmit` 干净。

---

## 6. 已处理的迁移点

1. **`isInjectedUserMessage` 的字面量依赖**（`context.ts:119`）—— 首行保持 `"The user referenced these workspace files with @mentions."` 原样，裁剪逻辑无需改动。**后续改文案必须同步改 `context.ts:119`**，否则 @ 上下文会被当成"最后一个真实用户回合"强制保留。

2. **`<file path="...">` 标签已废弃**，改为 `{"path":"..."}` JSON 形式（ZCode 式注入块内）。`collectInjectedPaths` 用 `/\{"path":"((?:[^"\\]|\\.)*)"\}/g` 提取并做 JSON 反转义。如果以后要改注入格式，两处一起改。

3. **`file-mentions.test.ts` 已重写**（4 → 11 个用例）：新增伪装格式、8 文件均分、按行截断、二进制路径引用、NUL 嗅探兜底、去重占位、`collectInjectedPaths`、`mentionTokenBudget` 边界。

4. **去重的过期风险仍在**：文件在两轮之间被 `edit_file` 改过时，占位会让模型看到旧内容的锚点。当前用 "Re-read it only if you need its current contents" 兜底，**尚未**在编辑类工具执行后把路径从 seen 集合移除 —— 如果后续发现模型因此读到旧内容，应该在 `tools.ts` 的 edit/write 分支里做失效标记（比如给 context note 追加一行 `[stale: modified at turn N]`）。

5. **`read_file` 行为未变**：`MAX_OUTPUT_CHARS = 20_000`、`MAX_READ_LINES = 400` 保持不变，只是内部改调共享切片器。单行超预算时多了一条 `use grep` 提示（此前只有 `[line truncated]`）。

6. **`dist/` 需要重新构建**：`pnpm start:server` 跑的是 `dist/agent/*.js`，改动只在 `src/` 里生效于 `dev:server`（tsx watch）。打包前跑 `pnpm build:agent`。
## 7. 不建议做的事

1. **不要引入第二套 token 计数器。** 已有 `estimateTokens`（`context.ts:9`），它对 CJK 的 1:1 估计偏保守，正好适合做预算上限。再写一个精确分词器只会引入不一致。

2. **不要给 @ 做"结构大纲"（只注入函数签名）。** 实现复杂，且模型对"只看到签名"的文件容易产生错误判断（以为函数体是空的）。真需要省 token，让它用 `grep` 或 `read_file offset`。

3. **不要抄 codex 的补丁协议式 thinking。** 与 @ 无关，别扩大改动面。

4. **不要为了省 token 把 `MAX_MENTION_FILES` 降到 4。** 用户 @ 了 8 个就是想要 8 个，静默丢掉 4 个比多烧 5k token 更糟。均分预览是更好的取舍。
