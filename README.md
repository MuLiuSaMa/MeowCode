# MeowCode

MeowCode 是一个极简的本地编程 Agent 桌面应用(Windows),灵感来自 Codex、Metis、DeepSeek Harness、LanAgent 与 ZCode。Electron + React 负责界面,Agent 内核跑在本地 HTTP/SSE 服务里,UI 与内核通过事件流通信。

## 功能特性

- **多服务商接入**:支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种协议;内置常用服务商目录(DeepSeek、Kimi、通义、智谱、OpenRouter 等),也可自定义接入。
- **文件与搜索工具**:`list_dir` / `read_file` / `glob` / `grep`(内置 ripgrep)/ `write_file` / `edit_file` / `multi_edit`。
- **命令执行**:`run_command` 运行 PowerShell,长输出自动截断,高危命令给出风险提示。
- **审批模式**:`read-only` / `ask` / `auto` / `full` 四档;写文件与命令默认弹出 diff 审批,审批期间文件被外部改动会自动刷新 diff。
- **子 Agent(`task`)**:每回合最多 3 个并发,可后台运行,子 Agent 的写操作审批记在父会话上。
- **会话模式**:`default` 常规对话;`plan` 只读研究并输出计划文档到 `plans/`,确认后才实施;`goal` 围绕目标用 `update_plan` 自主推进。
- **会话管理**:本地持久化、断点恢复、上下文压缩(compaction)、自动会话标题。
- **省 Token 机制**:服务端原生压缩(Anthropic `compact_20260112` / OpenAI `/responses/compact`)、
  本地摘要双路径(复用前缀命中提示缓存)、工具输出三层治理(淘汰 / 抽头尾 / 模型纪要)、
  逐请求输出预算预检(按真实用量锚点收紧 max_tokens)、PTC `run_code`(写/命令走宿主审批)、
  MCP schema 瘦身与 8k 预算(保名字、按档砍描述)、读区间并集短路与跨回合结果去重、
  摘要失败时的零模型兜底与连续失败熔断。
- **桌面集成**:内置终端(node-pty)、Agent 浏览器面板(打开页面/截图/点击/输入)、侧边聊天(`Ctrl+Alt+S`)、文件快开(`Ctrl+P`)、终端(`Ctrl+``)。
- **项目指令**:自动读取工作区根目录与 `.meowcode/AGENTS.md` 作为项目级指引。
- **图片输入**:用户附图与截图回传,取决于所配模型的输入模态。

## 快速开始

需要 Node.js 与 pnpm。

```powershell
pnpm install
pnpm dev:desktop
```

首次启动后在设置里填入服务商 API Key 与模型列表;密钥只保留在 agent server 内存中,不会落盘。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev:desktop` | 启动桌面端开发环境(Vite + Electron) |
| `pnpm dev:server` | 单独以 watch 模式跑 agent server |
| `pnpm build` | 编译 agent(TSC)并构建桌面端渲染层 |
| `pnpm test` | 运行 vitest 单元测试 |
| `pnpm package` | 构建并打包 Windows x64 NSIS 安装包(输出到 `desktop/release`) |

## 目录结构

```
src/agent    Agent 内核:工具定义与执行、provider 分派、runtime、会话存储、压缩
src/server   本地 HTTP/SSE 服务:会话、事件流、工作区文件访问
desktop      Electron 桌面应用:React 渲染层、主进程、终端、浏览器宿主
docs         设计文档
plans        计划模式产出的实现计划
```

## Agent Server 环境变量

| 变量 | 说明 |
| --- | --- |
| `MEOWCODE_PROVIDERS` | 服务商配置 JSON(由桌面端注入,读取后立即从环境变量删除) |
| `MEOWCODE_SERVER_TOKEN` | 本地服务鉴权 token(未提供时随机生成) |
| `MEOWCODE_SESSIONS_DIR` | 会话存储目录,默认 `%APPDATA%\MeowCode\agent\sessions` |
| `MEOWCODE_WORKSPACE` | 默认工作区目录 |
| `MEOWCODE_SERVER_PORT` | 服务监听端口,默认随机分配 |

## 安全说明

- API Key 注入 server 后立即从环境变量删除,`run_command` 默认过滤敏感环境变量,避免模型通过子进程读回密钥。
- 写文件与命令执行默认需要审批;只有 `full` 模式允许读写工作区之外的路径。
- 会话与密钥数据仅保存在本机。

## License

[GPL-3.0-or-later](./LICENSE)
