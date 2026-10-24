# 编辑能力对比：MeowCode vs codex / opencode / ZCode / deepseek-harness

> 视角：**编辑效率与 Token 消耗**。不讨论功能有无本身，只讨论「同一件事要烧多少 token、几次往返」。
> 调研对象：`src/agent/`（MeowCode 自身）、`codex-main/`、`opencode-2/`、`ZCode-main/`、`deepseek-harness-master/`。
> 所有现状断言均带 `文件:行号`。

---

## 1. 结论摘要

1. **MeowCode 的编辑功能在"正确性"上不弱，在"效率"上偏弱。** 编码/BOM/CRLF/路径逃逸/唯一性校验做得比多数开源项目细（`src/agent/edit-content.ts:19-159`、`src/agent/paths.ts:42-51`），但只有 **1 级匹配**，且失败后给模型的信息几乎为零。
2. **最大的 token 浪费不在字符，在往返次数。** 一次编辑失败 = 多一次请求 = 把当前全部上下文（system + 工具 schema + 历史）重发一遍。按 15k 上下文估算，**一次失败 ≈ 15,000 输入 token**，比任何输出格式优化贵一个数量级。所以优先级应该由"减少失败/减少往返"决定。
3. **最该补的三件事**：① 匹配 fallback 链（尤其**行号前缀剥离**，因为 `read_file` 自己给每行加了 `N: ` 前缀）；② 失败时给可行动的候选片段；③ `multi_edit` + `replaceAll` 把多次往返压成一次。
4. **最容易被忽略的一处**：编辑成功后只回 `Edited X`（`src/agent/tools.ts:553`），模型没有回执就倾向于再 `read_file` 验证一遍——400 行 ≈ 4k token + 一次完整往返。codex / ZCode 都显式告诉模型「编辑后不要重读」。
5. **不需要抄 codex 的补丁协议。** 自定义 freeform 语法（`apply-patch.lark`）对模型适配和本地解析都是净负担；用 JSON 的 `multi_edit` 能拿到 80% 的收益。

---

## 2. Token 成本模型

先立公式，后面所有优先级都从它推出来：

```
总 token ≈ Σ(每次请求的输入)  +  Σ(模型输出)
        ≈ 往返次数 × (system + 工具 schema + 历史长度)  +  编辑载荷
```

三个乘数里：

| 乘数 | MeowCode 现状 | 说明 |
|---|---|---|
| **往返次数** | 无批量编辑能力 → 多文件改动 = N 次往返 | 权重最高 |
| **上下文长度** | 旧工具输出不淘汰（`src/agent/context.ts:152-207` 按整单元丢弃） | 越到后面每次往返越贵 |
| **编辑载荷** | `edit_file` 要求 oldString 完整回显 | 30 行改动 ≈ 输出 60 行 |

**估算前提（全文统一）**：会话中期上下文 15k token；代码约 4 char/token；工具 schema + system ≈ 3.5k token（`src/agent/runtime.ts:43-50` 的 BASE_SYSTEM_PROMPT 加上 `toolDefinitions`，其中 `task` 单个描述就接近 1k token）。

据此，一个"改了 5 个文件"的重构任务：

| 做法 | 往返 | 输入 token 量级 |
|---|---|---|
| 现状（5 次 `edit_file` + 5 次审批 + 可能 2 次失败重试） | 12 | ~180k |
| 有 `multi_edit`（2 次调用）+ fallback 兜底（0 失败） | 4 | ~60k |

**差距 3 倍**，全部来自往返次数。

---

## 3. 差异矩阵

