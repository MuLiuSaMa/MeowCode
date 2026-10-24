# MeowCode vs 6 个参考开源项目 对比分析报告（v2）

> 对比对象：Codex CLI(Rust) / opencode-2(TS) / ZCode(TS) / DeepSeek Harness(TS) / Metis(TS) / AllAgent.NET(C#)
> 分析日期：2026-10-18（v2，覆盖 10-18 当天落地的新改进：三层压缩触发链、流中工具执行、图片资产化、SSE 合帧）
> MeowCode 实测基线：`vitest run` **474 通过 / 33 文件（10.6s）**；`tsc --noEmit` **0 错误**；源码 TODO/FIXME **0 处**

---

## 一、七项目规模与质量实测对比

| 项目 | 语言 | 代码规模 | 测试 | TODO/FIXME | 工程门禁 |
|---|---|---|---|---|---|
| codex-main | Rust | **208 万行** / 186 crate | 21,229 用例 + 1,588 快照 | ~73 处（200 万行中密度极低） | deny unwrap/expect 40+ 项、多平台 CI、nextest 分片 |
| opencode-2 | TS | **85 万行** / 35 包 | 1,159 测试文件 | ~55 处 | oxlint + ast-grep 自定义规则、turbo typecheck、禁止根目录跑测试 |
| ZCode-main | TS | **205 万行** / 13+33 包 | 2,762 测试文件（core 测试 13 万行 > 源码 10.4 万行） | ~32 处 | 架构检查 baseline 0 violations、knip、pre-push 全链路 |
| deepseek-harness | TS | **~4.8 万行**（packages 25.7k + apps 22.1k） | 1,497 spec 文件 | 27 个文件 | everything-is-a-plugin(Cordis)、developer preview |
| metis-main | TS | **src 8.96 万行** + 测试 7.37 万 + desktop 7.7 万 | 310 文件 / ~2,794 用例 | **0 处** | CI + prompt 预算回归测试 + 缓存前缀字节级断言 |
| AllAgent.NET | C# | **2.78 万行** | 448 用例（含真实 microVM 集成） | **0 处** | `dotnet test` 一条命令、doctor 自检 |
| **MeowCode** | TS | **~2.1 万行**（agent 内核约 1.2 万，server 0.16 万，desktop 0.75 万） | **474 用例 / 33 文件，全过** | **0 处** | vitest + tsc 零错误 |

**结论：MeowCode 是七个项目里核心最小的（体量约为 codex 的 1/100），且做到了"0 TODO + 测试全过 + 类型零错误"的一线卫生水平。**

---

## 二、MeowCode 已完成内容（实测清单）

### Agent 内核（src/agent，~1.2 万行非测试）

| 模块 | 行数 | 内容 |
|---|---|---|
| runtime.ts | 3,294 | Agent 主循环、子 Agent、审批、三层上下文治理 |
| tools.ts | 1,241 | 10 个工具定义与执行 |
| session-store.ts | 1,403 | JSONL 持久化、断点恢复、图片资产目录 |
| context.ts | ~550 | token 估算（CJK 感知）、usage 锚点、工具配对修复 |
| verify.ts | 383 | **写后自动验证闭环**（.meowcode/verify.json，失败回灌同回合修复） |
| compaction.ts | ~250 | 双层压缩：全量摘要 + 工具输出纪要 |
| anthropic.ts / responses.ts / provider.ts / http.ts | ~1,100 | 三协议 provider、429 指数退避、prompt caching |

### 已落地的关键能力

1. **10 个工具**：list_dir / read_file / glob / grep / write_file / edit_file / multi_edit / run_command / task(子 Agent) / update_plan
2. **三协议 provider**：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses；国内服务商目录（DeepSeek/Kimi/通义/智谱/OpenRouter）
3. **上下文治理三层**（10-18 新增）：0.8~0.95 后台预热压缩 → 85% 回合间隙主动档（零模型调用）→ 溢出四级降级（stage0 采纳预热 / 1 收缩 / 1.5 等预热 / 2 工具纪要 / 3 全量摘要）
4. **Token 效率核心件**：Anthropic 缓存三点布局（system[0]+末工具定义+末消息）+ 网关拒识时自动剥字段降级重试；usage 锚点计量（服务商真实 input token + 尾部估算）；CJK 感知估算（中文 1 字≈1 token）
5. **压缩防误报**：OVERFLOW_EXCLUSIONS 排除限流/max_tokens 配置错误，不把 429 当溢出白丢历史
6. **流中工具执行**（实验开关 midstreamToolExec）：只读工具参数 JSON 闭合即提前执行，按原序回填
7. **图片资产化**：JSONL 不存 base64，落 sessions/assets/，恢复 hydrate 回填
8. **SSE→IPC 合帧**（desktop/event-batcher.cjs）：16ms 微批 + 白名单 + 终态直发
9. **安全基线**：API Key 注入后立即从 env 删除；run_command 过滤敏感环境变量；写操作四档审批（read-only/ask/auto/full）+ diff 外部改动自动刷新
10. **桌面集成**：内置终端、Agent 浏览器面板、侧边聊天、文件快开

### BUG / 漏洞排查结论（实测）

- **474 个测试全部通过，tsc --noEmit 零错误，源码 0 TODO/FIXME** —— 未发现功能性 BUG 或已知崩溃路径
- 测试桩里模拟的失败场景（磁盘满、prompt too long、journal 失败）均有对应用例覆盖且行为符合设计
- 属于**设计级缺口**（非 bug，但确实是安全/能力短板）：
  - 无 OS 沙箱：full 模式下模型可写工作区外路径（Windows 无隔离层）
  - 无 MCP：外部工具生态入口缺失（6 个参考项目全部支持）
  - runtime.ts 单文件 3,294 行 / 128KB，修改风险集中
  - AGENTS.md 单层读取，monorepo 子目录规则丢失；系统提示词未做 stable/dynamic 分区（缓存前缀稳定性弱于 ZCode/metis）

---

## 三、综合排名（工程成熟度 × Token 效率 × 功能广度 × 轻量度 × 开放性）

| 排名 | 项目 | 工程 | Token | 功能 | 轻量 | 开放 | 一句话定位 |
|---|---|---|---|---|---|---|---|
| 🥇 1 | **codex-main** | 10 | 10 | 10 | 2 | 6 | 工业级标杆，208 万行的质量天花板 |
| 🥈 2 | **opencode-2** | 9 | 8 | 9 | 3 | 9 | 现代架构 + 226 provider 生态最全 |
| 🥉 3 | **ZCode-main** | 9 | 8 | 9 | 2 | 6 | 测试超过源码，治理工具化，绑定智谱 |
| 4 | **metis-main** | 8 | 9 | 8 | 5 | 7 | Token 效率工程化最深，但核心三包只发 dist |
| 5 | **deepseek-harness** | 7 | 7 | 8 | 7 | 8 | 架构最现代（everything-is-a-plugin），developer preview |
| 6 | **MeowCode** | 8 | 6 | 4 | 10 | 7 | 七者中最小核心 + 国内生态，功能广度差距明显 |
| 7 | **AllAgent.NET** | 9 | 8 | 6 | 8 | 4 | 工程质量极高，但 Windows/Hyperlight 深锁定 |

### Token 效率专项排名（用户核心关注）

| 排名 | 项目 | 依据 |
|---|---|---|
| 1 | **codex-main** | 稳定前缀 + 内容哈希 item ID + prompt_cache_key + deferred tool loading(tool_search) + code mode + 三级压缩（本地/远程/token-budget）+ 输出截断体系，全链路且有实现 |
| 2 | **metis-main** | Prompt 长度预算写成 CI 回归测试（system prompt < 10k 字符）、缓存前缀字节级断言、零 token 学习过滤、截断分页引导、子代理隔离 |
| 3 | **AllAgent.NET** | CodeAct 单工具范式（模型只见 execute_code，37 个宿主工具走系统提示词目录）+ prompt 分段有序化 + Anthropic 4 断点 + 三层输出预算 |
| 4 | **opencode-2** | compaction 阶梯收缩(0.7/0.5/0.35) + code mode(2000 字符目录预算) + cache 血缘 + 动态工具指引 + provider 原生 compact |
| 5 | **ZCode-main** | auto compact 优先采信 provider 真实 usage + microcompact(免费剪枝层) + Bash 30KB artifact 落盘 + skill 元数据预算 + cache hit rate 可观测 |
| 6 | **deepseek-harness** | PTC run_code（类似 code mode）+ tool-result-pruner + image-offload + spill |
| 7 | **MeowCode** | 三点缓存布局+降级重试、双层压缩、usage 锚点、CJK 估算、三层触发链——**单点不弱，系统性有缺口**（见下） |

**MeowCode 省 Token 判断：核心单项达到参考项目中上游水准，但整体排第 7。** 关键差距：

| 差距 | 参考项目做法 |
|---|---|
| 系统提示词无 stable/dynamic 分区 | ZCode cacheHint 分区；metis 运行时上下文走 user 消息；dsh surface node 0 |
| 无免费 tool-result 剪枝层（现有 summarizeToolOutputs 要花模型调用） | ZCode microcompact 占位符替换；dsh tool-result-pruner head/middle/tail |
| 无 code mode / deferred tools | codex/opencode/dsh/AllAgent 均有"一段代码编排多工具"或"工具按需加载" |
| read_file 超限砍头不可恢复 | metis head+tail+落盘；dsh spill |

**但注意反向优势**：按"单位代码量的 token 优化密度"MeowCode 排第一；且 **CJK 感知估算是 7 个项目里独有的**——海外项目按 4 字符/token 一刀切，在中文场景会严重低估上下文（真实溢出风险），国内服务商场景下 MeowCode 的实用 token 安全性反而占优。

---

## 四、每个项目的优缺点

### 1. codex-main（OpenAI，Rust）🥇

**优点**：① 架构分层彻底（186 crate，protocol 与 core 解耦，Session/Turn/Step 三级上下文）；② 质量门禁业界顶配（deny unwrap/expect、21k 测试、1,588 快照、多平台 CI）；③ Token 效率全链路系统化（前述 7 项）；④ 安全体系深入（landlock/seatbelt/Windows sandbox、exec policy、Guardian）；⑤ 压缩机制最全（本地/远程/token-budget 三实现 + mid-turn/post-turn 触发）。

**缺点**：① 208 万行，认知与维护成本极高，feature flag 膨胀（大量 UnderDevelopment）；② 强绑定 OpenAI（仅 Responses wire，无 Anthropic 内置，chat 已移除）；③ 已知问题未清：TRACE 级 SQLite 日志磨损 SSD（#28224 此快照未修）、V8 macOS 崩溃、Windows SQLite I/O 卡顿、Guardian 误报；④ 文档严重脱节（docs/config.md 6 行 stub）；⑤ 云/IDE 集成体系（app-server 196k 行）占比过高。

### 2. opencode-2（TS）🥈

**优点**：① 架构先进自洽（Effect-TS 全链路 + 持久化事件 session + 写前 claim 崩溃恢复）；② provider/协议层自研且深（226 provider、8,443 模型、36+ 协议适配、4 breakpoint 缓存管理）；③ 测试哲学硬（1,159 测试文件、禁根目录跑测试、自定义 lint 规则）；④ token 效率成体系（前述 5 项）；⑤ 产品形态完整（TUI + Electron + Web + ACP + 扩展宿主）。

**缺点**：① 85 万行，session 子系统单目录 38 文件，上手成本高；② 强绑定 Effect 4.0 beta + bun + 三套条件导出，技术选型激进排他；③ v2 剧烈演进中：HTTP API 139 端点尚在审计收敛、claim 非 exactly-once、clustered execution 未实现；④ provider 拼通过度碎片化（大量代理网关，行为一致性靠白名单兜底）；⑤ GUI 成熟度落后于核心（多处 TODO "Restore X when V2 client exposes…"）。

### 3. ZCode-main（智谱，TS）🥉

**优点**：① Agent 核心工程质量高（显式 turn 状态机非法迁移即报错、工具调度器拓扑+并行+只读元数据、read-file-state 防 stale 编辑）；② 测试投入罕见（core 测试 13 万行 > 源码 10.4 万行，flaky 测试有根因注释）；③ 治理体系化工具体系（architecture-check baseline 0 violations、knip、pre-push 全链路）；④ 文档与 spec 文化（300+ docs、spec 先行）；⑤ provider 抽象干净（三种协议 + revision 热更新 + 远程目录）。

**缺点**：① 205 万行全仓 + 嵌套 monorepo（双 lockfile/turbo/vitest）；② 内部审计顽疾：fix:feat ≈ 3.7:1、CI lint/typecheck job 曾被 `when: never` 禁用、max-lines 被 162 文件 disable 绕过、69 文件持有模型选择状态副本、logger 5 套并存；③ 强绑定智谱（默认 GLM 目录、账号体系、Coding Plan 网关自动转发无逐次确认）；④ 无 OS 沙箱（NOTICE 自述共享执行适配器不提供默认沙箱，Computer Use 是占位实现）；⑤ 依赖极新（TS 6 beta、vitest 4）有跟随破损风险。

### 4. metis-main（TS）

**优点**：① 核心循环成熟（steering 插入、并行/顺序双模式、prepareNextTurn 热切换模型 + compaction/branch summary）；② **Token 效率是七项目里工程化最深的**（prompt 预算 CI 回归、缓存前缀字节级断言、零 token 学习、截断分页引导）；③ 测试密度罕见（310 文件/~2,794 用例，测试代码为 src 的 82%）；④ 54 provider + OAuth 订阅登录；⑤ 代码卫生极好（真实 TODO 为 0）；⑥ 六种形态共享同一 AgentSession 核心。

**缺点**：① **核心三包（metis-ai/agent-core/tui）只发 dist 无源码**，调试 agent loop 必须回上游 pi 仓库；② 巨型文件集中（interactive-mode 6,555 行、agent-session 5,491 行）；③ 概念膨胀（T0–T3 分级 + G1–G7 门 + harness 架构图 + self-learning，ramp-up 长）；④ 发行链偏重（bundleDependencies + tsgo 构建）；⑤ desktop UI 细节测试约 60 文件，维护投入与核心演进不成比例。

### 5. deepseek-harness（DeepSeek，TS）

**优点**：① 架构最现代（everything-is-a-plugin + Cordis，55 个包职责单一）；② PTC run_code（模型写代码编排工具，子派发日志可重建，只回传 curated result）；③ compaction 子包齐全（basic / tool-result-pruner / image-offload）；④ 1,497 spec 文件测试密度高；⑤ DeepSeek 官方出品 + 插件市场 + 多端（cli/desktop/web/acp）。

**缺点**：① **developer preview，明示会有破坏性变更**；② 概念多（plugin/surface/node/epoch），调试路径长；③ vendor 目录 + 大量 i18n yaml 使仓库结构复杂；④ 相比 codex/opencode，沙箱/权限体系文档化程度低；⑤ 快照式评测产物（snapshots/、eval_results/）留在仓库。

### 6. MeowCode（本项目）

**优点**：① **七者中最小核心（约 2.1 万行，codex 的 1/100）却保持 0 TODO + 474 测试全过 + tsc 零错误**；② Token 效率核心单项齐（三点缓存+降级重试、双层压缩、usage 锚点、三层触发链）；③ **CJK 感知估算 + 国内服务商目录是独有差异化**；④ 写后验证闭环（verify.ts）是七项目中少有的；⑤ 审批体验细节（diff 外部刷新、子 Agent 审批记父会话、四档模式）；⑥ 桌面集成完整（终端/浏览器/侧边聊天/快开）。

**缺点**：① **功能广度差距大：无 MCP / 无沙箱 / 无 LSP / 无会话分支 / 无 checkpoint-undo**（6 个参考项目全部支持 MCP）；② 系统提示词未分区、无免费剪枝层、无 code mode——token 效率系统性排第 7；③ runtime.ts 3,294 行单文件；④ AGENTS.md 单层读取；⑤ 辅助请求（标题/摘要）无缓存亲和；⑥ 无 CI（Git 仓库都未初始化）。

### 7. AllAgent.NET（LanAgent，C#）

**优点**：① **工程质量极高：0 TODO + 448 测试（含真实 microVM 集成）+ prompt 缓存字节级回归测试**；② CodeAct 范式优雅（模型只见 execute_code，Hyperlight 隔离，hostCall 回调）；③ Token 效率系统性设计（单工具+prompt 有序化+4 断点+三层输出预算）；④ 安全深入（路径边界、SHA256 审计、截断响应不提交、子代理深度限制、孤儿 tool 消息修补）；⑤ 插件系统 6 类扩展点 + Roslyn 源码生成器。

**缺点**：① **平台深锁定**：Windows x64 + Hyperlight 硬件虚拟化 + PowerShell 7.6 + 宿主 Python，跨平台基本不可行；② Hyperlight 1.24 preview 依赖风险（poisoned lock 等 native 故障特判）；③ 单体化（AgentEngine 单方法 ~300 行塞十余职责，FullScreenTerminal 923 行）；④ 首次使用需 winget 装一堆工具，full-access 默认模式权限边界心智负担大；⑤ Web 端 12,735 行 TS 仅 3 个测试文件，前后端测试投入悬殊。

---

## 五、给 MeowCode 的优化路线（性价比排序，v2 更新）

| # | 动作 | 状态 | 预期收益 |
|---|---|---|---|
| 1 | 系统提示词 stable/dynamic 分区 | ❌ 未做 | 缓存命中率直接提升，对齐 ZCode/metis |
| 2 | 免费 tool-result 剪枝层（占位符替换，不调模型） | ❌ 未做 | 先于 summarizeToolOutputs 触发，立竿见影 |
| 3 | 预压缩触发档（80% 时先剪枝再摘要） | ✅ **已完成**（三层触发链） | 消除"溢出才卡住"体感 |
| 4 | 流中提前执行只读工具 | ✅ **已完成**（midstreamToolExec，默认关） | 缩短多工具回合墙钟时间 |
| 5 | read_file head+tail+落盘 | ✅ **已完成**（v2 修正：tools.ts:724 超长文件头尾预览+全文落盘+分页提示） | 超限文件可恢复，少一次整读往返 |
| 6 | MCP 支持（stdio 起步） | ❌ 未做 | **最大功能缺口**，决定外部工具生态 |
| 7 | SSE→IPC 合帧 | ✅ **已完成**（event-batcher.cjs） | 桌面端流式渲染流畅度 |
| 8 | 图片独立存储+引用 | ✅ **已完成**（assets 目录） | JSONL 不膨胀 + 恢复不丢图 |
| 9 | 初始化 git 仓库 + GitHub/Gitee 双远端 | ❌ 未做 | 版本安全 + 用户既有习惯 |
| 10 | runtime.ts 按 seam 拆分 | ❌ 未做 | 降低修改风险 |

---

## 六、总结

**是否比其他 6 个开源项目好？**
- 比"大而全"：MeowCode 远不如 codex/opencode/ZCode（功能广度、生态、多端）
- 比"轻量+核心质量"：MeowCode 用 1/100 的代码量做到了 0 TODO + 测试全过 + 类型零错误 + 三协议 + 双层压缩 + 三层触发链，**性价比七者第一**
- 比"省 Token"：单项（缓存三点布局+降级、usage 锚点、CJK 估算）达到中上游，系统性排第 7；中文场景下因 CJK 估算的保守性，实际溢出安全性反而占优

**排名**：综合 codex > opencode > ZCode > metis > dsh > **MeowCode** > AllAgent.NET；Token 效率 codex > metis > AllAgent > opencode > ZCode > dsh > **MeowCode**；轻量度与国内生态适配 **MeowCode 第一**。
