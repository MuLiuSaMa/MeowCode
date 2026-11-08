import { useTranslation } from "react-i18next";
import { Badge } from "../ui/Badge";
import { Toggle } from "../ui/Toggle";
import type { MarketplaceEntryLike, McpServerState, PluginDescriptor } from "../../api";
import { MCP_ENV_PLATFORMS } from "../../api";
import { MarketIcon, CommunityBadge } from "./MarketplaceCard";
import "./marketplace.css";

/** MCP 连接状态徽标（就绪 · N 工具 / 连接中 / 待配置 / 失败）；「我的」栏的手动 MCP 行也用 */
export function McpStatusBadge({ state }: { state: McpServerState | undefined }) {
  const { t } = useTranslation("marketplace");
  if (!state) return null;
  if (state.status === "ready") {
    return <Badge tone="success">{t("mcp.ready", { count: state.toolCount })}</Badge>;
  }
  if (state.status === "connecting") return <Badge tone="running">{t("mcp.connecting")}</Badge>;
  if (state.status === "unconfigured") {
    const names = (state.missingEnv ?? []).join(", ");
    return <Badge tone="neutral">{names ? t("mcp.unconfiguredDetail", { names }) : t("mcp.unconfigured")}</Badge>;
  }
  if (state.status === "needs_auth") {
    return <Badge tone="neutral">{t("mcp.needsAuth")}</Badge>;
  }
  return (
    <Badge tone="danger">
      {state.error ? t("mcp.failedDetail", { error: state.error }) : t("mcp.failed")}
    </Badge>
  );
}

