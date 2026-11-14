# MeowCode 优化清单（基于 dsh-superagent 调研）

> 来源：`docs/reference/dsh-superagent.md` 的四项结论，落到 MeowCode 的具体改法。
> 原则：只做有明确收益、能独立验收的项；每项都标清改动面与验收方式。
> 本文不含代码改动，开工时按 §1 → §2 → §3 → §4 顺序推进。

## 怎么读

- **§0 是一页决策表**，只想看结论看它。
- **P0 两项可以直接开工**：不碰 `runtime.ts` 的业务逻辑，改动面小，当天能验收。
- **P1 需要先评审映射表**（§3.4），那张表决定了整个任务 UI 的语义。
- **P2 最重**，独立在 `desktop/` 主进程，可与 P1 并行。

优先级判据是三条，不按 dsh 的原始 ABCD：

1. 收益是否直接可感知（模型能不能拿回丢掉的输出 / 会不会漏审批）
2. 改动面是否够小（文件数 × 是否触碰 `runtime.ts` 这个 9550 行的热点）
3. 是否有明确验收口径（能写成断言或可观察现象）

## §0 一页决策表

| 编号 | 优化项 | 解决的问题 | 改动面 | 量级 | 风险 | 碰 runtime 业务逻辑 |
|---|---|---|---|---|---|---|
| **P0-1** | 工具集合一致测试 | 新加工具漏写契约、漏加审批 → 静默放行 | 新增 1 个测试文件 + `runtime.ts` 4 处 `export` | S（2 小时） | 无 | 否 |
| **P0-2** | 截断处留可续读指针 | MCP/插件工具与 `task` 子 Agent 输出超 3000 token 后**永久丢失** | 1 个新函数 + 3 个调用点 + 1 处防自增殖 | S（半天） | 低 | 否（只换调用） |
| **P1** | 任务阶段派生 | plan / subagent / workflow 三套状态互不相通；同一套图标逻辑写了两遍；「是否需要人处理」全仓没有判据 | 1 个纯函数文件 + 6 处 UI + 删 1 个死文件 | M（2~3 天） | 中 | 是（5 处 emit 附加字段） |
| **P2** | 自动化决策记录与 observe 档 | 定时任务到点闷头执行，无审计、无观察档；重试会建 2~3 个孤儿会话 | `scheduler.cjs` 拆 5 步 + 3 个组件 + i18n | L（1 周） | 中 | 否 |
| **暂缓** | 多 Agent 消息归属协议 | dsh 的 follow-up 所有权 | — | — | — | — |

**为什么暂缓消息归属**：MeowCode 没有「多条会话共享一条人类消息流」的场景（一个会话一个 runtime，子 Agent 的消息由父会话 `steer` 定向投递）。dsh 那套协议的真正内核是「同一条消息最多投递一次」的幂等键，这个能力在 P2 的 `triggerId` 里以更小的形态落地了（见 §4.4）。等出现多会话共享消息流的需求再引入完整协议。

## §1 P0-1：工具集合一致测试

### 1.1 现状

内置工具一共 **36 个**，分三处声明：

| 来源 | 数量 | 位置 |
|---|---|---|
| `toolDefinitions` | 28 | `src/agent/tools.ts:251-848` |
| `admitToolDefinition` | 1 | `src/agent/tools.ts:855`（仅 `governance !== "off"` 时下发） |
| `browserToolDefinitions` | 7 | `src/agent/browser-tools.ts:15` |

契约表 `BUILTIN_TOOL_CONTRACTS`（`src/agent/tool-contract.ts:70`）目前**恰好 36 个键**，与上面三处一一对应。

但只有一条单向断言：

```ts
// src/agent/tool-contract.test.ts:46-50
it("静态工具与治理工具都有契约", () => {
  for (const tool of [...toolDefinitions, admitToolDefinition]) {
    expect(BUILTIN_TOOL_CONTRACTS[tool.function.name], tool.function.name).toBeDefined();
  }
});
```

三个缺口：

1. **浏览器工具没进这个循环** —— 7 个 `browser_*` 加一个漏一个，测试都不会红
2. **反向没测** —— 删掉某个工具但契约表残留一个键，永远发现不了
3. **策略集合完全没绑** —— `APPROVAL_TOOLS`（`runtime.ts:346`）少写一个写工具，后果是**这个工具不弹审批直接执行**，这是全仓最危险的一类漂移

后者的现实威胁很具体：`tool-contract.ts` 的文件头注释自己写着

> 加工具时只需要改两处：本表 + 实现；漏改本表不会静默放行……这一点靠 code review 与 `tool-input.test.ts` 的覆盖清单兜住。

也就是说，目前只靠人眼。而 `APPROVAL_TOOLS` 连这份注释都没提到。

