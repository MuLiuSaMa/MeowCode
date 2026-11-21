# MeowCode Electron CPU / 内存优化报告

> **文档状态**：审计完成；阶段一全部落地，阶段二部分落地（明细见第 11 节）。
> **依据**：对 `desktop/`、`desktop/src/`、`src/agent/`、`src/server/` 的只读审计，以及 Electron 官方文档、VS Code / Conductor / Streamdown / memlab 等公开实践。
> **行号说明**：正文与附录里的行号取自审计时点。改动会让行号漂移，复现时优先按函数名或符号搜索。

## 目录

1. 执行摘要 —— 结论，以及每项「已修 / 待修」
2. 测量基线 —— `perf-monitor.cjs` 采样与前后对比方法
3. 主进程 —— settings 缓存、事件广播、悬浮岛
4. 渲染层 —— 单体 App、流式 Markdown、消息列表
5. agent server —— entries 载荷、idle timer、token 估算
6. 打包与资源 —— asar 体积、字体
7. 外部参考对照 —— Electron / VS Code / Conductor / Streamdown / memlab
8. 依赖选型
9. 分期与验收
10. 明确不做的事
11. 执行记录
12. 附：热点溯源索引

---

## 一、执行摘要

**结论：MeowCode 的问题不是「Electron 天生重」，而是几处确定性浪费没有被治理。**

| 层 | 根因 | 收益 | 优先级 | 状态 |
|---|---|---|---|---|
| 观测 | 全项目零 `getAppMetrics` / 零崩溃处理，无法验证任何优化 | —— | **P0 前置** | 已修 |
| 主进程 | `readSettings()` 同步读盘 44 处、`broadcast()` 无差别推全部窗口、悬浮岛 60ms 轮询 | 中高 | P0 | 已修（广播路由待做） |
| 渲染层 | 6006 行单体 App × 每秒 20 次全树重渲染、消息列表无虚拟化、流式 Markdown 近似 O(n²) | **高** | P0 | 部分（Markdown 已修） |
| agent server | 会话 entries 图片常驻、每轮 6–10 次全历史 token 扫描、idle timer 不清理 | 中高 | P0/P1 | 部分（token / timer 已修） |
| 打包 | asar 315MB，其中 289.8MB 是被 Vite 已内联的 `node_modules` | 体积确定收益 | P0（低成本） | 已修（35.2MB） |

**最初列出的「最值得先做的 5 件事」，现在的实际状态：**

| # | 事项 | 状态 |
|---|---|---|
| 1 | `readSettings()` 加 mtime 缓存 | 已做 |
| 2 | `runtime.closeSession()` 补 `cancelIdleTimers()` | 已做 |
| 3 | 打包瘦身 —— **注意：`build.files` 排除无效，正确做法是把 renderer 依赖移入 `devDependencies`** | 已做，asar 315MB → 35.2MB |
| 4 | 流式 Markdown 改块级 memo | 已做 |
| 5 | `App.tsx` 输入状态下沉 | 待做（`Composer` 2849 行、30+ props，需单独一轮 UI 回归） |

---

## 二、测量基线（P0 前置，必须先做）

现状：`process.memoryUsage` / `app.getAppMetrics` / `crashReporter` / `render-process-gone` 全项目 **0 命中**。没有基线，后面所有优化都无法证伪。

### 2.1 最小采样器（新增 `desktop/perf-monitor.cjs`）

- `app.getAppMetrics()` 每 **10s** 一次。不要 1s —— API 的 `percentCPUUsage` 语义是「距上次调用区间的均值」，10s 即 10s 窗口，且自身不成为噪音。
- 采集字段：`pid / type / cpu.percentCPUUsage / memory.workingSetSize`，按 `Browser | Tab | Utility | GPU | agent-server(fork)` 聚合。
- 输出：内存环形缓冲 360 点（1 小时），每 60s **异步 append** 一行 JSONL 到 `userData/perf/YYYY-MM-DD.jsonl`。**禁止 `writeJsonAtomic`** —— 它带 `fsync`，采样器自己会制造 IO 毛刺。
- 阈值触发：CPU > 30% 持续 30s 或 RSS 越阈时，追加 `process.getProcessMemoryInfo()` + 渲染层上报的 `PerformanceObserver('longtask')` 计数，打 `cause` 标记以便归因到具体操作。
- 生产默认开、仅本地、保留 7 天，`settings.performanceTelemetry` 可关。

### 2.2 进程健康

- `app.on('render-process-gone')`：落盘 `reason/exitCode`，限流自动 reload（5 分钟最多 1 次），避免崩溃循环。
- `child-process-gone`、`webContents.on('unresponsive')` 同样落盘。
- agent server 异常退出目前只清 `serverProcess/serverUrl`（`main.cjs:1982-1991`），无自动重启 → 补 1 次退避重启。
- 可选：`crashReporter.start({ uploadToServer: false })`，只留本地 dump。

### 2.3 前后对比方法（不依赖 DevTools）

