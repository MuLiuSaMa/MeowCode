<p align="center">
  <img src="./MeowCode.png" alt="MeowCode — A programming agent whose architecture you can tweak freely" width="100%">
</p>

<h1 align="center">MeowCode —— 可自由修改架构的Agent</h1>

<p align="center">
  <a href="https://meowcode.cn"><img alt="官网" src="https://img.shields.io/badge/%E5%AE%98%E7%BD%91-meowcode.cn-1f6feb?style=flat-square"></a>
  <a href="https://github.com/MuLiuSaMa/MeowCode"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-%E4%BB%93%E5%BA%93-181717?style=flat-square&amp;logo=github&amp;logoColor=white"></a>
  <a href="https://gitee.com/muliuawa/MeowCode"><img alt="Gitee" src="https://img.shields.io/badge/Gitee-%E4%BB%93%E5%BA%93-C71D23?style=flat-square&amp;logo=gitee&amp;logoColor=white"></a>
  <a href="https://gitcode.com/MuLiuSaMa/MeowCode"><img alt="GitCode" src="https://img.shields.io/badge/GitCode-%E4%BB%93%E5%BA%93-1677FF?style=flat-square&amp;logo=gitcode&amp;logoColor=white"></a>
  <img alt="Stars" src="https://img.shields.io/github/stars/MuLiuSaMa/MeowCode?style=flat-square&amp;logo=github&amp;color=e3b341">
  <img alt="Downloads" src="https://img.shields.io/github/downloads/MuLiuSaMa/MeowCode/total?style=flat-square&amp;logo=github&amp;label=%E4%B8%8B%E8%BD%BD%E9%87%8F&amp;color=2ea043">
  <img alt="QQ群 1128483595" src="https://img.shields.io/badge/QQ%E7%BE%A4-1128483595-12B7F5?style=flat-square&amp;logo=tencentqq&amp;logoColor=white">
</p>

一个**架构可以随你改**的本地编程 Agent 桌面应用。

Electron + React 负责界面，Agent 内核跑在本地 HTTP/SSE 服务里，UI 与内核只通过事件流通信——所以内核可以单独跑、单独换、单独重写，不会牵动界面。

## 亮点

-   **内核与界面彻底解耦**：`pnpm dev:server` 就能脱离 Electron 单独跑，任何 HTTP 客户端都能接入。
-   **不是黑盒**：工具调用、审批、压缩、缓存策略全是 `src/agent/` 里的普通 TypeScript，改完即生效，没有打包魔法。
-   **认真对待 Token**：服务端原生压缩 + 本地摘要 + 工具输出三层治理 + 输出预算预检，长会话不容易崩。
-   **桌面不是壳**：终端、浏览器、邮件、文件预览、Git、Diff 审阅、悬浮岛都在同一个窗口，不用在编辑器和终端之间来回切。
-   **本地优先**：会话、密钥、日志都留在本机；密钥进内存即从环境变量抹除，不落盘。

## 功能特性

**模型接入**

-   支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种协议。
-   内置常用服务商目录（DeepSeek、Kimi、通义、智谱、OpenRouter 等），也可完全自定义。
-   模型能力画像：思考预算档位、提示缓存 TTL / 断点、PDF 与图片输入门禁。
-   服务商故障自动切换（timeout / 限流 / 5xx），异常退出不打断回合。

**工具与审批**

