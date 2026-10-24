# MeowCode 治理架构（参考 metis-main 的核心架构版）

本文档描述 2026-10 落地的 Agent 架构改造:把"单类 AgentRuntime 承包一切"的标准 Agent
重构为 metis 式的 **薄循环 / 厚宿主 + 角色化子代理 + 治理层(可编辑架构图驱动)**。
范围是核心架构版,明确不做 G0–G7 全门禁、26 角色库、读写锁工具调度器与 self-learning。

## 一、分层总览

```
AgentRuntime (runtime.ts, 厚宿主)
 ├─ 会话 / 审批 / 插件 / 子代理编排（原有职责，保留）
 ├─ createLoopHost(): 把能力按 AgentLoopHost 接口交给薄循环
 ├─ createLoopHooks(): 治理 hooks（门禁 / 证据采集 / frontier 注入）
 ├─ WorkflowRuntime (workflow-runtime.ts): admission + gate 状态机（纯内存）
 └─ runAgentLoop() (agent-loop.ts, 薄循环)
      只负责：轮次迭代、流式请求、工具批次分派、消息记账、4 个 hook 调用点
```

对应 metis 的 vendor `agent-loop.js` + `agent-session.ts` 宿主层:循环只认
`AgentLoopHost` 接口与 `AgentLoopHooks` 钩子,治理全部在宿主侧,循环代码零治理逻辑。

### AgentLoopHooks（4 个钩子,全部可选）

| 钩子 | 时机 | MeowCode 用途 |
|---|---|---|
| `beforeToolCall` | 每次工具执行前 | admission 门禁:未 admit 时拦截变更类工具 |
| `afterToolCall` | 工具消息进入上下文后 | 根侧文件改动 → T1 G4 证据;清单更新计数 |
| `prepareNextTurn` | 两轮之间 | 注入 `[workflow]` frontier 提醒;8 次变更没更新清单的 nudge |
| `shouldStopAfterTurn` | 批次结束后 | 预留（当前由宿主续命循环承担终止判定） |

## 二、角色注册表（agent-definition.ts）

子代理仍是**进程内递归 AgentRuntime**(非 metis 的子进程隔离),但装配走注册表:
`{name, description, systemPrompt, tools 白名单, readOnly, expectedGates, injectInstructions}`。

| 角色 | 工具 | gate 绑定 | 说明 |
|---|---|---|---|
| general | 全量（含 MCP/浏览器） | — | 原通用子代理,平移 |
| explore | 只读 7 件套 | — | 只读探索,不注入 AGENTS.md |
| planner | 只读 7 件套 | G1 | 产出带文件路径的排序工作项 |
| scoper | 只读 7 件套 | G2 | 写死改动边界:可改路径 / 不可碰契约 / 明确不做（metis scoper） |
| depth-prober | 只读 7 件套 | G3.5 | 把计划依赖的假设逐条证实或证伪,未解未知不许开工（metis depth-prober） |
| implementer | 只读 + 写 + 命令 | G4 | TDD 实现一个 lane |
| reviewer | 只读 7 件套 | G5 | 独立评审,输出 severity + file:line findings |
| verifier | 只读 + run_command | G0 / G6 | 真实跑验证命令,报告退出码;复杂档用它跑基线 |
| fresh-verifier | 只读 + run_command | G6 | 没参与实现的独立复验者（metis fresh-verifier） |
| juror | 只读 7 件套 | G7 | default-FAIL 终审,每条结论都要亲手打开证据（metis juror） |
| sweeper | 只读 7 件套 | sweep | 收敛清扫:漏改的调用点 / 半截重命名 / 残留死代码（metis sweeper） |
| goal-checker | 只读 7 件套 | goal-check | 用户诉求逐条对证据,未验证即未达成（metis goal-checker） |
| custom | 全量 | 图决定 | 架构图自定义角色 |