function EnvWarning({ names }: { names: string[] }) {
  const { t } = useTranslation("marketplace");
  if (!names.length) return null;
  return <span className="mc-mkt__warn">{t("mcp.envRequired", { names: names.join(", ") })}</span>;
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
  onSetManualToken,
  onDisconnectManualToken,
  oauthConnected,
  oauthPending,
  onCancelOauth,
  onAuthorize,
  onRevoke,
  authorizing,
  onDelete,
  canDelete,
}: {
  entry: MarketplaceEntryLike;
  iconUrl?: string;
  state: McpServerState | undefined;
  busy: boolean;
  onInstall: (entry: MarketplaceEntryLike) => void;
  onUninstall: (entry: MarketplaceEntryLike) => void;
  /** GitHub OAuth 是否已连接（settings.githubAuth；token 由主进程保存） */
  githubConnected?: boolean;
  /** GitHub MCP 的“连接/重新授权”入口 */
  onConnectGithub?: () => void;
  /** 解除本机 GitHub 授权 */
  onDisconnectGithub?: () => void;
  /** Gitee/GitCode OAuth 的“连接/重新授权”入口 */
  onConnectOauth?: (entry: MarketplaceEntryLike) => void;
  /** 解除本机 Gitee/GitCode OAuth */
  onDisconnectOauth?: (entry: MarketplaceEntryLike) => void;
  /** 无 OAuth 通道的 MCP（如 Figma Context）的手动令牌粘贴入口 */
  onSetManualToken?: (entry: MarketplaceEntryLike) => void;
  /** 手动令牌的「解除授权」入口（删除本机令牌并断开 MCP） */
  onDisconnectManualToken?: (entry: MarketplaceEntryLike) => void;
  /** Gitee/GitCode OAuth 是否已连接 */
  oauthConnected?: boolean;
  /** 已打开系统浏览器，正在等待授权回调 */
  oauthPending?: boolean;
  /** 放弃本次浏览器授权 */
  onCancelOauth?: () => void;
  /** 远程 MCP（oauthCapable）的 MCP 协议内授权入口：起浏览器 + 等回环回调 */
  onAuthorize?: (entry: MarketplaceEntryLike) => void;
  /** 解除已生效的 MCP OAuth 授权（清本机 token + 断开） */
  onRevoke?: (entry: MarketplaceEntryLike) => void;
  /** 正在等浏览器完成 MCP 授权 */
  authorizing?: boolean;
  /** 社区条目删除入口（自己的条目才可见） */
  onDelete?: (entry: MarketplaceEntryLike) => void;
  canDelete?: boolean;
}) {
  const { t } = useTranslation("marketplace");
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
  const oauthLabel = oauthPlatform ? t(`platforms.${oauthPlatform}`) : "";
  const oauthReady = oauthPlatform ? oauthConnected === true : false;
  const showOauthConnect = Boolean(
    oauthPlatform && onConnectOauth && (!oauthReady || state?.status === "failed"),
  );
  // 远程 MCP 的协议内授权：没连上就给一个显式入口。连接期那次 401 自动授权失败后
  // 不会自己再弹，用户否则只能干等或重装。
  // unconfigured（缺 env）不显示：那种情况该配凭据，不是授权。
  // 平台条目（Gitee/GitCode/Undermind 等 requiresEnv 映射到 OAuth 平台的）与 GitHub 通道
  // 不走协议内授权/解除：凭据来自平台 OAuth，断开走下面的平台「解除授权」——
  // 否则一行会同时出现两个「解除授权」（协议内 + 平台），用户无法区分。
  const showAuthorize = Boolean(
    entry.type === "mcp" &&
      entry.oauthCapable &&
      entry.installed &&
      onAuthorize &&
      !requiresGithub &&
      !oauthPlatform &&
      state?.status !== "ready" &&
      state?.status !== "unconfigured",
  );
  const needsReauth = state?.status === "failed";
  // 已授权成功（ready）才给「解除授权」：needs_auth 时没有 token 可清，该点的是「授权」
  const showRevoke = Boolean(
    entry.type === "mcp" &&
      entry.oauthCapable &&
      entry.installed &&
      onRevoke &&
      !requiresGithub &&
      !oauthPlatform &&
      state?.status === "ready",
  );

  return (
    <div className="mc-mkt__row">
      <MarketIcon entry={entry} iconUrl={iconUrl} />
      <div className="mc-mkt__rowinfo">
        <div className="mc-mkt__rowname">
          <span title={entry.name}>{entry.name}</span>
          <CommunityBadge entry={entry} />
          {entry.localMcpSource === "manual" ? <Badge>{t("mine.badge")}</Badge> : null}
          {entry.localMcpSource === "local" ? <Badge>{t("mcp.localBadge")}</Badge> : null}
        </div>
        <p className="mc-mkt__rowdesc">{entry.description}</p>
      </div>
      <div className="mc-mkt__badges">
        {canDelete && onDelete ? (
          <button
            type="button"
            className="mc-mkt__ghost"
            title={t("card.deletePrTitle")}
            disabled={busy}
            onClick={() => onDelete(entry)}
          >
            {t("actions.delete")}
          </button>
        ) : null}
        {entry.localMcpEnabled === false ? <Badge tone="neutral">{t("mcp.disabled")}</Badge> : null}
        {/* 授权进行中由下面的「等待授权」徽标独占提示，不再重复显示「需要授权」 */}
        {entry.installed && !showGithubConnect && !showOauthConnect && !authorizing ? (
          <McpStatusBadge state={state} />
        ) : null}
        {authorizing ? <Badge tone="running">{t("mcp.authorizing")}</Badge> : null}
        {showAuthorize && !authorizing ? (
          <button
            type="button"
            className="mc-mkt__connect"
            disabled={busy}
            title={state?.error ?? t("mcp.authorizeTitle")}
            onClick={() => onAuthorize?.(entry)}
          >
            {needsReauth ? t("mcp.reauthorize") : t("mcp.authorize")}
          </button>
        ) : null}
        {showRevoke ? (
          <button
            type="button"
            className="mc-mkt__ghost"
            disabled={busy}
            title={t("body.disconnect.title", { platform: entry.name })}
            onClick={() => onRevoke?.(entry)}
          >
            {t("actions.disconnect")}
          </button>
        ) : null}
        {oauthPending ? <Badge tone="running">{t("oauth.awaitingBrowser")}</Badge> : null}
        {oauthPending && onCancelOauth ? (
          <button type="button" className="mc-mkt__ghost" disabled={busy} onClick={onCancelOauth}>
            {t("oauth.cancelAuth")}
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
                  ? t("oauth.reauthorizeTitle", { platform: oauthLabel })
                  : t("oauth.directTitle", { platform: oauthLabel })
            }
            onClick={() => onConnectOauth?.(entry)}
          >
            {oauthReady ? t("actions.reauthorize") : t("oauth.connectPlatform", { platform: oauthLabel })}
          </button>
        ) : null}
        {oauthPlatform && oauthConnected && onDisconnectOauth ? (
          <button
            type="button"
            className="mc-mkt__ghost"
            disabled={busy}
            onClick={() => onDisconnectOauth?.(entry)}
          >
            {t("actions.disconnect")}
          </button>
        ) : null}
        {entry.envReady === false && !requiresGithub && !oauthPlatform ? (
          <>
            {onSetManualToken ? (
              <button
                type="button"
                className="mc-mkt__connect"
                disabled={busy}
                title={t("mcp.setTokenTitle")}
                onClick={() => onSetManualToken(entry)}
              >
                {t("mcp.setToken")}
              </button>
            ) : null}
            <EnvWarning names={otherEnvNames} />
          </>
        ) : null}
        {!requiresGithub &&
        !oauthPlatform &&
        entry.envReady === true &&
        !showRevoke /* 同一条目协议内 OAuth ready 时不重复给手动令牌解除入口 */ &&
        onDisconnectManualToken ? (
          <button
            type="button"
            className="mc-mkt__ghost"
            disabled={busy}
            onClick={() => onDisconnectManualToken(entry)}
          >
            {t("actions.disconnect")}
          </button>
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
                  ? t("github.reauthorizeTitle")
                  : t("github.connectTitle")
            }
            onClick={() => onConnectGithub?.()}
          >
            {githubReady ? t("actions.reauthorize") : t("github.connect")}
          </button>
        ) : null}
        {requiresGithub && githubConnected && onDisconnectGithub ? (
          <button
            type="button"
            className="mc-mkt__ghost"
            disabled={busy}
            onClick={onDisconnectGithub}
          >
            {t("actions.disconnect")}
          </button>
        ) : null}
        {entry.installed ? (
          <>
            {entry.updateAvailable ? (
              <button
                type="button"
                className="mc-mkt__install"
                disabled={busy}
                title={t("actions.updateTitle", { version: entry.version })}
                onClick={() => onInstall(entry)}
              >
                {busy ? t("actions.updating") : t("actions.update")}
              </button>
            ) : null}
            <button
              type="button"
              className="mc-mkt__ghost"
              disabled={busy}
              onClick={() => onUninstall(entry)}
            >
              {busy ? t("actions.removing") : t("actions.remove")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="mc-mkt__install"
            disabled={busy}
            onClick={() => onInstall(entry)}
          >
            {busy ? t("actions.installing") : t("actions.install")}
          </button>
        )}
      </div>
    </div>
  );
}

