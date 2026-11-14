# 贡献指南

感谢你愿意为 MeowCode 花时间。这份文档说明本地怎么跑起来、代码放在哪、提交前要过哪些检查。

## 开始之前

- **主平台是 Windows**。开发和 CI 都在 `windows-latest` 上跑（PowerShell 语义、路径大小写、node-pty 走 ConPTY）。其他系统能跑，但请以 Windows 上的行为为准。
- **Node.js 20+，pnpm 11**。CI 用的 Node 24 / pnpm 11。
- 熟悉 TypeScript 和 Electron 会轻松一些，不熟也没关系——代码里没什么魔法。

## 本地起步

```powershell
git clone https://github.com/MuLiuSaMa/MeowCode.git
cd MeowCode
pnpm install
pnpm dev:desktop
```

首次启动后在设置里填服务商 API Key 与模型列表。密钥只留在 agent server 内存里，不落盘。

只改内核、不想等 Electron 启动时，可以单独跑：

```powershell
pnpm dev:server
```

server 起来后任何 HTTP 客户端都能接，UI 不是必需品。

## 先搞清楚改哪一层

| 想改的东西 | 去哪 |
| --- | --- |
| 工具定义与执行、审批、上下文压缩、缓存策略、provider 分派、运行时主循环 | `src/agent/` |
| HTTP 路由、SSE 事件流、会话读写、工作区文件访问 | `src/server/` |
| 界面、交互、样式、i18n | `desktop/src/` |
| 主进程、终端、浏览器宿主、托盘、通知 | `desktop/*.cjs` |
| 插件宿主、MCP 客户端、命令与技能加载 | `src/plugins/` |
| 语言服务反馈 | `src/lsp/` |
| 市场条目、图标生成、端到端校验 | `resources/marketplace/` + `scripts/` |

有一条硬边界：**渲染层不直接碰内核**，所有交互都走 server 的 HTTP + SSE。绕开它会让「内核可以单独跑」这个前提失效。

## 提交前必须通过

与 CI 完全一致（`.github/workflows/ci.yml`），四条全绿再发 PR：

```powershell
pnpm lint
pnpm build:agent
pnpm --filter @meowcode/desktop typecheck
pnpm test
```

`pnpm lint` 是零告警门禁，不是建议。

跑全量测试时如果 `server.plugins` / `restart` / `runtime.subagent` 这几组超时，多半是本机 MCP 的 `npx` 冷启动太慢，单独加长超时重跑即可，不要因此改断言：

```powershell
npx vitest run --testTimeout=40000
```

## 测试怎么写

- **新功能带测试，修 bug 带能复现的回归测试**。只改代码不加测试的 PR 大概率会被要求补上。
- 测试文件与被测模块同目录，命名 `*.test.ts`。
- runtime 相关测试共用一套 mock 基建（`vi.hoisted` + `vi.mock("./provider.js")`），照现有文件抄结构即可。
- 纯样式调整可以不加测试，但不要把已有断言改宽松来「变绿」。

## 提交信息

用 Conventional Commits，描述用中文：

```
feat(agent): 子 Agent 支持后台运行
fix(git): 大提交不再因 4MB 输出上限整条失败
style(diff): diff 增删色换成更鲜艳的绿/红
```

- 常用 type：`feat` / `fix` / `style` / `refactor` / `perf` / `docs` / `test` / `chore`
- 一行说清改了什么，结尾不加句号
- 一个提交只做一件事；顺手改的无关文件拆出去

## 分支与 PR

1. 从 `main` 切分支，命名随意但能看出意图（`fix/compaction-overflow`、`feat/island-settings`）。
2. 保持小而聚焦，一个 PR 解决一个问题。
3. PR 描述里写清楚：**问题是什么、怎么改的、怎么验证的**。UI 改动请附前后截图。
4. 不要在一个 PR 里顺手重构无关模块，review 成本会翻倍。

## 不要提交的内容

`.gitignore` 已经挡掉大部分，这里列出来是为了避免你误用 `git add -f`：

- `node_modules/`、`dist/`、`desktop/release/`、`*.tsbuildinfo`
- `.meowcode/`、`.workbuddy/`、`.trae/`、`.zcode/` 等本机 Agent/编辑器状态
- API Key、真实 token、会话 JSONL、含个人路径的日志
- 体积很大的二进制，除非是该技能运行所必需（例如市场里 `deployment` 技能的 CLI）

提交前扫一眼暂存区，别把 `.env` 或调试用的临时脚本带进去。

## 发布与更新令牌

自动更新走 GitCode Releases（`api.gitcode.com/api/v5/repos/.../releases/latest`）。匿名调用很快会被限流，所以需要一个只读令牌。

**令牌永不进仓库**。`desktop/update-check.cjs` 按这个顺序查找：

1. 环境变量 `MEOWCODE_GITCODE_UPDATE_TOKEN`
2. `resources/gitcode-update-token.txt`（打包时随 `resources` 进安装包，`.gitignore` 已挡）
3. `~/.meowcode/gitcode-update-token.txt`（仅本机生效）

三者都没有时退回匿名请求，功能可用但容易撞限流，错误提示会说明原因。

发版流程：

1. 改 `desktop/package.json` 的 `version`
2. `pnpm package`
3. 在 GitCode 建 Release，tag 用 `v<version>`，上传 `MeowCode-<version>-setup.exe`
4. 客户端拿 `app.getVersion()` 和 release 的 `tag_name` 按数字段比较

内置令牌会随安装包分发，拿到安装包的人都能提取出来。请只授予该仓库的**只读**权限，不要用带写权限的私钥。

打包相关的两处配置在 `desktop/package.json` 的 `build` 里，都是踩坑之后加的：

- `npmRebuild: false`：`node-pty` 用的是 N-API 预编译（`prebuilds/win32-x64/*.node`），不重编译也能被 Electron 加载。而重编译要求本机装了 Visual Studio 的 Spectre 缓解库，缺了会以 `MSB8040` 直接失败。
- `electronDownload.mirror`：electron 二进制走 npmmirror，避免 GitHub 直连超时。

以后如果新增了别的原生依赖，`npmRebuild: false` 需要重新评估——它会让所有原生模块都跳过针对 Electron ABI 的重编译。

## 报告问题

开 Issue 前先搜一下有没有重复。写的时候尽量包含：

**Bug**

- MeowCode 版本、Windows 版本
- 用的哪个服务商与模型
- 最小复现步骤（能稳定复现最好）
- 期望行为 vs 实际行为
- 相关日志或截图（记得脱敏 token 和路径）

**功能建议**

- 你想解决的场景，而不是只给一个方案
- 现在卡在哪一步、临时怎么绕过的

**安全漏洞**

不要开公开 Issue。请通过官网 [meowcode.cn](https://meowcode.cn) 上的联系方式私下告知，我会尽快回复。

## 一点约定

- 讨论对事不对人，review 意见针对代码不针对作者。
- 不确定的改动可以先开 Issue 聊，避免写完才发现方向不对。
- 中文、英文都行，怎么顺手怎么来。