task 工具的 `agent_type` 枚举由注册表决定;`lane_id` 把派发绑定到治理 lane。
`readOnly` 角色的子会话直接落在 read-only 审批模式(verifier 除外——它要跑命令,
文件写由白名单排除)。请求的角色不在当前主 Agent 档位里时,task 直接报错并列出可用角色
(不再静默回落 general)。

### 主 Agent 档位（agent-profiles.ts,会话级）

主 Agent 不再只有一种装配:会话级 `agentProfile` 决定根 runtime 的提示词、工具白名单、
可派发角色与并发上限。切换走 `PUT /session/agent-profile`,随 `session_settings` 落盘、恢复。

| 档位 | 子 Agent 角色 | 主 Agent 工具 | 并发上限 | 架构图门禁 |
|---|---|---|---|---|
| `standard` 标准 Agent | 7 个（general/explore/planner/implementer/reviewer/verifier/custom） | 全量 | 3 | T1/T2 走 G4→G5→G6 |
| `minimal` 极简 Agent | general / explore | 仅 `read_file` + `run_command` | 1 | 无门禁 |
| `complex` 复杂 Agent | 13 个（标准 7 个 + scoper / depth-prober / fresh-verifier / juror / sweeper / goal-checker） | 全量 | 5 | T1: G0→G4→G5→G6→goal-check；T2: G0→G1→G2→G3.5→G4→G5→G6→G7→sweep→goal-check |

复杂档的门禁链照搬 metis 的 `builtin-harness.ts`(G0 基线 / G1 规划 / G2 范围 / G3.5 深挖锁定 /
G4 实现 / G5 评审 / G6 独立复验 / G7 终审 / sweep 收敛 / goal-check 目标核对),
每道门禁绑一个独立角色,`onFail=loop-to:G4` 让评审/复验/终审/清扫失败都回到实现返工;
metis 的 T3 在 MeowCode 里并入 T2(T2 已经是并行 lane)。

`task` / `admit` 是编排通道,任何档位都保留;档位只收紧 `task.agent_type` 枚举与干活工具。
子 Agent 的 `allowedTools` 在创建时与档位白名单求交集,所以极简档的 general 也只有两个工具。

**每个档位一张独立架构图**:图存在 `.meowcode/harness/<profile>.json`(`standard` / `minimal` / `complex`),
互不覆盖;旧版单图 `.meowcode/harness.json` 只作为标准档的兼容来源。
角色名统一走 `AGENT_ROLE_LABELS`(通用 / 探索 / 规划 / 范围界定 / 深挖 / 实现 / 评审 / 验证 /
独立复验 / 终审 / 收敛清扫 / 目标核对 / 自定义);`completeHarnessRoles()` 在载入时把该档位
**可派发但图里没画**的内置角色节点补上并接到根节点(只加不删,用户删掉的层级/门禁/连线一律尊重),
所以每张图都是该主 Agent 的完整装配。`custom` 不自动补:它要在节点面板里自己配提示词与工具,
默认画一个空壳没有意义(需要时手动加一个 role 节点并把 role 设成 custom)。极简档的种子图只有
根节点 + 通用 / Explore,没有层级与门禁(它的工具集里没有实现/评审/验证角色,门禁无处关账);
复杂档的种子图是 metis 式十道门禁 + 十个关账角色,和标准档的三道门禁完全不同。
切档后 `setAgentProfile` 会重新装载当前档位的图;治理 run 活跃时保持旧快照,下一轮生效。
门禁本身仍只由会话模式 `goal` 决定,档位只改变"图里有没有门禁"。

## 三、ChildResult 契约（child-result.ts）