/** 已加载插件的来源徽标（内置 / 全局 / 项目） */
const SOURCE_LABEL_KEYS: Record<string, string> = {
  builtin: "pluginSource.builtin",
  user: "pluginSource.user",
  project: "pluginSource.project",
};

/**
 * 已安装插件行：点击进详情页；Toggle 启停（settings.plugins.disabled → server 重启）+ 卸载。
 */
export function InstalledPluginRow({
  descriptor,
  name,
  description,
  iconUrl,
  busy,
  onToggle,
  onUninstall,
  onOpen,
  onOpenPanel,
}: {
  descriptor: PluginDescriptor;
  /** 市场条目的中文名（市场安装的插件没有 descriptor.displayName） */
  name?: string;
  /** 插件介绍（来自市场索引；用户手放的非市场插件没有） */
  description?: string;
  iconUrl?: string;
  busy: boolean;
  onToggle: (descriptor: PluginDescriptor, next: boolean) => void;
  onUninstall: (descriptor: PluginDescriptor) => void;
  onOpen: (descriptor: PluginDescriptor) => void;
  /** 插件自带 ui/index.html 时打开它的面板页签 */
  onOpenPanel?: (descriptor: PluginDescriptor) => void;
}) {
  const { t } = useTranslation("marketplace");
  const sourceKey = SOURCE_LABEL_KEYS[descriptor.source];
  return (
    <div className="mc-mkt__row">
      <span
        role="button"
        tabIndex={0}
        className="mc-mkt__rowiconbtn"
        title={t("actions.viewDetails")}
        onClick={() => onOpen(descriptor)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onOpen(descriptor);
        }}
      >
        <MarketIcon
          entry={{
            id: descriptor.id,
            name: descriptor.displayName ?? name ?? descriptor.id,
            source: descriptor.source,
          }}
          iconUrl={descriptor.iconUrl ?? iconUrl}
          size={30}
        />
      </span>
      <button
        type="button"
        className="mc-mkt__rowinfo mc-mkt__rowinfo--clickable"
        onClick={() => onOpen(descriptor)}
        title={t("actions.viewDetails")}
      >
        <div className="mc-mkt__rowname">
          <span>{descriptor.displayName ?? name ?? descriptor.id}</span>
          {sourceKey ? <Badge>{t(sourceKey)}</Badge> : null}
          {descriptor.error ? <Badge tone="danger">{t("plugin.loadFailed")}</Badge> : null}
        </div>
        <p className="mc-mkt__rowdesc">
          {descriptor.error ? descriptor.error : descriptor.description || description || t("plugin.noDescription")}
        </p>
      </button>
      <div className="mc-mkt__badges">
        {descriptor.ui && onOpenPanel ? (
          <button
            type="button"
            className="mc-mkt__ghost"
            disabled={busy || !descriptor.enabled || Boolean(descriptor.error)}
            title={t("actions.openPanel")}
            onClick={() => onOpenPanel(descriptor)}
          >
            {t("actions.openPanel")}
          </button>
        ) : null}
        <Toggle
          checked={descriptor.enabled && !descriptor.error}
          disabled={busy}
          label={t("plugin.enableAria", { id: descriptor.id })}
          onChange={(next) => onToggle(descriptor, next)}
        />
        {descriptor.source === "builtin" ? null : (
          <button
            type="button"
            className="mc-mkt__ghost"
            disabled={busy}
            title={t("actions.uninstall")}
            onClick={() => onUninstall(descriptor)}
          >
            {t("actions.uninstall")}
          </button>
        )}
      </div>
    </div>
  );
}