### 1.2 目标

新加一个工具、或从工具表删一个工具，**测试必须红**，不需要人记得去改某个集合。

### 1.3 方案

新建 `src/agent/tool-sets.test.ts`，三条断言，全部 `.sort()` 后比较：

**断言 1：schema 与契约表双向一一对应**

```ts
const staticNames = [
  ...toolDefinitions.map((d) => d.function.name),
  admitToolDefinition.function.name,
  ...browserToolDefinitions.map((d) => d.function.name),
].sort();

expect(Object.keys(BUILTIN_TOOL_CONTRACTS).sort()).toEqual(staticNames);
```

**断言 2：所有策略集合的成员都是真实工具**（防改名、防拼错、防工具删了集合还在）

遍历 `APPROVAL_TOOLS`、`WRITABLE_ROOT_TOOLS`、`BROWSER_APPROVAL_TOOLS`、`MEMORY_TOOL_NAMES`、`GOVERNANCE_GATED_TOOLS`、`PLAN_MUTATION_TOOLS`、`WRITE_TOOLS`、`READ_ONLY_PARALLEL_TOOLS`、`EXPLORE_TOOLS`、`VERIFIER_TOOLS`，每个名字都要在 `BUILTIN_TOOL_CONTRACTS` 里存在。

**断言 3：写类集合口径一致**

```ts
expect(sorted(WRITABLE_ROOT_TOOLS)).toEqual(sorted(WRITE_TOOLS));
expect(sorted(PLAN_MUTATION_TOOLS)).toEqual(sorted(WRITE_TOOLS));
expect(sorted(APPROVAL_TOOLS)).toEqual(sorted([...WRITABLE_ROOT_TOOLS, "run_command"]));
```

这三组当前都是「6 个文件写工具」的同一份事实，分散在 4 个文件里各写一遍。绑住之后，加第 7 个写工具时，四处任一漏改都直接红灯。

### 1.4 改动清单

| 文件 | 改什么 |
|---|---|
| `src/agent/tool-sets.test.ts` | **新建**，约 80 行 |
| `src/agent/runtime.ts:346` | `const APPROVAL_TOOLS` → `export const APPROVAL_TOOLS` |
| `src/agent/runtime.ts:368` | `const BROWSER_APPROVAL_TOOLS` → `export const ...` |
| `src/agent/runtime.ts:449` | `const WRITABLE_ROOT_TOOLS` → `export const ...` |
| `src/agent/runtime.ts:815` | `const MEMORY_TOOL_NAMES` → `export const ...` |

四处都只是加 `export`，零行为变更。其余集合已在各自文件导出，直接 import 即可。

注意 import 路径：`GOVERNANCE_GATED_TOOLS` 在 `workflow-runtime.ts:59`，`PLAN_MUTATION_TOOLS` 在 `plan-freshness.ts:18`，**都不在 `runtime.ts`**。

### 1.5 明确不纳入断言的东西

写进测试文件头部注释，避免后来人加断言时误报：

| 对象 | 为什么不纳入 |
|---|---|
| 动态工具（MCP/插件，`mcp__*` 等） | 运行时注册，`BUILTIN_TOOL_CONTRACTS` 里永远没有，`toolContractOf` 走「动态优先回落内置」 |
| `ALWAYS_VISIBLE_DYNAMIC_TOOLS`（`tools.ts:945`） | 同上，是动态名 |
| `types.ts` 的 `ToolName` 联合 | 已陈旧，只列了 17 个（缺 20 个）。拿它当基准第一版就红，**它本身该单独清理** |
| `runtime.computeTools()` 的运行时输出 | 按 `memoryEnabled` / `webSearchSupported()` / `enableTaskTool` / `governance` / profile 动态过滤，同一进程不同配置下不同。测试必须读模块级常量 |

### 1.6 验收

```bash
cd D:/MeowCode && npx vitest run src/agent/tool-sets.test.ts
```

三条手工验证（改完即还原，不要提交）：

1. 从 `tool-contract.ts` 删掉 `browser_back` 一条 → 断言 1 红
2. 从 `APPROVAL_TOOLS` 删掉 `write_file` → 断言 3 红
3. 往 `toolDefinitions` 加一个假工具 → 断言 1 红（漏契约）

### 1.7 风险

无。纯新增测试 + `export` 关键字。唯一的注意点是 `WRITE_TOOLS` / `PLAN_MUTATION_TOOLS` 是 `ReadonlySet`，比较前统一 `[...set].sort()`。

## §2 P0-2：截断处留可续读指针

### 2.1 现状

工具输出的截断有一个通用兜底：

