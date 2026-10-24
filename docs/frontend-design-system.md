# MeowCode 前端设计系统

> 深色优先的**黑白灰** Agent 工作台。灰阶一律中性（R=G=B），**唯一的彩色是「思考强度」滑杆的 Codex 蓝**，大圆角卡片，无边框窗口 + 自绘标题栏，气质仿 Codex / ZCode。
> 界面语言：**简体中文**。字体：**MiSans**。
> 代码位置：`desktop/src/`。

## 1. 技术栈与结构

Electron 44 + React 19 + Vite 8 + TypeScript。**已移除 Chakra UI / Emotion / framer-motion**，改为手写 CSS + CSS 自定义属性。打包 JS 由 632 KB 降至 321 KB。

```
desktop/src/
  main.tsx            入口，import theme/tokens.css + theme/base.css
  App.tsx             控制器：保留全部 state / 事件处理 / API 调用，只负责组合组件
  api.ts              api()、renderMarkdown()、全部类型（含 reasoningEffort）
  effort.ts           思考强度档位：EFFORT_LEVELS / effortIndex / effortLabel / effortFromIndex
  util.ts             baseName() 等小工具
  assets/
    icon.png             应用图标（打包 / 任务栏用）
    wordmark.png         「MeowCode 文字白」字标，已裁掉透明留白（2217×377，带透明通道）
    fonts/MiSansVF.ttf   MiSans 可变字重（100–900），随包分发
  theme/
    tokens.css        设计令牌（唯一颜色来源）+ @font-face
    base.css          reset、排版、滚动条、焦点环、工具类、markdown
  components/
    AppShell          窗口外壳：标题栏 + 左侧导航栏 + 面板区
    TitleBar          自绘标题栏（拖拽区 + 字标 + 最小化/最大化/关闭）
    Rail              左侧导航栏：**只有图标**（主页 / 设置），与标题栏连成一体
    ConversationPanel 对话列表：新聊天 + 工作区（置顶）+ 按项目分组的会话
    ChatHeader        标题 + token 用量 + 停止 + 右侧栏开关 + 错误条
    MessageList       滚动容器 + 空态 + 吸底 + 时间线分组
    UserBubble        右对齐用户气泡
    AssistantMessage  无气泡正文 + 流式光标
    ToolCard          可折叠工具卡
    ChainOfThought    连续工具调用的折叠时间线
    Composer          输入区：上下文 chip + 加号/权限 + 模型 chip + 圆形发送
    ModelPopover      模型与思考强度弹层（强度滑杆 + 重置）
    Inspector         右侧信息栏（可由 ChatHeader 的按钮收起）
    ApprovalDialog / SettingsDialog
    ui/               Dialog / Button / IconButton / TextField / Badge / Spinner / StatusDot / ToolIcon / Markdown
```

## 2. 窗口外壳（无边框 + ZCode 同款标题栏）

`main.cjs` 用 **`frame: false`** 禁用原生标题栏，窗口操作全部由渲染层自绘：

```js
new BrowserWindow({
  frame: false,
  backgroundColor: "#0b0d0f",   // == --bg-root，消除启动闪白
  // …
});
```

- **标题栏**：`TitleBar` 组件，48px 高，整条 `-webkit-app-region: drag`；左侧是「MeowCode 文字白」字标（`assets/wordmark.png`，18px 高），右侧三个按钮（最小化 / 最大化·还原 / 关闭）为 `no-drag`。
- **窗口控制 IPC**：`meow:window-minimize` / `meow:window-toggle-maximize` / `meow:window-close` / `meow:window-state`；最大化状态通过 `meow:window-state` 事件推给渲染层以切换图标。
- **窗口按钮**：最小化 / 最大化·还原 / 关闭，每个 **48×48（1:1）圆角矩形**（`border-radius: 10px` + superellipse），撑满标题栏高度并**贴死窗口右上角**（`.mc-titlebar` 的 `padding-right: 0`），所以鼠标甩到右上角就一定能点到关闭；hover 用 `--surface-hover`，关闭按钮 hover 用 Windows 原生的 `--win-close-hover: #c42b1c` + 白图标。
- **启动页也保留标题栏**，否则无边框窗口在启动阶段无法拖动。
- 双击标题栏最大化由 Electron 对 drag 区域原生处理。
- 标题栏与左侧按钮栏共用 `--bg-chrome`，二者连成一体（见下一节）。

