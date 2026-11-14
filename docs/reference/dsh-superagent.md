# dsh-superagent 评估：能给我们什么、不能给什么

> 评估对象：`D:/MeowCode/dsh-superagent-prototype-main`
> 来源：DeepSeek Harness 团队，2026-10 随设计文章《Exploring Super-agent Design》开源，MIT
> 评估时间：2026-11-14 · 对照基线：MeowCode（GPL-3.0-or-later）
> 本文只做结论沉淀，不含任何代码改动。

## 0. 一句话结论

**这是一份写得极好的架构参考实现 + 一个 MIT 的领域内核库，不是可集成的产品。**

MeowCode 该拿走的是「授权 · 事件 · 工单」三套模型，以及 `src/core/` 那 2,088 行零外部依赖代码；
最不该拿走的是 DSH 适配层、4k 行面板代码和它的安全姿态。

## 1. 它是什么 / 不是什么

### 是什么

- 一个**为一个 GitHub 仓库服务的常驻主动 Agent**：监听仓库（可选飞书）→ 判定准入 → 开工单 → 每个工单一个独立 Session 与独立目录 → 回原会话交付 PR。`README.md:7`
- 一个**跑在 DeepSeek Harness 之上的 bundle**，不是独立程序。`package.json:30-46` 声明 `dsh.bundle.patch` + 6 个 `dsh.client.inject`
- 一篇**可执行的设计文档**：8 篇编号文档共 1,973 行，编码了几乎全部设计取舍；`docs/007-architecture.md` 单篇 617 行
- 规模（`wc -l` 实测）：`src` **15,205** 行 / `tests` **12,981** 行（48 个 spec）/ `docs` **1,973** 行

### 不是什么（这几条比上面更重要）

| 事实 | 证据 | 对我们的含义 |
|---|---|---|
| 官方自述"仅供参考的研究代码，非 DeepSeek 正式产品" | `README.md:3` | 不能作为生产依赖 |
| 强耦合 23 个 `@deepseek-ai/dsh-*`，精确 pin 到 `0.2.1-alpha.2` | `package.json:62-85` | 用 DSH 的 Session/Agent/LLM 类型贯穿全仓，整体不可移植 |
| 本 checkout **没有 `node_modules`**，`pnpm check` 跑不起来 | 目录实况 | 无法在本机验证任何行为，只能读代码 |
| 它自己**没有 agent loop** | 全仓无 loop 实现 | 它只做编排层；loop 在 DSH 里。MeowCode 的 `agent-loop.ts` 无需参考它 |
| 面板不是聊天流，是"监督台"，5 秒轮询 | `src/client/provider.tsx:74,89` | UI 范式与 MeowCode 完全不同 |

## 2. 三张清单

### A. 值得抄思路（改造后自研）

| # | 思路 | dsh 出处 | MeowCode 现状 | 价值 |
|---|---|---|---|---|
| A1 | **授权是数据**：Mandate（谁、依据哪条规则、范围多大）+ PolicyVersion，不可变、可审计、可失效 | `src/core/model.ts:128-134`、`src/policy.ts:213-241` | `approval-rules.ts` 只有**工具级**审批（tool/path/command-*），没有"谁允许了什么工作" | ★★★ |
| A2 | **三档自主** off / observe / auto，默认 observe 只记录 `would_accept` 不执行 | `src/core/model.ts:103` | `scheduler.cjs` 到点就直接发 prompt，没有观察档 | ★★★ |
| A3 | **两段准入**：Gate（代码，确定可单测）+ Assessment（模型，只做语义判断） | `src/policy.ts:191-211` + `src/app/assessment.ts` | 无 | ★★★ |
| A4 | **工单阶段是纯函数派生**（存事实、算显示状态，闭合枚举 `TICKET_STATES`） | `src/core/stage.ts`（26 行）、`src/app/cards.ts:17-25` | `update_plan` / plan 模式 / workflow roadmap 三套互不相通，`PlanCard.tsx` 已废弃 | ★★☆ |
| A5 | **Effects 持久副作用队列**：事务内入队、提交后执行、同 key 合并、`Later` 不计失败、ordered 串行阻塞、每 kind 一条健康条目 | `src/app/effects.ts`（161 行） | scheduler 有重试，没有幂等收据 / 有序阻塞 / 健康上报 | ★★☆ |
| A6 | **卡片 + 读指针**：160 字符预览 + 字符数 + `read` 指针，分页快照必须先读 offset 0 再续读 | `src/app/cards.ts:8-11,53-57,89-92` | `truncateOutput` / `sliceHeadToTokens` 是硬砍，砍掉就再也拿不回来 | ★★☆ |
| A7 | **follow-up 所有权协议**：一条人类后续消息归哪个 worker，worker `handback` 才交回 | `docs/002`、`src/core/model.ts:74-86` | 有 `steerSubagent`，但没有"归谁"的规则 | ★★☆ |
| A8 | **元测试防漂移**：文档顺序/链接/模块表、类 JSDoc、模型可见面尺寸预算，全部进 CI | `tests/docs.spec.ts`、`tests/model-surface.spec.ts` | 只有 `prompt-budget.test.ts`；`tool-contract.ts` 注释自认"漏改不会报错" | ★★☆ |
| A9 | **注意力预算**：IM 消息 100 词硬上限（中文用 `Intl.Segmenter` 计词），只在该说话时说话 | `src/infra/text.ts:3-16` | 无出站消息，暂无直接对应物 | ★☆☆ |