```ts
// src/agent/tools.ts:90-96
export function truncateOutput(
  text: string,
  maxTokens = MAX_OUTPUT_TOKENS,   // 3_000，tools.ts:67
): { output: string; truncated: boolean } {
  const truncated = truncateToTokens(text, maxTokens);
  return { output: truncated.text, truncated: truncated.truncated };
}
```

截断后的文案来自 `tool-budget.ts:94`：

```
... [truncated <omitted> of <total> tokens]
```

**里面没有路径，没有 offset，没有「怎么拿回来」。**

对比一下仓库里已经做对了的地方 —— 一共有 6 处已实现「落盘 + 指针」，措辞高度统一：

| 位置 | 文案 |
|---|---|
| `tools.ts:188-224`（结构化搜索降级） | `... [N of M tokens omitted; full result saved to <path> — page it with read_file (offset/limit) instead of re-running this search]` |
| `tools.ts:1765`（`list_dir`） | `... [truncated: showing first N of M entries; full list saved to <path>]` |
| `tools.ts:1977`（`read_file` 超长） | `... [N lines omitted; full content of <name> saved to <path> — read that path with read_file (offset/limit) to page through]` |
| `tools.ts:2065`（`read_many`） | `... [N more lines; full content saved to <path> — read that path with read_file (offset/limit)]` |
| `tools.ts:2596`（`run_command`） | `... the log is saved to <path>; read it with read_file]` |
| `context.ts:542`（上下文收缩） | `full text saved to <path>; read it with read_file` |

**唯一漏网的就是 `truncateOutput` 这个通用兜底**，而它正好兜着两处「丢了就真没了」的结果：

| 调用点 | 场景 |
|---|---|
| `src/agent/tools.ts:1391` | 动态工具（MCP / 插件）返回值 |
| `src/agent/runtime.ts:5864` | `task` 子 Agent 报告（流式分支） |
| `src/agent/runtime.ts:8327` | `task` 子 Agent 报告（resume 分支） |

也就是说：**MCP 工具吐了 5000 token 的结果，模型只能看到头尾各 1500 token，剩下的永久蒸发**，而落盘基建（`tool-output.ts`）早就在那儿了，只是没接上。

### 2.2 目标

任何超过预算的工具输出，模型都能从提示文案里拿到一个可读路径，按需续读；且不会因为「读产物」而生成新的产物。

### 2.3 方案

**新增一个函数，放在 `tools.ts` 的 `degradeStructuredOutput` 旁边（约 25 行）**：

```ts
/**
 * 通用截断收口：超预算就落盘，并在头尾之间留可续读指针。
 * 与 degradeStructuredOutput 同一条约定，只是不要求结果结构化。
 */
async function truncateWithSpill(
  workspace: string,
  tool: string,
  text: string,
  maxTokens = MAX_OUTPUT_TOKENS,
): Promise<{ output: string; truncated: boolean; spilled?: string }>
```

内部逻辑：先 `truncateToTokens(text, maxTokens, { note })` 判断是否超预算；超了才 `persistToolOutput(workspace, tool, text)`，用返回的相对路径拼 note：

```
... [N of M tokens omitted; full output saved to <path> — read that path with read_file (offset/limit)]
```

措辞直接沿用 `tools.ts:188-224` 那条，不新造句式。

**三处调用点替换**（都是 async 上下文，可直接 `await`）：

| 文件:行号 | 现在 | 改成 |
|---|---|---|
| `tools.ts:1391` | `truncateOutput(result.output)` | `await truncateWithSpill(workspace, name, result.output)` |
| `runtime.ts:5864` | `truncateOutput(result.output)` | `await truncateWithSpill(session.cwd, "task", result.output)` |
| `runtime.ts:8327` | 同上 | 同上 |

**不改 `truncateOutput` 本身的签名**。它是同步函数，被 `toolResult()`（`tools.ts:120`）和 `browser-tools.ts` 的 5 个调用点共用，改成 async 会波及 13 处 `toolResult(`。而这些调用点产出的都是短文本（`memory_*`、`tool_search`、浏览器快照），3000 token 基本打不到，不值得为它们付出改签名的代价。

**必须同时做的防回归**（否则会自我增殖）：

`read_file` 的落盘分支在 `tools.ts:1943`：

```ts
if (estimateTokens(read.file.content) > READ_SAVE_THRESHOLD_TOKENS && slice.shown < slice.total) {
```

一旦模型开始「读产物」，而产物本身仍 > 2000 token，就会再落一个 `read_file-*.log`，形成「读 A 生成 B，读 B 生成 C」。在落盘分支前加一条判断：目标路径已在 `TOOL_OUTPUT_DIR`（`tool-output.ts:13`）下则跳过落盘。