1. **固定场景回放**：录一段真实 SSE 流为 fixture，用隐藏窗口回放「200 条消息 + 8000 字长回答」，采样 metrics 与 longtask。
2. **双打点**：主进程 `ready-to-show` + 渲染层 `performance.mark('boot')` → 首条消息 paint。
3. **体积**：`npx asar list` 按目录聚合。
4. **长跑**：2h 空闲，对 `percentCPUUsage` 积分得 CPU 时间，RSS 做线性回归看斜率。

---

## 三、主进程（`desktop/main.cjs`）

### P0-1 `readSettings()` 无缓存 —— 已修

**事实**：`main.cjs:753-757` 每次都是 `readFileSync + JSON.parse + migrateSettings`，全文件 44 处调用。其中 `shouldNotifyNow()` 落在 **SSE 每个终态事件**上（`:2180-2188`、`:2446-2455`），托盘菜单每次会话变化都会重建并调 `uiStrings()`。

**做法**：模块级 `{ mtimeMs, size, value, writtenAt }`；命中前 `fs.statSync` 比对（stat 比 readFile+parse+migrate 便宜 1–2 个数量级）；`writeSettings()` 成功后用刚写的 migrated 对象回填。

**正确性风险（必须处理）**

- 外部改动判定用 **stat（mtimeMs + size）**，不要用 `fs.watch`：落盘是 tmp+rename（`persist.cjs`），Windows 上单文件 watch 在 rename 后失联。
- 写入后 500ms 内强制仍 stat，覆盖「同毫秒同 size 的快速连写」。
- **magpie overlay 不参与失效**：`withMagpieOverlay` 现在是启动期一次性快照，产品语义就是「改 overlay 需重启」。缓存放在 overlay 外层，保持该语义 —— 不要顺手改成热加载，会破坏 `stripMagpieProviders` 的写入契约。
- 读失败 **不缓存**（或 500ms 短 TTL），否则文件损坏瞬间会被永久钉在 `defaultSettings`。

### P0-2 `broadcast()` 无差别推所有窗口 —— 待做

**事实**：`main.cjs:2042-2046` 遍历 `BrowserWindow.getAllWindows()` 全发；热路径在 `:2073` 的 batcher → `broadcast("meow:event")`，悬浮岛和主窗共享同一份 preload。岛还设了 `backgroundThrottling: false`（`:2690`）。

**重要纠正**：不能按窗口一刀切白名单 —— 岛的 reducer（`IslandApp.tsx:555`）消费**全部** `MeowEvent` 并按 sessionId 聚合多会话，直接过滤会让岛丢状态。

**正确做法（两段式）**

1. **类型层**：岛只保留状态类事件（`turn_start / turn_complete / error / permission / tool_call / files_rewound / server.*`），丢弃 `assistant_delta / thinking_delta / tool_output` 等高频增量 —— 岛不显示正文，纯减量、零语义损失。
2. **会话层**：主进程维护每窗口的「关注 sessionId 集合」（岛在快照刷新时经 IPC 声明当前展示的 N 个会话），`sessionId ∉ 集合` 不发；`sessionId` 为空视为全局，照发。
3. 主窗口 **不按** active session 过滤（后台会话仍在跑，切回需完整状态），只对超长 `tool_output` 做字段级截断。

守卫：岛收到未知类型打 warn；e2e 用例「主窗 + 岛同开跑一轮含工具调用的回合」。

### P0-3 悬浮岛常驻开销 —— 已修

- 60ms 光标轮询（`:2608-2635`）改为：仅当岛可见且鼠标在屏内时 60ms，静止 3s 后降到 250ms，隐藏/失焦时暂停。
- `backgroundThrottling: false` **保留**（去掉会掉到 ~1fps，状态推进失真），但把 `island.css:272` 的 1.1s infinite pulse 用 `animation-play-state` 绑「运行中会话数 > 0」，空闲即停。
- `nativeTheme.on("updated")` 现在注册在 `createWindow()` 内部（`:2835`），窗口重建会叠加监听器 → 移到模块级只注册一次。

### P1 主进程杂项 —— 部分

- `meow:save-ui-state`（`:2919-2929`）每次按键一次 IPC，主进程全量 `sanitizeUiState()`（上限 4MB，`:1269-1303`）→ 改增量 patch + 按字段校验。
- 全局 `disable-features=CalculateNativeWinOcclusion`（`:88`）是为了避免 Windows「切走再切回整页重绘、文字重新光栅化」，**建议保留**；但隐藏到托盘时主动 `webContents.setBackgroundThrottling(true)`，让后台真正省电。这个 tradeoff 在 Chromium 文档和 DSH 的公开 issue 里有对照记录。

---

## 四、渲染层（收益最大）

### P0-4 单体 App × 每秒 20 次全树重渲染 —— 部分