-   文件与搜索：`list_dir` / `read_file` / `glob` / `grep`（内置 ripgrep）/ `write_file` / `edit_file` / `multi_edit`。
-   命令执行：`run_command` 运行 PowerShell（5.1 与 7 的行为对齐）；退出码如实上报，失败不再被当成成功；没有 stdin 通道，交互式命令直接失败而不是空等超时；彩色码与进度噪音在采集层清掉，超长输出保留头 + 尾，报错不会随尾部一起被截掉；高危命令给出风险提示。
-   浏览器：`browser_navigate` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_snapshot` / `browser_back` / `browser_reload`；直接驱动内嵌页签的 guest webContents，快照只收可见可交互元素（最多 200 个）。
-   网络与文档：`web_search` / `web_fetch`；PDF 直接解析（pdfjs-dist）；视频走 ffprobe + 9 帧 storyboard（约 1.5k token），长视频不硬塞上下文。
-   电脑控制（内置插件，Windows）：`computer_screenshot` / `click` / `drag` / `scroll` / `key` / `type` / `wait` / `window_list` / `window_activate` / `clipboard`；截图走 desktopCapturer，输入走 PowerShell SendInput。
-   审批四档：`read-only` / `ask` / `auto` / `full`；写文件与命令默认弹出 diff 审批，审批期间文件被外部改动会自动刷新 diff。批准过的操作可以沉淀成项目级规则（`.meowcode/approvals.json`），文件一改规则自动失效。
-   写后验证：写类工具成功后自动跑 `.meowcode/verify.json` 声明的 typecheck / lint / test，失败结果压缩后附在工具回执里，模型同一回合内修复。
-   子 Agent（`task`）：每回合最多 3 个并发，可后台运行，子 Agent 的写操作审批记在父会话上。

**多 Agent 编排**

-   13 种内置角色：`general` / `explore` / `planner` / `scoper` / `depth-prober` / `implementer` / `reviewer` / `verifier` / `fresh-verifier` / `juror` / `sweeper` / `goal-checker` / `custom`；探索、评审、裁决类角色强制只读。
-   分层编排：T0 / T1 / T2 三层，lane 可并行推进、各自声明负责的路径与验证命令；门禁按序关账，关账角色互不复用，失败按 `onFail` 回跳到指定门禁。
-   编排即配置：角色、层级、门禁、工具白名单与系统提示词都写在可编辑架构图里（`.meowcode/harness.json`），改完保存即生效，不用重新编译。

**会话与工作区**

-   三种模式：`default` 常规对话；`plan` 只读研究并输出计划文档，确认后才实施；`goal` 围绕目标用 `update_plan` 自主推进。
-   本地持久化、断点恢复、上下文压缩、自动会话标题、分支回溯、检查点与整轮撤销。
-   会话全文检索：影子索引 + size/mtime 增量，零模型调用，跨会话命中直接跳转。
-   Git 工作区：会话级 Worktree（独立检出 + 独立分支 + `refs/meowcode-backup/` 备份 ref，`node_modules` 回链原目录）；分支切换、提交、历史、逐文件 Diff 都在侧栏完成。
-   导出：会话可导出为 HTML 或 Markdown。
-   项目指令：自动读取工作区根目录与 `.meowcode/AGENTS.md` 作为项目级指引。

**邮件**

-   侧栏内置邮件客户端：多账号 IMAP 收件 / SMTP 发件，文件夹、HTML 正文与附件。
-   发件箱独立排队：发送失败留在发件箱由你手动重试，重启不会自动重发，避免重复投递。
-   AI 起草正文：说出要点即可生成邮件，区分新写 / 回复 / 转发三种语境；只产出正文，不带主题行和客套模板。
-   复用已配置的模型与代理，不需要为邮件单独填一套密钥。

**Token 效率**

-   服务端原生压缩（Anthropic `compact_20260112` / OpenAI `/responses/compact`）。
-   本地摘要双路径，复用前缀命中提示缓存。
-   工具输出三层治理：淘汰 / 抽头尾 / 模型纪要。
-   逐请求输出预算预检，按真实用量锚点收紧 `max_tokens`。
-   PTC `run_code`：写操作与命令仍走宿主审批。
-   MCP schema 瘦身与 8k 预算（保名字、按档砍描述）。
-   读区间并集短路与跨回合结果去重；已读区间随回合落盘，重启后仍能短路「已读过且未变更」的重读。
-   压缩后回填「改过哪些文件」并带净增删行数，减少压缩之后的重新探索。
-   摘要失败时的零模型兜底与连续失败熔断。
-   实时用量：输入 / 输出 / 缓存读 / 缓存写 / 命中率分开统计，同一轮多次上报按 roundId 替换而不是累加。

**桌面集成**

-   内置终端（node-pty）、浏览器面板、文件预览、插件页面板、计划面板、子 Agent 面板，右侧栏按需切换。
-   多项目工作区切换；设置页覆盖模型与服务商、审批、沙箱、Hooks、项目规则、记忆、自我学习、Worktree、外观、快捷键、数据位置与归档。
-   标题栏公告：更新动态显示在 Logo 右侧，点开看全文；关闭状态按公告 id 记录，换新公告才会再提示。
-   AI 悬浮岛：屏幕顶部胶囊聚合所有运行中会话，待审批亮琥珀点，悬停展开迷你聊天窗，空闲时鼠标穿透。
-   外观：6 套配色（经典色 / 熔岩橙 / 蜜蜂黄 / 薄荷绿 / 羊皮纸 / 和谐蓝）× 明暗 / 跟随系统；11 种界面语言。
-   托盘会话、系统通知、自动更新检查与下载。
-   侧边聊天 `Ctrl+Alt+S`、文件快开 `Ctrl+P`、终端 `` Ctrl+` ``。
-   图片输入：用户附图与截图回传，取决于所配模型的输入模态。

