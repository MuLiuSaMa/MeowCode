# MCP OAuth CIMD 客户端元数据

把 `oauth-client.json` 发布到：

```
https://meowcode.cn/.well-known/oauth-client
```

- Content-Type: `application/json`
- 必须走 HTTPS，路径不能只是根 `/`
- 这是 SEP-991 / OAuth Client ID Metadata Document：远程 MCP 授权服务器（如 Undermind `api.undermind.ai`）会拉取它，把 URL 当作 `client_id`

## 为什么要固定端口

`redirect_uris` 写死 `http://127.0.0.1:53683/callback`。
MeowCode 的 MCP OAuth 回环监听默认绑 `53683`，被占用时退回随机端口——那时需要 AS 支持RFC 8252 可变端口，否则授权会 `redirect_uri mismatch`。

## 新增远程 MCP（Undermind 类）清单

1. AS 元数据：`client_id_metadata_document_supported: true`、无 `registration_endpoint` → 走 CIMD（默认已覆盖）
2. 有自己的预注册 `client_id` → 在 `mcp.json` 里配 `auth.clientId`
3. scope 一般填 `mcp`；PRM `scopes_supported` 也会兜底
4. 长任务工具记得配 `timeoutMs`（Undermind 深度检索默认 600000）

## 关闭 CIMD 回退

某个 server 想强制走 DCR：

```json
{ "auth": { "type": "oauth", "clientMetadataUrl": "" } }
```
