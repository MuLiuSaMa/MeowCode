# MeowCode 可行性方案与 MVP 记录

MeowCode 采用“移植式自研内核 + Electron 桌面端”。

## 复用矩阵

- `metis-main` / MIT：主要参考本地 HTTP/SSE Server、JSONL 会话、事件流、工具循环、Provider 结构、Electron 分层。
- `codex-main` / Apache-2.0：参考 Session / Task / Turn / Approval / Event 语义。
- `deepseek-harness-master` / MIT：参考插件化 Harness、Provider 配置、事件生产消费。
- `LanAgent-main` / GPL-3.0：参考 Windows PowerShell 工具、路径边界、审批、Token 缓存优化。
- `ZCode-main` / Apache-2.0：参考 Electron 打包和聊天工作台结构。

## MVP

- Windows x64。
- OpenAI-compatible API。
- 工具：`list_dir`、`read_file`、`write_file`、`edit_file`、`run_command`。
- 本地 HTTP/SSE Server，只监听 `127.0.0.1`。
- JSONL 会话。
- 文件写入和命令执行需要审批。
- 不做插件市场、MCP、技能、子代理、SSH、语音、Hyperlight。