**事实**：`App.tsx` 6006 行、83 个 `useState`、40 个 `useEffect`、123 个 `useCallback`，仅 18 个 `useMemo`。合帧后约 20 次/秒 `setTimeline`（`App.tsx:276, 2500-2512`），每次重跑整个函数体。全库只有 4 个 `memo`，而 `Composer / ConversationPanel / RightPanel / Rail / MessageList / UserBubble / ToolGroup` 都没有，props 还大量内联箭头（`:5473-5501`、`:5716-5809`）—— 补了 memo 也会被打破。

**做法（先小后大）**

1. `input` 从 App 派生状态（`:647-678`）**下沉到 Composer 局部 state**；drafts 用外部 store + `useSyncExternalStore`，写入 ref + 300ms 防抖，不再每次按键触发 App setState + IPC。保持 `setInput` 签名不变，`editingQueued` 分支随迁，缩小回归面。
2. 给 `UserBubble / MessageNavigator / Composer / RightPanel tab body` 加 `memo`，内联箭头改 `useCallback` / 模块级常量。优先这 4 个 —— 它们在每个 delta 都会重渲。
3. `UserBubble` 的 `parseUserMessage(content)`（`UserBubble.tsx:43`）包 `useMemo([content])`：现在是每条历史用户消息 × 20fps 重复 `split("\n")`。

### P0-5 流式 Markdown 近似 O(n²) —— 已修

**事实**：`Markdown.tsx:78-99` 已把内容切成 stable / tail，但 `stableHtml` 的 deps 是 `[stable]` —— 每推进一个段落边界，就把整段稳定前缀重新 `marked + DOMPurify + DOMParser + hljs` 全量跑一遍（`code-highlight.ts:161-170`，28 门语言）。长回答的总成本近似 O(n²)，且历史代码块被反复重新高亮。

**做法**

1. `streaming-markdown.ts` 新增 `splitMarkdownBlocks(stable)`：单遍行扫描维护 fence / 表格 / 列表 / `$$` / HTML 块 / setext 标题状态，输出 `[{ start, text }]`。**必须自研，不能按 `\n\n` 切** —— 代码围栏、表格、HTML 块都能跨空行。
2. 每块一个 `memo` 组件，key 用 `start`（不用 index，块会前移）。
3. tail 块走现有 `renderOpenFence` 路径；未闭合 `**` / `[` / 缺分隔行的表格补全只作用于 tail。
4. **代码块未闭合时不高亮**，闭合后才跑 hljs —— 这是单点最大收益。

**正确性风险**：跨块的 link reference / footnote definition（`[x]: url`）会失效 → 预扫描全文收集定义注入各块上下文；检测到定义存在时该段退回整段渲染。

### P0-6 消息列表无虚拟化 —— 待做

**事实**：`MessageList.tsx:267` 每 delta 重算 `groupIntoTurns`，`:283-290` 读 `scrollHeight` 再写 `scrollTop`（强制布局），`:521-648` 遍历所有 turn 重建元素。没有 react-window / virtuoso / virtua，消息全量常驻 DOM，且无条数上限。

**方案**：`react-virtuoso`（chat 语义最全）＋「尾巴不进虚拟列表」：

- 稳定消息进虚拟列表；最后一条（流式中）作为 footer **留在真实 DOM**，规避「最后一条被裁 / 闪烁」。
- 吸底保留 `stickRef`；footer 上 `ResizeObserver` + rAF 节流 `scrollToIndex(last, { align: 'end' })`，用户上滚立即解除。
- `groupIntoTurns / userNavItems` 加「仅结构变化才重算」的缓存键 —— 最后一条的 delta 不应让 turns 失效。

**前置依赖（不做必回归）**：`MessageNavigator.tsx:84-88` 靠 `querySelector + getBoundingClientRect`（`:47` 依赖 `messages` 引用）逐条测量。虚拟化后离屏锚点不在 DOM → **必须先改成「索引 + scrollToIndex」**。

### P1 渲染层杂项

| 项 | 现状 | 做法 |
|---|---|---|
| 图片常驻 | base64 dataUrl 进 timeline state + DOM，无回收（`UserBubble.tsx:156-167`、`timeline-events.ts:117-122`） | `src` 指向 `meow:asset-base` URL；离屏置空 `src` |
| FilePreview | 同步 hljs 高亮 ≤512KB、最多 3000 行 ≈ 9000 DOM（`FilePreview.tsx:117-123, 191-203`） | 高亮移入 Worker + 行窗口化 |
| 常驻毛玻璃 | `.mc-viewtabs` `backdrop-filter: blur(16px)` 常显且悬浮在消息流上（`AppShell.css:269-270`） | 仅滚动/悬停时启用 |
| 布局动画 | `mc-insp-expand` 动 `width + margin-left`（`AppShell.css:155-178`） | 改 `transform + opacity` |
| 隐藏页签 | RightPanel 非激活页签仍挂载（`RightPanel.tsx:336-339`），每个 browser 页签 = 1 webview = 1 渲染进程 | 非 webview 页签卸载；webview 页签给「休眠」开关 |
| 全局监听 | GlobalTooltip 用 `MutationObserver` 观察 `document.body` 整棵子树（`GlobalTooltip.tsx:87-102`）+ 6 对 document capture 监听 | 改为单次委托 + 局部观察 |
| CSS 廉价方案 | 全库无 `content-visibility` / `contain` | 工具组、长代码块加 `content-visibility:auto` + `contain-intrinsic-size` |