## 3. 面板框架（标题栏 + 左栏一体，无分界线）

不再用 1px 分割线切分面板。窗口底色 `--bg-chrome` 从面板之间的 8px 间隙透出，每个面板自己是圆角卡片。

```
.mc-root    background: var(--bg-chrome)
  .mc-titlebar                       48px 拖拽条（字标在左，窗口按钮在右）
  .mc-body    padding: 0 8px 8px 0; gap: 8px      ← 左边缘不留白
    .mc-rail            width 64px，无背景 → 透出 --bg-chrome
    .mc-columns  gap: 8px
      .mc-panel--conversations  width 268px, bg --bg-panel
      .mc-panel--content        flex:1,      bg --bg
      .mc-panel--inspector      width 320px, bg --bg-panel（可收起）
```

**关键点**：`.mc-body` 左侧不留白、`.mc-rail` 不带自己的背景，所以**顶部标题栏与左侧导航栏共用同一块 `--bg-chrome`，在视觉上连成一体**（左上角是一整块 L 形）。标题栏字标的左缘与导航按钮的左缘都对齐到 12px。

**左侧导航栏只有图标，没有文字**：依次为「主页」`LuHouse` 与「设置」`LuSettings`。按钮 42×42、圆角 15px（`corner-shape: superellipse(1.5)`）——圆润的方圆形；默认透明，hover 用 `--surface`，当前项用 `--surface-hover`。

**对话列表**（`ConversationPanel`）自上而下：

1. 「新聊天」按钮（`--surface` 底）
2. 工作区行 —— 原来在面板底部的文件夹路径**已移到顶部**，点击即可切换工作区；只显示目录名，完整路径在 `title` 里
3. 「项目」分组：按 `session.cwd` 分组，组名是目录名，组内是会话（只显示时间，**不带图标**）

图标能少就少：整个对话列表只有「新聊天」和「工作区」两个图标。

**右侧检查器**由 `ChatHeader` 最右侧的按钮控制（`App` 里的 `showInspector` 状态）。收起后对话区自动占满剩余宽度。

所有面板 `border-radius: var(--radius-xl)` + `corner-shape: superellipse(1.5)`。**面板之间没有 border**；`border-right` / `border-bottom` / `border-left` 已全部移除。卡片与输入框内部仍保留细边框（那是控件描边，不是面板分割线）。

## 4. 配色：纯中性黑

**所有灰阶都是 R=G=B 的中性色**，不带任何冷色（蓝）偏移 —— 这是「不偏蓝」的关键。之前用的 `#121417` / `#0b0d0f` / `#16181b` / `#f4f5f6` 蓝通道都最高，所以整体发蓝，现已全部改掉。

> 例外：`--accent` 系列（Codex 蓝 `#0c77ff` + 紫罗兰渐变）是**刻意引入的唯一彩色**，只允许用在「思考强度」滑杆上。除此之外任何地方都不许出现彩色灰。

| 令牌 | 深色值 | 说明 |
| --- | --- | --- |
| `--bg-chrome` | `#0a0a0a` | 标题栏 + 左侧按钮栏（一体） |
| `--bg-root` | `#0a0a0a` | 窗口底色（== `main.cjs` 的 `backgroundColor`） |
| `--bg` | `#0d0d0d` | 对话内容面板（最黑的主画布） |
| `--bg-panel` | `#131313` | 对话列表 / 检查器面板 |
| `--bg-elevated` | `#1e1e1e` | 弹窗 / 浮层 |

自检脚本（应只剩绿/红两个状态色）：

```bash
# 扫描所有 CSS，列出蓝通道高于红通道的十六进制色值
node -e '...'   # 见提交历史 / 或用任意脚本检查 B > R
```

**纪律**：新增任何颜色前先确认 `R === G === B`（中性灰）或属于 `--success` / `--danger` 两个状态色。

## 5. 字体

**MiSans**（小米兰亭 Pro 可变字重），随包分发，`@font-face` 先试 `local("MiSans")` 再回落到 `assets/fonts/MiSansVF.ttf`：

```css
--font-sans: "MiSans", "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "MiSans", monospace;
```

> 说明：`--font-mono` 保持等宽字体优先、MiSans 作为中文回退 —— 代码块、JSON、路径需要等宽对齐，用比例字体（MiSans 的拉丁字形是比例的）会错位。

