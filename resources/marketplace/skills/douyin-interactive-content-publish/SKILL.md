---
name: douyin-interactive-content-publish
description: "One-click publish tool for Interactive Space (互动空间). Upload zip+icon to create/update interactive space apps with auto-generated name/description. Trigger on: publish/submit/upload interactive space, 发布互动空间, 提交互动空间, 一键发布, 上传游戏包, 提审互动空间, 提审游戏, upload game package, submit for review, go live."
---

# 互动空间一键上传发布

实现互动空间从本地 zip 包到发布上线的完整流程。核心理念：尽量减少用户输入，通过分析 zip 包自动推断信息，让用户确认即可。

详细 API 规格见 `references/api.md`。

## 交互原则

每次向用户提问或需要用户输入时，必须明确告知用户**具体在哪里输入、怎么输入**。因为用户可能在不同的 IDE 环境中使用本 skill（如 Trae、Cursor 等），输入方式各有不同。具体来说：

- 当提供多个选项时，明确说"回复数字 1/2/3 选择"或"回复对应文字选择"
- 当需要用户输入路径、ID 等具体内容时，明确说"请直接输入 xxx"或"请将路径粘贴到输入框"
- 当问题既有预设选项又允许自定义输入时，明确说"回复选项编号，或直接输入自定义内容"
- 避免模糊的开放式提问，每个问题都给出明确的回复格式示例

## MCP 服务器信息

- **名称**：`interative_content_mcp`
- **传输协议**：Streamable HTTP
- **鉴权**：IDE 自动处理（首次连接会弹出授权页面）

## 执行流程

> ⚠️ **严格顺序执行**：必须从 Step 1 开始，逐步完成。Step 1 为阻塞性前置检查，未通过前禁止执行任何后续步骤。

### Step 1：检查并配置 MCP（阻塞性）

本步骤未通过前，不得执行后续任何步骤。

> **行为限制（贯穿全流程）：**
> - 禁止打开浏览器、访问网页、或引导用户到任何平台/网站进行操作
> - 禁止尝试通过 HTTP 请求、浏览器自动化等方式绕过 MCP 工具
> - 所有与服务端的交互只能通过 MCP 工具完成
> - 如果 MCP 工具不存在或未加载，必须先进入 1.2 自动检查并补写 MCP 配置；不要直接要求用户手动配置或刷新
> - 只有自动检查/补写配置后，再次获取 MCP 工具列表仍找不到工具，才提示用户打开 MCP 配置页面点击刷新
> - 如果 MCP 因认证、授权、登录态失效而不可用，只提示用户打开当前 IDE/AI 工具的配置界面，在 MCP / MCP Servers / MCP 设置中完成 `interative_content_mcp` 的认证或重新授权；不要自行寻找替代方案
> - 如果工具调用失败或返回错误，只需告知用户错误信息；认证类问题引导用户去配置界面处理，非认证类问题再建议刷新 MCP

#### 1.1 检查 MCP 是否可用

检查可用工具列表中是否存在 `interative_content_mcp` 提供的工具（`get_upload_token`、`modify_game_app`、`submit_audit_game_app`、`query_game_app_list`）。

- **全部存在** → 调用 `query_game_app_list`（参数 `{"biz_id": 3, "biz_platform_type": 1, "page_num": 1, "page_size": 1}`）探活：
  - 返回正常响应 → MCP 可用 ✅，直接进入 Step 2
  - 返回认证/授权/登录态错误 → 直接提示用户打开当前 IDE/AI 工具的配置界面，在 MCP / MCP Servers / MCP 设置中找到 `interative_content_mcp`，完成认证或重新授权。禁止自行打开浏览器、尝试其他方式获取授权、或继续发散排查
- **任何工具不存在** → 说明 MCP 配置可能缺失或尚未加载，必须进入 1.2 自动检查并补写配置；此时不要让用户手动处理

#### 1.2 自动检查并补写 MCP 配置

不要询问用户，按以下流程自动完成。