> 下表是**改动前**的基线。改动后的新矩阵见[第 9 节](#9-改动后复核新差异矩阵2026-10-17-实施)。

✅ 有且好用 / ⚠️ 有但弱或只覆盖部分 / ❌ 没有 / — 不适用

| 维度 | MeowCode | codex | opencode | ZCode | deepseek-harness |
|---|---|---|---|---|---|
| 单次调用改多处 | ❌ | ✅ 多 hunk + 多文件 | ⚠️ 单处，但支持 `replaceAll` | ❌ | ❌ |
| 匹配容错层级 | ❌ 1 级（仅 CRLF） | ✅ 4 级 | ✅ 3 级 | ✅ 8 级 | ❌ 1 级 |
| 剥离 `行号: ` 前缀 | ❌ | — | — | ✅ | — |
| 唯一性冲突处理 | ❌ 直接报错 | ⚠️ 靠补丁上下文规避 | ✅ `replaceAll` | ✅ 报错 + 多级回退 | ⚠️ 报错并列出所有命中行号 |
| 错误信息可行动性 | ❌ 一句话 | ⚠️ 带缺失的上下文串 | ⚠️ 带路径 + 匹配说明 | ✅ 含匹配策略与位置 | ✅ 列出命中行号 |
| 编辑后回执 | ❌ `Edited X` | ✅ diff + 文件清单 | ⚠️ 纯文本 | ✅ patch + 状态回写 | ✅ hunk diff 写入 meta |
| read-before-edit 校验 | ❌ | ❌（靠补丁自带上下文） | ❌ | ✅ mtime/size/revision | ✅ version CAS |
| 编辑后是否需重读 | ⚠️ 需（无状态无提示） | ❌ 不需要（提示词禁止） | ❌ 不需要 | ❌ 不需要（状态已回写） | ❌ 不需要 |
| 格式化后处理 | ❌ | ❌ | ✅ prettier/biome/ruff 等 | ❌ | ❌ |
| 撤销 / 回滚 | ❌ | ❌ | ✅ git 树快照 | ✅ checkpoint + rewind | ❌ |
| 审批粒度 | ⚠️ 全局 3 档 | ✅ 按可写根自动批准 | ✅ 规则 + "always" 落盘 | ✅ 6 种模式 | ✅ sandbox × approval 正交 |

---

## 4. 逐项差异与改法

### P0-1 匹配只有 1 级，且没有剥离行号前缀

**现状**：`src/agent/edit-content.ts:40-66` 的 `locateAll` 先做 `indexOf` 精确匹配，失败后**只放宽换行处的 `\r`**。L47 的注释写得很明确：「只放宽换行，不做模糊匹配：空格和缩进仍然必须精确」。

**对手**：
- codex `apply-patch/src/seek_sequence.rs:12-111` 四级：精确 → 忽略行尾空白 → 两端 trim → Unicode 标点归一（弯引号、长破折号、NBSP）。
- opencode `packages/core/src/tool/plugin/edit.ts:160-175` 三级：精确 → Unicode 归一 → 逐行 `trimEnd`。
- ZCode `core/src/tool/edit-matchers.ts:41-69` 八级，其中 `line_number_prefix_stripped` 和 `indentation_flexible` 是关键。

**为什么这条对 MeowCode 特别重要**：`src/agent/tools.ts:495` 的读文件输出是 `` `${index + 1}: ${lines[index]}` ``，**每行都带行号前缀**。模型抄 oldString 时经常连 `123: ` 一起抄进去，于是必然 `not-found`。ZCode 专门为这个坑写了一级匹配，MeowCode 现在完全没有防御。

**影响**：这是失败率的最大来源。假设 10 次编辑有 2~3 次因空白/行号/引号差异失败，每次失败 ≈ 15k 输入 token + 模型重试时的输出，**每 10 次编辑白烧 30k~45k token**。

**改法**（只改 `edit-content.ts`，约 +120 行）：

```
level 0  exact                       ← 现有
level 1  line-ending flex            ← 现有
level 2  stripLineNumberPrefix       ← 新增（\d+:\s 逐行剥离后再比）
level 3  rstrip (忽略行尾空白)        ← 新增
level 4  trim (两端 trim 后逐行比)    ← 新增
level 5  unicodeNormalize            ← 新增（弯引号→直引号、NBSP→空格、长破折号→-）
level 6  indentFlexible              ← 新增（按相对缩进偏移对齐，不改内容）
```

约束：
- 每一级命中后**必须用命中位置回原文切片替换**，不能拿归一化后的文本写回，否则会把弯引号"修正"成直引号，制造额外 diff。
- 命中 level ≥ 2 时，把"用了哪一级"记进结果，供 P0-2 的错误/回执文案使用。
- **不做** ZCode 的 `block_anchor`（Levenshtein ≥0.8）。它会静默改错位置，收益不抵风险，理由见第 6 节。

---

### P0-2 失败信息不可行动，模型只能盲试

**现状**：`src/agent/tools.ts:543-551` 只有两句：
```
oldString was not found in ${name}.
oldString is not unique in ${name}; include more surrounding lines.
```
没有行号、没有近似候选、没有"你可能抄了行号前缀"的提示。

**对手**：codex `file_update.rs:80-83` 回 `Failed to find context '{ctx}' in {path}`，把缺失的上下文串原样带回；deepseek `tool-str-replace-editor/src/index.ts:297-311` 在歧义时**列出所有命中行号**，模型据此直接补上下文即可一次成功。

**影响**：同样是"一次失败 = 一次 15k 往返"。有候选时模型通常 1 次修好；没有候选时常见 2~3 次盲试，成本翻 2~3 倍。

**改法**（`tools.ts` 错误分支，约 +60 行）：

1. **not-found** 时给「最像的三段」：
   - 取 oldString 首行，在文件里做 trim 后模糊搜索，返回前 3 个候选的行号 + 该行原文；
   - 若首行匹配到的是 `\d+: ` 开头的内容，直接加一句：`Hint: the matched text starts with a line-number prefix; retry without it.`；
   - 若文件行数 < 50，直接附上全文（比让模型再 read 一次便宜）。
2. **not-unique** 时列出全部命中行号（不止前两处，`locateAll` 现在 L45 就 `return hits` 截断了，需要单独开一个 `locateAllPositions`）。
3. 错误信息里带 `path:line`，方便模型与用户对齐。

---

### P0-3 没有批量编辑，多文件改动被拆成 N 次往返

**现状**：`src/agent/tools.ts:259-292` 只有 `write_file` 和 `edit_file`，两者都是**单文件单处**。`multi_edit`、`apply_patch`、`replaceAll` 全仓不存在。

**对手**：
- codex `apply-patch` 一次调用可跨多文件、多 hunk，还支持 `*** Move to:` 和 `*** Delete File:`；
- opencode `edit.ts:24-34` 有 `replaceAll`（重命名场景一次搞定），并且对 gpt 系模型会自动隐藏 edit/write 只留 patch（`patch.ts:296-309`）；
- ZCode / deepseek 都没有批量编辑 —— 说明这不是必需品，但对"多文件重构"这种高频场景，缺它就是每次多 15k。

**影响**：
| 场景 | 现状往返 | 补齐后 |
|---|---|---|
| 同一文件改 5 处 | 5 次 `edit_file` | 1 次 `multi_edit` |
| 重命名一个符号（12 处） | 12 次，或 1 次 `write_file` 全文件重写 | 1 次 `replaceAll` |
| 改 3 个文件各 1 处 | 3 次 | 1 次 `multi_edit`（允许跨文件） |

**改法**（新增工具，约 +150 行）：
1. `multi_edit`：参数 `{ path, edits: [{ oldString, newString, replaceAll? }] }`。
   - **顺序应用**，每条都用完整 fallback 链；
   - **全有或全无**：任一条失败则整次不落盘，并在错误里指明是第几条、失败原因、候选片段；
   - 回执给一条汇总 diff（复用 `src/agent/diff.ts:125` 的 `renderDiff`）。
2. `edit_file` 增加可选 `replaceAll: boolean`（对齐 opencode）。唯一性冲突时，错误文案直接建议「若确实要全改，传 replaceAll: true」。
3. 不做 `apply_patch` 的自由格式语法。若将来要跨文件补丁，用 `{ edits: [{ path, oldString, newString }] }` 的 JSON 数组即可，模型输出成本比 `*** Begin Patch` 低且不用写解析器。

---

### P0-4 编辑成功只回一句 `Edited X`，诱导模型重复读文件

**现状**：`src/agent/tools.ts:553` 返回 `Edited ${name}`。`src/agent/runtime.ts:2257-2277` 虽然算了 diff，但只写进会话 JSONL 给「审阅」页签用（`src/agent/session-store.ts:473`），**不进模型上下文**。

**对手**：
- codex 成功回执是 `Success. Updated the following files:` + A/M/D 清单（`apply-patch/src/lib.rs:826-841`），并在提示词里明确「编辑后不要重读」（`protocol/src/prompts/base_instructions/default.md:132,143`）；
- ZCode `edit.ts:572-593` 编辑后回写 read-state，模型侧文案直接说不需要再 Read。

**影响**：模型在"没看到结果"时倾向 `read_file` 复核。一次 400 行读 = ~4k token 输出 + 一次 15k 往返。假设 30% 的编辑会触发复核，**每次编辑平均多花 5k~6k token**。

**改法**：
1. `edit_file` / `multi_edit` 的返回改为**改动片段回执**（≤15 行）：
   ```
   Edited src/agent/tools.ts (3 replacements)
   @@ -541,7 +541,9 @@
     const read = await readTextFile(file);
   - if (!read.ok) return textFileProblem(name, read);
   + if (!read.ok) return textFileProblem(name, read, { hint: "edit" });
   ...
   File is up to date; no need to re-read.
   ```
2. 在 `src/agent/runtime.ts:44` 的 BASE_SYSTEM_PROMPT 里加一条：`After a successful edit the tool result already shows the changed lines; do not re-read the file to verify.`
3. 回执必须**明确写"文件已是最新"**——这句话是让模型停止复核的关键。

---

### P1-1 没有 read-state，陈旧编辑靠失败来发现

**现状**：无任何已读记录、无 mtime/size/revision 校验。`src/agent/runtime.ts:44` 只有一句软约束 `Prefer reading files before changing them`。

**对手**：
- ZCode `edit.ts:421-468`：无 read 记录 → `FILE_NOT_READ`；mtime 前进或 size 变化 → stale；唯一豁免是"严格全文读 + 字节相同"；
- deepseek `fs-observation-policy/src/index.ts:78-88`：未观测 → `FS_NOT_OBSERVED`，已观测则给 version 做 CAS。

**影响**：用户或 `run_command`（格式化、代码生成）在中间改了文件，模型的编辑会打在旧内容上——要么失败重试（一次 15k），要么**改错位置但成功**（更贵：返工 + 用户信任损失）。

**改法**（约 +80 行）：
1. 新增 `src/agent/read-state.ts`：`Map<absPath, { mtimeMs, size, digest }>`，`read_file` 成功后登记，`edit_file` / `write_file` 成功后更新。
2. `edit_file` 入口校验：未读 → 允许但记录（**不要**像 ZCode 那样硬拒，MeowCode 是小工具链，硬拒会多一次往返）；已读但 mtime/size 变了 → 在回执里加一行 `Note: the file changed on disk since your last read; the edit applied to the current content.`
3. **不要**上 version CAS。那是为并发 agent 设计的，MeowCode 单会话单写者，收益不抵复杂度。

---

### P1-2 历史里的旧工具输出不淘汰

**现状**：`src/agent/context.ts:152-207` 的 `trimMessages` 按「assistant(tool_calls) + 其 tool 结果」为不可拆单元，从旧到新整块丢弃。**没有**"保留结构、清空内容"的中间档。

**问题**：一次 400 行 `read_file` 的 4k token 会一直躺在上下文里，直到整个单元被丢弃——而丢弃时连"读过这个文件"这个事实也一起没了。

**对手**：Claude Code / opencode 系普遍先做 tool-result 淘汰（把旧结果替换成 `[old tool result cleared]` 占位），再考虑丢消息。

**改法**（`context.ts`，约 +50 行）：
- 在 `trimMessages` 丢弃单元之前插入一轮"压缩"：
  - 超过 N 轮（建议 6）的 `tool` 消息，若其内容 > 2000 字符，替换为 `[${name} output elided: ${原字符数} chars]`；
  - `read_file` 的结果永远可以被淘汰（模型需要时能重读）；
  - **`edit_file` / `write_file` 的结果不要淘汰**——它们是"我改过什么"的唯一记录。
- 收益：长会话每轮省 2k~5k token，且能让更多近期轮次留在窗口内。

---

### P1-3 `read_file` 的行号前缀是固定开销

**现状**：`src/agent/tools.ts:495` 每行 `` `${index + 1}: ${line}` ``。400 行文件 → 约 1.9k 字符纯前缀（1~9 行 3 字符、10~99 行 4 字符、100+ 行 5 字符），≈ 500~800 token。

**取舍**：行号对"让模型引用位置"有价值（错误信息、patch 定位都靠它），**不建议直接去掉**。但可以：

1. 加可选 `noLineNumbers: true`，用于「整文件通读理解」场景（模型不需要引用行号时）；
2. 默认行为改为：**只在前 200 行加行号**，之后用 `... (line numbers omitted)` 提示——超过 200 行后模型极少逐行引用；
3. 单次上限从 400 行降到 300 行（`tools.ts:22`）。配合 P1-1 的 read-state，模型可以精确读区间，不需要一次读 400 行。

收益较小（每次读省 300~500 token），但改动只有几行，顺手做。

---

### P1-4 `write_file` 整文件重写 vs 补丁

**现状**：`write_file` 要求模型输出完整文件内容（`tools.ts:268`），并对已存在文件沿用行尾/BOM 后整文件落盘（`edit-content.ts:156-159`）。

**成本对比**（500 行文件改 10 行，平均 40 字符/行）：

| 方式 | 模型输出 | 历史增量 |
|---|---|---|
| `write_file` | 20,000 字符 ≈ 5,000 token | +5,000 |
| `edit_file`（3 行上下文） | 约 700 字符 ≈ 200 token | +200 |
| `multi_edit`（10 处） | 约 2,000 字符 ≈ 600 token | +600 |

**改法**：
1. 工具描述里明确写「**优先 `edit_file`，只有新建文件或整体重写超过 60% 时才用 `write_file`**」——现在的描述（`tools.ts:262-263`）只说"创建或覆盖"，没有引导。
2. 在 `write_file` 里加一条软保护：若目标文件已存在且新内容与旧内容的行级差异 < 30%，返回错误并提示改用 `edit_file`（复用 `diff.ts:37` 的 `diffLines` 统计）。这条能挡住模型"偷懒整文件重写"的常见行为。

---

### P2 与对手无关、但会制造返工的自身缺陷

这两条不是 token 问题，但一次事故的代价远超所有优化收益，顺带记录：

1. **非原子写**：`tools.ts:527` 和 `tools.ts:552` 直接 `fs.writeFile`。写一半崩进程 = 文件被截断。改法：写 `file.tmp` → `fs.rename`（Windows 上 rename 到已存在文件需要 `fs.rm` 后 rename 或 `fs.copyFile`，注意处理）。
2. **审批预览与执行之间的竞态**：`runtime.ts:2155` 在弹审批前算 diff，`runtime.ts:2253` 才真正执行，中间用户可能改了文件。用户批准的是 A 内容，落盘的是 B 内容。改法：执行前重新读一次并比对 `mtime`，不一致则重新弹审批。

---

## 5. 收益估算与改动面

按"每 10 次编辑任务"折算（前提：上下文 15k、4 char/token、当前失败率约 25%）。

| 项 | 预计节省 | 依赖 | 改动面 |
|---|---|---|---|
| P0-1 fallback 链 | **30k~45k** | 无 | `edit-content.ts` +120 行，`edit-content.test.ts` +80 行 |
| P0-2 可行动错误 | **15k~30k**（失败时从 3 次盲试降到 1 次） | 依赖 P0-1 的层级信息 | `tools.ts` +60 行 |
| P0-3 multi_edit / replaceAll | **40k~60k**（往返 12 → 4） | 依赖 P0-1 | `tools.ts` +150 行，`runtime.ts` 审批白名单 +5 行 |
| P0-4 编辑回执 | **15k~25k**（消除 30% 的复核读） | 无 | `tools.ts` +40 行，`runtime.ts:44` 提示词 +1 行 |
| P1-1 read-state | **10k~20k**（减少陈旧失败） | 无 | 新文件 `read-state.ts` +80 行 |
| P1-2 工具输出淘汰 | 长会话每轮 **2k~5k** | 无 | `context.ts` +50 行 |
| P1-3 行号优化 | 每次读 **300~500** | 无 | `tools.ts` 3 处 |
| P1-4 write 引导 | **10k~20k**（避免整文件重写） | 无 | `tools.ts` +30 行 |

**合计量级：每 10 次编辑任务省 120k~200k token**，约相当于现状消耗的一半。

---

## 6. 不建议照抄的部分

| 项目 | 做法 | 为什么不适合 MeowCode |
|---|---|---|
| codex | Lark 定义的 freeform 补丁语法（`apply_patch.lark`） | 需要模型侧强适配 + 自写解析器（`parser.rs` 近千行）。JSON 的 `multi_edit` 能拿到 80% 收益，成本 1/5。 |
| ZCode | `block_anchor` 相似度匹配（Levenshtein ≥ 0.8） | 相似度匹配会**静默改错位置**。对本地 IDE 产品，一次改错文件的代价远大于省下的几次重试。 |
| deepseek | 纯字面量匹配 + version CAS | 对弱模型太苛刻，会把失败率推到 40%+。CAS 是并发场景的设计，单会话单写者用不上。 |
| opencode | 编辑后自动跑 formatter | 依赖 formatter 子进程 + 项目配置探测（`formatter/builtins.ts` 一整套）。属于体验优化，不是 token 优化，且会引入"模型改 A、formatter 改 B"的 diff 噪音。 |

---

## 7. 落地顺序

**批次 1 — 纯后端、零 UI 改动、风险最低**（先做，收益最大）
1. `edit-content.ts`：fallback 链（level 2~6）
2. `tools.ts`：可行动错误（候选片段 + 行号 + 行号前缀提示）
3. `tools.ts`：`edit_file` 回执改成片段 diff + "文件已是最新"
4. `tools.ts`：`replaceAll` 参数
5. `runtime.ts:44`：加"编辑后不要重读"提示

批次 1 完成后就能拿到约 60% 的收益，且**不改变任何 UI 行为**。

**批次 2 — 需要碰运行时和上下文**
6. `multi_edit` 工具（含全有或全无语义）
7. `read-state.ts` + 陈旧提示
8. `context.ts` 工具输出淘汰

**批次 3 — 结构性改动**
9. 原子写 + 审批竞态修复
10. checkpoint / undo（这是"用户可控性"方向的活，不是 token 优化，单独排期）

---

## 8. 怎么验证省了多少

MeowCode 已经有 token 计量（`src/agent/context.ts:9` 的 `estimateTokens`、`types.ts` 的 `TokenUsage`）。建议在会话 JSONL 里加一条轻量统计，跑同一批任务对比：

| 指标 | 怎么取 |
|---|---|
| 编辑失败率 | `tool_finished` 事件里 `name in (edit_file, multi_edit) && ok === false` 占比 |
| 平均往返数 | 每个用户请求对应的 assistant 消息数 |
| 单次编辑 token | 相邻两次 `usage` 的差值 |
| 复核读占比 | `read_file` 的目标路径在最近 3 轮内被编辑过的比例 |

目标是：失败率从 ~25% 降到 <8%，平均往返数降 40%，单次编辑 token 降 50%。

---

## 附录：关键代码位置速查

| 内容 | 位置 |
|---|---|
| 工具定义 | `src/agent/tools.ts:187-380` |
| 编辑实现 | `src/agent/tools.ts:531-554` |
| 匹配器 | `src/agent/edit-content.ts:40-82` |
| diff 生成 | `src/agent/diff.ts:37-137` |
| 审批流程 | `src/agent/runtime.ts:2132-2214` |
| 变更捕获 | `src/agent/runtime.ts:2247-2277` |
| 上下文裁剪 | `src/agent/context.ts:152-207` |
| 系统提示词 | `src/agent/runtime.ts:43-50` |
| 审阅 UI | `desktop/src/components/panel/ReviewTab.tsx:73-131` |
| 审批 UI | `desktop/src/components/ApprovalDialog.tsx:54-57` |
| 代码展示 | `desktop/src/components/ui/CodeBlock.tsx:3-10`（裸 `<pre>`，无高亮） |

---

## 9. 改动后复核：新差异矩阵（2026-10-17 实施）

第 7 节的批次 1、批次 2 与 P2 的两条工程缺陷已落地，**只改后端 + 一处 UI 文案，未动架构**。测试 327 通过（原 317 + 新增 10）。

### 9.1 已落地清单

| # | 改动 | 落点 | 对应原计划 |
|---|---|---|---|
| 1 | 6 级匹配链（exact → line-ending → line-number-prefix → rstrip → trim → unicode） | `src/agent/edit-content.ts` | P0-1 |
| 2 | 行号前缀剥离（含单行 needle 的正则式 Unicode 容错） | 同上 | P0-1 |
| 3 | `replaceAll` 参数 | `src/agent/tools.ts` | P0-3 |
| 4 | `multi_edit` 工具（单文件多 hunk，全有或全无） | `src/agent/tools.ts` | P0-3 |
| 5 | 可行动错误：最近似 3 行 + 行号、小文件（≤80 行）直接附全文、歧义列出全部命中行号 | 同上 | P0-2 |
| 6 | 编辑回执：片段 diff + `File is up to date; no need to re-read.` | `tools.ts` + `diff.ts:renderChangeSnippet` | P0-4 |
| 7 | read-state（mtime/size），陈旧时在回执里提示一句 | `src/agent/read-state.ts`（新增） | P1-1 |
| 8 | 旧工具输出淘汰（6 轮后清内容保结构，edit/write 结果永不淘汰） | `src/agent/context.ts` | P1-2 |
| 9 | 原子写（tmp + rename，rename 失败回退直接写） | `src/agent/tools.ts` | P2-1 |
| 10 | 整文件重写护栏（改动 <35% 且 ≥40 行时拒绝，`force: true` 可越过） | 同上 | P1-4 |
| 11 | 提示词引导：优先 edit_file/multi_edit、编辑后不要重读 | `src/agent/runtime.ts:44` | P0-4 |
| 12 | `multi_edit` 纳入审批与只读拦截、审阅记录 | `runtime.ts:114,168,2248` | P0-3 |
| 13 | UI：工具行显示「批量修改 · N 处」 | `desktop/src/components/ToolRow.tsx` | — |

### 9.2 新差异矩阵

✅ 有且好用 / ⚠️ 有但弱或只覆盖部分 / ❌ 没有 / — 不适用

| 维度 | MeowCode（改后） | codex | opencode | ZCode | deepseek-harness |
|---|---|---|---|---|---|
| 单次调用改多处 | ✅ `multi_edit` 多 hunk + `replaceAll`（跨文件仍需多次） | ✅ 多文件 | ⚠️ 单处 + `replaceAll` | ❌ | ❌ |
| 匹配容错层级 | ✅ **6 级** | ✅ 4 级 | ✅ 3 级 | ✅ 8 级 | ❌ 1 级 |
| 剥离 `行号: ` 前缀 | ✅ 单行/多行都覆盖 | — | — | ✅ | — |
| 唯一性冲突处理 | ✅ 报错 + 全部命中行号 + `replaceAll` 建议 | ⚠️ 靠上下文规避 | ✅ `replaceAll` | ✅ | ⚠️ 列行号 |
| 错误信息可行动性 | ✅ 最近似行 + 行号 + 小文件全文 + 行号前缀提示 | ⚠️ | ⚠️ | ✅ | ✅ |
| 编辑后回执 | ✅ 片段 diff + 「无需重读」 | ✅ | ⚠️ 纯文本 | ✅ | ✅ |
| read-before-edit 校验 | ⚠️ 只提示不拦截（mtime/size 比对） | ❌ | ❌ | ✅ 硬拦截 | ✅ version CAS |
| 编辑后是否需重读 | ✅ 不需要 | ✅ | ✅ | ✅ | ✅ |
| 整文件重写护栏 | ✅ 改动 <35% 直接拒绝并引导 | ❌ | ❌ | ❌ | ❌ |
| 旧工具输出淘汰 | ✅ 6 轮后清内容、保结构 | — | ⚠️ | — | — |
| 原子写 | ✅ tmp + rename | — | — | — | — |
| 格式化后处理 | ❌ | ❌ | ✅ | ❌ | ❌ |
| 撤销 / 回滚 | ❌ | ❌ | ✅ git 树快照 | ✅ checkpoint + rewind | ❌ |
| 审批粒度 | ✅ 4 档：只读 / 每次询问 / **工作区内自动** / 完全访问 | ✅ 按可写根自动 | ✅ 规则 + always | ✅ 6 模式 | ✅ 正交开关 |

**位置变化**：改动前 MeowCode 在这一组维度里 **0 项 ✅、2 项 ⚠️、12 项 ❌**；改动后 **11 项 ✅、1 项 ⚠️、2 项 ❌**。最明显的是「单次改多处」「匹配层级」「错误可行动性」「编辑后回执」「审批粒度」五栏从全表最弱变成中上，并且多出一项对手都没有的能力（整文件重写护栏）。剩下的 2 个 ❌ 是格式化和撤销——都不属于 token 优化。

### 9.3 仍然缺的（按剩余收益排序）

| 缺口 | 为什么还没做 | 收益量级 |
|---|---|---|
| **撤销 / checkpoint** | 属于「用户可控性」，需要快照存储 + rewind UI，不是 token 优化，应单独排期 | 不省 token，但决定用户敢不敢让它改 |
| **跨文件补丁** | `multi_edit` 已覆盖单文件多 hunk，跨文件场景频率低；真要做用 JSON 数组即可，不必抄 codex 的 `*** Begin Patch` | 多文件重构每次省 1 次往返 |
| **审批 → 执行的 mtime 复检** | 需要改审批状态机（重新弹窗），收益是"防一次改错" | 低频但事故代价高 |
| **`read_file` 行号可选关闭** | 每次读省 300~500 token，改动只有 3 行，但收益最小 | 小 |
| **formatter / LSP 诊断** | 属于体验层，会引入"模型改 A、formatter 改 B"的 diff 噪音 | 不省 token |

### 9.4 实测回执样例

模型把 `read_file` 的行号抄进了 `oldString`——改动前这一定失败，现在自动降级命中并说明原因：

```
Edited app.ts
Note: line-number prefix stripped.
--- a/app.ts
+++ b/app.ts
  export function greet(name: string) {
-   const greeting = "hello";
-   return `${greeting}, ${name}`;
+   const greeting = "hi";
+   return `${greeting}, ${name}!`;
  }
File is up to date; no need to re-read.
```

`multi_edit` 中途失败时整次放弃，并指明是第几条：

```
multi_edit aborted at edit #1 of 3; nothing was written. oldString is not unique.
Found 2 matches at L1, L2. Add surrounding lines to make it unique, or pass replaceAll: true to change every occurrence.
```

整文件重写护栏：

```
write_file refused: this rewrite only changes 5% of 60 lines. Use edit_file or multi_edit instead —
they cost a fraction of the tokens. If a full rewrite is really intended, call write_file again with force: true.
```

---

## 10. 审批粒度改造：codex 式「可写根自动」

### 10.1 为什么改

原先是三档、且只有两端：`default`（每次写/改/命令都弹窗）和 `full`（全放行，连命令一起）。中间没有档位，改 5 个文件就要点 5 次允许，用户嫌烦切 `full` 之后连 `run_command` 的保护也没了 —— 这是安全性问题，不只是体验问题。

### 10.2 新模型（4 档）

| 模式 | 写文件 / 改文件 | 工作区外路径 | run_command | 浏览器写操作 |
|---|---|---|---|---|
| `read-only` 只读 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| `ask` 每次询问 | 弹窗 | 直接拒绝（不进审批） | 弹窗 | 弹窗 |
| **`auto` 工作区内自动**（新默认） | **区内自动批准，区外直接拒绝** | 直接拒绝 | **仍然弹窗** | 弹窗 |
| `full` 完全访问 | 自动 | 自动 | 自动 | 自动 |

判定逻辑对齐 codex `core/src/safety.rs:67-125`：

```ts
// 只有写类工具参与；命令没有沙箱兜底，永远需要人确认
WRITABLE_ROOT_TOOLS.has(tool)
  && (await isWithinWritableRoots(session.cwd, input))
```

`isWithinWritableRoots` 复用 `paths.ts:resolveWithinWorkspace`（含 `realpath` + 缺失段回溯），所以**工作区内指向外部的软链接 / junction 不会被误判为可写**。自动批准仍写一条 `approval` 记录留痕，`reason: "writable_root"`，可在会话 JSONL 里审计。

### 10.3 迁移

- 旧会话里存的 `"default"` 读出来归一为 `"ask"`（`normalizeApprovalMode`，在 `session-recovery.ts` 落点），不会因为升级而悄悄放宽已有会话的权限。
- 新建会话与侧边会话默认 `auto`；前端三处默认值、`/session/permissions` 校验文案同步更新。
- API 仍接受 `"default"`（等价 `"ask"`），旧客户端不会 400。

### 10.4 与 codex 的差距（有意保留）

| 点 | codex | MeowCode | 原因 |
|---|---|---|---|
| 可写根之外 | 弹审批，用户可放行 | 直接拒绝（除非 `full`） | 没有沙箱，放行后无法回收 |
| 命令 | 由 exec policy + 沙箱管 | 永远弹审批 | 同上 |
| 硬链接逃逸 | 靠外层沙箱兜底 | 检测不到 | 本地 IDE 场景风险低，接受 |

测试 332 通过（新增 5 项：默认 auto、区内自动批准、命令仍询问、区外不自动、旧值归一）。