## 6. 设计令牌（`theme/tokens.css`）

所有颜色只能来自令牌，组件里不写死色值。

| 令牌 | 深色值 | 说明 |
| --- | --- | --- |
| `--fg` | `#f5f5f5` | 主文字（中性近白） |
| `--fg-subtle` | `rgba(245 245 245 / .60)` | 次级文字 |
| `--fg-subtlest` | `rgba(245 245 245 / .34)` | 三级 / 占位符 / 禁用 |
| `--card` | `color-mix(in oklab, #fff 5%, var(--bg))` | 卡片底（Codex 公式） |
| `--surface` / `--surface-hover` | `rgba(255 255 255 / .05 / .10)` | 悬停 / 选中叠加 |
| `--user-fill` | `color-mix(in oklab, #fff 12%, var(--bg))` | 用户气泡底 |
| `--input-fill` | `color-mix(in oklab, #fff 6%, var(--bg))` | 输入框底 |
| `--border` / `--border-strong` | `rgba(255 255 255 / .10 / .16)` | 控件描边 |
| `--brand` | `#ffffff` | 品牌色 = 纯白（ZCode 做法） |
| `--success` | `#9ab894` | 低饱和灰绿，仅状态指示 |
| `--danger` | `#d98a86` | 低饱和灰红，仅状态指示 |
| `--ring` | `rgba(255 255 255 / .55)` | 焦点环（**白色，不是蓝色**） |

**圆角阶梯**：`xs 6 / sm 8 / md 10 / lg 12.5 / xl 16 / 2xl 20 / full 9999`。面板与卡片用 `xl`，输入框与弹窗用 `2xl`。

**超椭圆圆角**：面板 / 卡片 / 弹窗 / 作曲器上叠加 `corner-shape: superellipse(1.5)`（Codex 的 squircle 质感）。仅 Chromium 139+ 支持，Electron 44 满足；不支持的引擎自动退化为普通圆角，无需 polyfill。

**排版**：`--fs-base: 14px`，字重 `380 / 450 / 520`（对应 MiSans Medium / Demibold / Semibold，按实际字重轴从 Codex 430/500 体系下调）。

**阴影**：克制。面板无阴影（靠底色差异区分）；作曲器 `--shadow-md`；弹窗 `--shadow-lg`。

## 7. 输入区（Composer）

```
        ┌ 📁 meow-demo ┐                        ← 上下文 chip：左右内缩、下沿被输入框盖住
┌─────────────────────────────────────────────┐
│  随心输入                                     │  ← textarea，自动增高
│                                             │
│  ＋  🛡 完全访问      deepseek-chat 高 ⌄   (↑) │
└─────────────────────────────────────────────┘
    左：加号 + 权限 chip              右：模型 chip + 圆形发送
```

- **上下文 chip**：`margin: 0 16px -12px` + `padding-bottom: 19px`，靠负边距把下半截塞进输入框底下，形成「贴在输入框顶部的标签」。
- **加号按钮**：菜单内容按需求**暂未实现**，只渲染按钮（`title` 提示）。
- **权限 chip**：展示当前审批模式（每次询问 / 完全访问）。完全访问会跳过工具审批并允许读写工作区外的整机路径；模式为会话级，切换会话回到「每次询问」。
- **模型 chip**：模型名 + 当前思考强度档位 + 下拉箭头，点击打开 `ModelPopover`。
- **发送按钮**：32px 正圆；启用时白底黑箭头，禁用时灰底，流式中变成停止方块。

### 思考强度（可调）

`ModelPopover` 的结构：中间档位名（居中）、右上重置按钮；下面居中是模型名；再下面是**刻度点滑杆**。

```
              最高                    ↺
           deepseek-chat
(━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●)       ← 36px 粗胶囊轨道 + 蓝色填充
 ·   ·   ·   ·   ·   ·   ·              ← 每个档位一个刻度点
```

