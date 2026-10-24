# MeowCode 插件系统

MeowCode 支持两类扩展：**进程内 TS/JS 插件**（注册工具、订阅生命周期 hooks、注册命令）与 **MCP 外部服务**（接入外部工具）。另有纯声明式的 **markdown 命令** 与 **Skill**。

## 插件市场

桌面端左侧 Rail 的「插件市场」入口（商店图标）打开市场面板，含 **插件 / 技能 / MCP** 三个页签、搜索与分类筛选。内容打包在 `resources/marketplace/`（由 `pnpm tsx scripts/build-marketplace.ts` 从 Trae 本地数据与参考仓库搬运生成，128 项：技能 115 / 插件 10 / MCP 3）。

- **安装位置**：统一装到全局 `~/.meowcode/`（skills→`skills/<id>/`，plugins→`plugins/<id>.ts`，MCP→合并 `mcp.json` 的 `mcpServers.<id>`）
- **生效方式**：技能下一轮对话自动生效（每轮重扫）；插件/MCP 安装后 server 自动 reload
- **卸载保护**：只允许卸载带市场标记（`.meowmarketplace.json`）的安装物，手工放置的同名内容报 409
- **MCP 凭据**：GitHub MCP 走 GitHub App Device Flow OAuth（内置公开 Client ID；应用内「连接 GitHub」→ 一次性设备码 → 浏览器授权）。access token 用 safeStorage 加密存 settings，登录/刷新时经 `/plugins/mcp-credentials` 写入进程 env 并重载 MCP，不重启 agent server。GitHub App 需启用 Device flow 并授予所需仓库权限。
- **Gitee / GitCode 直连（OAuth 授权码 + 本地回跳）**：市场里点「连接 Gitee/GitCode」→ 系统浏览器打开平台授权页 → 平台回跳 `http://127.0.0.1:53682/oauth/<platform>/callback` → 主进程换 token 并加密存 `settings.oauthAccounts`，经 `/plugins/mcp-credentials` 注入 `MEOWCODE_GITEE_TOKEN` / `MEOWCODE_GITCODE_TOKEN`（token 优先于手工 PAT，过期前 1 小时自动 refresh）。
  - Client ID **内置**（公开信息，`desktop/oauth-platforms.cjs` 的 `defaultClientId`），用户无需自建应用；平台侧回调地址需登记为上面的固定地址。
  - 两个平台换 token 都强制校验 secret 且不支持 PKCE，解析优先级：设置页手动保存（safeStorage 加密）→ 环境变量 `MEOWCODE_GITEE_CLIENT_SECRET` / `MEOWCODE_GITCODE_CLIENT_SECRET` → 本机 `%APPDATA%/MeowCode/oauth-apps.json`（`{"gitee":{"clientSecret":"..."}}`）→ `desktop/oauth-platforms.cjs` 内置官方应用凭据。
  - 内置凭据让新装也能「点一下直接开系统浏览器」；用户自建应用可用前三种来源覆盖（Client ID 与 Secret 需成对）。
  - 兜底：仍可在同一弹窗切换「改用私人令牌」粘贴 PAT。
- **API**：`GET /marketplace`、`POST /marketplace/install {id,type}`、`POST /marketplace/uninstall {id,type}`（幂等，重装=覆盖恢复出厂）、`POST /plugins/mcp-credentials {env}`（受 server token 保护，运行时更新 MCP 凭据并 reload）
- **打包**：electron-builder extraResources `resources/marketplace → resourcesPath/marketplace`，desktop 经 `MEOWCODE_MARKETPLACE_DIR` 注入 server

## 目录约定

```
<工作区>/.meowcode/
├── plugins/          # 项目级插件（优先）
│   ├── my-tool.ts    # 单文件插件
│   └── my-pack/      # 目录插件（index.ts 或 package.json main）
├── commands/         # markdown 斜杠命令（deploy.md → /deploy）
├── skills/           # SKILL.md 技能（skills/<name>/SKILL.md）
└── mcp.json          # MCP 服务声明
~/.meowcode/          # 全局级（Windows: %USERPROFILE%\.meowcode\），同名时项目级胜出
```

插件发现规则：目录下的 `*.ts / *.mts / *.js / *.mjs / *.cjs` 各算一个插件；一层子目录含 `index.*` 或带 `main` 的 `package.json` 算一个插件；**不深层递归**。`*.d.ts`、`*.test.*`、`*.spec.*` 被忽略。

改完插件后：设置 → 插件 → 重新加载（或重启应用）。加载失败的插件会被禁用并标红，不影响其他插件。

## 写一个插件

插件就是一个导出工厂函数的模块，默认导出（或模块本身）为 `(api) => void | Promise<void>`：