**顺带同步一处文案**：`read_file` 的 description（`tools.ts:270`）补半句，与 `list_dir`（`tools.ts:256`，已经写了 `large listings spill to .meowcode/tool-output/`）对齐。

### 2.4 改动清单

| 文件 | 改什么 |
|---|---|
| `src/agent/tools.ts` | 新增 `truncateWithSpill`（约 25 行）；`:1391` 换调用；`:1943` 加目录判断；`:270` description 补半句 |
| `src/agent/runtime.ts:5864` | 换调用 + `await` |
| `src/agent/runtime.ts:8327` | 换调用 + `await` |

`runtime.ts` 只有两行改动，且都在已有的 async 分支里，不碰业务判断。

### 2.5 验收

1. 注册一个假 MCP 工具返回 6000 token 文本 → 工具结果里出现 `.meowcode/tool-output/<tool>-*.log` 路径
2. `read_file` 该路径 → 拿回全文
3. 连续读同一个产物两次 → `ls .meowcode/tool-output/ | wc -l` 不增长
4. `npx vitest run src/agent` 全绿（重点看 `tools`、`tool-output`、`runtime` 相关）

### 2.6 风险

- **`runtime.ts:5864` / `:8327` 是否在 sync 函数内**：这是本项唯一的连锁风险。两个都在 `task` 工具结果组装路径上，按现有代码是 async；若实际在 sync 回调里，需把外层改 async。开工第一步先确认这一点。
- **落盘开销**：`persistToolOutput` 每次写盘 + `cleanupToolOutput` 扫目录（`tool-output.ts:30`）。只在超预算时触发，不在热路径。
- **路径泄漏到模型上下文**：路径本身是工作区相对路径（`tool-output.ts:29` 用 `path.relative`），不含用户名或绝对盘符，可接受。

## §3 P1：任务阶段派生与 UI 收敛

### 3.1 现状

会话里同时跑着三套「任务」，每套自己的状态、自己的展示、自己的图标：

| 套 | 数据源 | 事件 | UI 消费点 |
|---|---|---|---|
| 计划清单 | `PlanStep[]`（`types.ts:1014`） | `plan_updated`（`runtime.ts:8365`） | `SessionProgressPill.tsx`，本地 `filter` 计数（`:42-49`） |
| 子 Agent | `SubagentSummary`（`types.ts:1457`） | `subagent_started` / `subagent_completed` | `TaskToolRow.tsx`（图标 `:58-66`）+ `SubagentsTab.tsx`（图标 `:96-104`） |
| 治理 lane | `Lane`（`workflow-runtime.ts:32`），渲染层镜像 `WorkflowLane`（`api.ts:234`） | `workflow_roadmap` / `workflow_gate` | `PlanTab.tsx` 的 `RoadmapSection`（`:29-75`） |

三个具体问题：

1. **同一套图标逻辑写了两遍**。`TaskToolRow.tsx:58-66` 与 `SubagentsTab.tsx:96-104` 几乎是逐字重复（running→spinner、failed→✗、aborted/interrupted→⚠），只差点击行为。
2. **事件发了没人收**。`workflow_gate` 与 `workflow_admitted` 在 `desktop/src` 里**没有任何消费者**（grep 只命中 `api.ts:216` 的类型注释）。gate 状态只能靠 `workflow_roadmap` 快照间接看到。
3. **「是否需要人处理」全仓没有判据**。`grep -i "attention|needsAttention|requiresAttention"` 在 `desktop/src` 零命中。唯一近似的是 `ConversationPanel.tsx:613-614` 的两态：

```ts
const waitingApproval = (approvalSessionIds ?? []).includes(session.id);
const running = (runningSessionIds ?? []).includes(session.id) || waitingApproval;
```

「待审批压过运行中」—— 这是目前唯一的优先级判断，只在会话维度，且是硬编码布尔。而通知侧 `main.cjs:2177` 的 `shouldNotifyNow` 又是另一套判断（窗口前后台）。同一件事（这个任务要不要打扰人）在两个进程里各写一遍。

另有一个死文件：`desktop/src/components/PlanCard.tsx`（79 行）**全仓零引用**，已被 `SessionProgressPill` 取代。

### 3.2 目标

一个纯函数把三种输入算成同一个阶段，`needsHuman` 成为可派生字段；UI 侧「图标 → 文案」只写一次。

写法对齐 dsh 的 `src/core/stage.ts`（26 行，存事实、算显示、首条命中即返回）。

### 3.3 数据形状

放 `src/agent/stage.ts`，零依赖纯函数：