- **档位按模型区分**（对齐 ZCode 的 `config/provider/zcode-builtin.json` → `modelRules[].optionSpecs.reasoningLevel.values`）。
  第一档固定是**「默认」**（不下发 `reasoning_effort`），后面跟该模型真实支持的档位：

  | 模型（正则） | 档位 |
  | --- | --- |
  | `glm-5.3` / `glm-5.2` | 低 / 高 / 最高 → `low` / `high` / `max` |
  | `kimi-k3` | 低 / 高 / 最高 → `low` / `high` / `max` |
  | `gpt-5.6` | 关闭 / 低 / 中 / 高 / 极高 / 最高 / 极致 → `none` … `ultra` |
  | `gpt-5.3-codex` | 低 / 中 / 高 / 极高 → `low` … `xhigh` |
  | `gpt-5.4` | 关闭 / 低 / 中 / 高 / 极高 |
  | `gpt-5.4-pro` | 中 / 高 / 极高 |
  | `claude-*-5` | 低 / 中 / 高 / 极高 / 最高 |
  | `grok-4.6` | 低 / 中 / 高 / 极高 |
  | 认不出 | 极低 / 低 / 中 / 高（OpenAI 通用四档） |

  标签沿用 ZCode 的文案表：`minimal→极低`、`low→低`、`medium→中`、`high→高`、
  `xhigh→极高`、`max→最高`、`ultra→极致`、`none→关闭`。
- ⚠️ **为什么要按模型分**：各家认识的值不一样，**兜底行为也不一样**。GLM 只认 low/high/max，
  传 `medium` 不报错、而是被当成 max（最贵的档）；而另一些网关不认 `xhigh` 时会**静默回落到 medium**，
  把「高强度」的意图悄悄降级成中强度。只有按模型给出真实支持的档位，用户选的才等于真正发出去的。
- 存下来的档位如果不属于当前模型（换过模型），按「默认」处理，不会拿旧值去撞新模型。
- **颜色**：`--accent: #0c77ff`（蓝）。档位名也是蓝色。**拉到最高档**时填充换成
  `--accent-gradient` 蓝紫渐变（`#1d2ed1 → #6656ef → #a16ffd → #6c3bf8`），
  上面叠 20 颗白色粒子，档位名转为 `--accent-violet`。
  蓝与紫的值都是**从参考图里直接取样**的，不是估的。
- **粒子向左飞**：`mc-drift` 关键帧把 `translate3d` 从 `+46px` 推到 `-104px`，配合
  `scale 0.45 → 1 → 0.4` 和两端淡入淡出，形成一条向左流动的粒子带；飞出左端时由
  填充层的 `overflow: hidden` 裁掉。粒子用**长手写属性**（`animation-name` / `-duration` / `-delay`）
  而不是 `animation` 简写，否则会把内联的 duration / delay 重置掉。
  另附 `@media (prefers-reduced-motion: reduce)` 降级为静态粒子。
- **视觉**：36px 粗胶囊轨道 + 42px 白色圆形滑块（比轨道大 6px，略微凸出，配投影才看得清）。
  刻度点 5px：落在填充区内用 `rgba(255,255,255,.55)`，区外用 `rgba(255,255,255,.20)`。
- **定位算法**：
  - 滑块与刻度点的圆心行程是 `calc(21px + f * (100% - 42px))` —— 两端各留出滑块半径，永不溢出。
  - **轨道两端各内缩 3px**（`(42 - 36) / 2`）。不内缩的话，最低/最高档时轨道的圆头会与滑块**恰好相切**，
    抗锯齿会露出一道暗边；内缩后圆头正好落在滑块圆心，被完全盖住。
  - 填充左缘从 3px 起、宽度用同一公式，保证填充右缘永远正好落在滑块圆心。
- 交互用「假轨道 + 透明原生 `input[type=range]` 覆盖」，避免跨浏览器样式差异。
- 粒子位置用**固定种子的伪随机**（`Math.sin` 哈希），不能用 `Math.random()`，否则每次重渲染都会跳；
  每颗粒子的 duration 在 2.8–4.6s 之间随机，`animation-delay` 取**负值**，这样一上屏粒子就已经散布在
  各自行程的不同位置，不会整批同时从右侧冒出来。

数据流（已端到端验证）：

```
滑杆 → App.changeEffort()
   ├─ PUT /session/model { provider, modelId, reasoningEffort }  → 作用到运行中的 runtime
   └─ window.meow.saveProviderPrefs({ providers:[{id, reasoningEffort}] })  → 落盘，下次启动记住
```

