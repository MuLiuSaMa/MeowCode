/**
 * Gitee / GitCode OAuth（授权码模式）：端点与 token 归一化。
 *
 * 连接方式是「直接连接」：内置官方 OAuth 应用的 Client ID（公开信息，不是 secret），
 * 用户点一下就连，不需要自建应用、不需要填 Client ID。主进程用系统浏览器打开授权页，
 * 平台回跳本地 127.0.0.1:53682，换到的 token 只加密存本机。
 *
 * 注意：Gitee / GitCode 的 token 端点强制校验 client_secret（无 PKCE），所以内置应用
 * 同时带内置 Secret，做到点一下直接开浏览器；用户自建应用可用设置页 / 环境变量 / 本机文件覆盖。
 */
const OAUTH_PLATFORMS = {
  gitee: {
    label: "Gitee",
    authorizeUrl: "https://gitee.com/oauth/authorize",
    tokenUrl: "https://gitee.com/oauth/token",
    scope: "user_info projects pull_requests issues notes",
    localCallbackPath: "/oauth/gitee/callback",
    tokenEnv: "MEOWCODE_GITEE_TOKEN",
    appSetupUrl: "https://gitee.com/oauth/applications",
    appSetupHint: "Gitee 设置 → 第三方应用 → 创建应用",
    /** MeowCode 内置应用 Client ID（公开信息） */
    defaultClientId: "cbe8604db051ea4fc5e21b6952330cb194e24c1cbd2e7c1bcb1fd34cc44e7dcd",
    /** 内置应用 Client Secret：用于开箱即用的一键授权；设置页 / 环境变量 / 本机文件可覆盖 */
    defaultClientSecret: "c421e08bc98a61c5628592030801449952b1fde28ddadb57a1bd3f6a203127f2",
  },
  gitcode: {
    label: "GitCode",
    authorizeUrl: "https://gitcode.com/oauth/authorize",
    tokenUrl: "https://gitcode.com/oauth/token",
    scope: "user_info projects pull_requests issues",
    localCallbackPath: "/oauth/gitcode/callback",
    tokenEnv: "MEOWCODE_GITCODE_TOKEN",
    appSetupUrl: "https://gitcode.com/settings/applications",
    appSetupHint: "GitCode 设置 → 应用管理 → 创建应用",
    /** MeowCode 内置应用 Client ID（公开信息） */
    defaultClientId: "b23b63eaf5764ea9a95e2613e5bf918a",
    /** 内置应用 Client Secret：用于开箱即用的一键授权；设置页 / 环境变量 / 本机文件可覆盖 */
    defaultClientSecret: "05f760d694a241278ab86c42ef5f12da",
  },
  /**
   * 社区市场独立登录：与 gitcode 槽位（MCP 连接）分属两个应用、两份 token。
   * 提交/删除社区条目需要 fork → 建分支 → 传文件 → 建 PR，scope 只申请这三组权限。
   */
  "gitcode-community": {
    label: "GitCode 社区",
    authorizeUrl: "https://gitcode.com/oauth/authorize",
    tokenUrl: "https://gitcode.com/oauth/token",
    scope: "user_info projects pull_requests",
    localCallbackPath: "/oauth/gitcode-community/callback",
    tokenEnv: "MEOWCODE_GITCODE_COMMUNITY_TOKEN",
    appSetupUrl: "https://gitcode.com/settings/applications",
    appSetupHint: "GitCode 设置 → 应用管理 → 创建应用",
    defaultClientId: "0cdb15925d064724a031159253a33dde",
    defaultClientSecret: "d287fbc3e26b4a6fa252805d67a197f1",
  },
};

/** 生效的 Client ID：用户自建应用优先，否则用内置应用。 */
function resolveClientId(config, app) {
  const stored = typeof app?.clientId === "string" ? app.clientId.trim() : "";
  return stored || config?.defaultClientId || "";
}

function describeOauthError(data) {
  const code = typeof data?.error === "string" ? data.error : "";
  const description = typeof data?.error_description === "string" ? data.error_description : "";
  return description || (code ? `平台返回错误：${code}` : "平台未返回 access_token。");
}

function normalizeOauthToken(data) {
  const accessToken = typeof data.access_token === "string" ? data.access_token.trim() : "";
  if (!accessToken) return null;
  const expiresIn = Number(data.expires_in);
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "",
    tokenType: typeof data.token_type === "string" ? data.token_type : "bearer",
    scope: typeof data.scope === "string" ? data.scope : "",
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0,
  };
}