```ts
export type Stage =
  | { stage: "person"; action: "approval" | "answer" | "review" }
  | { stage: "machine"; action: "gate" | "blocked" | "repair" | "queued" }
  | { stage: "working"; action: "running" }
  | { stage: "idle" }
  | { stage: "ended"; outcome: "completed" | "failed" | "aborted" | "interrupted" | "cancelled" };

export type StageInput =
  | { kind: "attention"; source: "approval" | "ask_user" }
  | { kind: "plan"; steps: ReadonlyArray<{ status: "pending" | "in_progress" | "completed" | "cancelled" }>; streaming: boolean }
  | { kind: "subagent"; status: "running" | "completed" | "failed" | "aborted" | "interrupted" }
  | { kind: "lane"; status: "queued" | "active" | "done" | "blocked";
      gates: Readonly<Record<string, "pending" | "passed" | "failed" | "pass" | "fail">>;
      repairCount: number; maxRepairs?: number; upstreamDone?: boolean };

export type StageView = { stage: Stage; needsHuman: boolean; reason: string };

export function deriveStage(input: StageInput): StageView;
export function aggregateStage(views: StageView[]): StageView;
```

`needsHuman === (stage === "person")` —— 这是「要不要人管」的唯一判据，不允许调用方自己判断。

分开两个轴（`stage` + `needsHuman`）而不是一个平铺枚举，是因为 dsh 的教训：把所有状态塞进一个线性序列后，「机器在等」和「人在等」被压成同一个「阻塞」，通知逻辑就再也分不出来了。

### 3.4 映射规则（首条命中即返回）

这张表是整个 P1 的核心，评审时重点看它。

| 输入 | stage | needsHuman |
|---|---|---|
| `attention = approval` | `person / approval` | true |
| `attention = ask_user` | `person / answer` | true |
| plan：任一步 `in_progress` | `working / running` | false |
| plan：非空且全 `completed` | `ended / completed` | false |
| plan：非空且全 `cancelled` | `ended / cancelled` | false |
| plan：有 `pending` 且 `streaming = true` | `working / running` | false |
| plan：有 `pending` 且 `streaming = false` | `machine / queued` | false |
| plan：空数组 | `idle` | false |
| subagent `running` | `working / running` | false |
| subagent `completed` | `ended / completed` | false |
| subagent `failed` | `ended / failed` | false |
| subagent `aborted` | `ended / aborted` | false |
| **subagent `interrupted`** | `person / review` | **true** |
| lane `queued` | `machine / queued` | false |
| lane `active` + 存在 `pending` gate | `working / running` | false |
| lane `active` + gate `failed` 且 `repairCount < maxRepairs` | `machine / repair` | false |
| lane gate `failed` 且 `repairCount >= maxRepairs` | `person / review` | true |
| lane `blocked` 且 `upstreamDone = false` | `machine / queued` | false |
| lane `blocked` 且 `upstreamDone = true` | `machine / blocked` | false |
| lane `done` | `ended / completed` | false |

三条边界必须写进注释，否则后来人一定会改错：

- `cancelled`（计划里显式放弃）→ 终态，不需要人
- `aborted`（人主动停机）→ 终态，不需要人
- **`interrupted`（应用重启杀掉的子 Agent）→ 需要人确认是否续跑**。这是唯一「终态但仍需人」的项。理由：自动续跑会在重启后同时拉起多个子 Agent 一起烧 token；且用户已明确选择「等人确认」。

另外，`gates` 的值在入口做归一：`workflow-runtime.ts` 用 `GateStatus = "pending" | "passed" | "failed"`，而事件里的 verdict 是 `"pass" | "fail"`，两套拼写必须在 `deriveStage` 入口收敛，否则静默漏判。

### 3.5 聚合规则（会话级）

优先级 `person > working > machine > ended > idle`。

- 任一输入为 `person` → 会话 `person`，`needsHuman = true`
- 全部为 `ended` 时才返回 `ended`，`outcome` 取最坏：`failed > interrupted > aborted > cancelled > completed`
- `machine` 内部取最早阻塞者：`repair > blocked > gate > queued`
- 空输入 → `idle`

### 3.6 放在哪个文件

`src/agent/stage.ts` + `src/agent/stage.test.ts`。理由是服务端要用 `needsHuman` 决定推不推系统通知，必须与渲染层用同一份规则。`desktop/src/plugins/slot-registry.ts` 已有跨目录 import `src/` 的先例，Vite 直接吃 TS 源码没问题。

**但主进程不能 import**：`desktop/main.cjs` 是 CJS，根包是 `"type": "module"`，无法 `require` ESM 产物。所以做法是 —— 由 runtime 在 5 处 emit 的 payload 上附加 `stage` / `needsHuman` 字段，`main.cjs` 只读字段，不自己算：