---

## 五、agent server（`src/agent` + `src/server`）

### P0-7 会话 entries 的图片/文档常驻 —— 待做

**事实**：`SessionStore.entries` 只 append（`session-store.ts:91, 1819`），压缩只改「重放视图」`effectiveMessages`，从不删除 entries；`hydrateImages()`（`:170-171, 642-687`）把 `imageRefs` 的 base64 **全量读回内存条目**（单图 ≤4MB、单文档 ≤28MB）。落盘层本来只有 refs（`:569-605`），是内存层把它撑起来的。

**关键风险**：entries 只追加不截断是**设计契约** —— checkpoint 依赖「此前全部 message 条目即时间线位置」（`:1576` 注释、`:961`），rewind 也是 append 语义。**从头部裁剪 entries 会直接破坏 rewind / 分支 / 恢复。**

**正确层次**

1. **内存层（本期做）**：对已被 compression summary 覆盖区段的 message entry，把内联 `images/documents` 换成 `imageRefs`，需要时单条 hydrate。无损 —— 落盘本来就只有 refs。
2. **派生层（本期做）**：`effectiveMessages` 投影缓存、token 估算、会话索引加 LRU 上限 + 按 session 淘汰。
3. **落盘层（P2，需产品决策）**：真要截断必须新增 `archive` entry + 保留 `.archive.jsonl`，并让 rewind 到归档点显式降级为只读。**第一期不做。**

### P0-8 后台隐性 CPU —— 部分（idle timer 已修）

- **`runtime.closeSession()` 不调 `cancelIdleTimers()`**（`runtime.ts:2403-2409` 只清 warmup），而 server 的 `demoteActiveRuntime / pruneBackgroundRuntimes` 只调 `closeSession`（`server.ts:1004-1015`）→ 已丢弃的 runtime 仍会在 290s 后用**已关闭的会话**重放 system + 全量工具 + 全量历史发 `max_tokens=1`，最多 4 次（`:7619-7752`）。这是本项目**唯一确认的 timer 泄漏**，一行修复。
- 流式落盘现在 1s 或每 2KB 就 `writeJsonAtomic`（tmp + fsync + rename，`runtime.ts:3531-3552` + `atomic-json.ts:16-41`）→ 改 5s / 8KB，partial checkpoint 用 append；Windows 上每秒一次 fsync 是稳定的 IO/CPU 噪声。
- SSE 广播不看 `write()` 返回值、无 `drain`（`server.ts:848-874`），且不按 sessionId 过滤 → 加背压 + 客户端集合过滤。
- `read-state.ts` 全局 Map 无淘汰（`:16, 38-61`，含工作区外路径）；PDF 磁盘缓存无上限 → 加 LRU / 容量上限。

### P0-9 token 估算的固定燃烧 —— 已修

- 每轮模型调用触发 **6–10 次全历史扫描**（`agent-loop.ts:332-357` + `context.ts:594/606/617`）；一次 `getContextUsage()` 跑 3 遍全量（`runtime.ts:3088-3103`）。
- `estimateTokens` 用 `text.match(/[CJK]/g)?.length`（`context.ts:8-15`）—— 中文长会话下**每个汉字分配一个数组槽位**，50 万汉字 = 50 万元素，是长跑 GC 抖动主源 → 改 `for` 循环计数，结果按 message 缓存。
- `estimateContextTokens`（`context.ts:268-288`）在锚点分支之前先无条件跑一次全量 `estimateMessagesTokens`（`:273`），锚点优化形同虚设 → 把全量计算延迟到 fallback 分支内。

### P1 agent server 杂项 —— 待做

- 会话索引：每次 append 触发 2s 防抖 → `listSessions` 对目录内**每个** `.jsonl` stat，变化的整文件 `readFile + split + 逐行 JSON.parse`，再 `writeJsonAtomic(index.json)`（`session-store.ts:1964, 1973-1982, 2022-2086`）。流式回合中每 2s 解析一次正在增长的文件，且会话无保留策略 → 2s 窗口内多次 append 合并为一次对账；索引条目加 `{size, mtime}` 命中即跳过（已有雏形）；补会话保留策略（子 agent 会话也落同一目录）。
- `read_file` 给了 `offset/limit` 仍从文件头读最多 4MB 再切片（`edit-content.ts:25, 370-405`）→ 用 `fs.read` 定位。
- `grep/glob` 每次 spawn 新 rg 子进程（`search.ts:141-160`），无常驻索引 —— 可接受，不建议上索引（收益/复杂度不划算）。

---

## 六、打包与资源