### B. 可直接复用代码（MIT，与 GPL-3.0 兼容）

| 文件 | 行数 | 用途 | 移植注意 |
|---|---|---|---|
| `src/core/**`（15 个文件） | **2,088** | 领域内核：Trigger/Thread/Eval/Decision/Ticket/Mandate/Assignment 的类型、状态机、纯函数 | 只依赖 `node:crypto`（`core/ids.ts:2`），**零外部依赖**。但用 `.ts` 后缀 import（`from './model.ts'`），进 tsc 构建要去后缀 |
| `src/app/effects.ts` | 161 | 持久副作用队列 | 把 `store.db.prepare` 换成 `{ exec, afterCommit }` 接口；MeowCode 无等价物 |
| `src/app/cards.ts` | 96 | 卡片投影 + `textPage` + `newestPage` | `preview` / `textPage` / `newestPage` 可直接用；`ticketCard` 依赖 `github-pull.ts`，要解耦 |
| `src/app/versions.ts` | 34 | 编号快照 + 指针 | 直接用，配 JSON 存储即可 |
| `src/admission.ts` + `src/limits.ts` | 24 | 2×2 准入矩阵 + 校验边界 | 纯常量纯函数，直接拷 |
| `src/core/stage.ts` + `reasons.ts` + `errors.ts` | 125 | 阶段派生 / 原因码 / 错误码 | 纯函数，直接拷 |
| `prompts/admission.md` `dispatch.md` `work.md` | 176 | 三段角色提示词 | 需改写（含 GitHub 语境），但"准入判断"那段的措辞质量很高 |
| `docs/000~003` | 517 | 设计基线（哲学 / 领域 / 授权 / 执行） | 文档不是代码，可读性强，适合作为讨论材料 |

**不建议整目录拷的部分**：`src/app/sessions.ts`（DSH 会话装饰）、`src/executor/dsh.ts`（DSH 事件订阅）、`src/sources/**`（`gh` / `lark-cli` 子进程轮询）。

### C. 别碰

| 对象 | 原因 |
|---|---|
| DSH 插件外壳（`cordis.patch.yml`、`src/index.ts` 的 `inject` 列表） | MeowCode 有自己的 runtime，抄了只多一层无用的适配 |
| `src/client/**`（4,037 行） | 绑 DSH 的 UI host、`window.__ModuleLoader__` CJS 包格式、DSH design token |
| `src/sources/**`（2,059 行） | 本质是 CLI 子进程 + 轮询；接 GitHub 应走 API 或已有 MCP |
| `scripts/dsh-superagent`（tmux + `fcntl`） | POSIX 专属，Windows/Electron 用不上 |
| `danger-full-access` 默认姿态（`src/app/sessions.ts:152`） | 作者自己写了"wrapper 不是安全边界"（`docs/003:80`），MeowCode 的审批更细，不要回退 |
| 无界增长的表设计（`docs/007:484` 作者自列） | 作者标注为缺陷 |
| 硬编码魔数（30 分钟作业上限、5 秒 shell 阈值、1500/600 字符裁剪） | 需按我们的交互重调 |

## 3. 四个关注点详细对照

### 3.1 主动自动化的准入与降噪

**dsh 怎么做**

判定分两段，先代码后模型：