**确定配置路径：**

执行 `uname -s` 判断操作系统，得到各 IDE 的配置基础路径：

| OS                          | 基础路径                             |
| --------------------------- | -------------------------------- |
| Darwin (macOS)              | `~/Library/Application Support/` |
| Linux                       | `~/.config/`                     |
| Windows (MINGW/MSYS/CYGWIN) | `$APPDATA/`                      |

然后依次检查以下目录是否存在，**存在就写入**：

| IDE           | 子目录                          |
| ------------- | ---------------------------- |
| Trae Solo 国际版 | `TRAE SOLO/User/`            |
| Trae Solo 国内版 | `TRAE SOLO CN/User/`         |
| Cursor        | `Cursor/User/globalStorage/` |

无论上述目录是否命中，都**额外写入**项目根目录 `.trae/mcp.json` 作为兜底。

**写入逻辑（Python）：**

写入前先检查 Python 3 是否可用（`python3 --version`）。如果不可用，先帮用户安装：

- macOS：执行 `xcode-select --install`（系统自带 Python 3）
- Linux（Debian/Ubuntu）：`sudo apt-get install -y python3`；（CentOS/RHEL）：`sudo yum install -y python3`
- Windows：`winget install Python.Python.3.12`，或提示用户从 [python.org](https://python.org) 下载安装

安装完成后重新检查 `python3 --version` 确认可用。

确认 Python 3 可用后，对每个命中的路径，将以下 Python 脚本保存为临时文件并执行（替换 `target_dir` 为实际路径）。如果配置文件不存在，创建并写入 `interative_content_mcp`；如果配置文件已存在但没有 `interative_content_mcp`，补写该配置；如果已存在 `interative_content_mcp`，保持原样并继续检查下一个路径。

```python
import json, os, sys

target_dir = '<命中的目录路径>'
target_file = os.path.join(target_dir, 'mcp.json')

new_server = {
    'interative_content_mcp': {
        'url': 'https://vcreate.douyin.com/mgplatform/api/apps/interact_content/mcp',
        'oauth': {}
    }
}

os.makedirs(target_dir, exist_ok=True)

if os.path.exists(target_file):
    with open(target_file, 'r') as f:
        data = json.load(f)
    if 'interative_content_mcp' in data.get('mcpServers', {}):
        print(f'已存在 interative_content_mcp，跳过: {target_file}')
        sys.exit(0)
    data.setdefault('mcpServers', {}).update(new_server)
else:
    data = {'mcpServers': new_server}

with open(target_file, 'w') as f:
    json.dump(data, f, indent=2)
print(f'已写入: {target_file}')
```

#### 1.3 写入/检查后验证

配置写入或确认已存在后，重新获取 MCP 工具列表，再次检查是否存在 `interative_content_mcp` 提供的工具（同 1.1 逻辑）。

- **可用** → 进入 Step 2
- **仍找不到 MCP 工具** → 向用户输出以下提示：

> MCP 配置已检查/写入，但当前会话还没有加载到 `interative_content_mcp` 工具。请在当前 IDE/AI 工具的 MCP 配置页面中操作（禁止打开浏览器或访问任何网站）：
>
> 1. 打开该工具的 **MCP** / **MCP Servers** / **MCP 设置**入口
> 2. 如果列表里能看到 `interative_content_mcp`，在 MCP 配置页面点击**刷新 / Reload / Reconnect**
> 3. 如果列表里找不到 `interative_content_mcp`，复制下面的 JSON 配置，在 MCP 配置页面中手动添加该 server，然后点击**刷新 / Reload / Reconnect**
> 4. 如果看到认证、授权、登录态或账号配置异常，请在该配置界面中完成认证或重新授权，然后再次点击**刷新 / Reload / Reconnect**
> 5. 完成后回来告诉我"已刷新"，我会重新检查
>
> ```json
> {
>   "mcpServers": {
>     "interative_content_mcp": {
>       "url": "https://vcreate.douyin.com/mgplatform/api/apps/interact_content/mcp"
>     }
>   }
> }
> ```
>
> <br />

***

### Step 2：查询已有作品（权限校验 + 数量检查）

调用 `query_game_app_list` 查询用户当前的互动空间列表：

```json
{
  "biz_id": 3,
  "biz_platform_type": 1,
  "page_num": 1,
  "page_size": 20
}
```

**根据返回结果判断：**

**a) 调用成功** → 记录返回的 `max_num`（最大可创建数量）和当前作品列表，继续 Step 3。