implementer / reviewer / verifier 的最终报告必须带 ```json 块:

```json
{"status": "completed", "summary": "...", "findings": [{"severity": "critical", "message": "...", "location": "a.ts:12"}]}
```

宿主结算流水线:**normalize(宽容归一化) → mergeHostObservations(宿主观测覆盖自述) →
validate(fail-closed)**。宿主观测是 ground truth:

- `filesChanged`:子会话 onFileChange 回写时记录;
- `commands`:子事件流里 run_command 的 tool_started/finished 配对(exitCode 以 ok 近似)。

fail-closed 规则:implementer 宣称完成但观测不到文件改动 → invalid
(`IMPLEMENTER_COMPLETED_WITHOUT_FILE_CHANGES`);verifier 完成但没跑命令 → invalid;
reviewer 失败但不给 findings → invalid。校验结果随任务工具结果回灌父模型
(`Child result (host-verified): ...`),并发 `child_result` 事件。

## 四、治理层（workflow-runtime.ts）

### admission（admit 工具,控制面虚拟工具,不走审批）

```
admit { tier: T0|T1|T2, task_shape, lanes[] }
  T0: 琐碎任务,无 gate,run 立即完成(门禁解除,留审计)
  T1: 隐式单 lane "main";root 自己实现(观测到文件改动即 G4 过)
  T2: 显式 lanes + depends_on DAG;owned_paths 两两不相交;依赖完成自动激活
```

校验 fail-closed:tier 枚举、task_shape 非空、lane id 规范、依赖存在、无环
(DFS)、ownedPaths 不重叠(大小写/斜杠归一化比较)。活跃 run 期间重复 admit 拒绝;
**新的用户请求会把已完成的 run 清空,门禁重新武装**。

### 门禁（beforeToolCall hook)

`governance: "off" | "goal" | "always"`(构造参数,默认 `"goal"`):

- off:完全不启用(admit 工具也不注册);
- goal:仅 goal 模式的会话强制(默认);
- always:所有模式强制。

条件 `workflow.needsAdmission && GOVERNANCE_GATED_TOOLS.has(tool)` 时拦截
write_file / edit_file / multi_edit / run_command / task / browser_navigate /
browser_click / browser_type,提示先 admit。只读工具与 update_plan 不受影响。
审批流与治理门禁是叠加关系,互不替代。

### gate 状态机(由可编辑架构图驱动)

门禁序列、角色绑定、失败回跳**全部来自工作区 `.meowcode/harness.json`**
(格式参考 metis `.metis/harness.json`,见 `src/agent/harness-document.ts`;
缺省回内置种子 = G4→G5→G6、失败回跳 G4):

```
nodes: [ {id, type: tier|gate|role, data, position(编辑器画布坐标)} ]
edges: [ {id, source, target, type, order} ]
  tier-gate  (带 order):admit 该 tier 时的门禁执行序
  gate-role            :该门禁由哪个内置角色关闭
gate 节点 data.onFail: "block" | "loop-to:<gateId>"(失败回跳/阻塞)
```

- 图编辑器在桌面端「Agent 架构 → 治理流程」:拖节点、增删、连线、改 onFail,
  保存走 `PUT /harness`(服务端结构校验,metis 原则:只管结构,故意删掉 G6 或
  reviewer 不算错误——那是用户的架构决策);
- 快照按 run 冻结:admit 前装载一次,run 中不换图;
- 判定语义按绑定角色(implementer=文件改动 / reviewer=无 critical / verifier=命令全 0),
  把门禁绑给其他角色则只认 completed+valid;
- 把某 tier 的 tier-gate 边全删 = 该 tier 无门禁、声明即完成(内置 T0 即如此);
- 序列里的门禁缺 gate-role 绑定时 admit fail-closed 拒绝并提示补边。

其余硬规则:独立性(一道门禁的关账 agent ≠ 同 lane 此前所有门禁关账者)、
每 lane 返工上限 3 次超限 blocked、宿主续命 ≤2 次。

### 宿主续命循环（runPrompt 内)

```ts
await this.runTurn(session);
let continuations = 0;
while (continuations < 2 && (await this.handlePostPrompt(session))) {
  continuations += 1;
  await this.runTurn(session);
}
```

模型停止回答而治理 run 仍活跃 → 持久化 `[workflow]` context note 并强制继续,
最多 2 次(metis `_unfinishedPerformanceContinuation`)。lane 全部 blocked 时不再催。
frontier 每回合尾注入(ephemeral,不落盘),轮间由 prepareNextTurn 注入。

## 五、一次受治任务的生命周期

```
用户 prompt (goal 模式)
 → 变更工具被拦(门禁) → 只读调查自由
 → admit {tier, lanes}            [门禁解除; workflow_admitted + roadmap 事件]
 → update_plan 建清单
 → T1: root 实现(观测到文件改动 → G4 过)
    T2: 按 DAG 激活 lane;task(implementer, lane_id) → ChildResult → G4
 → task(reviewer, lane_id)  → findings 无 critical → G5 过(critical → 返工)
 → task(verifier, lane_id)  → 验证命令全 0 → G6 过 → lane done → 下一 lane 激活
 → 全 lane done → run completed
 → (模型中途谎报完成 → 宿主注入续跑,≤2 次)