- `src/agent/provider.ts` **只在显式设置了档位时**才把 `reasoning_effort` 放进请求体，避免不支持的网关因未知字段报 400；「关闭」= 不下发该字段。
- 落盘**必须走 `saveProviderPrefs`**，不能走 `saveSettings` —— 后者会 `startServer()` 重启 agent server，拖一次滑杆就重启一次服务。
- 后端 `PUT /session/model` 现在 `modelId` 与 `reasoningEffort` 都是可选的。

## 8. Agent 感的呈现规则

1. **用户消息**右对齐气泡，`--user-fill` 底，右下角小圆角。
2. **助手消息无气泡**，正文直接落在页面上，行首一个极小的「助手」标签；流式时行尾闪烁光标。
3. **工具调用**为可折叠卡片，头部 = 图标 + 工具名 + 状态点 + 徽章（运行中 / 成功 / 失败）；运行中自动展开。折叠动画用 `grid-template-rows: 0fr → 1fr`，不依赖动画库。
4. **连续工具调用**归组为一个「思考过程 · N 步」折叠块，折叠时显示最新工具名与状态点。
5. **输入框是视觉主角**：20px 大圆角外壳 + 内嵌 textarea（自动增高）+ 右下角「发送 / 停止」，`Enter` 发送、`Shift+Enter` 换行。
6. **弹窗**用原生 `<dialog>` + `showModal()`，自带焦点陷阱、ESC 关闭、`::backdrop` 与背景 inert。

## 9. 语义色使用纪律

主色面**全部中性**。`--success` / `--danger` 只出现在小面积状态指示上（状态点、1px 边框、文字），**不做大块填充**。运行中状态用中性脉冲白点表达，不引入色相。

- 审批弹窗：「允许」= 纯白实心，「拒绝」= 描边灰红。
- 标题栏「关闭」按钮 hover 才转为灰红，其余按钮 hover 用中性叠加。
- 链接 / 头像 / 焦点环：一律白。
- **唯一的彩色例外**：思考强度滑杆的 `--accent`（Codex 蓝）与满档的紫罗兰渐变 + 粒子。别的地方要用彩色前先确认是有意为之。

## 10. 契约

前端重写**不影响**后端与通信层：

- `window.meow`：`request / getSettings / saveSettings / pickWorkspace / onEvent` + 窗口控制 `minimizeWindow / toggleMaximizeWindow / closeWindow / getWindowState / onWindowStateChange` + 偏好落盘 `saveProviderPrefs`（`preload.cjs` + `global.d.ts`）。
- `api.ts` 的 `api()`、`renderMarkdown()` 与全部类型。
- SSE 事件：`assistant_delta / message_complete / tool_started / tool_output / tool_finished / message_start / turn_complete / approval_required / usage / error`。
- HTTP 路由：`/session`、`/sessions`、`/session/messages`、`/session/new`、`/session/switch`、`/session/prompt`、`/session/abort`、`/approval/response`、`PUT /session/model`（可选 `modelId` + `reasoningEffort`）。
- `ProviderConfig` / `ProviderSettings` 新增可选 `reasoningEffort`，并在 `settings.json` 里持久化。

## 11. 开发与验证

```bash
cd desktop
pnpm dev         # vite + electron
pnpm typecheck   # tsc --noEmit
pnpm build       # 产物输出到 desktop/renderer/
```

`desktop/preview.html` 是一个**仅用于视觉预览**的独立页面（mock 掉 `window.meow`），可用浏览器直接打开 `http://localhost:5273/preview.html?s=chat|approval|settings` 查看界面状态，不需要启动 Electron。加 `&hover=close` 可以强制关闭按钮显示 hover 态，方便截图核对。该文件不参与打包（`vite build` 只以 `index.html` 为入口，electron-builder 的 `files` 也未包含它）。

设置页相关参数：`&sec=general|appearance|models|about` 直接定位分区，`&theme=light|dark` 强制主题，`&menu=1` 打开模型列表、`&menu=2` 打开后再点第一个模型直接跳到强度滑杆。

## 12. 设置页（应用内页面，非弹窗）

点左栏「设置」后**对话内容区整体换成设置页**，不再是模态弹窗。对话 DOM 保持挂载，用 `display: contents` / `display: none` 切换，返回后滚动位置和输入框高度都还在。

```
mc-root
  TitleBar                    明暗两套字标（见下）
  mc-body
    Rail                      active="settings" 时高亮
    mc-columns
      对话列表
      mc-panel--content
        .mc-contentview        display:contents；[data-hidden=true] → display:none
          ChatHeader / MessageList / Composer
        SettingsPage            仅 view === "settings" 时渲染
      检查器
```

