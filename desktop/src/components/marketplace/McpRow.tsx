import { Badge } from "../ui/Badge";
import { Toggle } from "../ui/Toggle";
import type { MarketplaceEntry, McpServerState, PluginDescriptor } from "../../api";
import { MCP_ENV_PLATFORMS, MCP_PLATFORM_LABELS } from "../../api";
import { MarketIcon } from "./MarketplaceCard";
import "./marketplace.css";

/** MCP 连接状态徽标（就绪 · N 工具 / 连接中 / 失败） */
function McpStatusBadge({ state }: { state: McpServerState | undefined }) {
  if (!state) return null;
  if (state.status === "ready") return <Badge tone="success">就绪 · {state.toolCount} 工具</Badge>;
  if (state.status === "connecting") return <Badge tone="running">连接中</Badge>;
  return <Badge tone="danger">失败{state.error ? ` · ${state.error}` : ""}</Badge>;
}

function EnvWarning({ names }: { names: string[] }) {
  if (!names.length) return null;
  return <span className="mc-mkt__warn">需设置 {names.join("、")}</span>;
}

/**
 * MCP 列表行（市场未安装/已安装通用）：图标 + 名称 + 描述 + 状态/凭据徽标 + 安装/移除按钮。
 */
export function McpRow({
  entry,
  iconUrl,
  state,
  busy,
  onInstall,
  onUninstall,
  githubConnected,
  onConnectGithub,
  onDisconnectGithub,
  onConnectOauth,
  onDisconnectOauth,
  oauthConnected,
  oauthPending,
  onCancelOauth,
}: {
  entry: MarketplaceEntry;
  iconUrl?: string;
  state: McpServerState | undefined;
  busy: boolean;
  onInstall: (entry: MarketplaceEntry) => void;
  onUninstall: (entry: MarketplaceEntry) => void;
  /** GitHub OAuth 是否已连接（settings.githubAuth；token 由主进程保存） */
  githubConnected?: boolean;
  /** GitHub MCP 的“连接/重新授权”入口 */
  onConnectGithub?: () => void;
  /** 解除本机 GitHub 授权 */
  onDisconnectGithub?: () => void;
  /** Gitee/GitCode OAuth 的“连接/重新授权”入口 */
  onConnectOauth?: (entry: MarketplaceEntry) => void;
  /** 解除本机 Gitee/GitCode OAuth */
  onDisconnectOauth?: (entry: MarketplaceEntry) => void;
  /** Gitee/GitCode OAuth 是否已连接 */
  oauthConnected?: boolean;
  /** 已打开系统浏览器，正在等待授权回调 */
  oauthPending?: boolean;
  /** 放弃本次浏览器授权 */
  onCancelOauth?: () => void;
}) {
  const requiresGithub =
    entry.type === "mcp" && (entry.requiresEnv ?? []).includes("MEOWCODE_GITHUB_TOKEN");
  const githubReady = !requiresGithub || githubConnected === true || entry.envReady !== false;
  const showGithubConnect = Boolean(
    requiresGithub && onConnectGithub && (!githubReady || state?.status === "failed"),
  );
  const otherEnvNames = (entry.requiresEnv ?? []).filter(
    (name) => name !== "MEOWCODE_GITHUB_TOKEN",
  );
  const oauthPlatform =
    entry.type === "mcp" ? MCP_ENV_PLATFORMS[(entry.requiresEnv ?? [])[0] ?? ""] : undefined;
  const oauthLabel = oauthPlatform ? MCP_PLATFORM_LABELS[oauthPlatform] : undefined;
  const oauthReady = oauthPlatform ? oauthConnected === true : false;
  const showOauthConnect = Boolean(
    oauthPlatform && onConnectOauth && (!oauthReady || state?.status === "failed"),
  );

  return (
    <div className="mc-mkt__row">
      <MarketIcon entry={entry} iconUrl={iconUrl} />
      <div className="mc-mkt__rowinfo">
        <div className="mc-mkt__rowname">
          <span title={entry.name}>{entry.name}</span>
        </div>
        <p className="mc-mkt__rowdesc">{entry.description}</p>
      </div>
      <div className="mc-mkt__badges">
        {entry.installed && !showGithubConnect && !showOauthConnect ? (
          <McpStatusBadge state={state} />
        ) : null}
        {oauthPending ? <Badge tone="running">等待浏览器授权…</Badge> : null}
        {oauthPending && onCancelOauth ? (
          <button type="button" className="mc-mkt__ghost" disabled={busy} onClick={onCancelOauth}>
            取消授权
          </button>
        ) : null}
        {showOauthConnect && !oauthPending ? (
          <button
            type="button"
            className="mc-mkt__connect"
            disabled={busy}
            title={
              state?.status === "failed"
                ? state.error
                : oauthReady
                  ? `用浏览器重新授权 ${oauthLabel}`
                  : `直接连接：用浏览器授权 ${oauthLabel}，无需粘贴 Token`
            }
            onClick={() => onConnectOauth?.(entry)}
          >
            {oauthReady ? "重新授权" : `连接 ${oauthLabel}`}
          </button>
        ) : null}
        {oauthPlatform && oauthConnected && onDisconnectOauth ? (
          <button
            type="button"
            className="mc-mkt__ghost"
            disabled={busy}
            onClick={() => onDisconnectOauth?.(entry)}
          >
            解除授权
          </button>
        ) : null}
        {entry.envReady === false && !requiresGithub && !oauthPlatform ? (
          <EnvWarning names={otherEnvNames} />
        ) : null}
        {showGithubConnect ? (
          <button
            type="button"
            className="mc-mkt__connect"
            disabled={busy}
            title={
              state?.status === "failed"
                ? state.error
                : githubReady
                  ? "重新授权 GitHub"
                  : "使用 GitHub OAuth 连接"
            }
            onClick={() => onConnectGithub?.()}
          >
            {githubReady ? "重新授权" : "连接 GitHub"}
          </button>
        ) : null}
        {requiresGithub && githubConnected && onDisconnectGithub ? (
          <button
            type="button"
            className="mc-mkt__ghost"
            disabled={busy}
            onClick={onDisconnectGithub}
          >
            解除授权
          </button>
        ) : null}
        {entry.installed ? (
          <button
            type="button"
            className="mc-mkt__ghost"
            disabled={busy}
            onClick={() => onUninstall(entry)}
          >
            移除
          </button>
        ) : (
          <button
            type="button"
            className="mc-mkt__install"
            disabled={busy}
            onClick={() => onInstall(entry)}
          >
            {busy ? "安装中…" : "＋ 安装"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 已安装插件行：点击进详情页；Toggle 启停（settings.plugins.disabled → server 重启）+ 卸载。
 */
export function InstalledPluginRow({
  descriptor,
  description,
  iconUrl,
  busy,
  onToggle,
  onUninstall,
  onOpen,
}: {
  descriptor: PluginDescriptor;
  /** 插件介绍（来自市场索引；用户手放的非市场插件没有） */
  description?: string;
  iconUrl?: string;
  busy: boolean;
  onToggle: (descriptor: PluginDescriptor, next: boolean) => void;
  onUninstall: (descriptor: PluginDescriptor) => void;
  onOpen: (descriptor: PluginDescriptor) => void;
}) {
  return (
    <div className="mc-mkt__row">
      <span
        role="button"
        tabIndex={0}
        className="mc-mkt__rowiconbtn"
        title="查看详情"
        onClick={() => onOpen(descriptor)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onOpen(descriptor);
        }}
      >
        <MarketIcon entry={{ id: descriptor.id, name: descriptor.id, source: descriptor.source }} iconUrl={iconUrl} size={30} />
      </span>
      <button
        type="button"
        className="mc-mkt__rowinfo mc-mkt__rowinfo--clickable"
        onClick={() => onOpen(descriptor)}
        title="查看详情"
      >
        <div className="mc-mkt__rowname">
          <span>{descriptor.id}</span>
          <Badge>{descriptor.source === "user" ? "全局" : "项目"}</Badge>
          {descriptor.error ? <Badge tone="danger">加载失败</Badge> : null}
        </div>
        <p className="mc-mkt__rowdesc">{descriptor.error ? descriptor.error : description || "暂无介绍"}</p>
      </button>
      <div className="mc-mkt__badges">
        <Toggle
          checked={descriptor.enabled && !descriptor.error}
          disabled={busy}
          label={`启用插件 ${descriptor.id}`}
          onChange={(next) => onToggle(descriptor, next)}
        />
        <button
          type="button"
          className="mc-mkt__ghost"
          disabled={busy}
          title="卸载"
          onClick={() => onUninstall(descriptor)}
        >
          卸载
        </button>
      </div>
    </div>
  );
}
