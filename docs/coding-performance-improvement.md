# 提升模型编程性能：Harness 工程调研报告与改进路线图

> 日期：2026-10-17 ｜ 范围：Harness 工程（工具 / 上下文 / 验证闭环），不涉及模型微调与选型

---

## TL;DR

1. **评测分数的大头在 Harness，不在模型。** OpenAI 公开数据：同一模型在 ARC-AGI-3 上，仅把"滚动截断"换成"保留推理 + 上下文压缩"，得分从 **13.3% → 38.3%**，输出 token 反而少 6 倍（来源：OpenAI《Harness Engineering》，掘金中文解读 https://juejin.cn/post/7677218586256670735 ）。
2. **MeowCode 的编辑正确性与上下文省钱已是同类中上水平，但能力上限被三件事压制：没有验证闭环、没有代码智能（LSP/诊断）、没有 git/checkpoint。**
3. **建议第一步：做"编辑后自动验证 + 失败回灌自修复"闭环（R1）**，这是所有头部开源项目公认的可靠性核心，也是当前投入产出比最高的一项。

### 路线图总表

| 编号 | 方向 | 优先级 | 核心动作 | 主要落地模块 |
|---|---|---|---|---|
| R1 | 验证闭环 | **P0** | 编辑后自动跑 typecheck/lint/test，失败结构化回灌，限时自修复循环 | `runtime.ts`、`tools.ts` |
| R2 | 上下文工程 | **P0** | 85% 填充率预压缩、命令输出瘦身、验证输出压缩 | `context.ts`、`compaction.ts`、`tools.ts` |
| R3 | Git 集成 | P1 | 每轮 checkpoint（可不依赖 git）、仓库级 diff 注入 | 新模块 + `runtime.ts` |
| R4 | 自建评测集 | P1 | 小型任务集量化回归，防止盲改 harness | `eval/` 新目录 |
| R5+ | 其余 P1/P2 | P2 | 流式命令输出、JSON 参数修复、后台进程、web fetch 等 | 见文末附表 |

---

## 一、为什么 Harness 决定编程性能

### 1.1 硬数据

| 数据 | 数值 | 来源 |
|---|---|---|
| ARC-AGI-3：滚动截断 → 保留推理+压缩 | **13.3% → 38.3%**，输出 token 少 6 倍 | OpenAI《Harness Engineering》 |
| 检索分层：全仓塞入 vs 定向检索 | 100k → 3k token/查询，**100 倍成本差**且效果更好 | getburnrate.io 上下文工程综述 |
| 长会话衰减（Context Rot） | 第 1 轮正常 → 第 15 轮出现推理错误 → 第 50 轮输出不可用 | openllm.wavise.com |
| Lost in the Middle | 关键信息放中间，准确率**下降 10-40%** | Stanford (Liu et al. 2023) |
| LLM 自动生成的规则文件 | **伤害性能**，且多烧 20%+ token | ETH Zurich（prg.sh 引用） |

结论：**"能否提升模型编程能力"——能，而且不需要动模型。** 上述每一条都是不改一行模型权重、纯 harness 侧的改动。

### 1.2 机制解释

- **Context Rot**：注意力被摊薄、早期指令被工具输出掩埋、重复内容挤占预算。表现为"前几轮很聪明，越改越崩"。
- **验证即反压（back-pressure）**：测试/类型检查结果是唯一能让模型"知道自己错了"的信号。没有它，模型把错误带进下一轮继续放大。注意：验证输出本身也要压缩——4000 行通过测试会让模型产生"已完成"的幻觉。
- **上下文结构**：关键规则放头部 10%，最近任务上下文放尾部 5%，中间的历史尽量压缩。

---

## 二、开源项目做法对照（本地可直接查看）

| 项目 | 机制 | 本地路径 | 值得抄什么 |
|---|---|---|---|
| **Codex** (codex-main) | apply_patch 流式解析器 + file_update | `codex-main/codex-rs/apply-patch/src/`（`parser.rs`、`file_update.rs`、`streaming_parser.rs`） | 编辑工具的解析健壮性；把"验证命令写进规范"作为仓库默认组件 |
| **Codex** | AGENTS.md = 目录页而非百科全书；任务跑在独立 git worktree | `codex-main/AGENTS.md` | 规则文件短小 + 用环境物理隔离而非指令恳求 |
| **opencode** | Snapshot：capture / diff / restore，**不依赖 git 的文件级 checkpoint** | `opencode-2/packages/core/src/snapshot.ts` | MeowCode 无 git 仓库（D:/MeowCode 本身不是 git repo）也能做 undo |
| **opencode** | Formatter：编辑后自动格式化的 hook 点 | `opencode-2/packages/core/src/formatter.ts` + `formatter/builtins.ts` | "编辑完成"事件后挂后处理，正是 R1 验证闭环要复用的注入点 |
| **opencode** | git / worktree 隔离 | `opencode-2/packages/core/src/git.ts`、`worktree.ts` | 大改动先开 worktree，崩了不污染主树 |
| **ZCode** | hooks / plugins / skills 体系、trajectory 记录 | `ZCode-main/apps/zcode-cli/packages/`、`docs/plan/trajectory/` | 用 PostToolUse 类钩子做**确定性检查**（防提前宣告胜利靠运行时强制，不靠提示词恳求） |
| **Claude Code**（业界实践） | 分层记忆（组织→用户→项目→本地）、子 agent 独立 sidechain、五层压缩漏斗（先无损剪枝再有损摘要） | 无本地副本，见掘金解读 | 压缩分级：先丢旧工具输出，再结构化提炼，最后才 LLM 摘要 |