`SettingsPage` 左侧 180px 分区导航（通用 / 外观 / 模型 / 关于）+ 右侧滚动内容，组件在 `components/settings/`。

### 通用
- 工作区：显示目录名 + 完整路径，可「更改」
- 关闭方式三选一（`SegmentedControl`）：`每次询问` / `缩小到托盘` / `直接关闭`

### 外观
- 主题三选一：`跟随系统` / `浅色` / `深色`，默认跟随系统，切换立即生效

### 模型
表格列 `模型 / 服务商 / 操作`，每行 = 独立启用开关（`enabled`，**互不排斥**，表示「该模型出现在输入框的模型列表里」）+ 编辑 + 两步删除确认。「添加模型」→ `ProviderPickerDialog`（服务商网格）→ `ModelFormDialog`。

`ModelFormDialog` 字段**只做 ZCode / DSH 真有的**：API 格式（三选一）、请求地址（根地址，路径按协议自动追加）、API 密钥、模型 ID（必填 + 全局唯一）、显示名称、上下文窗口、最大输出（均支持 `256K`/`1M`，K=1000、M=100 万）、输入模态（`text` 必选且不可取消 + `image`）、推理等级。
**不做** Temperature / Top P / Top K / 工具调用轮数 —— ZCode 与 DSH 都没有这些字段。

### Composer 模型 chip 的两视图
点模型名 → 弹层先显示**模型列表**（只列 `enabled` 的）→ 点某个 → 切为当前模型并跳到**思考强度滑杆**（带返回按钮）。当前模型名 chip 显示 `displayName ?? model`。

## 13. 主题系统

- 来源 `settings.theme`，默认 `system`；`system` 时用 `matchMedia("(prefers-color-scheme: dark)")` 解析并监听 OS 切换（`theme/theme.tsx` 的 `ThemeProvider`）。
- 落地：`document.documentElement.dataset.theme = resolved` + 镜像写 `localStorage["meow:theme"]`。
- **零闪色三处**：① `index.html` 内联阻塞脚本在样式与 React 之前读 localStorage/matchMedia 定主题；② `main.cjs` 建窗时解析主题设 `backgroundColor`（dark `#0a0a0a` / light `#e6e6e6`，== `--bg-root`），并监听 `nativeTheme.on("updated")`；③ `ThemeProvider` 挂载后再兜底一次。
- **字标**：`TitleBar` 用 `useTheme()`，浅色加载 `assets/wordmark-black.png`、深色加载 `wordmark.png`。两份都是 2217×377 的裁切 RGBA PNG，由 `scripts/make-wordmark.mjs` 从 `MeowCode文字{黑,白}.png` 按字形 bbox `257,552 → 2473,928` 生成（同一份解码逻辑，两边逐像素同构）。
- 浅色块 `:root[data-theme="light"]` 之前是**死令牌**（没人设过 `data-theme`），现已接入。

## 14. 托盘与关闭方式

`main.cjs` 常驻 `Tray`（菜单：显示 MeowCode / 设置… / 退出，单击显示窗口），图标按 `app.isPackaged ? resourcesPath/icons/icon.png : __dirname/../resources/icon.png` 取。

`mainWindow.on("close")` 按 `closeAction` 分派：

| 值 | 行为 |
| --- | --- |
| `quit` | 置 `isQuitting = true` 后放行 |
| `tray` | `preventDefault()` + `hide()`（不触发 `window-all-closed`，进程存活） |
| `ask` | `preventDefault()` + 原生 `dialog.showMessageBox`（缩小到托盘 / 直接关闭 / 取消 + 「记住我的选择」复选框） |

自绘标题栏的关闭按钮走 `meow:window-close` → `mainWindow.close()`，命中同一逻辑。只有托盘「退出」和 `before-quit` 会置 `isQuitting`，`before-quit` 仍 `await stopServer()`。

## 15. 服务商目录与协议