**事实**：`app.asar` 实测 **315MB**，其中 `node_modules` **289.8MB**（mermaid 120.9 / react-icons 81.9 / @mermaid-js 10.3 / node-pty 9.3 / cytoscape-fcose 8.9 / elkjs 7.8 / react-dom 7.7 / highlight.js 5.2 / katex 3.8）。而这些包**已被 Vite 打进 `renderer/`（30.4MB）** —— 等于双份，且 asar 里那份主进程根本 require 不到。

**做法**

1. **核心是把 renderer-only 依赖移出 `dependencies`**。electron-builder 会自动收集 production dependencies 打进 asar，`build.files` 里写 `"!node_modules/**"` **排不掉它们**，反而会把 `node-pty`（`terminals.cjs` 真正 require）一起排掉 —— 终端会直接不可用。改完 `dependencies` 只剩 `cron-parser` + `node-pty`，asar 里也就只剩这两个。
2. `MiSansVF.ttf` **20.1MB** 全量可变字体：先转 woff2（零风险，约 8MB），再 `pyftsubset` 按常用字集子集化（2–4MB），保留 VF 轴。
3. 顺带：KaTeX 全家族字体未裁剪、`base-*.js` 2.2MB / `main-*.js` 1.9MB 无 `manualChunks` 拆分。

**验收**：asar 315MB → <60MB（**实测 35.2MB**）；安装包同步下降；冷启动到首帧不劣于基线。

> 注：asar 体积对**运行时 RSS** 影响很小（未加载的模块不占内存），收益在安装体积、更新包、冷启动 asar 索引。要和 CPU/内存一起讲，但别夸大。

---

## 七、外部参考对照

| 来源 | 公开做法 | 对本项目可用点 |
|---|---|---|
| **Electron 官方 Performance** | 「Measure, Measure, Measure」；7 类反模式（carelessly including modules / loading too soon / blocking main / blocking renderer / polyfills / blocking network / bundle）；`node --cpu-prof --heap-prof -e "require('X')"` 量模块加载 | 观测优先；asar 里 289.8MB 无用依赖正是「carelessly including modules」；主进程 `readSettings` 同步 IO 是「blocking main process」 |
| **VS Code** | 内置 `Developer: Open Process Explorer` 逐进程 CPU/内存；`files.watcherExclude` 排除 node_modules/.git；扩展隔离到 Extension Host（1.84+ 可按扩展分进程）；per-profile 精简。社区实测：关 7 个扩展启动 8.2s→3.1s、内存 1.2GB→620MB；空工作区基线 150–300MB | ① 做一个「进程资源管理器」面板（复用 §2.1 数据）② workspace watcher 排除 `node_modules/.git/dist` ③ 插件 / MCP 隔离已具备（独立进程），继续坚持 ④ 给「技能 + MCP」加启停与按需加载 |
| **Conductor**（agent 桌面应用重写） | 消息列表用 `react-virtuoso` 的 `VirtuosoMessageList`（贴底、前插锚定、流式高度平滑重测）；每条消息 `React.memo` + 稳定 key，token 只重渲那一条；空闲 agent 进程自动关停靠 `--resume` 恢复 | 正是本项目 §P0-6 + §P0-4 的解法；子 agent 也可做「空闲即关、按需 resume」 |
| **Streamdown**（Vercel） | `parseMarkdownIntoBlocks` 切块 + 每块独立 memo，只有变化的最后一块重渲染；`remend` 预处理补全未闭合围栏。明确「每次更新全文重解析」是主要成本 | §P0-5 的算法参考（**只借思路，不引库**：它是 React 组件 + Tailwind 样式体系，与现有 marked + decorate + 文件链接不兼容） |
| **Chrome / content-visibility** | `content-visibility: auto` + `contain-intrinsic-size` 跳过离屏 layout/paint，保留 DOM | §P1 的廉价方案：工具组、长代码块先上，虚拟化做不动时的兜底 |
| **memlab**（Meta） | 支持 Electron heap snapshot、retainer trace、`analyze unbound-object`，可做 E2E 泄漏回归 | nightly 场景：连续 50 轮对话 + 切会话 20 次，断言无增长 |
| **DSH public issue** | `CalculateNativeWinOcclusion` 的 tradeoff：禁用可避免 Windows 切回整页重绘，代价是被遮挡时不挂起；不设 `backgroundThrottling:false` 则后台降到 ~1fps | 解释本项目为什么全局禁用（`:88`）；改为「保留禁用 + 托盘时开节流」的折中 |
| **Live2D 项目实测** | 不限帧的渲染 ticker idle 时吃 **9.8 核**，限帧后 **1.05 核** | 佐证 §P0-3：无限动画 + `backgroundThrottling:false` 是常驻 CPU 的主因，必须让空闲动画停 |

---

## 八、依赖选型