**插件与技能**

-   进程内 TypeScript 插件、MCP 客户端、markdown 命令与 `SKILL.md` 技能；目录约定 `<工作区>/.meowcode/` 与全局 `~/.meowcode/`，项目级覆盖用户级。
-   内置市场 186 条（随市场更新）：168 个技能 / 8 个插件 / 10 个 MCP，聚合官方内置与 Trae、ZCode、Codex、DSH、Metis 等来源。
-   第三方源接 ClawHub 与 SkillHub：分页、图标、下载量，单源故障只标记「暂不可用」，不拖垮列表；另有社区投稿与本地手动导入。
-   一键连接：GitHub / Gitee / GitCode OAuth，用于社区投稿与 Git 平台凭据，不用自建应用、不用手填 Client ID。
-   三个内置插件：`computer-control`（电脑控制）、`claude-code-hooks`（把 Claude Code 的 hooks 配置翻译成 MeowCode hook，CC 生态脚本尽量零改动可用）、`extension-authoring`（`create_skill` / `create_plugin`，让 Agent 把新能力直接做成已安装的技能或插件，写插件前走审批）。

**数据导入**

-   从 Qoder（国内 / 国际）、WorkBuddy（国内 / 国际）、ZCode、opencode、DSH、Codex 导入 MCP 连接器、记忆、技能与会话记录。
-   只读来源应用数据，同名 / 同 ID 已存在一律跳过；`plan → apply` 两段式，桌面端逐条显示进度。

**自我学习（实验性）**

自我学习不是微调模型，而是把每回合验证过的经验写成本地可审阅的制品，在后续会话里按需召回；所有产物都是 Markdown/JSON，随时可以查看、修改或删除。

-   **默认关闭**，在「设置 → 自我学习」开启，或启动时设置 `MEOWCODE_SELF_LEARNING=1`。开启后每回合结束自动复盘，把值得复用的经验沉淀下来。
-   **先观察，再决定学不学**：只有用户纠正、明确要求记住、同一命令反复失败、失败后恢复、工具调用密集这几类回合才会触发学习；普通回合连学习模型都不调用，成本可控。
-   **四类产物**：用户画像（沟通风格 / 严谨程度 / 自主权 / 编码风格 / 工具链 / 领域）、带触发条件的项目经验、可复用的 `SKILL.md` 技能，以及只记录、不执行的工作流建议。
-   **试用期机制**：新条目先标记为 `tentative`；被召回后帮上忙达到 3 次且没有帮倒忙才转正为 `active`，帮倒忙 2 次自动退役为 `retired`（文件保留，不再召回）。另有 15% 的回合作为对照组，避免把噪声当成经验。
-   **按需召回**：用户画像每会话注入 system；项目经验只在命令、报错、关键词或文件模式命中时追加到回合尾部；技能索引常驻，模型看到需要时自己读取全文。这样不会每回合重写提示词、破坏前缀缓存。
-   **安全边界**：学习产物只允许 Markdown 与自有 JSON，绝不产出可执行工具、hook 或配置；路径越界、控制面工具、绕过验证、配置文件、密钥等内容会被守卫拒绝或脱敏。
-   **可审计、可回滚**：每次学习都记入 `helped/hurt` 账本与 `journal.jsonl`，覆盖前保存历史快照；设置页可以回滚单条技能、重新放回试用期或删除，也能一键「立即整理」合并近义经验。
-   **成本与熔断**：学习请求单飞执行，每日最多 40 次模型调用，学到的技能上限 20 个；任何一步失败都静默降级，不会影响当前对话。
-   **存放位置**：跨项目产物在 `~/.meowcode/learning/`，项目级产物在 `<工作区>/.meowcode/learning/`，项目级优先；包含 `profile.json`、`guidelines.json`、`skills/`、`ledger.json` 等文件，可直接查看和备份。