**目录 = ZCode ∪ DSH**，写在 `desktop/src/data/providerCatalog.ts`：
- ZCode `config/provider/zcode-builtin.json` 的 `templateRules`（20 条）提供 中文名 / 协议 / baseUrl / 内置模型 ID / 图标 key
- DSH `provider-data.generated.ts`（42 条）提供 id / 默认端点
- 去重键 = 小写 id，**ZCode 胜**；只折叠完全重复项（DSH `minimax-cn` 端点与 ZCode `minimax` 逐字节相同、`opencode`/`opencode-go` 无端点）
- 最终 53 条。图标资源在 `desktop/src/assets/provider-icons/`，映射见 `data/providerIcons.ts`

**图标配色（正式例外）**：ZCode 的图标是混合的 —— 彩色 4 个（alibaba / deepseek / minimax / bigmodel）、单色黑 4 个（zai / moonshot-kimi / xai / xiaomi-mimo）、浅底黑标 3 个（anthropic / openai / start-plan）、明暗成对 2 组（opencode / openrouter）。`providerIcon(key, theme)` 在深色主题下对单色标做 `filter: invert(1)`，其余用原色。无图标的服务商退回灰底首字母方块。**这是「唯一彩色是 `--accent`」纪律的正式放宽**，理由是你明确要求品牌原色。

**三种协议全实现**（`src/agent/`）：

| 协议 | 端点后缀 | 鉴权 | 请求体要点 | 流式事件 |
| --- | --- | --- | --- | --- |
| `openai-chat-completions` | `/chat/completions` | `Authorization: Bearer` | `messages` + `tools` + `max_tokens` + `reasoning_effort` | `choices[].delta` |
| `anthropic-messages` | `/v1/messages` | `x-api-key` + `anthropic-version` | `system` 顶层、`tools` 用 `input_schema`、tool 结果走 `tool_result` 块 | `content_block_start` / `content_block_delta`（`text_delta` / `input_json_delta`）/ `message_delta` |
| `openai-responses` | `/v1/responses` | `Authorization: Bearer` | `instructions` + 扁平 `input` + `reasoning: { effort }` | `response.output_text.delta` / `output_item.added` / `function_call_arguments.delta` / `completed` |

`completionUrl(baseUrl, protocol)` 处理「已带目标后缀 / 已带 `/vN` / 都不带」三种情况。SSE 帧解析共用 `agent/sse.ts` 的 `readSseFrames`。

**apiKey 可选**（DSH 约定：空 = 用服务商原生鉴权），只在有值时才带鉴权头。**`reasoning_effort` 只在显式设置时下发**，避免不支持的网关因未知字段报 400。

## 16. 上下文裁剪

`src/agent/context.ts`：`estimateTokens(text) = ceil(len/4)`；`trimMessages(messages, contextWindow, maxTokens?)` ——
预算 = `contextWindow - maxTokens - 1024`，**永远保留 `messages[0]`（system）**，从最新往回累计，
丢弃时按「带 `tool_calls` 的 assistant + 紧随其后的 tool 结果」成组丢（避免孤儿 `tool_call_id` 导致 API 400），
预算不足时至少保留最后一条 user 消息。`runtime.runTurn()` 每轮请求前调用。

## 17. 新增的轻量 IPC（不重启 agent server）

| 通道 | 签名 | 说明 |
| --- | --- | --- |
| `meow:save-preferences` | `(prefs: Partial<Preferences>) => Promise<Preferences>` | 主题 / 关闭方式落盘，**绝不重启** agent server |
| `meow:get-app-info` | `() => Promise<AppInfo>` | 关于页用的版本 / 平台信息 |
| `meow:open-settings` | M→R send | 托盘菜单「设置…」触发切到设置页 |

⚠️ **主题 / 关闭方式必须走 `savePreferences`，绝不能走 `saveSettings`** —— 后者有 `await startServer()`，切一次主题就重启一次后端。`savePreferences` 是读-改-写，保留 `providers[].apiKeyEncrypted`。

模型增删改 / 切换当前模型走 `saveSettings`（会重启 server，可接受，因为模型列表要进 `MEOWCODE_PROVIDERS` 环境变量）；思考强度仍走 `saveProviderPrefs`（不重启）。

## 18. 顺手修掉的两个 bug

1. **前端全程忽略 `providerId`**，硬用 `providers[0]`。现改为按 `providerId` 解析激活项，回退到第一个 `enabled` 项。
2. **后端 `/config/providers` 的 `activeProviderId` 写死成 `providers[0]`**（取的是环境变量列表的第一项）。改用 `runtime.activeProviderId`。