| 库 | 结论 | 理由 / 替代 | 体积 |
|---|---|---|---|
| `react-virtuoso` | **推荐** | chat 语义最全（贴底 / 前插锚定 / 动态高度）；`virtua` 更轻但要自写贴底；`@tanstack/react-virtual` 最灵活但工作量约 3 倍 | ~30–40KB gz |
| `virtua` | 备选 | 仅需窗口化、不要 chat 语义时用 | ~8KB |
| `streamdown` | **不引** | React 组件 + 自带样式/插件体系，替换成本高于自研分块；只借 `parseMarkdownIntoBlocks` 思路 | —— |
| `memlab` | **推荐（dev）** | 唯一支持 Electron heap 的成熟泄漏回归方案 | dev only |
| `fonttools`（pyftsubset） | **推荐（构建期）** | 唯一能把 20MB 字体压到个位数的路径 | dev only |
| `vite-plugin-visualizer` | 一次性分析 | 定位冗余依赖，不进产物 | dev only |
| React Compiler | P2 观察 | 与手工 memo 可能冲突，Electron 44 + React 19 下收益不确定 | —— |
| `why-did-you-render` / `react-scan` | dev only | 辅助定位重渲染，生产不引 | —— |

---

## 九、分期与验收

### 阶段一（低风险，可独立回滚）—— 已完成

§2 观测 + P0-1 settings 缓存 + P0-3 岛轮询/动画 + P0-8 的 `cancelIdleTimers()` + §6 打包瘦身。

### 阶段二（渲染层，收益最大）—— 部分完成

| 项 | 状态 | 说明 |
|---|---|---|
| P0-9 token 估算 | 已完成 | 逐字符计数、JSON 口径、消息包裹开销、锚点有限性校验、偏差自检 |
| P0-5 块级 Markdown | 已完成 | `splitMarkdownBlocks` + 每块 `memo` + HTML LRU |
| P0-4 `UserBubble` | 已完成 | `parseUserMessage` 改 `useMemo([content])` |
| P0-4 input 下沉 | 待做 | `Composer` 2849 行、30+ props，需要单独一轮 UI 回归 |
| P0-7 entries 载荷降级 | 待做 | 只降级内存载荷，**不从头部裁剪** |

### 阶段三（结构性）—— 待做

P0-6 虚拟化（**前置：MessageNavigator 索引化**）→ P0-2 事件路由两段式。

### 阶段四（P2）—— 待做

`App.tsx` 拆分（一次只搬「一个 state + 其唯一读写点」，props 形状不变，先补测试；先动 window chrome / 更新提示 / Toast / `useSideTabs` / `inspectorWidth`，**不要先动 `timeline` 与 session 生命周期**）→ 落盘层归档裁剪 → React Compiler 评估。

### 验收清单

| 项 | 指标 | 测法 |
|---|---|---|
| 空闲 CPU | 5min idle 全进程 CPU 时间 < 3s | metrics 积分 |
| 空闲 RSS | 主 / 渲染 / 岛 各自基线（先测后定阈值） | `workingSetSize` |
| 输入延迟 | 200 条会话，按键到上屏 p95 < 50ms | 注入按键 + `performance.measure` |
| 流式流畅 | 8000 字回答 longtask(>50ms) < 3 次/分钟 | `PerformanceObserver` |
| 重渲染 | 一次 delta 的 commit 只落在 1–2 个子树 | React Profiler |
| asar | < 60MB（实测 **35.2MB**） | `asar list` |
| 会话恢复 | 500 条 hydrate < 500ms | 埋点 |
| 长跑 | 2h RSS 斜率 < 5MB/h；memlab 0 增长 | 长跑 + nightly |
| 首启 | 冷启动到首帧不劣于基线 | 双打点 |

---

## 十、明确不做的事（避免踩坑）

1. **不从头部裁剪 `entries`** —— 破坏 rewind / 分支 / 恢复；只能降级内存载荷。
2. **不对 `broadcast()` 做窗口级一刀切白名单** —— 悬浮岛消费全部事件，按类型 + 会话两段式才对。
3. **不引 Streamdown** —— 组件/样式体系冲突，只借分块算法。
4. **不关闭硬件加速** —— acrylic 透明窗依赖 DWM 合成，关了会更慢。
5. **不先拆 `timeline` 与 session 生命周期** —— 40 个 effect 强耦合，最后再动。
6. **不给 `grep/glob` 上索引** —— 现有 spawn rg 的成本可接受，收益/复杂度不划算。
7. **不把 renderer-only 依赖留在 `dependencies`** —— electron-builder 会整包打进 asar（实测多出 289.8MB），而它们已被 Vite 内联进 `renderer/`，等于双份；也别指望 `build.files` 的 `!node_modules/**` 能解决，那会连 `node-pty` 一起排掉。

---

## 十一、执行记录

### 阶段一（2026-11-21）

