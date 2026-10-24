# MCP 工具参考

## 服务概览

- **MCP 服务名**：`interative_content_mcp`
- **传输协议**：Streamable HTTP
- **鉴权**：OAuth 2.1（IDE 自动处理，无需手动配置 token）

---

## 工具列表

### 1. get_upload_token

获取一次性上传凭证（5 分钟有效），用于通过 curl 上传文件。

**参数：** 无

**返回字段：**

| 字段 | 说明 |
|------|------|
| `upload_token` | 一次性上传凭证 |
| `upload_url` | 上传地址 |
| `expires_in` | 有效期（秒） |

**上传流程：**
1. 调用 `get_upload_token`
2. 用 curl 上传文件：
   ```bash
   curl -X POST '<upload_url>' \
     -H 'Authorization: UploadToken <upload_token>' \
     -F 'file=@<文件路径>'
   ```
3. 从返回 JSON 提取 `data.uri`

> upload_token 一次性使用，上传多个文件需多次调用。

**支持的文件类型：** zip, jpg, jpeg, png, gif, webp, bmp, svg, ico

**上传响应示例：**
```json
{
  "code": 0,
  "data": {
    "uri": "tos-cn-i-xxx/game_v1.0.zip",
    "file_type": "zip",
    "file_name": "game_v1.0.zip"
  }
}
```

---

### 2. modify_game_app

创建或更新互动空间。

**参数：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `action` | 是 | 1-创建, 2-更新 |
| `name` | 是 | 互动空间名称 |
| `icon_uri` | 是 | 图标 URI（上传获取） |
| `screen_direction` | 是 | 1-竖屏, 2-横屏 |
| `package_uri` | 是 | zip 包 URI（上传获取） |
| `biz_id` | 否 | 业务类型，固定传 3 |
| `biz_platform_type` | 否 | 平台类型，固定传 1（抖音） |
| `app_id` | 更新时是 | 更新时必填 |
| `desc` | 否 | 互动空间描述 |
| `package_type` | 否 | 产物类型，固定传 1（Zip） |
| `package_desc` | 否 | 产物来源描述，最多 20 字（填当前 AI 工具名称或空字符串） |

**返回：** 包含 `AppID`，用于后续更新和提审。

---

### 3. submit_audit_game_app

提交互动空间审核。

**参数：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `biz_id` | 是 | 固定传 3 |
| `biz_platform_type` | 是 | 固定传 1 |
| `app_id` | 是 | 要提审的 AppID |

---

### 4. query_game_app_list

查询互动空间列表。

**参数：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `biz_id` | 否 | 业务类型，固定传 3 |
| `biz_platform_type` | 否 | 平台类型，固定传 1 |
| `app_id` | 否 | 精确查询 |
| `search_key` | 否 | 模糊搜索关键词 |
| `status` | 否 | 状态筛选（数组） |
| `page_num` | 否 | 页码，从 1 开始 |
| `page_size` | 否 | 每页数量，默认 20 |

**状态码：**

| 值 | 含义 |
|----|------|
| 1 | 草稿 |
| 2 | 审核中 |
| 3 | 审核拒绝 |
| 4 | 已上线 |
| 5 | 已下线 |
