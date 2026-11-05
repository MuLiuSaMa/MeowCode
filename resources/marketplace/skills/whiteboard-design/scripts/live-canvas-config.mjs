const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DEFAULT_CONTROL_SERVER = "http://127.0.0.1:3000";

export function resolveLiveCanvasConfig(search) {
  const params = new URLSearchParams(search || "");
  if (params.get("mode") !== "workbench") {
    return null;
  }

  const rawBackend = params.get("backend") || DEFAULT_CONTROL_SERVER;
  let backend;
  try {
    backend = new URL(rawBackend);
  } catch {
    throw new Error(`无效的画板控制服务地址：${rawBackend}`);
  }

  if (
    backend.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(backend.hostname)
  ) {
    throw new Error("画板控制服务必须使用本机回环地址");
  }

  const httpOrigin = backend.origin;
  return {
    mode: "workbench",
    httpOrigin,
    websocketUrl: httpOrigin.replace(/^http:/, "ws:")
  };
}