**b) 返回权限错误** → 说明用户尚未报名。先检查错误信息中是否包含报名链接：

- 如果 error/message 中包含 URL（例如 `http://` 或 `https://` 开头的链接），优先使用错误信息里的报名链接
- 如果错误信息中没有报名链接，使用默认报名链接：`https://bytedance.larkoffice.com/share/base/form/shrcnEyRfMORxiHJj2BReaBF0Ys`

然后提示：

> ⚠️ 你还没有互动空间的权限，请先前往报名页面完成报名：
> [互动空间报名页](从错误信息提取的链接；如无则使用默认报名链接)
>
> 报名完成后审核通过后，再执行后续步骤。

**c) 作品数量已达** **`max_num`** **上限** → 无法新建，需要用户选择操作方式：

> ⚠️ 你的互动空间数量已达上限（<当前数量>/\<max\_num>），无法新建。
>
> 你可以选择（回复 1 或 2）：
>
> 1. **修改已有作品** — 在现有互动空间上更新内容
> 2. **删除旧作品** — 删除一个旧的后再新建
>
> 请提供要操作的 AppID，或回复"帮我查"查看你的作品列表。

如果用户回复"帮我查"或不知道 AppID，将已查到的作品列表以表格展示：

| AppID | 名称  | 状态 | 更新时间 |
| ----- | --- | -- | ---- |
| xxx   | xxx | 草稿 | xxx  |

用户选定后：

- **修改** → 记录 AppID，后续 Step 5 中 `action` 改为 2，附带 `app_id`
- **删除** → 提示用户到管理后台手动删除后，回来告知，重新执行查询

### Step 3：收集基础信息并分析 zip 包

发布互动空间需要两个文件：**zip 包**和**图标文件（300x300，jpg/png）**。

**3.1 自动发现文件**

按以下优先级获取：

1. 检查对话上下文中用户是否已提到文件路径
2. 如果未提到，在当前工作目录及子目录中搜索：
   - zip 包：`find . -maxdepth 2 -name "*.zip" -type f`
   - 图标：`find . -maxdepth 2 \( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" \) -type f`

发现候选文件后，列出让用户确认。如果发现多个，全部列出让用户选择。如果未找到，直接询问用户提供路径。

**3.2 分析 zip 包，生成建议信息**

拿到 zip 包后，分析其内容来自动推断互动空间的元信息：

1. **查看包结构**：`unzip -l <zip文件>` 列出文件列表
2. **推断名称**：从 `index.html` 的 `<title>` 标签 → 项目目录名 → zip 文件名（优先级依次降低）
3. **生成描述**：阅读核心文件（`index.html`、`main.js`、`game.js` 等），用一句话（50 字内）概括玩法
4. **推断屏幕方向**：从 canvas 尺寸、viewport meta 等推断横屏/竖屏

将分析结果展示给用户确认：

> 📋 我分析了你的 zip 包，以下是建议的发布信息：
>
> - 📦 包文件：`<zip文件名>`（<文件大小>）
> - 📁 包结构：`<主要文件列表>`
> - 📝 名称：`<推断的名称>`
> - 📋 描述：`<生成的描述>`
> - 🖼️ 图标：`<用户提供的图标文件名>`
> - 📱 体验方式：`<竖屏/横屏>`
> - 🔧 产物来源：`<当前AI工具名称>`（如能识别当前工具名称则自动填入，如 “Trae Solo”、“Cursor” 等；无法确定则留空）
>
> 是否需要修改？
>
> - 确认无误 → 回复"确认"
> - 需要修改 → 直接输入修改内容，如"名称改成 xxx"、"描述改成 xxx"或"改成横屏"