1. **Gate（代码，确定）**：`src/policy.ts:191-211`。人类消息先看 2×2 矩阵：

   | | 已 @ 提及 | 未 @ 提及 |
   |---|---|---|
   | **在白名单** | 直接 explicit，**不走表**（`:197`） | 查表：`inferred` / `ignore`（默认 inferred） |
   | **不在白名单** | 查表：`explicit` / `inferred` / `ignore`（默认 ignore） | 查表：`inferred` / `ignore`（默认 ignore） |

   机器触发（CI/bot）走 `machineGate`：只放行列在白名单的 bot（降为 inferred）和无发送者的系统事件，其余 `not_human` 直接拒。

2. **Assessment（模型，只判语义）**：模型必须对**每条启用的规则**给出 `matched: true/false`，少一条就抛错；至少一条正面匹配 + 有 `intent_evidence` 才建单（`src/policy.ts:41-59`、`prompts/admission.md`）。

配套三件事：

- **三档自主**：`off` / `observe`（**默认值**，只记 `would_accept` 不执行）/ `auto`（类型 `core/model.ts:103`，默认值 `policy.ts:84`）
- **变更传播**：规则改了只找出**受影响的在途工单**通知，不撤销已完成授权（`policy.ts:144-165`）
- **恢复前重验**：`revalidate()`（`policy.ts:213-241`），依据不成立就拒绝恢复

**MeowCode 现状**

`desktop/scheduler.cjs`（499 行）是纯 cron：`computeNextRun` → `tick` → `buildMessage` → `fire` → `POST /session/prompt`。没有准入、没有观察档、没有决策记录。

**能做什么（按性价比排序）**

1. 给每次 fire 记一条**决策记录**（触发源/时间/做或不做/原因），先只读不执行，跑一周看误报率
2. 引入"规则"概念：什么时候该主动、做到什么范围，规则是数据不是 prompt
3. 最后再谈 auto 档，且必须带"范围上限"

### 3.2 多 Agent 的消息归属

**dsh 怎么做**

- 线程订阅是多对多：一个 Thread 可被多个 Ticket 订阅，worker 之间**不直接通信**，靠共享事件流各自发现冲突
- 一条人类后续消息归**当前持有工单的 worker** 判断；Router 只能 stop，不能替它决定
- worker 必须 `handback` 才把控制权交回 Eval
- 工单结束时**未读消息归还**给 Eval（`docs/002`「Handing back and releasing follow-ups」；`src/core/tickets.ts:254-266`、`engine.ts:80`）
- 投递语义三选一（`src/app/delivery.ts:66-85`）：`queue`（下一轮）/ `steer`（本轮插话）/ `{ inject }`（写进历史但不唤醒），用 `requestId → MessageId` 做幂等，跨重启去重

**MeowCode 现状**

已有 `steerSubagent` / `enqueueSteer` / `MAX_PENDING_STEERS`，但**没有"这条消息归谁"的规则**；子 Agent 并发超额时返回错误文本让模型自己重试（`runtime.ts:6100-6116`）。

**能做什么**

`delivery.ts` 只有 86 行但依赖 DSH 的 `Session`/`Agent` 类型，**不能直接拷**，只取两个想法：

1. `requestId → 固定 MessageId` 的幂等键（约 20 行，可配 `session-store.ts` 用）
2. `queue / steer / inject` 三态语义收敛成一个 `send(agent, reqId, text, mode)`

`handback` 协议在有"多会话共享一条消息流"需求时再引入，现在没这个场景。

### 3.3 上下文与 token 经济

**dsh 怎么做**

所有面向模型的数据都是**卡片**，绝不是原文：

```ts
// src/app/cards.ts:8-11
export function preview(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 160)
}
// 卡片 = { preview, chars, read: `trigger/${id}` }
```

- **预览 160 字符 + 字符数 + `read` 指针**，模型需要全文就再调一次读
- **分页快照必须先读 offset 0**，再按 `next_offset` 续读（链式召回，防止模型跳着抽样）
- `textPage` 按 UTF-16 code unit 切片，保证拼接能无损还原（`cards.ts:89-92`）
- 评估上下文按距离分层裁剪：Trigger 原文 4,000 字符、窗口内消息 1,200 / 400 字符、窗口外一律压成 **50 字符预览**，全文靠 `orchestrator_eval_read` 按需取（`app/assessment.ts:37,196-201`）

**MeowCode 现状**