---

## 三、MeowCode 现状审计

### 3.1 已经做对的（保持，别推翻）

| 能力 | 证据 |
|---|---|
| 编辑正确性：6 级模糊匹配（exact→行尾→剥行号→rstrip→trim→Unicode 归一）+ 唯一性校验 | `src/agent/edit-content.ts:51-76, 269-324` |
| multi_edit 事务性：全内存预演 + 逐文件原子写 + 失败回滚 | `src/agent/tools.ts:800-930` |
| 整文件重写护栏：改动 <35% 拒绝 write_file | `src/agent/tools.ts:743-766` |
| 编辑失败反馈：not-found 给最近似行，not-unique 给全部命中行号 | `src/agent/tools.ts:686-725` |
| 旧工具输出淘汰：6 轮后清内容保结构，写操作回执不淘汰 | `src/agent/context.ts:161-194` |
| 压缩保留近期：16k 逐字保留，只摘要更早历史 | `src/agent/compaction.ts:16` |
| @文件 注入：按窗口 5% 预算、去重占位、编辑后重注 | `src/agent/file-mentions.ts:8-15` |
| 截断保护：finishReason=length 时工具参数不执行 | `src/agent/runtime.ts:1503-1520` |
| 审批期间文件变更二次确认 | `src/agent/runtime.ts:2507-2557` |

### 3.2 P0 缺口（直接压制能力上限）

1. **无验证闭环**：编辑后不自动跑 typecheck/lint/test；goal 模式仅靠提示词要求"自己验证"（`runtime.ts:143`）。模型改完对不对，全靠自觉。
2. **无代码智能**：无 LSP、无 tree-sitter、无诊断；检索只有 glob+grep（`search.ts`）。拿不到类型错误、未使用符号等结构信息。
3. **无 git 集成**：无 checkpoint/undo/仓库级 diff 上下文（审批 diff 只有单文件 3 行上下文，`diff.ts:13`）。模型看不到"本轮改了什么"，用户不敢放手。
4. **命令无沙箱**：`run_command` 以当前用户全权限跑 PowerShell，仅审批 + 高危提示（`tools.ts:989-1075`）。

### 3.3 P1 缺口（削弱效率与可靠性）

- 命令输出非流式，进程结束才一次性返回（`tools.ts:1041-1060`）
- 无后台进程管理，120s 固定超时 kill 全树（`tools.ts:1067-1074`）——起 dev server 后继续干活做不到
- **无自动预压缩**：只在 provider 报溢出后才压缩，85% 仅"建议"（`context.ts:48-58`、`runtime.ts:1420-1438`）——溢出那一刻才压，白浪费一个完整往返
- 工具参数 JSON 解析失败直接报错，无修复（`runtime.ts:208-221`）
- 规则文件只读根目录，不向下遍历子目录（`instructions.ts:14-36`）
- 无 web fetch、无模型 fallback、子 agent 重复携带全量工具 schema

---

## 四、改进路线图

### R1 验证闭环（P0，最优先）

**目标**：让模型在"改完"和"交差"之间强制经过一道客观检查。

**设计**：
1. **项目验证配置**：约定文件（如 `.meowcode/verify.json`）声明 typecheck/lint/test 命令；没有就用启发式探测（package.json scripts、tsconfig.json 存在 → `tsc --noEmit`）。
2. **触发点**：写类工具（write_file / edit_file / multi_edit）成功后，若本会话开启验证，静默跑最快的检查（typecheck 优先，test 仅在 goal 模式或用户要求时）。
3. **回灌方式**：失败结果**结构化压缩**后作为工具结果附注回灌（文件:行号:错误信息，去重、限量 20 条），模型下一轮自动修复——不需要新工具调用。
4. **防循环**：自修复最多 2 轮，仍失败则如实报告用户，不静默重试。
5. **输出压缩**：验证输出本身按"头尾保留 + 重复行折叠"瘦身（呼应 back-pressure 原则）。

**参考实现**：opencode Formatter 的"编辑完成 → 挂后处理"模式（`opencode-2/packages/core/src/formatter.ts`）。