## 架构

### 编排可视化

![](./assets/agent-architecture.png)

Agent 架构编辑器

主 Agent 与子 Agent 的关系、层级（T0 / T1 / T2）、门禁条件、可用工具与系统提示词都是可编辑的节点。改完保存即生效，不用改代码，也不用重新编译。

### 运行时分三层

```
┌─────────────────────── Electron 桌面端 (desktop/) ───────────────────────┐
│  React 渲染层 (Vite)  ◀──── IPC ────▶  主进程 (main.cjs)                  │
│  会话 · 审批 diff · 终端 · 浏览器 · Git · 市场 · 悬浮岛 · 设置            │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ HTTP + SSE 事件流
┌──────────────────────────────────▼───────────────────────────────────────┐
│  本地 Agent Server (src/server)                                           │
│  会话读写 · 事件广播 · 工作区文件访问 · 插件与市场管理                       │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ 进程内调用
┌──────────────────────────────────▼───────────────────────────────────────┐
│  Agent 内核 (src/agent)                                                   │
│  runtime 循环 · 工具分派 · 审批 · 上下文压缩 · 缓存策略 · 故障切换           │
└──────────┬───────────────────────────────────────────┬───────────────────┘
           │ 三种协议                                   │ 工具
           ▼                                           ▼
  Anthropic Messages                          文件 / 命令 / 搜索 / 子 Agent
  OpenAI Chat Completions                     浏览器 / 电脑控制 / 网络与文档
  OpenAI Responses                            MCP / 插件 / 技能
```

## 实测

同一道「前后端综合代码 BUG 修复」任务，六款 Agent 在同一模型（DeepSeek-V4.1-Flash-1017，思考强度 Max，上下文 1M）下的对比：

![图片](assets/benchmark-token-cache.png)

-   **总 Token**：5,123,379，最高比DeepSeek Harness减少了61.36%
    
-   **缓存命中率**：98.67%，在保证使用较少Token的情况下缓存命中率仍排名第二。
    
    \*数据为非权威评测，仅供参考。

## 快速开始

需要 Windows 10/11 x64、Node.js 20+ 与 pnpm。

```powershell
pnpm install
pnpm dev:desktop
```

首次启动后在设置里填入服务商 API Key 与模型列表。密钥只保留在 agent server 内存中，不会落盘。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev:desktop` | 启动桌面端开发环境（Vite + Electron） |
| `pnpm dev:server` | 单独以 watch 模式跑 agent server |
| `pnpm build` | 编译 agent（TSC）并构建桌面端渲染层 |
| `pnpm test` | 运行 vitest 单元测试 |
| `pnpm lint` | oxlint 检查 `src` 与 `desktop/src` |
| `pnpm package` | 构建并打包 Windows x64 NSIS 安装包（备用；正式版走 Inno Setup，见「打包发布」） |
| `pnpm package:msix` | 构建并打出微软商店 MSIX（未签名，输出到 `desktop/release`） |
| `pnpm test:msix` | 本地签名并侧载安装最新 MSIX（签名 + 信任证书 + 安装 + 启动） |
| `pnpm make:msix-assets` | 从 `resources/icon.png` 重新生成商店瓦片图 |

## 打包发布

两条产线都从 release 构建开始，命令均在仓库根目录执行：

```powershell
pnpm build
```

### 普通版（Inno Setup）

```powershell
# 1. 生成未封装目录（内部会 deploy agent 并做打包冒烟检查）
pnpm --filter @meowcode/desktop exec electron-builder --win --x64 --dir

# 2. 用 Inno Setup 编译安装包（自动查找 ISCC；已加入 PATH 时可直接 ISCC.exe installer.iss）
$iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
  $iscc = Get-ChildItem "$env:ProgramFiles\Inno Setup *\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup *\ISCC.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
