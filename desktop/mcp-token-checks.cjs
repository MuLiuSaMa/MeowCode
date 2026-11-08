/**
 * 手动 MCP 凭据的在线校验（main.cjs 的纯逻辑部分拆出，配对测试 mcp-token-checks.test.ts）。
 *
 * 校验器一律收 values（env 名 → 明文值 的整表）而不是单个 token：
 * 飞书这类「App ID + App Secret」双凭据条目必须成对提交（tenant_access_token 端点），
 * 单值签名扩展不动它。evaluate 用于「HTTP 200 但业务码非 0」的平台（飞书即如此）。
 *
 * MANUAL_MCP_CREDENTIAL_GROUPS：成组凭据——组内任一 env 有值时，组内全部 env 都必须有值
 * 才能保存并整组校验（避免只填一半的半成品凭据）。
 */

const MANUAL_MCP_TOKEN_CHECKS = {
  MEOWCODE_GITEE_TOKEN: {
    url: (values) =>
      `https://gitee.com/api/v5/user?access_token=${encodeURIComponent(values.MEOWCODE_GITEE_TOKEN ?? "")}`,
    headers: () => ({}),
  },
  MEOWCODE_GITCODE_TOKEN: {
    url: (values) =>
      `https://api.gitcode.com/api/v5/user?access_token=${encodeURIComponent(values.MEOWCODE_GITCODE_TOKEN ?? "")}`,
    headers: () => ({}),
  },
  MEOWCODE_FIGMA_TOKEN: {
    url: () => "https://api.figma.com/v1/me",
    headers: (values) => ({ "X-Figma-Token": values.MEOWCODE_FIGMA_TOKEN ?? "" }),
  },
  LUCKIN_MCP_TOKEN: {
    url: () => "https://gwmcp.lkcoffee.com/order/user/mcp",
    method: "POST",
    headers: (values) => ({
      authorization: `Bearer ${values.LUCKIN_MCP_TOKEN ?? ""}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }),
    // 直接对 MCP 端点做 initialize 握手：401 = 令牌无效，2xx = 鉴权通过
    body: () =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "MeowCode", version: "1.0.0" },
        },
        id: 1,
      }),
  },
  // 飞书自建应用：App ID + App Secret 成对校验。校验登记在 APP_ID 名下（组代表），
  // ensure 组校验时会把 SECRET 一起传进 values。
  MEOWCODE_LARK_APP_ID: {
    url: () => "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    method: "POST",
    headers: () => ({ "content-type": "application/json" }),
    body: (values) =>
      JSON.stringify({
        app_id: values.MEOWCODE_LARK_APP_ID ?? "",
        app_secret: values.MEOWCODE_LARK_APP_SECRET ?? "",
      }),
    // 飞书端点凭据错误也回 HTTP 200：必须判 body.code（0 = 成功）
    evaluate: (_response, body) => {
      try {
        const json = JSON.parse(body);
        if (json.code === 0) return true;
        return `飞书返回错误（code ${json.code}）：${json.msg ?? "未知错误"}。常见原因：应用未发布版本、IP 白名单未包含本机出口 IP。`;
      } catch {
        return "飞书响应不是合法 JSON。";
      }
    },
  },
};

/** 成组凭据（组内全部 env 缺一不可）；未列入的名字自成一组。 */
const MANUAL_MCP_CREDENTIAL_GROUPS = [["MEOWCODE_LARK_APP_ID", "MEOWCODE_LARK_APP_SECRET"]];

/** 某个 env 名所在的凭据组（未成组的名字返回单元素数组）。 */
function credentialGroupOf(name) {
  for (const group of MANUAL_MCP_CREDENTIAL_GROUPS) {
    if (group.includes(name)) return group;
  }
  return [name];
}

/** 校验登记名：组的第一个成员做代表（校验时整组 values 都会传进去）。 */
function credentialCheckName(name) {
  return credentialGroupOf(name)[0];
}

/**
 * 在线校验一组凭据。name 只决定用哪套 check（组代表）；values 需含校验用到的全部 env 值。
 * evaluate 返回 true 或失败原因字符串。
 */
async function validateManualMcpToken(name, values, { fetchImpl = fetch } = {}) {
  const check = MANUAL_MCP_TOKEN_CHECKS[name];
  if (!check) return { ok: false, message: "不支持的 MCP Token。" };
  try {
    const response = await fetchImpl(check.url(values), {
      method: check.method ?? "GET",
      headers: { accept: "application/json", "user-agent": "MeowCode", ...check.headers(values) },
      body: check.body ? check.body(values) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `Token 校验失败（HTTP ${response.status}），请确认是否是有效的私人令牌/访问令牌。`,
      };
    }
    if (check.evaluate) {
      const body = await response.text();
      const verdict = check.evaluate(response, body);
      if (verdict !== true) return { ok: false, message: `Token 校验失败：${verdict}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `无法连接平台校验 Token：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

module.exports = {
  MANUAL_MCP_TOKEN_CHECKS,
  MANUAL_MCP_CREDENTIAL_GROUPS,
  credentialGroupOf,
  credentialCheckName,
  validateManualMcpToken,
};
