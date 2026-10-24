/** GitHub App 的公开 Client ID（不是 secret），设备流不需要 client secret。 */
const DEFAULT_CLIENT_ID = "Iv23libhdEUWJwypZB0y";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

function describeGithubError(data) {
  const code = typeof data?.error === "string" ? data.error : "";
  switch (code) {
    case "authorization_pending":
      return "等待你在 GitHub 上授权…";
    case "slow_down":
      return "GitHub 要求放慢请求频率。";
    case "expired_token":
      return "设备码已过期，请重新开始。";
    case "access_denied":
      return "你取消了 GitHub 授权。";
    case "device_flow_disabled":
      return "GitHub App 还没有启用 Device flow。请到 GitHub App 设置勾选 Enable device flow 后重试。";
    case "incorrect_client_credentials":
      return "GitHub App 的 Client ID 无效。";
    case "unsupported_grant_type":
    case "incorrect_device_code":
      return "GitHub 授权失败，请重新开始。";
    default: {
      const description =
        typeof data?.error_description === "string" ? data.error_description : "";
      return description || (code ? `GitHub 授权失败：${code}` : "GitHub 授权失败。");
    }
  }
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
  if (!response.ok) throw new Error(`GitHub OAuth request failed (${response.status})`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("GitHub OAuth returned invalid JSON.");
  }
}

function tokenFromResponse(data) {
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

async function startDeviceFlow(clientId, fetchImpl) {
  const data = await postForm(DEVICE_CODE_URL, { client_id: clientId }, fetchImpl);
  if (data.error) {
    return { ok: false, error: { code: data.error, message: describeGithubError(data) } };
  }
  const deviceCode = typeof data.device_code === "string" ? data.device_code : "";
  const userCode = typeof data.user_code === "string" ? data.user_code : "";
  const verificationUri = typeof data.verification_uri === "string" ? data.verification_uri : "";
  if (!deviceCode || !userCode || !verificationUri) {
    return { ok: false, error: { code: "invalid_response", message: "GitHub 返回的设备码不完整。" } };
  }
  return {
    ok: true,
    flow: {
      deviceCode,
      userCode,
      verificationUri,
      expiresIn: Math.max(60, Number(data.expires_in) || 900),
      interval: Math.max(5, Number(data.interval) || 5),
    },
  };
}

async function pollDeviceFlow(clientId, deviceCode, fetchImpl) {
  const data = await postForm(
    TOKEN_URL,
    {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    fetchImpl,
  );
  if (data.error) {
    if (data.error === "authorization_pending") return { status: "pending" };
    if (data.error === "slow_down") {
      return { status: "slow_down", interval: Math.max(5, Number(data.interval) || 10) };
    }
    return { status: "error", code: data.error, message: describeGithubError(data) };
  }
  const token = tokenFromResponse(data);
  if (!token) {
    return { status: "error", code: "invalid_response", message: "GitHub 未返回 access_token。" };
  }
  return { status: "success", token };
}

async function refreshAccessToken(clientId, refreshToken, fetchImpl) {
  const data = await postForm(
    TOKEN_URL,
    {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    fetchImpl,
  );
  if (data.error) {
    return { ok: false, code: data.error, message: describeGithubError(data) };
  }
  const token = tokenFromResponse(data);
  if (!token) {
    return { ok: false, code: "invalid_response", message: "GitHub 未返回新的 access_token。" };
  }
  return { ok: true, token };
}

module.exports = {
  DEFAULT_CLIENT_ID,
  DEVICE_CODE_URL,
  TOKEN_URL,
  describeGithubError,
  startDeviceFlow,
  pollDeviceFlow,
  refreshAccessToken,
};