| emit 点 | 附加字段 |
|---|---|
| `runtime.ts:8365` `plan_updated` | `stage`, `needsHuman` |
| `runtime.ts:5186` `workflow_roadmap` | `stage`, `needsHuman` |
| `turn_complete` | `stage`, `needsHuman` |
| `ask_user` | 恒 `person/answer`, `true` |
| `approval_required` | 恒 `person/approval`, `true` |

后两个不需要计算，直接写死更能表达意图。

### 3.7 UI 收敛清单

| 文件 | 改什么 |
|---|---|
| `desktop/src/components/stage/StageBadge.tsx` + `.css` | **新建**：`Stage` → 图标 / 文案 / 颜色的唯一映射（含 spinner） |
| `desktop/src/components/SessionProgressPill.tsx` | 删 `:42-49` 的本地计数，改用 `deriveStage({kind:"plan"})`；文件改动段保留 |
| `desktop/src/components/TaskToolRow.tsx` | 删 `:58-66` 图标分支，改 `StageBadge` |
| `desktop/src/components/panel/SubagentsTab.tsx` | 删 `:96-104` 图标分支与重复的 `formatDuration`，改 `StageBadge`；`:57-61` 的排序改用聚合 stage |
| `desktop/src/components/panel/PlanTab.tsx` | `RoadmapSection`（`:29-75`）的 lane 状态改由 `deriveStage({kind:"lane"})` 产出，gate 芯片保留 |
| `desktop/src/components/ConversationPanel.tsx:613` | 两态布尔换成会话级 `stage`，`person` 优先于 `running`；拿不到 stage 时回退现有逻辑 |
| `desktop/src/App.tsx:2501` | 补 `workflow_gate` 消费者：就地更新对应 lane 的 gate 与 `repairCount`，消除「事件发了没人收」 |
| `desktop/src/App.tsx:3163` | 顺带修：`plan_updated` 现在**不按 sessionId 过滤**，后台会话会覆盖当前 plan |
| `desktop/src/components/PlanCard.tsx` + `PlanCard.css` | **删除**（全仓零引用） |

### 3.8 验收

`src/agent/stage.test.ts`，用 `it.each` 把 §3.4 的表逐行断言。六条不变量：

1. 对任意输入，`needsHuman === (stage.stage === "person")`
2. 输出全部落在闭枚举内
3. 聚合优先级：`person` 压过 `working`，`working` 压过 `machine`
4. `interrupted` 恒为 `person`；`aborted` / `cancelled` 恒为 `ended` 且 `needsHuman === false`
5. gate `failed` 且 `repairCount < maxRepairs` 恒为 `machine`（不能误报需人）
6. 空输入为 `idle`；全 `done` 的 lane 集合聚合为 `ended / completed`

UI 侧手工回归：同一个 `running` 子 Agent 在时间线行与右栏总览里图标一致；审批挂起时会话行显示 `person/approval` 而非 `running`。

### 3.9 风险

- **映射表一旦定错，改起来要动 UI 文案和 i18n**。所以 §3.4 必须先评审再动手，测试先行。
- `plan_updated` 的 sessionId 过滤是「顺带修」，会改变后台会话的行为。**明确限制在不扩大范围**：只加过滤条件，不改 plan 的其他语义。
- `ConversationPanel:613` 的改动会影响会话列表红点，属于高频可见区域，改完要手测「审批中 + 运行中」的排序。

## §4 P2：自动化决策记录与 observe 档

### 4.1 现状

`desktop/scheduler.cjs`（499 行）是纯 cron：`tick()` 每 30s 扫一遍 → `computeNextRun` → `fire()`。

`fire()`（`:333-368`）做的事：

```
buildMessage(前缀行 + prompt) → 重试 3 次（间隔 10s）→ 每次重试重新 POST /session/new → POST /session/prompt
```

四个具体问题：

1. **没有准入**。到点就发，没有「该不该做」这一步，也没有「只记录不执行」的观察档。
2. **重试会建多个会话**。`/session/new` 在重试循环**内部**（`main.cjs:2234-2255` 的 transport），一次故障最多留 3 个孤儿会话。
3. **两步非原子**。`/session/new` 与 `/session/prompt` 是两次独立请求，服务端 prompt 接口没有 `requestId` 之类的幂等字段（`server.ts:2930-3041`）。中间崩溃 → 有会话没任务。
4. **状态表达不了「等审批」**。`history` 只有 `started|ok|error|missed` 四态（`scheduler.cjs:27`），而审批事件确实会到主进程（`main.cjs:2333-2363`），只是没被用起来。

agent 内核完全不参与 automation（`grep -rn "automation" src/` 零命中）—— 这是刻意的分层，**P2 不去打破它**。

### 4.2 目标

每次触发留一条「做了 / 没做 / 为什么」的可审计记录；能在不执行的前提下先观察一段时间；一次触发最多建一个会话。

### 4.3 数据形状