async function postForm(url, params, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "MeowCode",
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    // 平台把原因放在响应体里（Gitee/GitCode 返回 error / error_description）：
    // 只报状态码会让人看到无信息的 401，实际最常见的是 client_id 与 secret 不配对。
    let detail = "";
    let code = "";
    try {
      const parsed = text ? JSON.parse(text) : {};
      code = typeof parsed?.error === "string" ? parsed.error : "";
      const description = typeof parsed?.error_description === "string" ? parsed.error_description : "";
      // GitCode 用的是另一套字段名
      const gitcodeCode = typeof parsed?.error_code_name === "string" ? parsed.error_code_name : "";
      const gitcodeMessage = typeof parsed?.error_message === "string" ? parsed.error_message : "";
      detail = description || gitcodeMessage || code || gitcodeCode;
    } catch {
      // 非 JSON 响应：只保留状态码
    }
    const error = new Error(
      `OAuth token request failed (${response.status})${detail ? `：${detail}` : ""}`,
    );
    // 错误码留给凭据自检判断：invalid_client = 凭据不匹配，invalid_grant = 凭据正确只是 code 无效
    error.oauthCode = code;
    throw error;
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("OAuth token response is not valid JSON.");
  }
}

function buildAuthorizeUrl(config, { clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  if (config.scope) params.set("scope", config.scope);
  return `${config.authorizeUrl}?${params.toString()}`;
}

async function exchangeCodeForToken(config, { clientId, clientSecret, code, redirectUri }, fetchImpl) {
  const data = await postForm(
    config.tokenUrl,
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    fetchImpl,
  );
  if (data.error || !data.access_token) {
    return { ok: false, code: data.error ?? "invalid_response", message: describeOauthError(data) };
  }
  const token = normalizeOauthToken(data);
  if (!token) return { ok: false, code: "invalid_response", message: describeOauthError(data) };
  return { ok: true, token };
}

async function refreshPlatformToken(config, { clientId, clientSecret, refreshToken }, fetchImpl) {
  const data = await postForm(
    config.tokenUrl,
    {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    fetchImpl,
  );
  if (data.error || !data.access_token) {
    return { ok: false, code: data.error ?? "invalid_response", message: describeOauthError(data) };
  }
  const token = normalizeOauthToken(data);
  if (!token) return { ok: false, code: "invalid_response", message: describeOauthError(data) };
  return { ok: true, token };
}


/**
 * 凭据自检：用一个必然无效的授权码去打 token 端点。
 *
 * 平台在换 token 时的报错顺序是「先校验 client_id/secret，再校验 code」：
 *  - invalid_client（认证失败/没有客户端）→ 这对 ID/Secret 不属于同一个应用，换了也连不上；
 *  - invalid_grant（授权码错误）→ 客户端认证其实通过了，ID/Secret 是对的。
 * 于是「401」不再是黑箱：一次自检就能区分「凭据填错」和「别的环节出问题」。
 */
async function verifyClientCredentials(
  config,
  { clientId, clientSecret, redirectUri },
  fetchImpl = fetch,
) {
  if (!clientId || !clientSecret) {
    return { ok: false, verdict: "incomplete", message: "Client ID 或 Client Secret 为空。" };
  }
  try {
    await postForm(
      config.tokenUrl,
      {
        client_id: clientId,
        client_secret: clientSecret,
        code: "meowcode-credential-probe",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      },
      fetchImpl,
    );
    // 探针 code 正常情况下不会换到 token；真换到了也算凭据可用
    return { ok: true, verdict: "credentials-ok", message: "凭据有效。" };
  } catch (error) {
    const code = String(error?.oauthCode ?? "");
    const message = error instanceof Error ? error.message : String(error);
    if (code === "invalid_client" || /认证失败|没有客户端|invalid_client/i.test(message)) {
      return {
        ok: false,
        verdict: "mismatch",
        message: "Client ID 与 Client Secret 不匹配（平台不认识这对凭据）。请确认两者来自同一个应用。",
      };
    }
    if (code === "invalid_grant" || /授权码错误|授权时发生错误|invalid_grant/i.test(message)) {
      return { ok: true, verdict: "credentials-ok", message: "凭据有效（探针授权码被拒属正常）。" };
    }
    return { ok: false, verdict: "unknown", message };
  }
}

module.exports = {
  OAUTH_PLATFORMS,
  resolveClientId,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshPlatformToken,
  verifyClientCredentials,
};