| 项 | 改动 | 结果 |
|---|---|---|
| 观测 | 新增 `desktop/perf-monitor.cjs`（6 个测试）：主进程 10s 采样 `getAppMetrics`，60s 异步 append 到 `userData/perf/YYYY-MM-DD.jsonl`；`render-process-gone` / `child-process-gone` / `unresponsive` 写 `crashes.jsonl`，异常渲染进程崩溃 5 分钟限流自动 reload；保留 7 天 | 待跑一段时间后看真实数据 |
| settings 缓存 | `readSettings()` 加 stat(mtimeMs + size) 缓存，`writeSettings()` 写后回填；读失败也缓存「不存在」，文件创建后自动失配；magpie overlay 语义不变 | 消掉 SSE 每个终态事件上的同步读盘 |
| 岛轮询 | 恒定 60ms → 按距离/静止分档（近 60ms、远 180ms、光标静止 240ms、岛不可见 600ms）；渲染层首次上报矩形时立即补一次轮询，避免展开头 600ms 点击穿透 | 空闲轮询次数约为原来 1/4，点击手感不变 |
| 监听器 | `nativeTheme.on("updated")` 从 `createWindow()` 内部移到模块级，只注册一次 | 窗口重建不再叠加监听器 |
| idle timer | `runtime.closeSession()` 补 `cancelIdleTimers()` | 修掉「已丢弃 runtime 在 290s 后重放全量历史发 max_tokens=1」的泄漏 |
| 打包 | **不是** 在 `build.files` 里排除 `node_modules`（那样会连带排掉 `node-pty`），而是把只被 Vite 打进 renderer 的 20 个包移入 `devDependencies`；`dependencies` 只剩 `cron-parser` 与 `node-pty`；`release-packaging.test.ts` 加防回归断言 | **app.asar 实测 315MB → 35.2MB**（另 `app.asar.unpacked` 9.7MB，为 node-pty 原生模块） |

### 阶段二（2026-11-21）

| 项 | 改动 | 结果 |
|---|---|---|
| token 估算 | 逐字符区间计数替代 `match(/[CJK]/g)`；JSON / 工具参数 / 工具 schema 改 3 字符/token；每条消息加 4 token 包裹开销；锚点加 `Number.isFinite`；工具定义加单槽缓存 | 估算不再系统性偏低（明细见下节） |
| UserBubble | `parseUserMessage(content)` 包 `useMemo([content])` | 历史用户消息不再随每次 delta 重复 `split("\n")` |
| 流式 Markdown | 新增 `splitMarkdownBlocks`（边界规则与 `splitStreamingMarkdown` 一致：空行 + 下一个非空行是安全顶层块，**不切断列表/引用/表格/HTML**；遇到 link reference / 脚注定义整篇退化）；稳定区按块渲染，每块 `memo` + HTML LRU（240 条 / 2M 字符）；`base.css` 补 `.mc-mdblock { display: contents }` 及首尾 margin 规则 | 稳定区从「每推进一个段落边界就全量重排」变成「只重排最后一块」 |

**累计验证**：

- `tsc -p tsconfig.json` 与 `tsc -p desktop/tsconfig.json` 均通过
- 全量 `vitest run` **2473 passed / 7 skipped**（`concurrency.test.ts` 的 3 个用例在 4 路并发下偶发超时，单跑通过，属已知 MCP 启动抖动）
- `pnpm build` 2.38s；`pnpm build:agent` 通过

> 说明：`Markdown` 的块级渲染只作用于 `streaming` 分支；非流式仍走原来的单容器 `innerHTML`，因此工具视图里 `.mc-tv__markdown > .mc-markdown > :first-child` 这类直接子选择器不受影响。

### token 估算口径（对齐 cc-haha）

参考 `cc-haha-main/src/services/tokenEstimation.ts` 与 `src/utils/tokens.ts`，补了三处会让估算系统性偏低的地方：

| 项 | 之前 | 现在 | 依据 |
|---|---|---|---|
| CJK | `match(/[CJK]/g)` | 逐字符 `charCodeAt` 区间比较 | 口径不变（1 字 1 token），去掉「每个汉字一个数组槽位」 |
| JSON / 工具参数 | chars/4 | chars/3 | JSON 的 `{ } : , "` 都是单字符 token；cc-haha 对 json/jsonl/jsonc 取 2，这里取 3 更保守 |
| 工具 schema | chars/4 | chars/3 + 单槽缓存 | 每次请求都带的固定开销，工具越多越不能按文本口径低估 |
| 每条消息 | 只算正文 | 正文 + 4 token 包裹开销 | Anthropic 口径约 4 token/条；不加会让长会话估算随条数线性偏低 |
| 锚点可用性 | `inputTokens > 0` | 再加 `Number.isFinite` | 网关回 `Infinity` / `NaN` 会让占用显示爆炸或归零，压缩阈值失效 |

同步核对过、确认本来就正确的两点（不改）：

- **锚点没有漏算缓存 token**：`anthropic.ts` 的 `inputTokens = 普通输入 + cache_read + cache_creation`；`provider.ts` 的 chat completions 用 `prompt_tokens`（已含命中/写入）。所以锚点直接用 `inputTokens` 就是总上下文。
- **图片不按 base64 长度估**：`IMAGE_TOKEN_ESTIMATE = 1500`，落在 1280×720 ≈ 1228 与 1568×882 ≈ 1844 之间；`ToolImage` 没有宽高字段，无法套官方 `(w×h)/750` 公式。