automation 对象新增四个字段：

```ts
type AutomationAutonomy = "off" | "observe" | "auto";

type AutomationDecision = {
  triggerId: string;        // 幂等主键：定时 `${id}:${scheduledAt}`，手动 `${id}:manual:${uuid}`
  scheduledAt: string;      // 本该执行的槽位时间（observed/skipped 也要能说明「本该何时做」）
  at: string;               // 实际决策时间
  trigger: "schedule" | "manual";
  autonomy: AutomationAutonomy;  // 触发瞬间的档位，事后改档不篡改历史
  outcome: "executed" | "observed" | "skipped" | "failed" | "uncertain";
  plannedMessage?: string;  // observed/skipped 时渲染出的完整正文（截 2000），审计「本该发什么」
  messageHash?: string;     // 正文指纹，连续槽位内容未变时可折叠展示
  sessionId?: string;
  phase?: "creating" | "created" | "delivered";
  error?: string;
  result?: "ok" | "error";  // turn_complete 回填
};

// automation 新增
autonomy: AutomationAutonomy;                                    // 缺省 "auto"
mandate: { mode: AutomationAutonomy; at: string; source: "user" | "legacy" };  // 授权是数据
decisions: AutomationDecision[];                                 // 最新在前，封顶 50
pendingTrigger?: Pick<AutomationDecision, "triggerId" | "scheduledAt" | "at" | "trigger" | "phase" | "sessionId">;
```

**决策记录放 `automation.decisions`，不塞 `history`**，理由有三条：

- `history` 只有 20 条且 `handleTurnComplete` 按 `history[0].sessionId` 匹配结算（`:466-481`），混入 observed 记录会破坏这个匹配
- `history` 的状态枚举是四个值，加值会影响已有的 UI（`AutomationPage.tsx:267` 的 `statusTone`）
- 单独开 jsonl 的收益要到「30+ 任务」才显现，现在不值得多一条读路径

**何时该迁移到 jsonl**：任务数超过 30 个，或单个 prompt 稳定超过 5 KB —— 那时每次触发的全量 `fsync` 重写与 IPC 广播会明显变重。

### 4.4 执行流程改造

`fire()` 拆成五步，observe 档在第 2 步短路：

```
1. resolveTrigger()   纯计算 triggerId / scheduledAt
2. gate()             autonomy === "off"     → 写 decision{skipped}，return（零 HTTP）
                      autonomy === "observe" → 写 decision{observed, plannedMessage, messageHash}，return（零 HTTP）
3. begin()            写 pendingTrigger{phase:"creating"} 并立刻 persist —— 必须在任何 fetch 之前
4. create()           POST /session/new → 立即持久化 {phase:"created", sessionId}
5. deliver()          POST /session/prompt → {phase:"delivered"}；写 history.started + decision{executed}；清 pendingTrigger
6. settle()           SSE turn_complete → decision.result，history started → ok/error
```

**重试语义必须改**：只对 `deliver` 重试（同 sessionId，最多 2 次，仅 5xx 与网络错误）；`create` 不原地重试；4xx（如 `session_not_found`）直接 `failed`，本槽位不再尝试。这一条同时修掉「一次故障留 3 个孤儿会话」。

**幂等（服务端不改的前提下）**：

- `triggerId` 按槽位确定，重复 tick 与重启都得到同一个键
- `begin()` 先落盘再发 HTTP，保证「客户端已发出」必然先于「服务端已创建」被记录
- 唯一缺口是「`/session/new` 已执行但响应没回来」。此时 `phase` 停在 `creating` 且无 sessionId → 标 `uncertain`，**永不重建**；启动时 `start()` 把超过 2 分钟的 `creating` 一律转 `uncertain`；`created` 未 `delivered` 的用同一 sessionId 补投一次

不变量：**一次触发 ≤ 1 个会话**。代价是极小概率留一个空会话（见 4.7）。

**结算**：`handleTurnComplete` 先查 `decisions[0]` 再查 `history[0]`，避免手动触发被定时历史抢结算。

### 4.5 改动清单