**落地模块**：`runtime.ts`（executeToolCall 成功路径后插 hook）、`tools.ts`（复用 run_command 的执行与截断设施）、新文件 `src/agent/verify.ts`。

**验收标准**：故意引入类型错误 → agent 在同一回合内收到错误并修复，全程无需用户干预；通过时回执不增加噪声（"verified"一行即可）。

### R2 上下文工程（P0，与 R1 同批或紧随）

**目标**：对齐业界 fill-rate 实践，消灭"溢出才压缩"的浪费。

1. **预压缩**：本轮请求前估算消息总 token，≥85% 窗口即主动触发压缩（而非等 provider 报错）；50-70% 区间开始激进淘汰旧工具输出。落地 `context.ts`（已有 `contextUsagePct` 基础）+ `runtime.ts:1420-1438` 改为前置检查。
2. **命令输出瘦身**：run_command 结果进上下文前过滤——去进度条/时间戳、连续重复行折叠成 `×N`、超长只留头尾。直接复用现有落盘机制（`.meowcode/tool-output/`），给模型看的与落盘的分离。落地 `tools.ts:1041-1060`。
3. **压缩保真**：摘要时保留"目标、已改文件清单、失败尝试、下一步"，与 Anthropic 三 agent 模式的 progress-file 思路一致。落地 `compaction.ts:6-9` 提示词微调。

**验收标准**：构造超长会话，对比改造前后"溢出错误次数 = 0"且关键指令（AGENTS.md 规则）在 50 轮后仍被执行。

### R3 Git 集成（P1）

1. **轻量 checkpoint**：仿 opencode Snapshot（`snapshot.ts` 的 capture/restore 接口），在每轮写操作前对目标文件做快照（内存或 `.meowcode/checkpoints/`），支持按文件 restore——**不强依赖 git**，D:/MeowCode 自身不是 git 仓库也能用。
2. **仓库级 diff 注入**：会话开始与 goal 模式每 N 轮，把"自本轮起已变更文件的 diff 摘要"注入上下文（复用 `diff.ts`），让模型始终知道自己改过什么。
3. 进阶（可选）：检测到 git 仓库时提供 `git worktree` 隔离大改动（参考 `opencode-2/packages/core/src/worktree.ts`）。

### R4 自建评测集（P1，防盲改）

**目标**：harness 改动可量化，避免"感觉变好了"。

- 收集 10-20 个真实小任务（bug 修复 / 小特性 / 重构），每个含：初始仓库快照、任务描述、验收命令（`tsc && vitest run`）。
- 跑分脚本：起 agent → 执行任务 → 跑验收命令 → 记录通过率、轮次数、token 消耗。
- 以后每次 harness 改动（R1/R2/R3）跑一遍对比。OpenAI 那组 13.3→38.3 的数据，正是靠这种可重复评测才被发现的。

### R5+ 其余项简表（P2，按需取用）

| 项 | 动作 | 落地 |
|---|---|---|
| 流式命令输出 | stdout 增量发事件，UI 实时可见，模型可提前止损 | `tools.ts:1041-1060` |
| 后台进程 | `run_command` 加 `background` 参数，返回进程句柄，可后续查询输出 | `tools.ts` |
| JSON 参数修复 | 解析失败先尝试去尾逗号/补全引号再报错 | `runtime.ts:208-221` |
| 规则文件遍历 | 读到 cwd 向下两层子目录的 AGENTS.md | `instructions.ts:14-36` |
| web fetch | 新增 `web_fetch` 工具（读网页正文转 markdown，无需开浏览器） | `browser-tools.ts` 旁 |
| 模型 fallback | 主力模型 429/5xx 时按备选列表降级 | `http.ts:51-112` |
| 子 agent 减负 | explore 子 agent 只注入只读工具的 schema | `runtime.ts:1737-1758` |

---

## 五、第一步建议

**从 R1 的最小切面开始**：`.meowcode/verify.json` 声明验证命令 → `write_file/edit_file/multi_edit` 成功后自动跑 typecheck → 失败结构化回灌（限量 20 条）→ 2 轮自修复上限。

改动集中在 3 个文件：`src/agent/runtime.ts`（hook 点）、`src/agent/tools.ts`（复用执行设施）、新增 `src/agent/verify.ts`（约 200-300 行）。做完这一项，MeowCode 就从"会改文件"跨到"能对结果负责"，这是所有头部开源项目公认的分水岭。

---

*参考来源：OpenAI《Harness Engineering》（掘金解读 juejin.cn/post/7677218586256670735）；getburnrate.io《Context Engineering》；openllm.wavise.com《Context Engineering for AI Coding Agents (2026)》；prg.sh《Context Engineering》（ACE/ICLR 2026、ETH Zurich 数据）；本地参考仓库 codex-main / opencode-2 / ZCode-main。*