### Step 4：执行上传

> **重要：上传凭证只通过 MCP 工具 `get_upload_token` 自动获取，无需用户手动操作。**
>
> - `upload_token` 和 `upload_url` 是一次性上传凭证，属于本地上传流程
> - 它们不来自互动空间平台、报名页、管理后台或任何网页
> - 禁止让用户去平台获取、复制或填写 `upload_token` / `upload_url`
> - 禁止打开浏览器或访问任何网站来获取上传凭证
> - 用户只需确认 zip 包和图标文件，后续由模型在本地依次调用 MCP 工具并执行 curl 上传

用户确认信息后，开始上传文件：

**4.1 上传 zip 游戏包**

1. 调用 MCP 工具 `get_upload_token` 获取本次 zip 上传的一次性凭证
2. 执行 curl 上传：

```bash
curl -X POST '<upload_url>' \
  -H 'Authorization: UploadToken <upload_token>' \
  -F 'file=@<zip文件路径>'
```

1. 提取返回的 `data.uri` 作为 `package_uri`

**4.2 上传图标**

1. 再次调用 MCP 工具 `get_upload_token` 获取图标上传的新凭证（每个 token 只能用一次）
2. 执行 curl 上传图标文件：

```bash
curl -X POST '<upload_url>' \
  -H 'Authorization: UploadToken <upload_token>' \
  -F 'file=@<图标文件路径>'
```

1. 提取返回的 `data.uri` 作为 `icon_uri`

### Step 5：创建/更新互动空间

调用 MCP 工具 `modify_game_app`：

```json
{
  "action": 1,
  "biz_id": 3,
  "biz_platform_type": 1,
  "name": "<确认后的名称>",
  "desc": "<确认后的描述>",
  "icon_uri": "<Step 4.2 上传的图标 URI>",
  "screen_direction": 1,
  "package_uri": "<Step 4.1 上传的游戏包 URI>",
  "package_type": 1,
  "package_desc": "<确认后的产物来源>"
}
```

- 新建时 `action` = 1
- 更新时 `action` = 2，并附带 `app_id`（来自 Step 2 中用户选择的 AppID）
- `package_desc`：产物来源描述（最多 20 字），使用 Step 3 中用户确认的值；如果用户未修改且值为空，传空字符串 `""`

从返回结果中提取 `AppID`。

### Step 6：询问是否提交审核

创建/更新成功后，询问用户：

> ✅ 互动空间已成功创建！AppID: \<app\_id>
>
> 是否需要立即提交审核？（回复 1 或 2）
>
> 1. 提审 — 立即提交，进入审核流程
> 2. 不用 — 保持草稿状态，后续可手动提审

**如果用户选择提审：**

调用 `submit_audit_game_app`：

```json
{
  "biz_id": 3,
  "biz_platform_type": 1,
  "app_id": "<AppID>"
}
```

**如果用户选择不提审：**

直接输出完成信息，告知用户后续可以使用 `submit_audit_game_app` 手动提审。

***

## 输出格式

流程完成后，以表格形式输出结果摘要：

> ✅ 互动空间发布流程完成

| 项目    | 内容                        |
| ----- | ------------------------- |
| 游戏包   | \<zip文件名> → `package_uri` |
| 图标    | \<icon文件名> → `icon_uri`   |
| AppID | \<app\_id>                |
| 名称    | \<name>                   |
| 描述    | \<desc>                   |
| 屏幕方向  | 竖屏/横屏                     |
| 当前状态  | <状态文字>                    |

> 下一步：等待审核结果，可随时使用 AppID 查询最新状态。

如果未提审，"当前状态"行填写"草稿（未提审）"，并在表格后追加：

> 💡 需要提审时告诉我即可。