| 文件 | 改什么 |
|---|---|
| `desktop/scheduler.cjs` | `normalizeAutomation`（`:154-234`）加四字段默认值与白名单过滤；`fire()`（`:333`）拆五步；新增 `resolveTrigger` / `gate` / `begin` 内部函数；`handleTurnComplete`（`:466`）先查 decisions；新增 `reapStaleTriggers()` |
| `desktop/src/api.ts:2838-2892` | `Automation` / `AutomationInput` 类型加字段；新增 `AutomationDecision` / `AutomationAutonomy` |
| `desktop/src/global.d.ts:385-392` | preload 签名不变，但返回类型加字段 |
| `desktop/src/components/automation/AutomationPage.tsx` | 行内加档位 Badge；末行「上次运行」旁显示最后一条 decision 的 outcome |
| `desktop/src/components/automation/AutomationEditDialog.tsx` | 高级设置折叠区加三档 SegmentedControl（auto / observe / off） |
| `desktop/src/components/automation/AutomationHistoryDialog.tsx` | 加「运行历史 / 决策记录」双页签，决策页复用现有 `mc-auto__history` 样式 |
| i18n（`desktop/src/i18n/locales/*/automation.json`） | 新增 `autonomy.*` 与 `decision.*` 两组文案 |
| `desktop/main.cjs` | `runNow` 保持默认真执行（人的显式动作应越过档位），只记 `trigger:"manual"`；通知逻辑可直接读 `needsHuman`（承接 P1） |

`save()` 里 `decisions` / `mandate` / `autonomy` 必须像 `history` 一样从 existing 继承，**否则编辑一次就丢全部审计记录**。这是最容易漏的一处。

### 4.6 向后兼容

`normalizeAutomation` 的处理：

| 字段 | 缺省 / 非法时的处理 |
|---|---|
| `autonomy` | 缺失或非法 → `"auto"`（保持现有行为，不惊动老任务） |
| `mandate` | 缺失 → `{ mode: autonomy, at: createdAt, source: "legacy" }`，只作审计标注，不弹窗要求重新授权 |
| `decisions` | 按 outcome 白名单过滤，非法条目丢弃，封顶 50；老条目缺 `triggerId` 时用 `at` 回填 |
| `pendingTrigger` | phase 不在枚举内，或 `at` 超过 24 小时 → 清空并补一条 `uncertain` |

### 4.7 验收

1. observe 档触发一次 → `automations.json` 多一条 `outcome: "observed"` 且带 `plannedMessage`，**会话数为 0**
2. auto 档连续两个槽位 → 会话数为 1，`decisions` 两条 `executed`
3. 断开 server 再触发 → `outcome: "failed"`，**不产生第 2 个会话**（对比现状会建 2~3 个）
4. 手动「立即运行」在 observe 档下 → 仍然真执行，`trigger: "manual"`
5. 用旧版 `automations.json` 启动 → 不报错，任务照常，`mandate.source === "legacy"`
6. 编辑一个任务的标题后 → `decisions` 与 `mandate` 仍在

### 4.8 风险

- **每次触发全量重写 `automations.json`** + IPC 广播变大。已在 4.3 给出迁移阈值（30 任务 / 5 KB）。
- **`uncertain` 会留空会话**，不做自动删除（避免误删有内容的会话）。UI 上标成 `uncertain` 让用户自己决定。
- **`plannedMessage` 含完整 prompt**，可能带敏感内容。处置口径：与 `history.error` 一致，只落本地 `automations.json`，不上报、不进日志。

## §5 实施顺序

```
P0-1（2h，护栏）
  → P0-2（半天，立刻见效）
  → P1（2~3 天，先纯函数 + 测试，再接 UI）
  → P2（1 周，独立在 desktop/，可与 P1 并行）
```

P0-1 排第一不是因为收益最大，而是它给后面三项兜住「新加工具忘了声明」的坑 —— P1/P2 都可能需要改工具或改审批集合。P1 与 P2 无依赖，可并行。

每项完成后单独跑一次全量：

```bash
cd D:/MeowCode && npx vitest run && npx tsc -p tsconfig.json --noEmit
cd D:/MeowCode && npx tsc -p desktop/tsconfig.json --noEmit
```

（`cd` 必须用大写盘符，否则 vitest 会因模块双实例在 `describe` 处集体报 `Cannot read properties of undefined (reading 'config')`。）

## §6 不做的事

| 不做 | 理由 |
|---|---|
| 引入 dsh 的 `src/core/**` 2088 行 | 那套是 Trigger/Thread/Ticket/Subscription 的领域内核，MeowCode 没有工单与多源订阅场景，拷进来是死代码 |
| 多 Agent 消息归属协议 | 无场景（见 §0 说明） |
| dsh 的 `effects.ts` 副作用队列 | scheduler 的失败面比它小得多，P2 的重试语义已够；等出现「多步跨进程副作用」再谈 |
| `danger-full-access` 式安全姿态 | MeowCode 的审批粒度更细，不回退 |
| 重构 `runtime.ts`（9550 行） | 真问题，但它是独立专项，不该塞进这份清单 |
| 改服务端 `POST /session/prompt` 加 `requestId` | P2 在客户端就能做到「一次触发最多一个会话」，不值得动传输层协议 |

---

_上一份调研见 `docs/reference/dsh-superagent.md`。本文只描述改法，不含任何代码变更。_