`truncateOutput` / `sliceHeadToTokens` / `shrinkToolOutputs` 都是**单向硬砍**——砍掉的内容模型再也拿不回来，只能重新读一遍整个文件。

**能做什么**

把"截断"改成"预览 + 读指针"，成本极低：MeowCode 已经有 `read_file` 的 offset/limit、`read_slice.ts`、`read-state.ts`（已读区间记录）。缺的只是**在截断处留一个指针**，例如：

```
[output truncated: 42,318 chars total, showing first 8,000]
read again with: read_file path=<tmp path> offset=8000 limit=200
```

这一条是四个关注点里**改动最小、收益最直接**的。

### 3.4 工程规范与防漂移

**dsh 怎么做**（四个元测试，全部进 CI）

| 测试 | 检查什么 |
|---|---|
| `tests/docs.spec.ts` | 编号文档只能引用更早的文档；本地链接必须解析；**本文档的模块表必须列出每个模块和每个测试** |
| `tests/class-docs.spec.ts` | `src` 里每个类前必须有 JSDoc |
| `tests/model-surface.spec.ts` | 工具 schema / prompt / skills / 术语表之间**不允许漂移**，且有每角色的体积预算 |
| `tests/cards.spec.ts` | 按文件校验内置 prompt 是否陈述了必须陈述的规则 |

另有硬纪律：`src/core` 不 import 任何外部；"每类状态只有一个 writer"；`src/sources` 不许 import `src/app`。

**MeowCode 现状**

只有 `src/agent/prompt-budget.test.ts` 一个回归测试（断言 `BASE_SYSTEM_PROMPT < 360 tokens`）。`tool-contract.ts` 的注释自己写着：

> 加工具时只需要改两处：本表 + 实现；漏改本表不会静默放行……这一点靠 code review 与 `tool-input.test.ts` 的覆盖清单兜住。

**能做什么**

写一条 `tool-surface.test.ts`，断言三者集合一致：

```
toolDefinitions 的工具名集合  ==  APPROVAL_TOOLS ∪ 只读工具  ==  tool-contract.ts 的键集合
```

三十行左右的测试，能永久消灭"新加工具忘了写契约 / 忘了加审批"这一类漏。

## 4. 风险与不适用

| 风险 | 说明 |
|---|---|
| 无法验证 | 缺依赖，跑不起来；所有结论来自读代码与文档，未见运行行为 |
| 概念泄漏 | 作者自列 9 处 GitHub/Feishu 概念渗进通用层（`docs/007:275-287`） |
| 平台绑定 | 服务管理用 `fcntl` / `ps` / `tmux`，Windows 不可用 |
| 安全姿态 | `danger-full-access`，worker 以操作员 OS 用户运行，"wrapper 不是边界" |
| 未实现的部分 | 文章里的"独立 Watchdog Session""云端算/状态分离"在原型里**没有**（`docs/007:614-617` 自认 Open questions） |

## 5. 关键文件索引

按「想验证什么 → 打开哪个文件」：

| 想了解 | 打开 |
|---|---|
| 设计哲学与取舍原则 | `docs/000-philosophy.md`（33 行，值得全读） |
| 领域模型与**被否决的概念** | `docs/001-domain.md`（概念表 :21-43、否决表 :45-60） |
| 授权模型 | `docs/002-authorization.md`（155 行）+ `src/policy.ts`（242 行） |
| 2×2 准入矩阵 | `src/admission.ts`（13 行，一屏看完） |
| 工单状态派生 | `src/core/stage.ts`（26 行，最能体现"存事实算显示"的写法） |
| 副作用队列 | `src/app/effects.ts`（161 行，注释质量极高） |
| 卡片协议 | `src/app/cards.ts`（96 行） |
| 投递幂等 | `src/app/delivery.ts`（86 行） |
| 注意力预算 | `src/infra/text.ts`（20 行） |
| 架构总览与模块表 | `docs/007-architecture.md`（617 行） |
| 提示词写法 | `prompts/admission.md`（68 行）、`prompts/dispatch.md`（59 行）、`prompts/work.md`（49 行） |
| 元测试怎么写 | `tests/docs.spec.ts`、`tests/model-surface.spec.ts` |

---

_参考仓库本身保持原样，不做修改。若日后要动手，从 §3.3 的"读指针"和 §3.4 的"三集合一致测试"开始——这两项各自独立、可单独验证、不触碰 `runtime.ts`。_