& $iscc installer.iss
```

-   输入：`desktop\release\win-unpacked\`
-   产物：`installer-output\MeowCode-<版本>-setup.exe`
-   版本号自动读取 `win-unpacked\MeowCode.exe`，由 `desktop/package.json` 的 `version` 决定

### 微软商店版（MSIX）

```powershell
pnpm --filter @meowcode/desktop exec electron-builder --win --x64 --config electron-builder.msix.config.cjs
```

-   产物：`desktop\release\MeowCode-<版本>-x64.msix`，**保持未签名**上传 Partner Center，商店入库时会重签
-   商店身份已写在 `desktop/electron-builder.msix.config.cjs`；换产品时可分别用 `MEOWCODE_MSIX_IDENTITY_NAME`、`MEOWCODE_MSIX_PUBLISHER`、`MEOWCODE_MSIX_PUBLISHER_DISPLAY_NAME` 覆盖
-   本地侧载测试：`pnpm test:msix`；换 Logo 后先跑 `pnpm make:msix-assets`
-   商店要求修订号为 0（版本自动补成 `x.y.z.0`），发新版本改 `desktop/package.json` 的 `version` 即可

## 目录结构

```
src/agent       Agent 内核：工具定义与执行、provider 分派、runtime、会话存储、压缩、缓存
src/agent/learning  自我学习：信号观察、经验蒸馏、召回、试用期评估与回滚
src/server      本地 HTTP/SSE 服务：会话、事件流、工作区文件访问、插件与市场
src/plugins     进程内插件宿主、MCP 客户端、命令与技能加载
src/plugins/builtin  内置插件：电脑控制、Claude Code hooks 桥接、技能与插件创作
src/git         Git 与 worktree：分支、提交、备份 ref、会话级独立检出
src/lsp         语言服务反馈
desktop         Electron 桌面应用：React 渲染层、主进程、终端、浏览器/电脑控制宿主、悬浮岛
resources/marketplace  内置市场资源：技能、插件、MCP 清单与图标
scripts         构建、图标生成、市场与端到端校验脚本
assets          README 截图与配图
```

## Agent Server 环境变量

| 变量 | 说明 |
| --- | --- |
| `MEOWCODE_PROVIDERS` | 服务商配置 JSON（由桌面端注入，读取后立即从环境变量删除） |
| `MEOWCODE_SERVER_TOKEN` | 本地服务鉴权 token（未提供时随机生成） |
| `MEOWCODE_SESSIONS_DIR` | 会话存储目录，默认 `%APPDATA%\MeowCode\agent\sessions` |
| `MEOWCODE_WORKSPACE` | 默认工作区目录 |
| `MEOWCODE_SERVER_PORT` | 服务监听端口，默认随机分配 |
| `MEOWCODE_SELF_LEARNING` | 自我学习开关，`1` / `true` / `on` 开启；默认关闭 |
| `MEOWCODE_CC_HOOKS_SCOPE` | Claude Code hooks 作用域：默认只跑 user 级（`user=true`、`workspace=false`） |
| `MEOWCODE_HOOKS_RUN_MODE` | hooks 运行模式：`auto` 直接执行 / `ask` 每次询问 |

## 安全说明

-   API Key 注入 server 后立即从环境变量删除；`run_command` 默认过滤敏感环境变量，避免模型通过子进程读回密钥。
-   写文件与命令执行默认需要审批；只有 `full` 模式允许读写工作区之外的路径。
-   浏览器宿主、电脑控制宿主、后台任务宿主都只监听 `127.0.0.1`，并用随机 token 校验请求。
-   电脑控制启用插件即视为授权，不再逐次审批；不需要时在插件页停用。
-   第三方市场里的技能与插件是任意代码，安装前请自行审查来源。
-   会话与密钥数据仅保存在本机。

## 参与贡献

欢迎 Issue 与 PR。完整流程、代码分层导览与提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

提交前请确认这四项全绿（与 CI 一致）：

```powershell
pnpm lint
pnpm build:agent
pnpm --filter @meowcode/desktop typecheck
pnpm test
```

## 许可证

本项目以 **GNU General Public License v3.0 or later** 发布，完整许可证文本见 [LICENSE](./LICENSE)。

这意味着你可以自由使用、修改、分发（包括商用），但**分发修改后的版本时必须同样以 GPL-3.0 开源**，并保留版权与许可声明。软件按“现状”提供，不附带任何担保。