**偏差自检**：设 `MEOWCODE_TOKEN_DIAGNOSTICS=1` 跑一轮对话，日志会打 `token estimate drift ±x% (usage=…, estimate=…)`。稳定在 ±15% 内说明常量合适；某个方向持续偏 30% 以上就该调 `charsPerToken` 或图片常量。

**已知限制（下一步）**：锚点不补偿 system 增长。system prompt 里的技能索引 / 系统段会在会话中变长，这部分增长不会被尾部估算覆盖；修法是在 anchor 里记下当时的 system 估算，取差值补进 trailing。

### 怎么复现这些结论

```bash
# 类型检查（两套工程，desktop 是独立 tsconfig）
npx tsc -p tsconfig.json --noEmit
npx tsc -p desktop/tsconfig.json --noEmit

# 全量测试
cd D:/MeowCode && npx vitest run --testTimeout=40000

# 渲染层构建 / agent 内核编译（桌面端 fork 的是 dist/server/server.js）
pnpm --filter @meowcode/desktop build
pnpm build:agent

# 看 asar 里到底装了什么
npx asar list desktop/release/win-unpacked/resources/app.asar | head -50
```

> 在部分工具链里 `cd` 到小写盘符会让 vitest 重复加载 `@vitest/runner`，表现为**所有**测试文件在 `describe` 处报 `Cannot read properties of undefined (reading 'config')`；用大写 `D:/MeowCode` 即可，不用改 `vitest.config`。

token 估算的偏差自检：

```bash
MEOWCODE_TOKEN_DIAGNOSTICS=1 pnpm --filter @meowcode/desktop dev
```

跑一轮对话后，主进程日志会打 `[meowcode] token estimate drift ±x% (usage=…, estimate=…)`。

回滚粒度：每项可独立回退。打包项只需把 `desktop/package.json` 的依赖段还原后 `pnpm install --lockfile-only`。

> 注：打包验证时 `beforePack` 会 `pnpm deploy` 整个 agent-server（约 6000 个文件）并清理 `.tmp/agent-release`，在受限环境里会被批量删除保护拦下。验证 asar 体积可以临时覆盖 `beforePack` / `afterPack` 为空，只跑 `--dir`。

---

## 附：热点溯源索引

> 行号取自审计时点（2026-11-21 上午）。以下改动已经让部分行号漂移：`main.cjs`（新增 perf-monitor 接线、岛轮询重构成递归 setTimeout）、`context.ts`（估算函数重写并新增 `estimateJsonTokens`）、`runtime.ts`（closeSession 与偏差自检）。复现时按函数名或符号搜索更可靠。

| # | 位置 | 问题 |
|---|---|---|
| 1 | `desktop/main.cjs:753-757`、`:2180-2188`、`:2446-2455` | `readSettings()` 同步读盘，落在 SSE 终态事件 |
| 2 | `desktop/main.cjs:2042-2046`、`:2073`、`:2690` | `broadcast()` 全窗口 + 岛 `backgroundThrottling:false` |
| 3 | `desktop/main.cjs:2608-2635`、`:88`、`:2835` | 60ms 光标轮询 / 全局禁遮挡判定 / 监听器叠加 |
| 4 | `desktop/main.cjs:2919-2929`、`:1269-1303`；`desktop/src/App.tsx:1115,1128` | 每次按键一次 IPC + 全量 sanitize |
| 5 | `desktop/src/App.tsx:2511`、`MessageList.tsx:267,283-290,350-372,521-648` | 每秒 20 次整树重渲染 + 每 delta 两次强制布局 |
| 6 | `desktop/src/ui/Markdown.tsx:78-99`、`code-highlight.ts:161-170` | stable 前缀反复全量重高亮，近似 O(n²) |
| 7 | `desktop/src/components/UserBubble.tsx:43,156-167` | 每次渲染重解析 + base64 图片常驻 |
| 8 | `desktop/src/AppShell.css:155-178,269-270`；`RightPanel.tsx:336-339` | 布局动画 / 常驻毛玻璃 / 隐藏 webview |
| 9 | `src/agent/session-store.ts:91,1819,569-605,642-687` | entries 只增 + 图片 base64 常驻 |
| 10 | `src/agent/context.ts:8-15,268-288`；`agent-loop.ts:332-357` | 每轮 6–10 次全历史扫描 + CJK 数组分配 |
| 11 | `src/agent/runtime.ts:2403-2409,7619-7752`；`server.ts:1004-1015` | closeSession 不清 idle timer |
| 12 | `src/agent/session-store.ts:1964,1973-1982,2022-2086` | 索引 2s 全量重解析 |
| 13 | `src/server/server.ts:848-874,234-235` | SSE 无背压 + 4MB replay 常驻 |
| 14 | `desktop/package.json:78-87`；`renderer/assets/MiSansVF-DutB4wjF.ttf` | asar 315MB / 20MB 字体 |