```ts
// .meowcode/plugins/timestamp.ts
import type { PluginFactory } from "meowcode"; // 类型提示可选，直接写也行

const factory: PluginFactory = (api) => {
  api.logger.info("timestamp plugin loaded");

  // 1) 注册自定义工具（模型可调用）
  api.registerTool({
    name: "now",
    description: "Get the current local time",
    parameters: { type: "object", properties: {} },
    execute: async (_input, ctx) => ({ output: new Date().toString(), ok: true }),
    // requiresApproval: true,  // 默认 false；true 则每次调用先弹审批
  });

  // 2) 订阅生命周期 hook
  api.on("tool_call", (event) => {
    if (event.tool === "run_command" && /rm\s+-rf/i.test(String(event.input.command))) {
      return { block: true, reason: "destructive command" };
    }
  });

  // 3) 注册斜杠命令（代码式；markdown 式见下文）
  api.registerCommand({
    name: "review",
    run: (args) => `Please review the following code changes: ${args}`,
  });
};

export default factory;
```

### PluginAPI

| 成员 | 说明 |
| --- | --- |
| `registerTool(tool)` | 注册 LLM 工具。`parameters` 为 JSON Schema；保留名（内置工具名、`browser_` 前缀、`task`/`update_plan`）与重名会被拒绝并告警 |
| `on(event, handler)` | 订阅生命周期 hook（见下表） |
| `registerCommand(cmd)` | 注册斜杠命令 `cmd.name`；重名被拒 |
| `storage` | 按插件隔离的 KV（`~/.meowcode/plugin-data/<id>.json`）：`get/set` |
| `logger` | 带 `[plugin:<id>]` 前缀的 info/warn/error |
| `workspace` | server 启动时的工作区路径 |

`Tool.execute` 返回 `{ output: string; ok: boolean; images? }`；抛错由内核兜底为失败结果。长任务请监听 `ctx.signal`。

### 生命周期 hooks

按注册顺序执行（项目插件先于全局插件）；改写字段链式传递；任一 handler 返回 `block` 即短路；handler 抛错只记日志。

| hook | 事件字段 | 可返回 |
| --- | --- | --- |
| `prompt_submit` | `{ sessionId, text }` | `{ block?, reason?, text? }` — block 则本回合直接以 assistant 消息说明原因结束 |
| `turn_start` | `{ sessionId, turnId, text }` | 仅观察 |
| `tool_call` | `{ sessionId, callId, tool, input }` | `{ block?, reason?, input? }` — block 则工具不执行，原因作为工具结果返回给模型 |
| `tool_result` | `{ sessionId, callId, tool, output, ok, truncated? }` | `{ output?, ok? }` — 可改写结果 |
| `turn_end` | `{ sessionId, turnId, status, error? }` | 仅观察 |
| `session_start` | `{ sessionId, cwd }` | 仅观察 |

注意：`task` / `update_plan` / `browser_*` 三类内置特殊工具不经过 `tool_call` / `tool_result` hook。

## markdown 斜杠命令

`.meowcode/commands/deploy.md`：

```markdown
---
description: 部署到指定环境
---
请把当前项目部署到 $ARGUMENTS，先跑测试再发布。
```

对话里输入 `/deploy staging` → 模型收到 `请把当前项目部署到 staging，先跑测试再发布。`。模板没有 `$ARGUMENTS` 占位符时，参数会以 `Arguments: ...` 追加。未命中命令表的 `/xxx` 原样透传。

## Skill（SKILL.md）

`.meowcode/skills/deploy-guide/SKILL.md`：

```markdown
---
name: deploy-guide
description: 本项目的发布流程与注意事项
---
（正文，模型按需 read_file）
```

系统提示只注入"可用技能索引"（名称 + 描述 + 路径），模型需要时自行读取全文，省 token。`always: true` 会把全文内联进上下文。

桌面端用「技能引用」chip 发起的回合不受会话权限模式约束（按完全访问执行，回合结束自动还原），技能里的写文件/命令不会弹审批。

## MCP 服务

`.meowcode/mcp.json`（项目级优先于全局）：

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/proj"],
      "env": { "K": "v" }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }  // ${VAR} 取进程环境变量
    },
    "gated-fs": { "command": "...", "trust": false, "timeoutMs": 30000 }
  }
}
```

- 工具以 `mcp__<server>__<工具名>` 注入，默认**免审批直接执行**；`"trust": false` 则每次调用前弹审批
- stdio 服务懒启动；崩溃自动重连（1s/4s/16s，3 次后标记失败并摘除工具）
- `callTool` 默认 60s 超时（可配 `timeoutMs`），超时返回失败结果不打断回合

## 启停管理

设置 → 插件：列表展示来源（项目/全局）、能力计数、错误信息，开关即启用/禁用（全局按 id，改动重启 Agent 服务生效）。`POST /plugins/reload` 提供热重载（开发期便利）。

## 示例

见 `examples/plugins/`：`hello-tool.ts`（工具 + hook + 命令 + storage）、`guard.ts`（命令守卫 hook）。
