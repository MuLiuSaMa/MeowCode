# 模型能力：PDF / 视频 / 思考预算 / 缓存画像 / 供应商 fallback

五个能力共用一套「省 token」取向：能在本地做的一律本地做，只有本地做不到的才花服务商的钱。

## 1. PDF 输入（`read_file` + `pages`）

- **入口**：复用 `read_file`，不新增工具名；`.pdf` 走文本层抽取。
- **参数**：`pages`（`"1-5"` / `"3"` / `"1-3,7"`），单次最多 20 页、2 万字符。
- **输出**：`PDF: name (N pages, M chars, showing a-b)` + `[page N]` 分段；被截断时给下一段的 `pages=` 续读提示。
- **扫描件**：抽到的页平均 < 50 字符即判定为扫描件。此时
  - 模型勾选了 `pdf` 输入模态且协议是 Anthropic Messages / OpenAI Responses → 原文件作为 `document` / `input_file` 附上；
  - 否则返回可操作提示（去设置里勾「PDF」，或转成图片读）—— 不硬报错。
- **缓存**：`.meowcode/cache/pdf/<sha256>-<first>-<last>.json`，同一文件的同一段页第二次读不重新解析。
- **协议**：chat completions 没有可移植的 file 块，不下发文档，只在正文补一行说明。
- **依赖**：`pdfjs-dist`（纯 JS，legacy 构建 + 动态 import，Node 侧 fake worker）。

## 2. 视频输入（`read_video`）

| mode | 产出 | 成本 |
| --- | --- | --- |
| `meta`（默认） | 时长 / 分辨率 / fps / 音轨 / 体积，**0 图** | ~100 token |
| `storyboard` | 区间内均匀 9 帧，单次 ffmpeg `tile=3x3` 拼成一张 1536px JPEG | ~1.5k token |
| `frames` | ≤4 个指定时间点，长边 2048、`-q:v 2` | ~1k token/帧 |

- 视频不进 prompt（30MB ≈ 千万 token），只能经工具按帧读。
- 临时目录 `os.tmpdir()/meowcode-video-<uuid>`，`finally` 递归删除。
- **ffmpeg 缺失**：返回安装提示（Windows `winget install Gyan.FFmpeg`），不抛栈。
- **自定义路径**：`MEOWCODE_FFMPEG`（ffprobe 默认取同目录，也可用 `MEOWCODE_FFPROBE`）。
- responses 协议下工具图片不再被丢弃：序列化时拆成紧随的 `user` 消息（顺带修好 `browser_screenshot` 丢图）。

## 3. 思考预算

- 档位映射（省 token 优先）：`minimal/low 1024`、`medium 2048`、`high 4096`、`xhigh 8192`、`max 16384`。
- `provider.thinkingBudget` 显式覆盖档位；无论哪种来源都会被钳制：给正文留 1024 token，
  `max_tokens < 2048` 时**不下发 thinking**（宁可不思考，也不构造必然 400 的请求）。
- `plan` / `goal` 模式按 `reasoningLevels` 升一档；显式 `thinkingBudget` 不参与升档。
- 辅助请求（标题 / 工具纪要 / 压缩摘要）一律剥掉 `reasoningEffort` 与 `thinkingBudget`。
- Responses：`reasoning.summary` 默认不下发，只有显式配置了 `reasoningSummary` 才带。

## 4. 缓存画像（`cache-profile.ts`）

| 服务商 | 断点 | 说明 |
| --- | --- | --- |
| Anthropic 官方 / Claude 模型 | `tools` + `system[0]` + `system[1]` + `tail` | 用满 4 个 |
| Qwen / DashScope | `system[0]` + `tail` | Qwen 不认 tools 断点 |
| 其他 Anthropic 兼容网关 | `system[0]` + `tail` | 保守 |
| 无法解析的端点 | 无 | 不打 `cache_control` |

- 出口统一按 `BREAKPOINT_CAP = 4` 裁剪并计数，任何路径都不会超限。
- `provider.cacheTtl === "1h"` 才带 `ttl: "1h"`，默认 5m（省略字段）。
- Responses：`api.openai.com` + `gpt-5.x / gpt-4.1 / o3-o4` 才发 `prompt_cache_retention: "24h"`；
  `prompt_cache_key` 同时镜像到 `x-session-id` 头，防代理串缓存。
- 观测：`usage` 事件与右侧「会话信息」现在同时显示缓存读取 / 写入 / 命中率。

## 5. 供应商 fallback 链

- 链 = 当前 provider + 其余 `enabled` provider（设置顺序），最多 2 跳；`provider.fallbackIds` 可显式指定顺序。
- **会切**：`ProviderTimeoutError`、408 / 429 / 500 / 502 / 503 / 504 / 529。
- **不切**：用户中止、401 / 403、400 / 422、404、上下文溢出（走既有压缩降级）。
- 切换时：`usageAnchor = null`、记录增量链清空、`escalation = 0`、native 压缩重放判定按新端点重算、预热压缩取消，
  并广播 `provider_switched { from, to, reason }`（桌面端在时间线留一条轻提示）。
- 每跳只发一次请求（`fetchWithRetry` 内部已有退避，不叠加）。

## 相关配置字段（`ProviderConfig`）

```ts
thinkingBudget?: number;                 // 显式思考预算
cacheTtl?: "5m" | "1h";                  // 前缀缓存 TTL
fallbackIds?: string[];                  // 故障转移链（留空 = 自动链）
reasoningSummary?: "none" | "auto" | "concise" | "detailed";  // Responses 思考摘要
inputModalities?: ("text" | "image" | "pdf")[];               // pdf 才能吃文档块
```

设置页「模型」表单已提供思考预算、缓存 TTL、思考摘要与 PDF 输入模态的编辑项。