```

## 六、事件与持久化

新增 MeowEvent:`workflow_admitted` / `workflow_gate` / `workflow_roadmap`(状态变化
全量快照,前端单一数据源)/ `child_result`。新增 SessionEntry:`admission` /
`gate_report` / `child_result`(审计;重放白名单制,天然不进 effectiveMessages)。
桌面端:计划页签顶部渲染 roadmap(lanes + G4/G5/G6 徽章),子 Agent 列表加角色徽章
与"已核验/校验未过"徽章。

## 七、与 metis 的对应关系

| metis | MeowCode | 差异 |
|---|---|---|
| vendor agent-loop(4 hooks) | agent-loop.ts AgentLoopHost/Hooks | 形态相同;循环内保留上下文装配调用 |
| agent-session 宿主层 | runtime.ts createLoopHost/createLoopHooks | 宿主是类内适配层而非独立文件 |
| .metis/harness.json 可编辑架构图 | .meowcode/harness.json + harness-document.ts | 无 framework 层;tier→gate 直接带序 |
| builtin-harness.ts 种子 | builtinHarnessSeed() | G4→G5→G6 + gate-role 绑定 + loop-to:G4 |
| performance_admit(T0–T3) | admit 工具(T0–T2) | 砍 T3 与 16 framework 路由 |
| PerformanceRuntime gate 白名单 | WorkflowRuntime(按图推导) | 门禁序列/绑定/回跳来自 harness.json |
| spawn_agent 子进程 | task 工具递归 AgentRuntime | 进程内;审批路由/事件转发复用现有机制 |
| ChildResult 契约 + normalize | child-result.ts | 证据用宿主观测(更强),非纯自述 |
| 独立性校验(作者≠评审≠验证) | 同(泛化为"关账者≠此前关账者") | 按图上任意门禁数生效 |
| _unfinishedPerformanceContinuation | handlePostPrompt 续命循环 | 上限 2 次 |
| workflow_context 隐形通道 | ephemeral 尾注 + context_note("workflow") | 注入不落盘,续命注落盘 |
| CHECKLIST_MUTATE_INTERVAL=8 | mutationsSincePlanCheck nudge | 同阈值 |
| SpawnGuard(深度/并发/去重) | MAX_SUBAGENTS_PER_TURN=3(既有) | 砂粒度更粗 |

## 八、关键文件

- `src/agent/agent-loop.ts` — 薄循环 + AgentLoopHost/AgentLoopHooks
- `src/agent/agent-definition.ts` — 角色注册表(BUILTIN_AGENTS)
- `src/agent/child-result.ts` — ChildResult 契约 + fail-closed 校验
- `src/agent/workflow-runtime.ts` — 治理状态机(admission/lanes/gates)
- `src/agent/runtime.ts` — 厚宿主:createLoopHost / createLoopHooks / handlePostPrompt
- 测试:`agent-loop.test.ts` / `agent-definition.test.ts` / `child-result.test.ts` /
  `workflow-runtime.test.ts` / `runtime.workflow.test.ts`(集成) / `runtime.subagent.test.ts`
